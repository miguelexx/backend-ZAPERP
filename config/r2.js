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
  // Default 1h: cobre a reprodução contínua de vídeos longos (as requisições de Range vão à mesma
  // URL assinada durante toda a sessão; se expirar no meio, o player recebe 403). Máx R2: 7 dias.
  const n = Number(trimEnv('R2_PRESIGN_EXPIRES_SECONDS'))
  if (!Number.isFinite(n) || n <= 0) return 3600
  return Math.min(604800, Math.max(60, Math.floor(n)))
}

/**
 * Empresas em R2 usam o R2 como armazenamento ÚNICO. O objeto é copiado para o bucket
 * imediatamente, mas o arquivo local de staging só é purgado depois de uma janela de
 * segurança — tempo para a UltraMSG terminar de baixar a mídia enviada por URL pública
 * (imagem/documento) sem quebrar a entrega. Depois disso, resta apenas o R2.
 * R2_KEEP_LOCAL=1 mantém a cópia local para sempre (transição/depuração).
 */
function keepLocalForever() {
  return trimEnv('R2_KEEP_LOCAL') === '1'
}

/** Janela antes de purgar o arquivo local de staging (default 5min; 0 explícito = purga imediata). */
function getLocalCleanupDelayMs() {
  const raw = trimEnv('R2_LOCAL_CLEANUP_DELAY_MINUTES')
  if (!raw) return 5 * 60 * 1000 // vazio = default (Number('') seria 0 e purgaria cedo demais)
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 5 * 60 * 1000
  return Math.min(24 * 60, n) * 60 * 1000
}

/**
 * Retenção de mídia: dias após a DATA DA MENSAGEM em que o ARQUIVO de mídia é apagado
 * (R2 e/ou disco), mantendo a mensagem no histórico (marcada como "mídia expirada").
 * 0 ou vazio = DESLIGADO (padrão seguro). Ex.: MEDIA_RETENTION_DAYS=60 (2 meses).
 */
function getMediaRetentionDays() {
  const raw = trimEnv('MEDIA_RETENTION_DAYS')
  if (!raw) return 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/** Intervalo da varredura de retenção (default 24h; mín 1h, máx 168h). */
function getMediaRetentionIntervalMs() {
  const n = Number(trimEnv('MEDIA_RETENTION_INTERVAL_HOURS'))
  if (!Number.isFinite(n) || n <= 0) return 24 * 60 * 60 * 1000
  return Math.min(168, Math.max(1, n)) * 60 * 60 * 1000
}

module.exports = {
  getR2Config,
  isR2Configured,
  getR2CompanyIds,
  empresaUsaR2,
  getPresignExpiresSeconds,
  keepLocalForever,
  getLocalCleanupDelayMs,
  getMediaRetentionDays,
  getMediaRetentionIntervalMs,
}
