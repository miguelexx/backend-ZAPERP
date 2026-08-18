/** Correlaciona bolha otimista do frontend com cada arquivo do lote (ordem do FormData). */
function parseClientTempIdsFromBody(body, fileCount) {
  const out = []
  const single = String(body?.client_temp_id ?? '').trim()
  if (single) out[0] = single.slice(0, 120)
  const raw = body?.client_temp_ids
  if (raw != null && String(raw).trim() !== '') {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (Array.isArray(parsed)) {
        parsed.forEach((v, i) => {
          if (v == null || String(v).trim() === '') return
          out[i] = String(v).trim().slice(0, 120)
        })
      }
    } catch (_) {
      /* ignora JSON inválido */
    }
  }
  const n = Number(fileCount) || 0
  return Array.from({ length: n }, (_, i) => out[i] || null)
}

function buildArquivoApiResultRow(msg, clientTempId) {
  if (!msg || msg.id == null) return null
  return {
    ok: true,
    id: msg.id,
    conversa_id: msg.conversa_id != null ? Number(msg.conversa_id) : null,
    client_temp_id: clientTempId || null,
    tipo: msg.tipo || null,
    url: msg.url || null,
    nome_arquivo: msg.nome_arquivo || null,
    texto: msg.texto || null,
    status: msg.status || 'pending',
    status_mensagem: msg.status_mensagem || msg.status || 'pending',
    ...(msg.whatsapp_id ? { whatsapp_id: msg.whatsapp_id } : {}),
    ...(msg.audio_duracao_sec != null && Number.isFinite(Number(msg.audio_duracao_sec))
      ? { audio_duracao_sec: Number(msg.audio_duracao_sec) }
      : {}),
  }
}

module.exports = {
  parseClientTempIdsFromBody,
  buildArquivoApiResultRow,
}
