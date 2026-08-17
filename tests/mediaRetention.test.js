const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Não configura R2 no ambiente: expirarMensagem mocka r2.deleteObject e o passe de "desligado"
// retorna antes de checar R2. Assim este arquivo não vaza env para os demais testes.
const svc = require('../services/mediaRetentionService')
const r2 = require('../services/storage/r2Client')

test('resolveLocalPath: resolve /uploads e bloqueia traversal', () => {
  const ok = svc._test.resolveLocalPath('/uploads/foto.jpg')
  assert.ok(ok && ok.endsWith(`${path.sep}foto.jpg`))
  assert.equal(svc._test.resolveLocalPath('/uploads/../segredo.env'), null)
  assert.equal(svc._test.resolveLocalPath('/media/r2/media/1/x.jpg'), null)
  assert.equal(svc._test.resolveLocalPath(null), null)
})

test('runMediaRetentionSweep: no-op quando MEDIA_RETENTION_DAYS não definido (desligado)', async () => {
  delete process.env.MEDIA_RETENTION_DAYS
  const out = await svc.runMediaRetentionSweep({ from: () => { throw new Error('não deveria consultar') } })
  assert.deepEqual(out, { r2: 0, local: 0, erros: 0 })
})

test('expirarMensagem: apaga R2 + local e marca a mensagem como expirada', async () => {
  // Mocka o deleteObject do R2 (sem rede).
  const origDelete = r2.deleteObject
  let deletedKey = null
  r2.deleteObject = async (key) => { deletedKey = key; return { ok: true } }

  // Arquivo local de staging real.
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-ret-'))
  process.env.UPLOADS_DIR = uploadsDir
  const abs = path.join(uploadsDir, 'legado.jpg')
  fs.writeFileSync(abs, 'bytes')

  const updates = []
  const supabase = {
    from() {
      return {
        update(patch) { updates.push(patch); const qb = {}; qb.eq = () => qb; qb.then = (r) => Promise.resolve({ error: null }).then(r); return qb },
      }
    },
  }

  const row = {
    id: 99, company_id: 1, tipo: 'imagem',
    url: '/media/r2/media/1/2026/01/imagem/x.jpg',
    storage_backend: 'r2', storage_key: 'media/1/2026/01/imagem/x.jpg',
    url_legado: '/uploads/legado.jpg',
  }

  try {
    const ok = await svc._test.expirarMensagem(supabase, row)
    assert.equal(ok, true)
    assert.equal(deletedKey, 'media/1/2026/01/imagem/x.jpg', 'deve apagar o objeto no R2')
    assert.equal(fs.existsSync(abs), false, 'deve apagar o arquivo local de staging')
    assert.deepEqual(updates, [{
      url: null, storage_backend: 'expirado', storage_key: null, url_legado: null, texto: '(mídia expirada)',
    }], 'deve zerar referências e marcar como expirada, mantendo a mensagem')
  } finally {
    r2.deleteObject = origDelete
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (_) {}
  }
})

test('expirarMensagem: falha ao apagar no R2 NÃO marca expirada (retenta depois)', async () => {
  const origDelete = r2.deleteObject
  r2.deleteObject = async () => { throw new Error('403 auth') }

  const updates = []
  const supabase = {
    from() {
      return { update(patch) { updates.push(patch); const qb = {}; qb.eq = () => qb; qb.then = (r) => Promise.resolve({ error: null }).then(r); return qb } }
    },
  }
  const row = { id: 1, company_id: 1, tipo: 'imagem', url: '/media/r2/media/1/x.jpg', storage_backend: 'r2', storage_key: 'media/1/x.jpg', url_legado: null }

  try {
    const ok = await svc._test.expirarMensagem(supabase, row)
    assert.equal(ok, false, 'não deve marcar expirada se o R2 falhou')
    assert.deepEqual(updates, [], 'não deve atualizar o banco')
  } finally {
    r2.deleteObject = origDelete
  }
})
