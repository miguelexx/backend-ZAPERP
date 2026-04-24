/**
 * Sincronização progressiva de contatos — delega para contactSyncService (lock + checkpoint tipo contact_sync).
 */

const {
  runContactSyncBatch,
  runContactSyncFull,
  tryAcquireLock,
  releaseLock,
  getCheckpoint,
  resetCheckpoint
} = require('./contactSyncService')

module.exports = {
  syncContactsProgressiva: runContactSyncBatch,
  syncContactsFullProgressiva: runContactSyncFull,
  acquireLock: tryAcquireLock,
  releaseLock,
  getCheckpoint,
  resetCheckpoint
}
