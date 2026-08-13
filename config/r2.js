/**
 * Configuração do Cloudflare R2 (armazenamento de mídia em nuvem).
 *
 * Rollout controlado: por padrão SOMENTE a empresa company_id = 1 usa o R2.
 * Todas as demais continuam no fluxo antigo (disco /uploads) sem qualquer alteração.
 *
 * Nada aqui derruba o método antigo: se o R2 não estiver configurado no .env,
 * empresaUsaR2() sempre retorna false e o sistema inteiro segue em disco.
 *
 * Variáveis de ambiente (todas lidas do .env):
 *   R2_ACCOUNT_ID        - ID da conta Cloudflare (compõe o endpoint)
 *   R2_ACCESS_KEY_ID     - Access Key do token R2 (escopo mínimo, por bucket)
 *   R2_SECRET_ACCESS_KEY - Secret do token R2
 *   R2_BUCKET            - Nome do bucket do ambiente (ex.: zaperp-media-prod)
 *   R2_ENDPOINT          - (opcional) sobrescreve o endpoint padrão do R2
 *   R2_COMPANY_IDS       - (opcional) CSV de company_id habilitados. Default: "1"
 *   R2_PRESIGN_EXPIRES_SECONDS - (opcional) validade da URL assinada (default 900s = 15min)
 *   R2_DELETE_LOCAL_AFTER_MIRROR - (opcional) "1" apaga o arquivo local após espelhar (default: mantém)
 */

function trimEnv(name) {
  return String(process.env[name] || '').trim()
}

function getR2Config() {
  const accountId = trimEnv('R2_ACCOUNT_ID')
  const accessKeyId = trimEnv('R2_ACCESS_KEY_ID')
  const secretAccessKey = trimEnv('R2_SECRET_ACCESS_KEY')
  const bucket = trimEnv('R2_BUCKET')
  const endpointOverride = trimEnv('R2_ENDPOINT')

  const endpoint =
    endpointOverride ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    // R2 usa a região fixa "auto" para o protocolo S3-compatível.
    region: 'auto',
    service: 's3',
  }
}

/**
 * R2 só é considerado configurado quando TODAS as credenciais essenciais existem.
 * Sem isso, empresaUsaR2() retorna false e o backend inteiro permanece em disco.
 */
function isR2Configured() {
  const cfg = getR2Config()
  return Boolean(cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket && cfg.endpoint)
}

/** company_id habilitados para R2. Default: apenas a empresa 1. */
function getR2CompanyIds() {
  const raw = trimEnv('R2_COMPANY_IDS')
  if (!raw) return new Set([1])
  const ids = raw
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return new Set(ids.length ? ids : [1])
}

/**
 * Decide se uma empresa usa R2. É o único portão do rollout:
 * - R2 precisa estar configurado no .env, E
 * - o company_id precisa estar na lista habilitada (default: só 1).
 * Qualquer outra empresa cai no fluxo antigo (disco).
 */
function empresaUsaR2(company_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return false
  if (!isR2Configured()) return false
  return getR2CompanyIds().has(cid)
}

function getPresignExpiresSeconds() {
  const n = Number(trimEnv('R2_PRESIGN_EXPIRES_SECONDS'))
  if (!Number.isFinite(n) || n <= 0) return 900
  // R2 permite no máximo 7 dias (604800s) para presigned URLs.
  return Math.min(604800, Math.max(60, Math.floor(n)))
}

function deleteLocalAfterMirror() {
  return trimEnv('R2_DELETE_LOCAL_AFTER_MIRROR') === '1'
}

module.exports = {
  getR2Config,
  isR2Configured,
  getR2CompanyIds,
  empresaUsaR2,
  getPresignExpiresSeconds,
  deleteLocalAfterMirror,
}
