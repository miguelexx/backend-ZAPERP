const { getStatus, getQrCodeImage, restartInstance, getMe } = require('../services/zapiIntegrationService')

// Rate limit simples por empresa/endpoint em memória (complementar ao express-rate-limit global).
const perCompanyBuckets = new Map()

function checkCompanyRate(companyId, key, windowMs, max) {
  if (!companyId) return true
  const now = Date.now()
  const k = `${companyId}:${key}`
  let bucket = perCompanyBuckets.get(k)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    perCompanyBuckets.set(k, bucket)
  }
  if (bucket.count >= max) return false
  bucket.count += 1
  return true
}

exports.getStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'status', 60_000, 30)) {
    return res.status(429).json({ error: 'Muitas consultas de status, tente novamente em instantes.' })
  }
  const result = await getStatus(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(400).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json({
    connected: result.connected,
    smartphoneConnected: result.smartphoneConnected,
  })
}

exports.getQrCode = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'qrcode', 60_000, 10)) {
    return res.status(429).json({ error: 'Muitas solicitações de QR Code, tente novamente em instantes.' })
  }
  const result = await getQrCodeImage(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(400).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  if (result.alreadyConnected) {
    return res.json({ alreadyConnected: true })
  }
  return res.json({ imageBase64: result.imageBase64 })
}

exports.restart = async (req, res) => {
  const company_id = req.user?.company_id
  const result = await restartInstance(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(400).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json({ value: !!result.value })
}

exports.getMe = async (req, res) => {
  const company_id = req.user?.company_id
  const result = await getMe(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(400).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json(result.data || {})
}

