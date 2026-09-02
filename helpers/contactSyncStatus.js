function contactSyncStatus(job, progress = null) {
  const running = ['pending', 'running', 'cancel_requested'].includes(job.status)
  const r = running ? (progress?.job_id === job.id ? progress : {}) : (job.resultado_json || {})
  const failed = job.status === 'dead_letter' || job.status === 'failed' || (!running && r.ok === false)
  return {
    ok: !failed, running, queued: job.status === 'pending', job_id: job.id,
    tipo: 'sync_contatos', status: job.status, fase: r.fase || (running ? 'aguardando' : 'concluido'),
    total_contatos: r.totalProcessados || 0, total_agenda: r.totalAgendaValidos || 0,
    verificados: r.totalVerificados || 0, criados: r.totalCriados || 0,
    atualizados: r.totalAtualizados || 0, fotos_atualizadas: r.totalFotosAtualizadas || 0,
    fotos_indisponiveis: r.totalFotosIndisponiveis || 0, erros: r.totalErros || 0,
    error: failed ? (job.erro || r.error || 'Erro ao sincronizar contatos.') : null,
    message: running ? (job.erro ? 'Nova tentativa agendada: ' + job.erro : 'Sincronização em andamento. Os clientes aparecem conforme são importados.') : null,
    aviso: r.aviso || null,
  }
}
module.exports = { contactSyncStatus }
