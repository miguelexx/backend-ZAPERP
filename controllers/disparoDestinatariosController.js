/**
 * Controller de Destinatários — módulo Disparo de Mensagens.
 * Gerencia: busca de contatos ZapERP, adição, listagem, remoção e resumo de destinatários.
 */

const supabase = require('../config/supabase')
const { buildClienteListagemSearchOr } = require('../helpers/chatSearchHelper')
const { validarTelefoneDisparo } = require('../helpers/disparoPhoneHelper')
const {
  parseArquivo,
  planejarImportacao,
  detectMappingAuto,
  PREVIEW_SAMPLE,
} = require('../helpers/disparoPlanilhaHelper')

// ─── Helpers locais ──────────────────────────────────────────────────────────

function positiveInt(v) {
  const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null
}

/** Marca distribuição como "necessita revisão" se já estava confirmada. */
async function marcarRevisaoDistribuicao(campanhaId, companyId) {
  try {
    await supabase.from('disparo_campanhas')
      .update({ distribuicao_revisao: true, atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId)
      .eq('company_id', companyId)
      .eq('distribuicao_confirmada', true)
  } catch (_) { /* não bloqueia a operação principal */ }
}

function cleanText(v, max = 255) {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, max)
}

function paginationParams(q) {
  const page = Math.max(1, positiveInt(q.page) || 1)
  const limit = Math.min(50, Math.max(1, positiveInt(q.limit) || 30))
  return { page, limit, offset: (page - 1) * limit }
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' }); return false
  }
  return true
}

/** Carrega campanha e verifica que pertence à empresa do token. Retorna null se não encontrada. */
async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select('id, status, company_id')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) { res.status(404).json({ error: 'Campanha não encontrada.' }); return null }
  return data
}

/** Verifica se o status permite edição de destinatários. */
function statusPermiteEdicao(status) {
  return status === 'rascunho' || status === 'configurando'
}

/** Retorna conjunto de telefones normalizados já na campanha (para dedup). */
async function telefonesNaCampanha(campanhaId) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('telefone_normalizado')
    .eq('campanha_id', campanhaId)
    .neq('status', 'excluido')
  if (error) throw error
  return new Set((data ?? []).map(r => r.telefone_normalizado))
}

const BATCH_SIZE = 500

// ─── Busca de contatos ZapERP ─────────────────────────────────────────────────

/**
 * GET /disparo/campanhas/:id/contatos
 * Pesquisa contatos da empresa com paginação e busca por nome/telefone.
 * Marca quais já estão na campanha.
 */
exports.buscarContatos = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { page, limit, offset } = paginationParams(req.query)
    const search = cleanText(req.query.search ?? '', 100)
    const tagId = positiveInt(req.query.tag_id)

    // Base query
    let baseQ = supabase
      .from('clientes')
      .select('id, nome, telefone, wa_id, pushname, email, empresa, foto_perfil, criado_em', { count: 'exact' })
      .eq('company_id', companyId)

    if (search) {
      const or = buildClienteListagemSearchOr(search)
      if (or) baseQ = baseQ.or(or)
    }

    // Filtro por tag (via conversas)
    if (tagId) {
      const { data: convIds } = await supabase
        .from('conversa_tags')
        .select('conversa_id')
        .eq('company_id', companyId)
        .eq('tag_id', tagId)
      const ids = (convIds ?? []).map(r => r.conversa_id).filter(Boolean)
      if (ids.length === 0) {
        return res.json({ contatos: [], total: 0, page, limit })
      }
      const { data: clienteIds } = await supabase
        .from('conversas')
        .select('cliente_id')
        .in('id', ids)
        .eq('company_id', companyId)
      const cIds = [...new Set((clienteIds ?? []).map(r => r.cliente_id).filter(Boolean))]
      if (cIds.length === 0) {
        return res.json({ contatos: [], total: 0, page, limit })
      }
      baseQ = baseQ.in('id', cIds)
    }

    const { data, error, count } = await baseQ
      .order('nome', { ascending: true })
      .range(offset, offset + limit - 1)

    if (error) throw error

    // Telefones já na campanha para marcar como "já adicionado"
    const jaNaCampanha = await telefonesNaCampanha(campanhaId)
    const norm = validarTelefoneDisparo

    const contatos = (data ?? []).map(c => {
      const tel = c.telefone ?? c.wa_id ?? ''
      const { normalizado } = norm(tel)
      return {
        ...c,
        telefone_normalizado: normalizado,
        ja_na_campanha: normalizado ? jaNaCampanha.has(normalizado) : false,
      }
    })

    // Tags das conversas deste contato (para exibição)
    // Retornamos apenas as tags via join se não há busca por tag (performance)
    res.json({
      contatos,
      total: count ?? 0,
      page,
      limit,
    })
  } catch (err) {
    console.error('[disparo:destinatarios] buscarContatos', err)
    res.status(500).json({ error: 'Erro ao buscar contatos.' })
  }
}

// ─── Listar destinatários da campanha ────────────────────────────────────────

/**
 * GET /disparo/campanhas/:id/destinatarios
 */
exports.listarDestinatarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { page, limit, offset } = paginationParams(req.query)
    const search = cleanText(req.query.search ?? '', 100)

    let q = supabase
      .from('disparo_campanha_destinatarios')
      .select(
        'id, nome, telefone_original, telefone_normalizado, origem, variaveis, status, arquivo_origem, linha_planilha, criado_em, cliente:clientes!disparo_campanha_destinatarios_cliente_id_fkey(id, nome, foto_perfil)',
        { count: 'exact' },
      )
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')

    if (search) {
      q = q.or(`nome.ilike.%${search.replace(/[%_\\]/g, c => `\\${c}`)}%,telefone_normalizado.ilike.%${search.replace(/\D/g, '')}%`)
    }

    const { data, error, count } = await q
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    res.json({ destinatarios: data ?? [], total: count ?? 0, page, limit })
  } catch (err) {
    console.error('[disparo:destinatarios] listarDestinatarios', err)
    res.status(500).json({ error: 'Erro ao listar destinatários.' })
  }
}

// ─── Adicionar contatos salvos ───────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/destinatarios/add-contatos
 * Body: { cliente_ids: number[], select_all?: boolean, search?: string, tag_id?: number }
 */
exports.addContatos = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = Number(req.user.id ?? req.user.user_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível editar destinatários nesta fase da campanha.' })
    }

    let clienteIds = []

    if (req.body.select_all) {
      // Busca todos os IDs que casam com o filtro atual
      const search = cleanText(req.body.search ?? '', 100)
      const tagId = positiveInt(req.body.tag_id)
      let q = supabase.from('clientes').select('id').eq('company_id', companyId)
      if (search) {
        const or = buildClienteListagemSearchOr(search)
        if (or) q = q.or(or)
      }
      if (tagId) {
        const { data: convIds } = await supabase
          .from('conversa_tags').select('conversa_id').eq('company_id', companyId).eq('tag_id', tagId)
        const ids = (convIds ?? []).map(r => r.conversa_id).filter(Boolean)
        if (ids.length > 0) {
          const { data: cIds } = await supabase.from('conversas').select('cliente_id').in('id', ids).eq('company_id', companyId)
          const cl = [...new Set((cIds ?? []).map(r => r.cliente_id).filter(Boolean))]
          q = q.in('id', cl)
        }
      }
      const { data: allClientes } = await q.limit(10000)
      clienteIds = (allClientes ?? []).map(c => c.id)
    } else {
      clienteIds = (Array.isArray(req.body.cliente_ids) ? req.body.cliente_ids : [])
        .map(positiveInt).filter(Boolean)
    }

    if (clienteIds.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato selecionado.' })
    }

    // Carrega dados dos clientes (valida ownership e obtém telefone)
    const { data: clientes, error: cErr } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone, wa_id')
      .in('id', clienteIds)
      .eq('company_id', companyId)
    if (cErr) throw cErr

    const jaNaCampanha = await telefonesNaCampanha(campanhaId)

    const rows = []
    const ignorados = []

    for (const c of (clientes ?? [])) {
      const telRaw = c.telefone ?? c.wa_id ?? ''
      const { normalizado, valido, motivo } = validarTelefoneDisparo(telRaw)
      if (!valido) {
        ignorados.push({ cliente_id: c.id, nome: c.nome ?? c.pushname, motivo })
        continue
      }
      if (jaNaCampanha.has(normalizado)) {
        ignorados.push({ cliente_id: c.id, nome: c.nome ?? c.pushname, motivo: 'Número já incluído na campanha' })
        continue
      }
      jaNaCampanha.add(normalizado) // dedup dentro do batch atual
      rows.push({
        company_id: companyId,
        campanha_id: campanhaId,
        cliente_id: c.id,
        nome: cleanText(c.nome ?? c.pushname ?? '', 180) || null,
        telefone_original: telRaw,
        telefone_normalizado: normalizado,
        origem: 'contato_salvo',
        adicionado_por: userId,
        status: 'pendente',
      })
    }

    // Insere em lotes para evitar timeout
    let inseridos = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const { error: insErr } = await supabase.from('disparo_campanha_destinatarios').insert(batch)
      if (insErr) throw insErr
      inseridos += batch.length
    }

    // Avança status para 'configurando' se era rascunho
    if (campanha.status === 'rascunho' && inseridos > 0) {
      await supabase.from('disparo_campanhas')
        .update({ status: 'configurando', atualizado_em: new Date().toISOString() })
        .eq('id', campanhaId).eq('company_id', companyId)
    }

    await marcarRevisaoDistribuicao(campanhaId, companyId)

    res.json({ inseridos, ignorados, total_selecionados: clienteIds.length })
  } catch (err) {
    console.error('[disparo:destinatarios] addContatos', err)
    res.status(500).json({ error: 'Erro ao adicionar contatos.' })
  }
}

/**
 * DELETE /disparo/campanhas/:id/destinatarios/:destId
 */
exports.removerDestinatario = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const destId = positiveInt(req.params.destId)
    if (!campanhaId || !destId) return res.status(400).json({ error: 'IDs inválidos.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível remover destinatários nesta fase da campanha.' })
    }

    const { error } = await supabase
      .from('disparo_campanha_destinatarios')
      .update({ status: 'excluido' })
      .eq('id', destId)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
    if (error) throw error

    await marcarRevisaoDistribuicao(campanhaId, companyId)

    res.json({ ok: true })
  } catch (err) {
    console.error('[disparo:destinatarios] removerDestinatario', err)
    res.status(500).json({ error: 'Erro ao remover destinatário.' })
  }
}

// ─── Remover vários destinatários ───────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/destinatarios/remover-varios
 * Body: { ids: number[] }
 */
exports.removerVarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível remover destinatários nesta fase da campanha.' })
    }

    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(positiveInt).filter(Boolean)
    if (ids.length === 0) return res.status(400).json({ error: 'Nenhum ID informado.' })

    const { error } = await supabase
      .from('disparo_campanha_destinatarios')
      .update({ status: 'excluido' })
      .in('id', ids)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
    if (error) throw error

    await marcarRevisaoDistribuicao(campanhaId, companyId)

    res.json({ ok: true, removidos: ids.length })
  } catch (err) {
    console.error('[disparo:destinatarios] removerVarios', err)
    res.status(500).json({ error: 'Erro ao remover destinatários.' })
  }
}

// ─── Limpar todos os destinatários ──────────────────────────────────────────

/**
 * DELETE /disparo/campanhas/:id/destinatarios
 * Query: confirmado=true obrigatório (proteção extra)
 */
exports.limparDestinatarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    if (req.query.confirmado !== 'true') {
      return res.status(400).json({ error: 'Adicione confirmado=true para limpar todos os destinatários.' })
    }

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível limpar destinatários nesta fase.' })
    }

    const { error } = await supabase
      .from('disparo_campanha_destinatarios')
      .update({ status: 'excluido' })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')
    if (error) throw error

    await marcarRevisaoDistribuicao(campanhaId, companyId)

    res.json({ ok: true })
  } catch (err) {
    console.error('[disparo:destinatarios] limparDestinatarios', err)
    res.status(500).json({ error: 'Erro ao limpar destinatários.' })
  }
}

// ─── Resumo da campanha ──────────────────────────────────────────────────────

/**
 * GET /disparo/campanhas/:id/destinatarios/resumo
 */
exports.resumoDestinatarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { data, error } = await supabase
      .from('disparo_campanha_destinatarios')
      .select('status, origem')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
    if (error) throw error

    const rows = data ?? []
    const ativos = rows.filter(r => r.status !== 'excluido')
    const total = ativos.length
    const porOrigem = ativos.reduce((a, r) => {
      a[r.origem] = (a[r.origem] ?? 0) + 1; return a
    }, {})

    res.json({
      total,
      contato_salvo: porOrigem.contato_salvo ?? 0,
      importacao_planilha: porOrigem.importacao_planilha ?? 0,
      manual: porOrigem.manual ?? 0,
    })
  } catch (err) {
    console.error('[disparo:destinatarios] resumoDestinatarios', err)
    res.status(500).json({ error: 'Erro ao carregar resumo.' })
  }
}

// ─── Preview de importação ───────────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/destinatarios/preview
 * Multipart: arquivo + mapping (JSON string opcional)
 * Retorna análise sem gravar nada.
 */
exports.previewImportacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível importar nesta fase da campanha.' })
    }

    if (!req.file?.buffer || !req.file.size) {
      return res.status(400).json({ error: 'Envie um arquivo no campo "arquivo".', code: 'ARQUIVO_OBRIGATORIO' })
    }

    const ext = String(req.file.originalname ?? '').split('.').pop().toLowerCase()
    const sheetIdx = req.body.sheet_idx != null ? Number(req.body.sheet_idx) : null
    const validSheetIdx = Number.isInteger(sheetIdx) && sheetIdx >= 0 ? sheetIdx : null

    const { sheets, sheetIdxAtual, headers, dataRows } = await parseArquivo(req.file.buffer, ext, validSheetIdx)

    const autoMapping = detectMappingAuto(headers)
    const mapping = parseMapping(req.body.mapping, autoMapping, headers.length)

    const telefonesExistentes = await telefonesNaCampanha(campanhaId)
    const plano = planejarImportacao(headers, dataRows, mapping, telefonesExistentes)

    res.json({
      sheets,
      sheet_idx_atual: sheetIdxAtual,
      headers,
      mapping,
      mapping_auto: autoMapping,
      colunas_extras: plano.colunasExtras.map(c => ({ idx: c.idx, nome: c.nome, chave: c.chave })),
      stats: plano.stats,
      amostra_validas: plano.valid.slice(0, PREVIEW_SAMPLE),
      rejeitados: plano.invalid,
    })
  } catch (err) {
    return responderErro(res, err, '[disparo:import] previewImportacao', 'Erro ao analisar a planilha.')
  }
}

// ─── Confirmar importação ────────────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/destinatarios/confirmar-importacao
 * Multipart: arquivo + mapping + sheet_id + arquivo_nome (opcional)
 * Processa e salva os destinatários válidos em lotes.
 */
exports.confirmarImportacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = Number(req.user.id ?? req.user.user_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível importar nesta fase da campanha.' })
    }

    if (!req.file?.buffer || !req.file.size) {
      return res.status(400).json({ error: 'Envie um arquivo no campo "arquivo".', code: 'ARQUIVO_OBRIGATORIO' })
    }

    const ext = String(req.file.originalname ?? '').split('.').pop().toLowerCase()
    const sheetIdx = req.body.sheet_idx != null ? Number(req.body.sheet_idx) : null
    const validSheetIdx = Number.isInteger(sheetIdx) && sheetIdx >= 0 ? sheetIdx : null
    const arquivoNome = cleanText(req.body.arquivo_nome ?? req.file.originalname ?? '', 255)

    const { headers, dataRows } = await parseArquivo(req.file.buffer, ext, validSheetIdx)

    const autoMapping = detectMappingAuto(headers)
    const mapping = parseMapping(req.body.mapping, autoMapping, headers.length)

    if (mapping.nome == null || mapping.telefone == null) {
      return res.status(400).json({
        error: 'Mapeamento de nome e telefone obrigatório. Ajuste e tente novamente.',
        code: 'MAPEAMENTO_INCOMPLETO',
      })
    }

    const telefonesExistentes = await telefonesNaCampanha(campanhaId)
    const plano = planejarImportacao(headers, dataRows, mapping, telefonesExistentes)

    if (plano.valid.length === 0) {
      return res.status(400).json({
        error: 'Nenhuma linha válida para importar.',
        code: 'NENHUMA_LINHA_VALIDA',
        stats: plano.stats,
        rejeitados: plano.invalid.slice(0, 500),
      })
    }

    // Insere em lotes
    let inseridos = 0
    for (let i = 0; i < plano.valid.length; i += BATCH_SIZE) {
      const batch = plano.valid.slice(i, i + BATCH_SIZE).map(e => ({
        company_id: companyId,
        campanha_id: campanhaId,
        nome: cleanText(e.nome, 180),
        telefone_original: e.telefone_original,
        telefone_normalizado: e.telefone_normalizado,
        variaveis: e.variaveis,
        origem: 'importacao_planilha',
        arquivo_origem: arquivoNome || null,
        linha_planilha: e.linha,
        adicionado_por: userId,
        status: 'pendente',
      }))
      const { error: insErr } = await supabase.from('disparo_campanha_destinatarios').insert(batch)
      if (insErr) throw insErr
      inseridos += batch.length
    }

    // Avança para 'configurando' se estava em rascunho
    if (campanha.status === 'rascunho' && inseridos > 0) {
      await supabase.from('disparo_campanhas')
        .update({ status: 'configurando', atualizado_em: new Date().toISOString() })
        .eq('id', campanhaId).eq('company_id', companyId)
    }

    res.json({
      inseridos,
      rejeitados: plano.invalid,
      stats: plano.stats,
    })
  } catch (err) {
    return responderErro(res, err, '[disparo:import] confirmarImportacao', 'Erro ao importar destinatários.')
  }
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function parseMapping(raw, autoMapping, headersLen) {
  let obj = {}
  if (!raw) {
    obj = {}
  } else if (typeof raw === 'object') {
    obj = raw
  } else {
    try { obj = JSON.parse(raw) } catch { obj = {} }
  }

  const parseIdx = (v) => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 && n < headersLen ? n : null
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(obj, k)
  return {
    nome: has('nome') ? parseIdx(obj.nome) : autoMapping.nome,
    telefone: has('telefone') ? parseIdx(obj.telefone) : autoMapping.telefone,
  }
}

function responderErro(res, err, tag, fallback) {
  const status = Number(err?.status) || 500
  if (status >= 500) console.error(tag, err)
  return res.status(status).json({
    error: status >= 500 ? fallback : (err?.message ?? fallback),
    ...(err?.code ? { code: err.code } : {}),
  })
}
