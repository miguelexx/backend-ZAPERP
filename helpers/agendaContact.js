// A agenda aceita identidades telefônicas; LID, grupos e broadcasts não são telefones.
function agendaContactFields(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = [raw.name, raw.formattedName, raw.displayName, raw.short]
    .find((v) => typeof v === 'string' && v.trim())?.trim()
  if (!name || raw.isMyContact === false || raw.isGroup === true) return null
  const values = [raw.phone, raw.number, raw.wa_id, raw.id]
  for (const value of values) {
    const id = typeof value === 'object' && value
      ? (value._serialized || (value.user && value.server ? `${value.user}@${value.server}` : ''))
      : String(value || '').trim()
    if (!id || /lid|broadcast|group|newsletter|@g\.us/i.test(id)) continue
    if (id.includes('@') && !/^\d{10,15}@(c\.us|s\.whatsapp\.net)$/.test(id)) continue
    if (!id.includes('@') && !/^\+?[\d\s().-]+$/.test(id)) continue
    const phone = id.replace(/\D/g, '')
    if (phone.length < 10 || phone.length > 15) continue
    return { ...raw, phone: id, name }
  }
  return null
}

module.exports = { agendaContactFields }
