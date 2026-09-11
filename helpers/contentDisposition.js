/**
 * Content-Disposition seguro para download/visualização de arquivos (/uploads e /media/proxy).
 *
 * Node recusa (ERR_INVALID_CHAR) qualquer caractere acima de U+00FF num header: nome com travessão
 * "—", aspas curvas “ ” ou emoji — comuns em arquivos vindos do WhatsApp/Word — derrubava a
 * resposta. Aqui o `filename=` leva só ASCII (fallback de navegador antigo) e o nome real vai em
 * `filename*=UTF-8''…` (RFC 5987/6266), que todos os navegadores atuais preferem.
 */

const path = require('path')

const MAX_FILENAME_CHARS = 180

/**
 * Nome exibido/salvo, vindo de query/DB (não confiável): basename, sem controle/aspas/separadores,
 * com teto de tamanho. Sem extensão → herda a do arquivo real (`fallbackExt`, ex. ".pdf").
 * @returns {string|null}
 */
function sanitizeDownloadFilename(name, { fallbackExt = '' } = {}) {
  let s = String(name ?? '')
  // basename manual: aceita "a/b\\c.pdf" vindo de qualquer SO.
  s = s.split(/[\\/]/).pop() || ''
  s = s.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim()
  // ".." / "." / nomes só com pontos não viram arquivo oculto nem traversal.
  s = s.replace(/^\.+/, '').trim()
  if (!s) return null

  const ext = String(fallbackExt || '').toLowerCase()
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(s)
  if (!hasExt && /^\.[a-z0-9]{1,8}$/.test(ext) && ext !== '.bin') s = `${s}${ext}`

  if (s.length > MAX_FILENAME_CHARS) {
    const m = s.match(/(\.[a-z0-9]{1,8})$/i)
    const tail = m ? m[1] : ''
    s = `${s.slice(0, MAX_FILENAME_CHARS - tail.length).trimEnd()}${tail}`
  }
  return s
}

/** Fallback ASCII para o parâmetro `filename=` (acentos viram letra base; o resto vira "_"). */
function asciiFallbackFilename(name) {
  const base = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim()
  return base || 'arquivo'
}

/**
 * @param {'inline'|'attachment'} type
 * @param {string} filename já sanitizado
 */
function buildContentDisposition(type, filename) {
  const disp = type === 'inline' ? 'inline' : 'attachment'
  const name = String(filename || '').trim()
  if (!name) return disp
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disp}; filename="${asciiFallbackFilename(name)}"; filename*=UTF-8''${encoded}`
}

/** Extensão (".pdf") do arquivo gravado em disco. */
function storedFileExt(filePath) {
  return path.extname(String(filePath || '')).toLowerCase()
}

module.exports = {
  sanitizeDownloadFilename,
  asciiFallbackFilename,
  buildContentDisposition,
  storedFileExt,
  MAX_FILENAME_CHARS,
}
