const supabase = require('../config/supabase')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { getDisplayName } = require('../helpers/contactEnrichment')

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const STATUS_ATENDIMENTO_LABEL = {
  aberta: 'Aberta',
  fechada: 'Fechada',
  aguardando_cliente: 'Aguardando cliente',
  em_atendimento: 'Em atendimento',
  finalizada: 'Finalizada',
  ociosa: 'Ociosa'
}

function labelStatusAtendimento(raw) {
  const k = raw != null ? String(raw).trim().toLowerCase() : ''
  return STATUS_ATENDIMENTO_LABEL[k] || (raw ? escapeHtml(raw) : '—')
}

function formatDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return escapeHtml(String(iso))
    return escapeHtml(
      d.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    )
  } catch (_) {
    return escapeHtml(String(iso))
  }
}

function descricaoTipoMensagem(m) {
  const tipo = m?.tipo != null ? String(m.tipo).toLowerCase() : ''
  const map = {
    image: '[Imagem]',
    audio: '[Áudio]',
    voice: '[Mensagem de voz]',
    video: '[Vídeo]',
    document: '[Documento]',
    sticker: '[Figurinha]',
    contact: '[Contato]',
    location: '[Localização]',
    unknown: '[Mensagem]'
  }
  if (tipo && map[tipo]) return map[tipo]
  if (tipo) return `[${escapeHtml(tipo)}]`
  return ''
}

async function fetchMensagensParaImpressao(company_id, conversa_id, selectCols) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const pageSize = 500
  let offset = 0
  const all = []
  for (;;) {
    const { data, error } = await supabase
      .from('mensagens')
      .select(selectCols)
      .eq('company_id', cid)
      .eq('conversa_id', convId)
      .order('criado_em', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) return { error, mensagens: [] }
    const rows = Array.isArray(data) ? data : []
    all.push(...rows)
    if (rows.length < pageSize) break
    offset += pageSize
  }
  return { error: null, mensagens: all }
}

async function enrichAutoresMensagens(company_id, mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return mensagens
  const ids = [...new Set(mensagens.map((m) => m.autor_usuario_id).filter(Boolean))]
  if (ids.length === 0) return mensagens
  const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', ids)
  const map = new Map((us || []).map((u) => [u.id, u.nome]))
  return mensagens.map((m) => ({
    ...m,
    _autor_nome: m.autor_usuario_id ? map.get(m.autor_usuario_id) || null : null
  }))
}

function montarHtmlImpressao({
  tituloEmpresa,
  nomeCliente,
  telefone,
  dataAtendimento,
  statusLabel,
  atendenteNome,
  setorNome,
  imprimidoEm,
  mensagensHtml,
  conversaId
}) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(tituloEmpresa)} — Conversa #${Number(conversaId)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.45;
      color: #111;
      background: #fff;
      margin: 0;
      padding: 12mm 14mm;
      max-width: 210mm;
    }
    h1 {
      font-size: 16pt;
      font-weight: 600;
      margin: 0 0 4px 0;
      border-bottom: 1px solid #ccc;
      padding-bottom: 8px;
    }
    .meta {
      margin: 14px 0 18px 0;
      font-size: 10pt;
    }
    .meta table {
      border-collapse: collapse;
      width: 100%;
    }
    .meta td {
      padding: 3px 8px 3px 0;
      vertical-align: top;
    }
    .meta td:first-child {
      color: #444;
      white-space: nowrap;
      width: 140px;
    }
    .thread {
      margin-top: 8px;
    }
    .msg {
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid #eee;
      page-break-inside: avoid;
    }
    .msg:last-child { border-bottom: none; }
    .msg-head {
      font-size: 9pt;
      color: #555;
      margin-bottom: 4px;
    }
    .msg-body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .dir-in .msg-head { color: #0a5; }
    .dir-out .msg-head { color: #05a; }
    .footer-print {
      margin-top: 20px;
      padding-top: 10px;
      border-top: 1px solid #ddd;
      font-size: 9pt;
      color: #666;
    }
    @media print {
      body { padding: 8mm; }
      .msg { break-inside: avoid; }
      @page { size: A4; margin: 12mm; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(tituloEmpresa)}</h1>
  <p style="margin:0 0 12px 0;font-size:10pt;color:#555;">Histórico da conversa / atendimento</p>
  <div class="meta">
    <table>
      <tr><td>Cliente</td><td><strong>${nomeCliente}</strong></td></tr>
      <tr><td>Telefone</td><td>${telefone}</td></tr>
      <tr><td>Data do atendimento</td><td>${dataAtendimento}</td></tr>
      <tr><td>Status</td><td>${statusLabel}</td></tr>
      ${atendenteNome ? `<tr><td>Atendente</td><td>${atendenteNome}</td></tr>` : ''}
      ${setorNome ? `<tr><td>Setor</td><td>${setorNome}</td></tr>` : ''}
      <tr><td>Conversa nº</td><td>${Number(conversaId)}</td></tr>
    </table>
  </div>
  <h2 style="font-size:12pt;margin:16px 0 8px 0;font-weight:600;">Mensagens</h2>
  <div class="thread">
    ${mensagensHtml}
  </div>
  <div class="footer-print">
    Impresso em ${imprimidoEm}
  </div>
</body>
</html>`
}

/**
 * GET /print/conversas/:conversaId — HTML para impressão pelo navegador (mesmas regras de visibilidade que detalharChat).
 */
exports.imprimirConversa = async (req, res) => {
  try {
    const { conversaId } = req.params
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'
    const cid = Number(company_id)
    const convId = Number(conversaId)

    if (!Number.isFinite(convId) || convId <= 0) {
      return res.status(400).send('ID de conversa inválido')
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select(`
        id,
        telefone,
        status_atendimento,
        atendente_id,
        criado_em,
        ultima_atividade,
        departamento_id,
        tipo,
        nome_grupo,
        nome_contato_cache,
        cliente_id,
        clientes!conversas_cliente_fk ( id, nome, pushname, telefone, observacoes, foto_perfil, company_id ),
        usuarios!conversas_atendente_fk ( id, nome ),
        departamentos ( id, nome )
      `)
      .eq('id', convId)
      .eq('company_id', cid)
      .maybeSingle()

    if (errConv) return res.status(500).send('Erro ao carregar conversa')
    if (!conversa) return res.status(404).send('Conversa não encontrada')

    const isGroup = isGroupConversation(conversa)
    const isAssignedToUser = conversa.atendente_id && Number(conversa.atendente_id) === Number(user_id)

    let podeAcessar = isAssignedToUser
    if (!podeAcessar && !isAdmin && !isGroup) {
      const convDep = conversa.departamento_id ?? null
      const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
      const pertenceAoSetor = convDep == null || depIds.some((d) => Number(d) === Number(convDep))
      if (!pertenceAoSetor) {
        const { data: transferRow } = await supabase
          .from('atendimentos')
          .select('id')
          .eq('company_id', cid)
          .eq('conversa_id', convId)
          .eq('de_usuario_id', Number(user_id))
          .eq('acao', 'transferiu')
          .limit(1)
          .maybeSingle()
        if (!transferRow) {
          return res.status(403).send('Sem permissão para imprimir esta conversa')
        }
      }
    }

    const isSupervisor = role === 'supervisor'
    const conversaAssumidaPorOutro = conversa.atendente_id != null && Number(conversa.atendente_id) !== Number(user_id)
    const deveBloquearMensagens = !isGroup && conversaAssumidaPorOutro && !isAdmin && !isSupervisor
    if (deveBloquearMensagens) {
      return res.status(403).send('Sem permissão para imprimir esta conversa')
    }

    const selectComRemetente =
      'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone, contact_meta, location_meta'
    const selectBasico =
      'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, contact_meta, location_meta'
    const selectFallback = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo'

    let result = await fetchMensagensParaImpressao(cid, convId, selectComRemetente)
    if (result.error) {
      const em = String(result.error.message || '')
      if (em.includes('remetente') || em.includes('does not exist') || em.includes('column')) {
        result = await fetchMensagensParaImpressao(cid, convId, selectBasico)
      }
    }
    if (result.error) {
      const em = String(result.error.message || '')
      if (em.includes('reply_meta') || em.includes('contact_meta') || em.includes('location_meta') || em.includes('column')) {
        result = await fetchMensagensParaImpressao(cid, convId, selectFallback)
      }
    }
    if (result.error) return res.status(500).send('Erro ao carregar mensagens')
    let { mensagens } = result

    try {
      const { data: ocultas, error: errOcultas } = await supabase
        .from('mensagens_ocultas')
        .select('mensagem_id')
        .eq('company_id', cid)
        .eq('conversa_id', convId)
        .eq('usuario_id', Number(user_id))
      if (!errOcultas && Array.isArray(ocultas) && ocultas.length > 0) {
        const hidden = new Set(ocultas.map((o) => String(o.mensagem_id)))
        mensagens = (mensagens || []).filter((m) => !hidden.has(String(m.id)))
      }
    } catch (_) {}

    mensagens = await enrichAutoresMensagens(cid, mensagens || [])

    let rawClientes = conversa.clientes
    let clientesConv = Array.isArray(rawClientes)
      ? rawClientes.find((cl) => cl && Number(cl.id) === Number(conversa.cliente_id)) || rawClientes[0]
      : rawClientes
    if (clientesConv && clientesConv.company_id != null && Number(clientesConv.company_id) !== cid) {
      clientesConv = null
    }

    const isLidConv = !isGroup && conversa.telefone && String(conversa.telefone).trim().toLowerCase().startsWith('lid:')
    const clienteNome = getDisplayName(clientesConv)
    const nomeCache = conversa.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
    const nomeCliente = isGroup
      ? conversa.nome_grupo || conversa.telefone || 'Grupo'
      : isLidConv
        ? 'Contato'
        : clienteNome || nomeCache || conversa.telefone || '—'

    const telefoneExibir = isGroup
      ? escapeHtml(conversa.telefone || '—')
      : isLidConv
        ? '—'
        : escapeHtml(String(conversa.telefone || clientesConv?.telefone || '—'))

    const dataAtendimento = formatDateTime(conversa.criado_em)
    const statusLabel = labelStatusAtendimento(conversa.status_atendimento)
    const atendenteNome = conversa.usuarios?.nome ? escapeHtml(String(conversa.usuarios.nome)) : ''
    const setorNome = conversa.departamentos?.nome ? escapeHtml(String(conversa.departamentos.nome)) : ''

    const tituloEmpresa = 'ZapERP — Atendimento'

    let mensagensHtml = ''
    if (!mensagens.length) {
      mensagensHtml = '<p class="msg-body" style="color:#666;">Nenhuma mensagem nesta conversa.</p>'
    } else {
      for (const m of mensagens) {
        const dt = formatDateTime(m.criado_em)
        const dir = m.direcao === 'out' ? 'out' : 'in'
        const dirLabel = dir === 'out' ? 'Equipe' : isGroup ? (m.remetente_nome ? String(m.remetente_nome) : 'Participante') : 'Cliente'
        let quem = dir === 'out' && m._autor_nome ? String(m._autor_nome) : dirLabel
        if (isGroup && dir === 'in' && m.remetente_nome) quem = String(m.remetente_nome)
        const tipoExtra = descricaoTipoMensagem(m)
        const textoBase = (m.texto != null && String(m.texto).trim()) ? String(m.texto) : ''
        const linhaConteudo =
          textoBase || tipoExtra
            ? `${textoBase ? escapeHtml(textoBase) : ''}${textoBase && tipoExtra ? ' ' : ''}${tipoExtra}`
            : escapeHtml(String(m.tipo || 'mensagem'))

        mensagensHtml += `
    <div class="msg dir-${dir}">
      <div class="msg-head">${escapeHtml(quem)} · ${dt}${m.nome_arquivo ? ` · ${escapeHtml(m.nome_arquivo)}` : ''}</div>
      <div class="msg-body">${linhaConteudo}</div>
    </div>`
      }
    }

    const imprimidoEm = formatDateTime(new Date().toISOString())

    const html = montarHtmlImpressao({
      tituloEmpresa,
      nomeCliente: escapeHtml(nomeCliente),
      telefone: telefoneExibir,
      dataAtendimento,
      statusLabel,
      atendenteNome,
      setorNome,
      imprimidoEm,
      mensagensHtml,
      conversaId: convId
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(html)
  } catch (e) {
    console.error('[print] imprimirConversa:', e)
    return res.status(500).send('Erro ao gerar impressão')
  }
}
