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
    // UltraMsg costuma usar bucket/path ultramsgmedia; alguns deployments usam host com "ultramsg" no nome.
    if (pathname.includes('/ultramsgmedia/')) return true
    if (hn.startsWith('ultramsgmedia.')) return true
    if (hn.includes('ultramsg')) return true
    return false
  }

  // CDN comum em frente ao bucket (algumas contas UltraMsg)
  if (host.endsWith('.cloudfront.net') && String(u.pathname || '').toLowerCase().includes('ultramsg')) {
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
