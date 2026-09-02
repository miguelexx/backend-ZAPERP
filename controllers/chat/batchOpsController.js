/**
 * Contagem de conversas por filtros e finalização de ausência em lote.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const { getChatFilterCounts } = require('../../services/chatListCountsService')

exports.contarConversasPorFiltros = async (req, res) => {
  try {
    if (String(req.query?.unread || '') === '1') {
      const { getUnreadSnapshot } = require('../../services/chatUnreadSnapshotService')
      res.set('Cache-Control', 'no-store')
      return res.json(await getUnreadSnapshot(req))
    }
    const counts = await getChatFilterCounts(req)
    return res.json(counts)
  } catch (err) {
    if (err && err.code === 'CHAT_COUNTS_TIMEOUT') {
      console.warn('[contarConversasPorFiltros] timeout')
      return res.status(504).json({ error: 'Timeout ao contar conversas' })
    }
    console.error('[contarConversasPorFiltros]', err)
    return res.status(500).json({ error: 'Erro ao contar conversas' })
  }
}

exports.finalizacaoAusenciaLoteAuth = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(400).json({ error: 'company_id inválido na sessão' })
    }
    const { finalizeAbsenceForConversaIds } = require('../../services/absenceFinalizationService')
    const body = req.body || {}
    const result = await finalizeAbsenceForConversaIds({
      company_id,
      conversa_ids: body.conversa_ids,
      dryRun: !!body.dry_run,
      execute: body.execute === true,
      confirm: body.confirm,
    })
    if (!result.ok) return res.status(400).json({ error: result.error || 'Falha na operação' })
    return res.json(result)
  } catch (err) {
    console.error('finalizacaoAusenciaLoteAuth:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}
