'use strict'

// Recebe pedidos de envio do CRM Avançado (automação por etapa / inbox bidirecional) e
// os despacha REUTILIZANDO a infraestrutura de envio Whapi do ZapERP: resolve a instância
// Whapi da empresa (token Bearer), o adapter Whapi (POST gate.whapi.cloud/messages/*),
// antiban e checagem de opt-out. Não cria rotina paralela de WhatsApp.
//
// IMPORTANTE (bug corrigido): as instâncias da plataforma são Whapi. Antes o endpoint
// resolvia a instância/provider default (que cai em UltraMSG/legado empresa_zapi quando
// a empresa é só-Whapi) — a UltraMSG responde HTTP 200 com id de fila mesmo sem entregar,
// então o CRM recebia ok:true e a mensagem NÃO chegava. Agora forçamos provider='whapi'
// e só retornamos ok:true quando o Whapi confirma o envio (sent:true / message.id).
//
// Autenticação: header x-zaperp-secret === ZAP_SSO_SECRET (mesmo segredo do SSO),
// comparado em tempo constante. É server-to-server; não usa o auth (JWT de usuário).
//
// CONTRATO (o CRM Avançado consome server-to-server):
//   - Sucesso (Whapi confirmou): 200 { ok:true, messageId:<id do Whapi|null> }
//   - Falha do Whapi / sem instância / opt-out / timeout: 200 { ok:false, error:"<motivo>" }
//     (o CRM usa `ok` para marcar Enviado × Erro). NUNCA ok:true sem confirmação do Whapi.
//   - Entrada inválida:   400 { ok:false, error }   · Config ausente: 503 · Segredo: 401.
//   - O token Whapi NUNCA aparece na resposta (só messageId/erro do provedor).
//
// IDEMPOTÊNCIA: o CRM pode enviar `referencia`. Se a MESMA referência (por empresa) já foi
// processada — ou está em andamento — não reenviamos: devolvemos o resultado anterior.

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { getDefaultWhatsappInstance } = require('../services/whatsappInstanceService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')
const { segredoConfere } = require('../helpers/zaperpSecret')
const whapiContacts = require('../services/providers/whapi/contacts')
const { listWhapiIdentityDigits, normalizeCanonicalWaId } = require('../services/whapiRecipientResolverService')

// Timeout curto na chamada ao Whapi (o adapter tem timeout interno ~30s; aqui impomos
// ~15s para o CRM não travar esperando um canal lento).
const WHAPI_SEND_TIMEOUT_MS = 15000

// Telefone mascarado para log (nunca logar o número inteiro).
function mascararTelefone(t) {
  const d = String(t || '').replace(/\D/g, '')
  if (d.length <= 4) return '****'
  return `${d.slice(0, 2)}***${d.slice(-4)}`
}

// Corre `promise` contra um timer; se estourar, resolve com `fallback` (não rejeita).
function comTimeout(promise, ms, fallback) {
  let timer
  const limite = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([
    Promise.resolve(promise)
      .catch((e) => ({ ok: false, error: `Falha ao enviar (Whapi): ${e?.message || e}`, httpStatus: null }))
      .finally(() => clearTimeout(timer)),
    limite,
  ])
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
// para o contrato { ok, messageId?, error?, httpStatus? } deste endpoint. httpStatus é
// preservado só para o LOG de diagnóstico (nunca vai para a resposta ao CRM).
function normalizarResultadoEnvio(resultado) {
  if (resultado === false) return { ok: false, error: 'Envio rejeitado pelo provedor.', httpStatus: null }
  if (resultado && typeof resultado === 'object') {
    if (resultado.ok === false) {
      return { ok: false, error: resultado.error || 'Falha no envio pelo provedor.', httpStatus: resultado.httpStatus ?? null }
    }
    return { ok: true, messageId: resultado.messageId || resultado.id || null, httpStatus: resultado.httpStatus ?? null }
  }
  // resultado === true (sucesso booleano sem detalhes)
  return { ok: true, messageId: null, httpStatus: null }
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

// Despacha o envio pelo Whapi (texto ou mídia), devolvendo { ok, messageId?, error?, httpStatus? }.
// Provider FORÇADO a 'whapi' + whatsappInstanceId da instância Whapi resolvida — nunca deixa
// o roteamento cair em UltraMSG/legado (causa do "ok:true sem entregar").
async function despacharEnvio({ companyId, instance, telefone, mensagem, midiaUrl }) {
  const adapter = getProvider({ provider: 'whapi' })
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

// Resolve o chat id CANÔNICO (wa_id) do número no Whapi ANTES de enviar, com fallback de
// 9º dígito BR. O adapter só faz essa resolução via /contacts quando há conversa/cliente no
// opts (resolveWhapiSendRecipient) — o envio do CRM não tem esse contexto, então a mensagem
// ia para o número cru: a Whapi aceita o formato e marca ✓✓, mas entrega a um chat que NÃO é
// o WhatsApp real quando o 9º dígito está errado. Aqui consultamos POST /contacts (checkPhones,
// force_check) com as variantes 12↔13 e usamos o wa_id autoritativo devolvido pela Whapi.
//
// Retorno:
//   { resolvido:true, chatId:'<digits>@s.whatsapp.net', waIdDigits }  → destino confirmado
//   { resolvido:false, semWhatsapp:true }                              → número não tem WhatsApp
//   { resolvido:false, erro }                                          → falha ao verificar (Whapi)
async function resolverChatIdWhapi({ companyId, whatsappInstanceId, telefone }) {
  // Candidatos = número + variantes de 9º dígito BR (12 e 13 dígitos do mesmo celular).
  const candidatos = listWhapiIdentityDigits(telefone)
  if (!candidatos.length) return { resolvido: false, semWhatsapp: true }

  let checked
  try {
    checked = await whapiContacts.checkPhones(candidatos, {
      companyId,
      whatsappInstanceId,
      forceCheck: true,
    })
  } catch (e) {
    return { resolvido: false, erro: `Não foi possível verificar o número no WhatsApp (Whapi): ${e?.message || e}` }
  }

  const soDigitos = (v) => String(v || '').replace(/@[^@]+$/, '').replace(/\D/g, '')
  const validosPorInput = new Map()
  for (const item of (Array.isArray(checked) ? checked : [])) {
    if (!item?.exists || !item?.waId) continue
    const d = soDigitos(item.input)
    if (d) validosPorInput.set(d, item)
  }

  // Prefere o wa_id do primeiro candidato NA NOSSA ordem que a Whapi validou; senão, qualquer válido.
  const escolher = (item) => {
    const chatId = normalizeCanonicalWaId(item.waId)
    return chatId ? { resolvido: true, chatId, waIdDigits: soDigitos(item.waId) } : null
  }
  for (const cand of candidatos) {
    const hit = validosPorInput.get(soDigitos(cand))
    if (hit) {
      const r = escolher(hit)
      if (r) return r
    }
  }
  const qualquer = (Array.isArray(checked) ? checked : []).find((i) => i?.exists && i?.waId)
  if (qualquer) {
    const r = escolher(qualquer)
    if (r) return r
  }
  return { resolvido: false, semWhatsapp: true }
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

    // Instância WHAPI da empresa (com credenciais). Sem instância/token → ok:false 200.
    const { instance, error: errInst } = await getDefaultWhatsappInstance(companyId, {
      provider: 'whapi',
      includeCredentials: true,
    })
    const token = instance && String(instance.instance_token || '').trim()
    if (errInst || !instance || !token) {
      idempClear(companyId, referencia)
      return res.status(200).json({ ok: false, error: 'Empresa sem instância Whapi conectada.' })
    }

    // Resolve o chat id canônico no Whapi (com fallback de 9º dígito) ANTES de enviar.
    const wa = await resolverChatIdWhapi({ companyId, whatsappInstanceId: instance.id, telefone })
    if (!wa.resolvido) {
      idempClear(companyId, referencia)
      const motivo = wa.semWhatsapp
        ? `Número não tem WhatsApp: ${telefone}`
        : (wa.erro || 'Não foi possível resolver o destino no WhatsApp.')
      console.warn(
        '[crm:enviar-mensagem] SEM_DESTINO company=%s to=%s motivo=%s',
        companyId,
        mascararTelefone(telefone),
        motivo,
      )
      return res.status(200).json({ ok: false, error: motivo })
    }

    // Envio pelo Whapi para o wa_id RESOLVIDO, com teto de ~15s (o adapter confirma sent:true / message.id).
    const resultado = await comTimeout(
      despacharEnvio({ companyId, instance, telefone: wa.chatId, mensagem, midiaUrl }),
      WHAPI_SEND_TIMEOUT_MS,
      { ok: false, error: 'Tempo esgotado ao enviar (Whapi).', httpStatus: null },
    )

    if (!resultado.ok) {
      idempClear(companyId, referencia)
      // Log de diagnóstico: telefone original + wa_id resolvido (mascarados) + status HTTP + motivo.
      console.warn(
        '[crm:enviar-mensagem] FALHA company=%s to=%s waId=%s httpStatus=%s erro=%s',
        companyId,
        mascararTelefone(telefone),
        mascararTelefone(wa.waIdDigits),
        resultado.httpStatus ?? '-',
        String(resultado.error || '').slice(0, 200),
      )
      return res.status(200).json({ ok: false, error: resultado.error || 'Falha no envio.' })
    }

    // Sucesso confirmado pelo Whapi → grava a referência (com messageId p/ respostas idempotentes).
    idempSet(companyId, referencia, { status: 'done', messageId: resultado.messageId ?? null })
    console.log(
      '[crm:enviar-mensagem] OK company=%s to=%s waId=%s id=%s',
      companyId,
      mascararTelefone(telefone),
      mascararTelefone(wa.waIdDigits),
      resultado.messageId ? String(resultado.messageId).slice(0, 16) : '-',
    )
    return res.status(200).json({ ok: true, messageId: resultado.messageId ?? null })
  } catch (err) {
    idempClear(companyId, referencia)
    console.error('[crm:enviar-mensagem] company=', companyId, err?.message)
    return res.status(500).json({ ok: false, error: 'Erro interno ao enviar.' })
  }
}

module.exports = { enviarMensagem }
