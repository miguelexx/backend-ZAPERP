/**
 * Domínios/paths permitidos para fetch de mídia inbound (proxy e persistência local).
 * Mantém alinhado com mediaProxyController — evita SSRF para IPs privados.
 */

/**
 * Domínios WhatsApp/Facebook CDN que podem hospedar mídia recebida via UltraMsg/Z-API.
 * Suporta wildcards no formato "*.dominio.tld" — o host deve terminar com ".dominio.tld".
 */
const WHATSAPP_FACEBOOK_CDN_PATTERNS = [
  // WhatsApp media servers (mmg, pps, v1..v99.fna, etc.)
  '*.whatsapp.net',
  'whatsapp.net',
  // Facebook CDN (fotos de perfil, stickers, mídia via Graph)
  '*.fbcdn.net',
  'fbcdn.net',
  // Facebook storage (lookaside.fbsbx.com e afins)
  '*.fbsbx.com',
  'fbsbx.com',
  // WhatsApp web static (stickers, emojis)
  '*.whatsapp.com',
]

/**
 * Verifica se o host bate em algum padrão da lista acima.
 * Padrão "*.dominio.tld" → host termina com ".dominio.tld" (subdomínio obrigatório).
 * Padrão sem "*" → match exato.
 */
function matchesCdnPattern(host) {
  for (const pattern of WHATSAPP_FACEBOOK_CDN_PATTERNS) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".dominio.tld"
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true
    } else {
      if (host === pattern) return true
    }
  }
  return false
}

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

  // WhatsApp / Facebook CDN — incluem mmg.whatsapp.net, *.fna.whatsapp.net, *.fbcdn.net, etc.
  if (matchesCdnPattern(host)) return true

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

  // MEDIA_PROXY_EXTRA_HOSTS: suporta wildcards no formato "*.dominio.tld" além de match exato.
  const extra = String(process.env.MEDIA_PROXY_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const entry of extra) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".dominio.tld"
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true
    } else {
      if (host === entry) return true
    }
  }

  return false
}

module.exports = { isAllowedInboundMediaUrl }
