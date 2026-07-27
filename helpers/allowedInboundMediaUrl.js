/**
 * Domínios/paths permitidos para fetch de mídia inbound (proxy e persistência local).
 * Mantém alinhado com mediaProxyController — evita SSRF para IPs privados.
 */

/**
 * @param {URL} u
 * @returns {boolean}
 */
function isAllowedInboundMediaUrl(u) {
  if (!u || u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^169\.254\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    return false
  }

  // Previne proxy-of-proxy: rejeita URLs que apontam para o próprio endpoint /media/proxy.
  if (String(u.pathname || '').startsWith('/media/proxy')) return false

  if (host.endsWith('.amazonaws.com')) {
    const pathname = (u.pathname || '').toLowerCase()
    const hn = host.toLowerCase()
    // UltraMsg: bucket/path ultramsgmedia. Evita substring solta ("evil-ultramsg.s3...") — SSRF.
    if (pathname.includes('/ultramsgmedia/')) return true
    if (hn.startsWith('ultramsgmedia.')) return true
    // Bucket virtual-hosted: ultramsg*.s3[.region].amazonaws.com (não "*-ultramsg*")
    if (/^ultramsg[a-z0-9.-]*\.s3([.-][a-z0-9-]+)*\.amazonaws\.com$/.test(hn)) return true
    return false
  }

  // CDN comum em frente ao bucket (algumas contas UltraMsg)
  // Exige segmento de path ultramsgmedia (não substring genérica "ultramsg" em qualquer path).
  if (host.endsWith('.cloudfront.net') && String(u.pathname || '').toLowerCase().includes('/ultramsgmedia/')) {
    return true
  }

  // Domínios UltraMsg diretos (não-S3): files.ultramsg.com, media.ultramsg.com, etc.
  if (host === 'ultramsg.com' || host.endsWith('.ultramsg.com')) return true

  // WhatsApp/Meta media CDN: quando a mídia NÃO é rehospedada pela UltraMsg, a URL vem crua do
  // WhatsApp (ex.: mmg.whatsapp.net, media-*.cdn.whatsapp.net, *.fbcdn.net). Documentos costumam
  // cair nesse caso (imagens/áudio geralmente vêm rehospedados no S3 da UltraMsg). Hosts públicos.
  if (host === 'whatsapp.net' || host.endsWith('.whatsapp.net')) return true
  if (host.endsWith('.fbcdn.net')) return true

  const extra = String(process.env.MEDIA_PROXY_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (extra.length && extra.includes(host)) return true

  return false
}

module.exports = { isAllowedInboundMediaUrl }
