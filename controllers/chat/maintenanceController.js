/**
 * Manutenção de conversas: página e ação de merge de duplicatas (contatos e conversas por telefone/LID).
 * Extraído de controllers/chatController.js (Fase 8 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js. Rota: admin only (definida em chatRoutes.js).
 */

const supabase = require('../../config/supabase')
const { phoneKeyBR } = require('../../helpers/phoneHelper')
const { mergeConversasIntoCanonico } = require('../../helpers/conversationSync')
const { dedupeClientesForCompany } = require('../../services/clienteDedupeService')

const MERGE_DUPLICATAS_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Apagar duplicatas</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 1rem; background: #f5f5f5; }
    .box { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); max-width: 380px; }
    .box h2 { margin: 0 0 .75rem; font-size: 1rem; font-weight: 600; color: #333; }
    .box p { margin: 0 0 1rem; font-size: 0.875rem; color: #666; }
    .btn { background: #25d366; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem; cursor: pointer; }
    .btn:hover { background: #20bd5a; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .msg { margin-top: 0.75rem; font-size: 0.8125rem; }
    .msg.ok { color: #0a0; }
    .msg.err { color: #c00; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Conversas e contatos duplicados</h2>
    <p>Unifica conversas e contatos do mesmo número (evita duplicados ao enviar pelo celular).</p>
    <button type="button" class="btn" id="btn">Remover duplicatas</button>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    (function() {
      var btn = document.getElementById('btn');
      var msg = document.getElementById('msg');
      function getToken() {
        try {
          return localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('jwt') || '';
        } catch (e) { return ''; }
      }
      function setMsg(text, isErr) {
        msg.textContent = text || '';
        msg.className = 'msg' + (text ? (isErr ? ' err' : ' ok') : '');
      }
      btn.addEventListener('click', function() {
        btn.disabled = true;
        setMsg('');
        var token = getToken();
        fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') }
        }).then(function(r) {
          return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(_) {
          var res = _.data;
          if (_.ok) {
            var parts = [];
            if (res.clientesRemovidos) parts.push(res.clientesRemovidos + ' contato(s)');
            if (res.merged) parts.push(res.merged + ' conversa(s)');
            setMsg(res.message || (parts.length ? parts.join(', ') + ' unificados.' : 'Nenhuma duplicata encontrada.'));
          } else setMsg(res.error || 'Erro', true);
        }).catch(function(e) {
          setMsg('Erro: ' + (e.message || 'rede'), true);
        }).finally(function() {
          btn.disabled = false;
        });
      });
    })();
  </script>
</body>
</html>
`

// GET /chats/merge-duplicatas — página com botão "Apagar duplicatas" (abrir no navegador)
exports.paginaMergeDuplicatas = (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(MERGE_DUPLICATAS_HTML)
}

// =====================================================
// Merge conversas duplicadas (mesmo contato, variantes de telefone)
// Inclui reconciliação LID: mescla conversas com telefone="lid:xxx" na conversa do mesmo chat_lid.
// POST /chats/merge-duplicatas — admin only
// =====================================================
exports.mergeConversasDuplicadas = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id)

    let clientesRemovidos = 0

    // 1) Remover contatos duplicados (mesmo número em formatos diferentes).
    // Delegado ao serviço seguro: reaponta TODAS as tabelas com FK cliente_id (CRM, opt-in/
    // opt-out, disparo, helpdesk, avaliações, nomes vinculados) antes de excluir, evitando
    // perda de dados via ON DELETE CASCADE/SET NULL. Agrupa por identidade WhatsApp (±9º dígito).
    try {
      const dedupeReport = await dedupeClientesForCompany(cid, { apply: true })
      clientesRemovidos = dedupeReport.clientesRemovidos || 0
      if (dedupeReport.errors && dedupeReport.errors.length) {
        console.warn('mergeConversasDuplicadas clientes:', dedupeReport.errors.slice(0, 5))
      }
    } catch (e) {
      console.warn('mergeConversasDuplicadas clientes:', e?.message || e)
    }

    // 2) Mesclar conversas duplicadas
    const { data: conversas, error: errList } = await supabase
      .from('conversas')
      .select('id, telefone, chat_lid, ultima_atividade, criado_em, tipo, whatsapp_instance_id')
      .eq('company_id', cid)
      .neq('status_atendimento', 'fechada')
      .not('telefone', 'is', null)

    if (errList) return res.status(500).json({ error: errList.message })

    const individuais = (conversas || []).filter((c) => !c.tipo || String(c.tipo).toLowerCase() !== 'grupo')
    const byKey = new Map()
    for (const c of individuais) {
      const phoneKey = phoneKeyBR(c.telefone) || String(c.telefone || '').replace(/\D/g, '')
      if (!phoneKey) continue
      const instanceScope = c.whatsapp_instance_id ? `wi:${c.whatsapp_instance_id}` : 'wi:legacy'
      const scopedKey = `${instanceScope}:${phoneKey}`
      if (!byKey.has(scopedKey)) byKey.set(scopedKey, [])
      byKey.get(scopedKey).push(c)
    }

    let merged = 0
    const redirects = []
    const ioMerge = req.app.get('io')
    for (const [, list] of byKey) {
      if (list.length <= 1) continue
      list.sort((a, b) => {
        const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
        const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
        if (tb !== ta) return tb - ta
        return (b.id || 0) - (a.id || 0)
      })
      const canonical = list[0]
      const otherIds = list.slice(1).map((c) => c.id).filter(Boolean)
      if (otherIds.length === 0) continue
      try {
        const mergeResult = await mergeConversasIntoCanonico(supabase, cid, canonical.id, otherIds, { io: ioMerge })
        if (mergeResult?.ok && Array.isArray(mergeResult.mergedFrom)) {
          merged += mergeResult.mergedFrom.length
          for (const fromId of mergeResult.mergedFrom) {
            redirects.push({ from: Number(fromId), to: Number(canonical.id) })
          }
        }
      } catch (e) {
        console.warn('mergeConversasDuplicadas:', e?.message || e)
      }
    }

    // Reconcilição LID: conversas com telefone="lid:xxx" mesclar na conversa com telefone real que tenha o mesmo chat_lid
    const lidConvs = individuais.filter((c) => String(c.telefone || '').startsWith('lid:'))
    for (const lidConv of lidConvs) {
      const lidPart = lidConv.telefone ? String(lidConv.telefone).replace(/^lid:/, '').trim() : (lidConv.chat_lid || '')
      if (!lidPart) continue
      const canonPhone = individuais
        .filter((c) =>
          c.id !== lidConv.id &&
          !String(c.telefone || '').startsWith('lid:') &&
          c.chat_lid === lidPart &&
          (
            (lidConv.whatsapp_instance_id == null && c.whatsapp_instance_id == null) ||
            Number(c.whatsapp_instance_id) === Number(lidConv.whatsapp_instance_id)
          )
        )
        .sort((a, b) => new Date(b.ultima_atividade || 0).getTime() - new Date(a.ultima_atividade || 0).getTime())[0]
      if (canonPhone) {
        try {
          const mergeResult = await mergeConversasIntoCanonico(supabase, cid, canonPhone.id, [lidConv.id], { io: ioMerge })
          if (mergeResult?.ok && Array.isArray(mergeResult.mergedFrom) && mergeResult.mergedFrom.length) {
            merged += mergeResult.mergedFrom.length
            for (const fromId of mergeResult.mergedFrom) {
              redirects.push({ from: Number(fromId), to: Number(canonPhone.id) })
            }
            await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', canonPhone.id).eq('company_id', cid)
          }
        } catch (e) {
          console.warn('mergeConversasDuplicadas LID:', e?.message || e)
        }
      }
    }

    const msgParts = []
    if (clientesRemovidos) msgParts.push(`${clientesRemovidos} contato(s) removido(s)`)
    if (merged) msgParts.push(`${merged} conversa(s) unificada(s)`)
    const message = msgParts.length ? msgParts.join('. ') + '.' : 'Nenhuma duplicata encontrada.'
    return res.json({ ok: true, merged, clientesRemovidos, redirects, message })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao mesclar duplicatas' })
  }
}

// =====================================================
// Pré-visualização (DRY-RUN) dos contatos duplicados — não altera nada.
// GET /chats/merge-duplicatas/preview — admin only
// Retorna os grupos por identidade WhatsApp, o canônico escolhido e quais tabelas
// seriam reapontadas, para conferir antes de rodar o merge de verdade.
// =====================================================
exports.previewDuplicatasContatos = async (req, res) => {
  try {
    const cid = Number(req.user.company_id)
    const report = await dedupeClientesForCompany(cid, { apply: false })
    return res.json({ ok: true, ...report })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao pré-visualizar duplicatas' })
  }
}
