'use strict'

/**
 * Middleware FAIL-CLOSED para webhooks UltraMsg.
 * Exige WHATSAPP_WEBHOOK_TOKEN (ver index.js).
 * Aceita: X-Webhook-Token, Authorization: Bearer — e `?token=` enquanto
 * `WEBHOOK_QUERY_TOKEN_ENABLED` não for `false` (ver abaixo por que o default é ligado).
 * Fallback: instanceId registrado em empresa_zapi.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * TOKEN NA QUERY — por que desligado por padrão e por que a chave existe (doc 33 §F1)
 *
 * `?token=` era aceito porque a API do UltraMSG (`POST /instance/settings`) só aceita
 * `webhook_url`: **não existe campo de header**, logo o painel/instância UltraMSG não consegue
 * mandar `X-Webhook-Token`. O preço era o segredo viajar na URL — e `middleware/logger.js`
 * logava `req.originalUrl`, gravando em claro o MESMO segredo que autentica o webhook Whapi.
 *
 * Agora: a URL é redigida no log (`helpers/redactUrlSecrets.js`), então o segredo não é mais
 * escrito em claro — e isso vale mesmo quando o cliente manda `?token=` numa rota que recusa.
 * A aceitação da query virou uma chave (`WEBHOOK_QUERY_TOKEN_ENABLED`), para poder ser desligada
 * sem mexer em código no dia em que não houver mais canal UltraMSG.
 *
 * ⚠️ Desligar derruba canal UltraMSG ATIVO: 401 em inbound e ACK. Ver a medição em
 * `queryTokenNaQueryHabilitado` abaixo e doc 33 §6.3.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto')
const { getCompanyIdByInstanceId } = require('../services/whatsappConfigService')
const { getBooleanEnv, isProduction } = require('../config/env')

/** Extrai instanceId do payload (body.instanceId, instance_id, instance, ou dentro de data). */
function extractInstanceId(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance ??
    body.data?.instanceId ?? body.data?.instance_id
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

/**
 * Comparação em tempo constante — previne timing-attacks.
 * Retorna false se qualquer lado estiver vazio após trim (caller também valida presença).
 * Buffers são normalizados ao maior comprimento antes do compare (padding interno do Node).
 */
function timingSafeEqual(a, b) {
  const sa = String(a ?? '').trim()
  const sb = String(b ?? '').trim()
  if (!sa || !sb) return false
  const maxLen = Math.max(Buffer.byteLength(sa, 'utf8'), Buffer.byteLength(sb, 'utf8'))
  const ba = Buffer.alloc(maxLen)
  const bb = Buffer.alloc(maxLen)
  ba.write(sa, 'utf8')
  bb.write(sb, 'utf8')
  return crypto.timingSafeEqual(ba, bb) && sa.length === sb.length
}

/**
 * `?token=` ainda é aceito nesta rota (UltraMSG) — default LIGADO, e isto é deliberado.
 *
 * O pedido era parar de aceitar. Implementado e reversível por esta chave, mas o default ficou
 * LIGADO depois da medição em produção (16/10/2026): existem 4 canais UltraMSG ativos (empresas
 * 17, 8, 11 e 19, com 2991/727/647/608 mensagens em 7 dias), a API do UltraMSG não tem campo de
 * header (`POST /instance/settings` só aceita `webhook_url`) e o `.env` de produção não define
 * `ALLOW_INSTANCEID_WEBHOOK_FALLBACK` (default false em produção). Logo, o único jeito de esses
 * canais serem aceitos hoje é a query — desligar aqui seria 401 em todo inbound e todo ACK deles.
 *
 * O objetivo do F1 (o segredo do webhook Whapi não vazar por log) já está cumprido sem isto, por
 * dois caminhos independentes: segredo próprio da Whapi (`WHAPI_WEBHOOK_TOKEN`) e redação da URL
 * no log (`helpers/redactUrlSecrets`).
 *
 * Quando os canais UltraMSG migrarem: `WEBHOOK_QUERY_TOKEN_ENABLED=false` e a query morre.
 */
function queryTokenNaQueryHabilitado() {
  return getBooleanEnv('WEBHOOK_QUERY_TOKEN_ENABLED', true)
}

function requireWebhookToken(req, res, next) {
  const expected = String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()

  if (!expected) {
    console.error('[WEBHOOK_FATAL] WHATSAPP_WEBHOOK_TOKEN ausente')
    return res.status(500).json({ error: 'Configuração de segurança do webhook inválida' })
  }

  const authHeader = req.get('Authorization') || ''
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
  const bearer = bearerMatch ? bearerMatch[1].trim() : ''
  const queryToken = String(req.query?.token || '').trim()
  const queryTokenEnabled = queryTokenNaQueryHabilitado()
  const incoming = String(
    req.get('X-Webhook-Token') || bearer || (queryTokenEnabled ? queryToken : '') || ''
  ).trim()
  // Veio token na query com a porta fechada: não é "token ausente" por descuido, é canal
  // configurado no formato antigo. O log precisa dizer isso, senão vira outage misteriosa.
  const queryTokenRecusado = Boolean(queryToken) && !queryTokenEnabled
  req._webhookQueryTokenRecusado = queryTokenRecusado

  // Token presente e válido → permite
  if (incoming && timingSafeEqual(incoming, expected)) {
    return next()
  }

  const allowInstanceFallback = getBooleanEnv(
    'ALLOW_INSTANCEID_WEBHOOK_FALLBACK',
    !isProduction()
  )

  // Token ausente ou inválido → fallback opcional via instanceId registrado
  if (!allowInstanceFallback) {
    return _reject(req, res, incoming)
  }

  const instanceId = extractInstanceId(req.body)
  if (instanceId) {
    return getCompanyIdByInstanceId(instanceId)
      .then((companyId) => {
        if (companyId != null) {
          console.info(`[WEBHOOK_TOKEN_FALLBACK] Aceito via instanceId registrado — ${req.method} ${req.path} | instanceId: ${instanceId.slice(0, 16)}…`)
          return next()
        }
        _reject(req, res, incoming)
      })
      .catch((err) => {
        console.error('[requireWebhookToken] Fallback instanceId:', err?.message || err)
        _reject(req, res, incoming)
      })
  }

  _reject(req, res, incoming)
}

function _reject(req, res, incoming) {
  const queryRecusado = req?._webhookQueryTokenRecusado === true
  const motivo = queryRecusado ? 'token_na_query_desabilitado' : (!incoming ? 'token_ausente' : 'token_invalido')
  req.webhookLogData = { status: 'rejected_token', error: motivo }
  const label = motivo === 'token_na_query_desabilitado'
    ? 'Token veio na QUERY e a query está desabilitada'
    : (motivo === 'token_ausente' ? 'Token ausente' : 'Token inválido')
  console.warn(`[WEBHOOK_REJECTED] ${label} — ${req.method} ${req.path} | IP: ${req.ip || '?'}`)
  if (queryRecusado) {
    // Autoexplicativo de propósito: o UltraMSG NÃO manda header, então esta recusa derruba o
    // recebimento do canal até alguém religar a chave (doc 33 §F1).
    console.warn('[WEBHOOK_REJECTED] 💡 A API do UltraMSG não envia header. Se este canal é UltraMSG, defina WEBHOOK_QUERY_TOKEN_ENABLED=true; a Whapi usa header e não precisa disso.')
  } else {
    console.warn('[WEBHOOK_REJECTED] 💡 Envie o token no header X-Webhook-Token (ou Authorization: Bearer <WHATSAPP_WEBHOOK_TOKEN>)')
  }

  res.status(401).json({ error: motivo === 'token_invalido' ? 'Token do webhook inválido' : 'Token do webhook ausente' })
}

module.exports = requireWebhookToken
module.exports.queryTokenNaQueryHabilitado = queryTokenNaQueryHabilitado
