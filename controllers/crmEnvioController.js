'use strict'

// Recebe pedidos de envio do CRM Avançado (automação por etapa / inbox bidirecional) e
// os despacha REUTILIZANDO a infraestrutura de envio do ZapERP: instância padrão da
// empresa, provider correto (UltraMSG/Whapi), antiban e checagem de opt-out. Não cria
// rotina paralela de WhatsApp.
//
// Autenticação: header x-zaperp-secret === ZAP_SSO_SECRET (mesmo segredo do SSO),
// comparado em tempo constante (crypto.timingSafeEqual). É server-to-server; não usa
// o auth (JWT de usuário).
//
// CONTRATO (o CRM Avançado consome server-to-server):
//   - Sucesso:            200 { ok:true, messageId:<id do provedor|null> }
//   - Erro de negócio:    200 { ok:false, error:"<motivo claro>" }   (ex.: instância desconectada,
//                          opt-out, provedor recusou) — o CRM só precisa checar `ok`.
//   - Entrada inválida:   400 { ok:false, error }                    (companyId/telefone ausentes)
//   - Config ausente:     503 { ok:false, error }                    (ZAP_SSO_SECRET não setado)
//   - Segredo divergente: 401 { ok:false, error }
//   - Exceção inesperada: 500 { ok:false, error }
//
// IDEMPOTÊNCIA: o CRM pode enviar `referencia`. Se a MESMA referência (por empresa) já foi
// processada — ou está em andamento — não reenviamos: devolvemos o resultado anterior.

const crypto = require('crypto')
const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { resolveConversationProvider } = require('../services/chat/identity/conversationAddressService')
const { getDefaultWhatsappInstance } = require('../services/whatsappInstanceService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

// ─── Segredo compartilhado (comparação segura) ───────────────────────────────
// timingSafeEqual exige buffers de mesmo tamanho; comparamos o tamanho antes (isso
// não vaza o segredo, só o comprimento do header recebido) e usamos a comparação
// constante para o conteúdo.
function segredoConfere(recebido, esperado) {
  if (!esperado) return false
  const a = Buffer.from(String(recebido == null ? '' : recebido), 'utf8')
  const b = Buffer.from(String(esperado), 'utf8')
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch (_err) {
    return false
  }
}

// ─── Idempotência em memória por (companyId:referencia) ──────────────────────
// Vive pelo processo (produção roda PM2 em fork único). Cobre o caso real: o CRM
// reenvia a MESMA `referencia` (retry de rede, duplo disparo) numa janela curta.
// NÃO cobre reinício do processo — garantia forte exigiria uma tabela (migration).
// O CRM manda `referencia` justamente para deduparmos esse burst comum.
const IDEMPOTENCIA_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const IDEMPOTENCIA_MAX = 5000
const enviosPorReferencia = new Map() // key -> { status:'pending'|'done', messageId, expiresAt }

function idempKey(companyId, referencia) {
  return `${companyId}:${referencia}`
}

function idempPrune() {
  const agora = Date.now()
  for (const [k, v] of enviosPorReferencia) {
    if (v.expiresAt <= agora) enviosPorReferencia.delete(k)
  }
  // Teto de tamanho: descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (enviosPorReferencia.size > IDEMPOTENCIA_MAX) {
    const maisAntiga = enviosPorReferencia.keys().next().value
    if (maisAntiga === undefined) break
    enviosPorReferencia.delete(maisAntiga)
  }
}

function idempGet(companyId, referencia) {
  if (!referencia) return null
  const k = idempKey(companyId, referencia)
  const v = enviosPorReferencia.get(k)
  if (!v) return null
  if (v.expiresAt <= Date.now()) {
    enviosPorReferencia.delete(k)
    return null
  }
  return v
}

function idempSet(companyId, referencia, entry) {
  if (!referencia) return
  idempPrune()
  enviosPorReferencia.set(idempKey(companyId, referencia), {
    ...entry,
    expiresAt: Date.now() + IDEMPOTENCIA_TTL_MS,
  })
}

function idempClear(companyId, referencia) {
  if (!referencia) return
  enviosPorReferencia.delete(idempKey(companyId, referencia))
}

// ─── Roteamento de mídia por extensão da URL ─────────────────────────────────
// A URL da mídia vem do CRM sem um tipo explícito; inferimos pela extensão para
// escolher o endpoint certo do provedor. Sem correspondência → documento (sendFile),
// que aceita qualquer arquivo com legenda.
function inferirTipoMidia(url) {
  const limpa = String(url || '').split('?')[0].split('#')[0]
  const ext = (limpa.split('.').pop() || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'imagem'
  if (['mp4', 'mov', '3gp', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wav', 'amr', 'flac'].includes(ext)) return 'audio'
  return 'documento'
}

function nomeArquivoDaUrl(url) {
  const limpa = String(url || '').split('?')[0].split('#')[0]
  const base = limpa.split('/').pop() || ''
  return base || 'arquivo'
}

// Normaliza o retorno heterogêneo dos adapters (boolean | { ok, messageId, error })
// para o contrato { ok, messageId?, error? } deste endpoint.
function normalizarResultadoEnvio(resultado) {
  if (resultado === false) return { ok: false, error: 'Envio rejeitado pelo provedor.' }
  if (resultado && typeof resultado === 'object') {
    if (resultado.ok === false) {
      return { ok: false, error: resultado.error || 'Falha no envio pelo provedor.' }
    }
    return { ok: true, messageId: resultado.messageId || resultado.id || null }
  }
  // resultado === true (sucesso booleano sem detalhes)
  return { ok: true, messageId: null }
}

async function estaOptOut(companyId, telefone) {
  try {
    const normalizado = normalizePhoneBR(telefone)
    if (!normalizado) return false
    const { data } = await supabase
      .from('disparo_exclusoes')
      .select('id')
      .eq('company_id', companyId)
      .eq('telefone_normalizado', normalizado)
      .eq('ativo', true)
      .maybeSingle()
    return !!data
  } catch (_err) {
    // Falha ao consultar opt-out não deve derrubar o envio; loga e segue.
    return false
  }
}

// Despacha o envio pelo provedor certo (texto ou mídia), devolvendo { ok, messageId?, error? }.
async function despacharEnvio({ companyId, instance, telefone, mensagem, midiaUrl }) {
  const provider = await resolveConversationProvider(companyId, instance.id)
  const adapter = getProvider({ provider })
  const sendOpts = {
    companyId,
    whatsappInstanceId: instance.id,
    returnDetails: true,
  }

  if (midiaUrl) {
    const tipoMidia = inferirTipoMidia(midiaUrl)
    const legenda = mensagem || ''
    if (tipoMidia === 'imagem') {
      return normalizarResultadoEnvio(await adapter.sendImage(telefone, midiaUrl, legenda, sendOpts))
    }
    if (tipoMidia === 'video') {
      return normalizarResultadoEnvio(await adapter.sendVideo(telefone, midiaUrl, legenda, sendOpts))
    }
    if (tipoMidia === 'audio' && typeof adapter.sendAudio === 'function') {
      // Áudio não tem legenda no WhatsApp; se houver texto, ele será enviado à parte abaixo.
      const audioRes = normalizarResultadoEnvio(await adapter.sendAudio(telefone, midiaUrl, sendOpts))
      return audioRes
    }
    // documento (ou áudio sem adapter dedicado): legenda vai em opts.caption.
    return normalizarResultadoEnvio(
      await adapter.sendFile(telefone, midiaUrl, nomeArquivoDaUrl(midiaUrl), { ...sendOpts, caption: legenda }),
    )
  }

  return normalizarResultadoEnvio(await adapter.sendText(telefone, mensagem, sendOpts))
}

async function enviarMensagem(req, res) {
  const segredo = process.env.ZAP_SSO_SECRET
  if (!segredo) {
    return res.status(503).json({ ok: false, error: 'Integração de envio não configurada (ZAP_SSO_SECRET).' })
  }
  if (!segredoConfere(req.headers['x-zaperp-secret'], segredo)) {
    return res.status(401).json({ ok: false, error: 'Segredo inválido.' })
  }

  const companyId = Number(req.body?.companyId)
  const telefone = String(req.body?.telefone || '').trim()
  const mensagem = String(req.body?.mensagem || '').trim()
  const midiaUrl = req.body?.midiaUrl ? String(req.body.midiaUrl).trim() : ''
  const referencia = req.body?.referencia ? String(req.body.referencia).trim() : ''

  if (!Number.isFinite(companyId) || companyId <= 0) {
    return res.status(400).json({ ok: false, error: 'companyId inválido.' })
  }
  if (!telefone) {
    return res.status(400).json({ ok: false, error: 'telefone é obrigatório.' })
  }
  // Sem mídia, a mensagem é obrigatória; com mídia, o texto vira legenda (opcional).
  if (!midiaUrl && !mensagem) {
    return res.status(400).json({ ok: false, error: 'mensagem é obrigatória quando não há mídia.' })
  }

  // Idempotência: referência já processada (ou em andamento) → devolve o resultado anterior.
  if (referencia) {
    const anterior = idempGet(companyId, referencia)
    if (anterior) {
      return res.status(200).json({ ok: true, messageId: anterior.messageId ?? null, idempotent: true })
    }
    // Marca "em andamento" ANTES de enviar para barrar uma requisição concorrente idêntica.
    idempSet(companyId, referencia, { status: 'pending', messageId: null })
  }

  try {
    // Opt-out: respeita a lista de exclusões do ZapERP (erro de negócio → 200 ok:false).
    if (await estaOptOut(companyId, telefone)) {
      idempClear(companyId, referencia)
      return res.status(200).json({ ok: false, error: 'Destinatário em opt-out.', optOut: true })
    }

    // Instância padrão ativa da empresa (desconectada/ausente → erro de negócio → 200 ok:false).
    const { instance, error: errInst } = await getDefaultWhatsappInstance(companyId)
    if (errInst || !instance) {
      idempClear(companyId, referencia)
      return res.status(200).json({ ok: false, error: errInst || 'Sem instância WhatsApp ativa.' })
    }

    const resultado = await despacharEnvio({ companyId, instance, telefone, mensagem, midiaUrl })

    if (!resultado.ok) {
      idempClear(companyId, referencia)
      return res.status(200).json({ ok: false, error: resultado.error || 'Falha no envio.' })
    }

    // Sucesso → marca a referência como concluída (com o messageId para respostas idempotentes).
    idempSet(companyId, referencia, { status: 'done', messageId: resultado.messageId ?? null })
    return res.status(200).json({ ok: true, messageId: resultado.messageId ?? null })
  } catch (err) {
    idempClear(companyId, referencia)
    console.error('[crm:enviar-mensagem] company=', companyId, err?.message)
    return res.status(500).json({ ok: false, error: 'Erro interno ao enviar.' })
  }
}

module.exports = { enviarMensagem }
