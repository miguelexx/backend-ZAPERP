function isMissingTableError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('does not exist') ||
    msg.includes('relation') ||
    msg.includes('schema cache') ||
    msg.includes('permission denied')
  )
}

function duplicateKeyError(error) {
  const msg = String(error?.message || '').toLowerCase()
  return error?.code === '23505' || msg.includes('duplicate key') || msg.includes('violates unique constraint')
}

module.exports = {
  isMissingTableError,
  duplicateKeyError,
}
