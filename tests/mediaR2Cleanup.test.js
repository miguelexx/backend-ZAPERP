const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Credenciais R2 para isR2Configured() = true (o teste não faz rede: cleanup só mexe em disco + DB mock).
process.env.R2_ACCOUNT_ID = 'acc123'
process.env.R2_ACCESS_KEY_ID = 'AKIAEXAMPLE'
process.env.R2_SECRET_ACCESS_KEY = 'secretexample'
process.env.R2_BUCKET = 'bucket-test'
delete process.env.R2_KEEP_LOCAL

const svc = require('../services/mediaR2MirrorService')

/** Mock encadeável do supabase: select→{data:rows}, update→{error:null} (registra o patch). */
function makeSupabase(rows) {
  const updateCalls = []
  const supabase = {
    updateCalls,
    from() {
      return {
        select() {
          const qb = {}
          for (const m of ['in', 'eq', 'like', 'lt', 'order', 'limit']) qb[m] = () => qb
          qb.then = (res) => Promise.resolve({ data: rows, error: null }).then(res)
          return qb
        },
        update(patch) {
          updateCalls.push(patch)
          const qb = {}
          qb.eq = () => qb
          qb.then = (res) => Promise.resolve({ error: null }).then(res)
          return qb
        },
      }
    },
  }
  return supabase
}

test('runR2LocalCleanup: purga o arquivo local e zera url_legado', async () => {
  svc._test.resetColunasFlag()

  // Diretório de uploads temporário + arquivo de staging.
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-uploads-'))
  process.env.UPLOADS_DIR = uploadsDir
  const filename = 'inbound-c1-m777-abc123.jpg'
  const abs = path.join(uploadsDir, filename)
  fs.writeFileSync(abs, 'bytes-de-teste')
  assert.equal(fs.existsSync(abs), true)

  const supabase = makeSupabase([
    { id: 777, company_id: 1, url_legado: `/uploads/${filename}` },
  ])

  const out = await svc.runR2LocalCleanup(supabase)

  assert.equal(out.checked, 1)
  assert.equal(out.purged, 1)
  assert.equal(fs.existsSync(abs), false, 'arquivo local deve ter sido removido')
  assert.deepEqual(supabase.updateCalls, [{ url_legado: null }], 'url_legado deve ser zerado')

  try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (_) {}
})

test('runR2LocalCleanup: no-op com R2_KEEP_LOCAL=1 (mantém o local)', async () => {
  svc._test.resetColunasFlag()
  process.env.R2_KEEP_LOCAL = '1'
  try {
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-uploads-'))
    process.env.UPLOADS_DIR = uploadsDir
    const abs = path.join(uploadsDir, 'x.jpg')
    fs.writeFileSync(abs, 'x')

    const supabase = makeSupabase([{ id: 1, company_id: 1, url_legado: '/uploads/x.jpg' }])
    const out = await svc.runR2LocalCleanup(supabase)

    assert.equal(out.purged, 0)
    assert.equal(fs.existsSync(abs), true, 'com R2_KEEP_LOCAL o arquivo permanece')
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (_) {}
  } finally {
    delete process.env.R2_KEEP_LOCAL
  }
})

test('runR2LocalCleanup: não purga o arquivo de mídia espelhada há instantes (janela desde a troca)', async () => {
  svc._test.resetColunasFlag()
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-uploads-'))
  process.env.UPLOADS_DIR = uploadsDir
  const filename = 'inbound-c1-m888-recente.ogg'
  const abs = path.join(uploadsDir, filename)
  fs.writeFileSync(abs, 'bytes')

  const supabase = makeSupabase([{ id: 888, company_id: 1, url_legado: `/uploads/${filename}` }])

  svc._test.marcarEspelhadaAgora(888)
  const out = await svc.runR2LocalCleanup(supabase)
  assert.equal(out.purged, 0)
  assert.equal(fs.existsSync(abs), true, 'cliente ainda pode estar lendo o /uploads')

  // Passada a janela, a mesma varredura purga normalmente.
  svc._test.marcarEspelhadaAgora(888, Date.now() - 24 * 60 * 60 * 1000)
  const out2 = await svc.runR2LocalCleanup(supabase)
  assert.equal(out2.purged, 1)
  assert.equal(fs.existsSync(abs), false)
})

test('troca para o R2 é emitida para a sala da conversa E para os usuários que a enxergam', async () => {
  const gateway = require('../services/chat/realtime/chatRealtimeGateway')
  const original = gateway.emitirEventoConversaVisivel
  const chamadas = []
  gateway.emitirEventoConversaVisivel = async (...args) => { chamadas.push(args); return true }
  try {
    const salas = []
    const io = { to: (r) => { salas.push(r); return { emit() {} } } }
    svc._test.emitirMidiaAtualizada({
      io,
      company_id: 1,
      row: { conversa_id: 55, direcao: 'in' },
      updated: { id: 9, conversa_id: 55, direcao: 'in', url: '/media/r2/media/1/a.ogg', criado_em: '2026-10-09T12:00:00' },
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(chamadas.length, 1)
    const [, companyId, conversaId, evento, payload] = chamadas[0]
    assert.equal(companyId, 1)
    assert.equal(conversaId, 55)
    assert.equal(evento, 'nova_mensagem')
    assert.equal(payload.url, '/media/r2/media/1/a.ogg')
    assert.equal(payload.fromMe, false)
    assert.equal(salas.length, 0, 'sem fallback quando o gateway emitiu')
  } finally {
    gateway.emitirEventoConversaVisivel = original
  }
})
