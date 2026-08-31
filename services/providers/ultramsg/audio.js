const { buildSendMeta } = require('../../whatsappSendGuardService')
const { WHATSAPP_DEBUG } = require('./constants')
const { normalizeUltraMsgSendResult } = require('./result')
const { phoneCandidatesForSend } = require('./phones')
const { awaitSendDelay } = require('./delay')
const { resolveConfig } = require('./config')
const { postJson, aplicarReferenceId, maskToken } = require('./http')

/** 
 * Converte URL de áudio para formato compatível com UltraMsg.
 * Corrige MIME types problemáticos (webm -> ogg) mantendo o codec opus.
 */
function normalizeAudioUrl(audioUrl) {
  if (!audioUrl || typeof audioUrl !== 'string') return audioUrl
  
  // Se é data URI com webm, converter para ogg (mesmo codec, container compatível)
  if (audioUrl.startsWith('data:audio/webm')) {
    return audioUrl.replace('data:audio/webm', 'data:audio/ogg')
  }
  
  // Se é data URI com opus, converter para ogg
  if (audioUrl.startsWith('data:audio/opus')) {
    return audioUrl.replace('data:audio/opus', 'data:audio/ogg')
  }
  
  return audioUrl
}

function isDataUri(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('data:')
}

function extractAudioExtension(value = '') {
  try {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const withoutQuery = raw.split('?')[0].split('#')[0]
    const match = withoutQuery.match(/\.([a-z0-9]{2,5})$/i)
    return match ? String(match[1]).toLowerCase() : ''
  } catch {
    return ''
  }
}

function isAllowedAudioExtension(ext) {
  if (!ext) return true // URLs de CDN sem extensão explícita
  return ['mp3', 'ogg', 'aac', 'wav', 'm4a', 'opus', 'webm'].includes(String(ext).toLowerCase())
}

function isAllowedAudioEndpointExtension(ext) {
  if (!ext) return true // URLs de CDN da UltraMsg normalmente não têm extensão
  return ['mp3', 'ogg', 'aac'].includes(String(ext).toLowerCase())
}

/**
 * Verifica se o erro do UltraMsg é relacionado a extensão de arquivo não suportada.
 * UltraMsg pode retornar erro como string, objeto ou array de objetos.
 */
function isFileExtensionError(error) {
  if (!error) return false
  
  // Erro como string
  if (typeof error === 'string') {
    return error.includes('file extension not supported')
  }
  
  // Erro como array de objetos
  if (Array.isArray(error)) {
    return error.some(e => {
      if (typeof e === 'string') return e.includes('file extension not supported')
      if (e && typeof e === 'object') {
        return Object.values(e).some(val => 
          typeof val === 'string' && val.includes('file extension not supported')
        )
      }
      return false
    })
  }
  
  // Erro como objeto
  if (typeof error === 'object') {
    return Object.values(error).some(val => 
      typeof val === 'string' && val.includes('file extension not supported')
    )
  }
  
  return false
}

/**
 * Tenta enviar áudio com múltiplos formatos até um funcionar.
 * Usado quando o formato original é rejeitado pelo UltraMsg.
 */
async function tryMultipleAudioFormats(phone, originalAudioUrl, cfg, endpoint = '/messages/audio') {
  if (!originalAudioUrl.startsWith('data:')) return false
  
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length) return false
  
  const base64Data = originalAudioUrl.split(',')[1]
  if (!base64Data) return false
  
  // Lista de MIME types para tentar, em ordem de compatibilidade
  const mimeTypesToTry = [
    'audio/mpeg',  // MP3 - mais universalmente aceito
    'audio/ogg',   // OGG - boa compatibilidade
    'audio/wav',   // WAV - formato básico
    'audio/mp4',   // M4A/AAC em container MP4
    'audio/aac'    // AAC puro
  ]
  
  for (const mimeType of mimeTypesToTry) {
    try {
      const audioUrl = `data:${mimeType};base64,${base64Data}`
      const body = { to: nums[0], audio: audioUrl }
      
      const result = await postJson({
        ...cfg,
        endpoint,
        body,
        meta: buildSendMeta('audio_format_retry', nums[0], { companyId: cfg.companyId }),
      })
      const hasError = result.data?.error && result.data.error !== false && result.data.error !== 'false'
      const sentFailed = result.data?.sent === 'false' || result.data?.sent === false
      
      if (result.ok && !hasError && !sentFailed) {
        console.log(`✅ UltraMsg áudio enviado como ${mimeType}:`, nums[0]?.slice(-12))
        return true
      }
      
      // Se ainda é erro de extensão, continua tentando
      if (isFileExtensionError(result.data?.error)) {
        console.log(`[ULTRAMSG] ${mimeType} também rejeitado, tentando próximo formato`)
        continue
      }
      
      // Se é outro tipo de erro, para de tentar
      console.warn(`[ULTRAMSG] Erro não relacionado à extensão com ${mimeType}:`, result.data?.error)
      break
      
    } catch (error) {
      console.warn(`[ULTRAMSG] Erro ao tentar ${mimeType}:`, error?.message)
      continue
    }
  }
  
  return false
}

/**
 * Envia áudio por URL.
 * UltraMsg aceita: mp3, aac, ogg | máx 16 MB | link HTTP ou base64
 */
async function sendAudio(phone, audioUrl, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return returnDetails ? { ok: false, error: 'Destino ou áudio inválido' } : false
  
  // Processa URL de áudio para melhor compatibilidade
  const processedAudioUrl = normalizeAudioUrl(String(audioUrl).trim())
  const audioExt = extractAudioExtension(opts?.audioMeta?.originalName || processedAudioUrl)
  const audioMime = String(opts?.audioMeta?.mimeType || '').toLowerCase()

  if (isDataUri(processedAudioUrl)) {
    const reason = 'Data URI não suportado para /messages/audio; envie URL HTTP(S).'
    console.warn('[ULTRAMSG][AUDIO] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: 'data:*base64*' },
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioExtension(audioExt)) {
    const reason = `Extensão de áudio não suportada para UltraMsg: .${audioExt}`
    console.warn('[ULTRAMSG][AUDIO] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioEndpointExtension(audioExt)) {
    const reason = `Extensão .${audioExt} não suportada no endpoint /messages/audio`
    console.warn('[ULTRAMSG][AUDIO] Formato não aceito em /messages/audio, tentando /messages/voice:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    const allowVoiceFallback = opts?.allowVoiceFallback !== false
    if (!allowVoiceFallback) {
      return returnDetails
        ? { ok: false, error: `${reason}. Permitidos em /messages/audio: mp3/ogg/aac.` }
        : false
    }
    const voiceResult = await sendVoice(phone, processedAudioUrl, {
      ...opts,
      returnDetails: true,
      // Evita esperar delay duas vezes no fallback audio -> voice
      skipProviderDelay: true,
      // Evita "ping-pong" de fallback voice -> audio
      disableAudioFallback: true,
      allowVoiceFallback: false
    })
    if (voiceResult?.ok) {
      return returnDetails
        ? { ok: true, messageId: voiceResult?.messageId ?? null, error: null }
        : true
    }
    const voiceError = String(voiceResult?.error || 'Falha ao enviar via /messages/voice')
    return returnDetails ? { ok: false, error: `${reason}; fallback voice falhou: ${voiceError}` } : false
  }
  
  console.log(`[ULTRAMSG] Tentando enviar audio para ${nums[0]?.slice(-12)} com URL: ${processedAudioUrl.slice(0, 50)}...`)
  const body = aplicarReferenceId({ to: nums[0], audio: processedAudioUrl }, opts)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/audio',
    body,
    meta: buildSendMeta('audio', nums[0], opts),
  })
  
  // UltraMsg pode responder HTTP 200 com erro no body ou sem aceite explícito.
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const explicitError = data?.error && data.error !== false && data.error !== 'false'
  const sentFailed = data?.sent === 'false' || data?.sent === false
  
  // Verifica se é erro de extensão não suportada
  const isExtensionError = isFileExtensionError(data?.error)
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] sendAudio tentativa:', {
      endpoint: '/messages/audio',
      to: nums[0],
      audio: processedAudioUrl.slice(0, 120),
      ext: audioExt || null,
      mime: audioMime || null,
      result: { ok, status, hasError: !!explicitError, sentFailed, isExtensionError },
    })
  }
  
  if (!normalized.ok) {
    const errRaw = normalized.error || data?.error || (sentFailed ? 'sent:false' : null) || String(text || '').slice(0, 200) || `HTTP ${status}`
    const errMsg = typeof errRaw === 'object' ? JSON.stringify(errRaw) : String(errRaw)
    console.warn('❌ UltraMsg sendAudio falhou:', {
      to: nums[0]?.slice(-12),
      endpoint: '/messages/audio',
      status,
      error: errMsg.slice(0, 300),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
      response: { data: data || null, text: String(text || '').slice(0, 300) },
      token: maskToken(cfg.token),
    })
    return returnDetails ? { ...normalized, ok: false, error: errMsg } : false
  }
  console.log('✅ UltraMsg áudio enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia áudio de voz (voice note). UltraMsg exige codec opus.
 * POST /{instance_id}/messages/voice — body: token, to, audio
 * Fallback: se o endpoint voice rejeitar (ex.: formato), tenta /messages/audio.
 */
async function sendVoice(phone, audioUrl, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  // Respeita skipProviderDelay (ex.: fallback audio→voice) para não pagar o delay duas vezes.
  await awaitSendDelay(opts?.companyId ?? opts?.company_id, opts)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return returnDetails ? { ok: false, error: 'Destino ou áudio inválido' } : false
  
  // Processa URL de áudio para melhor compatibilidade
  const processedAudioUrl = normalizeAudioUrl(String(audioUrl).trim())
  const audioExt = extractAudioExtension(opts?.audioMeta?.originalName || processedAudioUrl)
  const audioMime = String(opts?.audioMeta?.mimeType || '').toLowerCase()

  if (isDataUri(processedAudioUrl)) {
    const reason = 'Data URI não suportado para /messages/voice; envie URL HTTP(S).'
    console.warn('[ULTRAMSG][VOICE] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: 'data:*base64*' },
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioExtension(audioExt)) {
    const reason = `Extensão de áudio não suportada para UltraMsg: .${audioExt}`
    console.warn('[ULTRAMSG][VOICE] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  
  const body = aplicarReferenceId({ to: nums[0], audio: processedAudioUrl }, opts)

  // Tenta endpoint voice primeiro
  console.log(`[ULTRAMSG] Tentando enviar voice para ${nums[0]?.slice(-12)} com URL: ${processedAudioUrl.slice(0, 50)}...`)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/voice',
    body,
    meta: buildSendMeta('voice', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const explicitError = data?.error && data.error !== false && data.error !== 'false'
  const sentFailed = data?.sent === 'false' || data?.sent === false
  
  // Verifica se é erro de extensão não suportada
  const isExtensionError = isFileExtensionError(data?.error)
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] sendVoice tentativa:', {
      endpoint: '/messages/voice',
      to: nums[0],
      audio: processedAudioUrl.slice(0, 120),
      ext: audioExt || null,
      mime: audioMime || null,
      result: { ok, status, hasError: !!explicitError, sentFailed, isExtensionError },
    })
  }
  
  if (!normalized.ok) {
    const errRaw = normalized.error || data?.error || (sentFailed ? 'sent:false' : null) || String(text || '').slice(0, 200) || `HTTP ${status}`
    const errMsg = typeof errRaw === 'object' ? JSON.stringify(errRaw) : String(errRaw)
    console.warn('❌ UltraMsg sendVoice falhou, tentando /messages/audio:', {
      to: nums[0]?.slice(-12),
      endpoint: '/messages/voice',
      status,
      error: errMsg.slice(0, 300),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
      response: { data: data || null, text: String(text || '').slice(0, 300) },
      token: maskToken(cfg.token),
    })

    if (opts?.disableAudioFallback) {
      return returnDetails ? { ...normalized, ok: false, error: errMsg } : false
    }

    // Fallback: tenta como áudio comum
    const fb = await postJson({
      ...cfg,
      endpoint: '/messages/audio',
      body,
      meta: buildSendMeta('voice_audio_fallback', nums[0], opts),
    })
    const fbNormalized = normalizeUltraMsgSendResult({
      httpOk: fb.ok,
      status: fb.status,
      data: fb.data,
      text: fb.text,
      fallbackError: fb.data?.message,
    })
    const fbExplicitError = fb.data?.error && fb.data.error !== false && fb.data.error !== 'false'
    const fbSentFailed = fb.data?.sent === 'false' || fb.data?.sent === false
    
    // Verifica se o fallback também tem erro de extensão
    const fbIsExtensionError = isFileExtensionError(fb.data?.error)
    
    if (!fbNormalized.ok) {
      const fbErrRaw = fbNormalized.error || fb.data?.error || (fbSentFailed ? 'sent:false' : null) || String(fb.text || '').slice(0, 200) || `HTTP ${fb.status}`
      const fbErrMsg = typeof fbErrRaw === 'object' ? JSON.stringify(fbErrRaw) : String(fbErrRaw)
      console.warn('❌ UltraMsg sendAudio (fallback) falhou:', {
        to: nums[0]?.slice(-12),
        endpoint: '/messages/audio',
        status: fb.status,
        error: fbErrMsg.slice(0, 300),
        ext: audioExt || null,
        mime: audioMime || null,
        payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
        response: { data: fb.data || null, text: String(fb.text || '').slice(0, 300) },
        isExtensionError: fbIsExtensionError || isExtensionError,
        token: maskToken(cfg.token),
      })
      return returnDetails ? { ...fbNormalized, ok: false, error: fbErrMsg } : false
    }
    console.log('✅ UltraMsg áudio enviado (fallback /messages/audio):', nums[0]?.slice(-12))
    return returnDetails ? fbNormalized : true
  }
  console.log('✅ UltraMsg voice enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

module.exports = {
  normalizeAudioUrl,
  isFileExtensionError,
  sendAudio,
  sendVoice,
}
