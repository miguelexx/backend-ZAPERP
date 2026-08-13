/**
 * Entrega de mídia armazenada no Cloudflare R2.
 *
 * GET /media/r2/<storage_key>
 *   -> 302 (redirect) para uma URL pré-assinada de curta duração do R2.
 *
 * O navegador segue o 302 e baixa direto do R2 (CDN da Cloudflare, egress zero,
 * suporte nativo a Range para <audio>/<video>). O backend não trafega os bytes.
 *
 * Modelo de segurança: idêntico ao /uploads atual — a chave contém um hex aleatório
 * no nome do arquivo (imutável e não-adivinhável). A rota é pública para permitir
 * <img src>/<audio src> (que não enviam Authorization), como o /uploads já é hoje.
 */

const { isR2Configured, getPresignExpiresSeconds } = require('../config/r2')
const { presignGetUrl } = require('../services/storage/r2Client')

exports.redirectToR2 = async (req, res) => {
  if (!isR2Configured()) {
    return res.status(503).json({ error: 'Armazenamento em nuvem indisponível' })
  }

  // Tudo após "/media/r2/" é a chave do objeto (contém barras).
  // Ex.: /media/r2/media/1/2026/08/imagem/arquivo.jpg
  let key = String(req.params[0] || '').trim()
  if (!key) return res.status(400).json({ error: 'Chave de mídia ausente' })

  // Normaliza barras iniciais e bloqueia traversal.
  key = key.replace(/^\/+/, '')
  if (key.includes('..')) return res.status(400).json({ error: 'Chave inválida' })
  // O rollout só grava chaves sob "media/". Recusa qualquer outra forma.
  if (!key.startsWith('media/')) return res.status(400).json({ error: 'Chave inválida' })

  try {
    const url = presignGetUrl(key, getPresignExpiresSeconds())
    // Cache curto do próprio redirect; o objeto no R2 é imutável (nome com hex).
    res.setHeader('Cache-Control', 'private, max-age=60')
    return res.redirect(302, url)
  } catch (e) {
    console.error('[mediaR2] presign falhou:', e?.message || e)
    return res.status(502).json({ error: 'Não foi possível gerar o acesso à mídia' })
  }
}
