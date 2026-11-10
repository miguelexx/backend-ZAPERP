/**
 * Doc 29 §3 item 6 — consultas repetidas no caminho quente do inbound.
 *
 * Cobre as partes SEM mudança de semântica:
 *  1. `helpers/shortTtlCache` — contrato do cache (chave com company_id, falha não cacheada,
 *     coalescing, teto + varredura, invalidação por empresa);
 *  2. `whatsapp_instances` — as leituras que `resolveConfig` faz em TODO envio passam a ser
 *     cacheadas, com `includeCredentials` na chave e invalidação nos mutadores;
 *  3. a dedup por whatsapp_id não roda mais 2× quando a primeira achou a linha.
 */

describe('helpers/shortTtlCache — contrato', () => {
  const { create } = require('../helpers/shortTtlCache')

  test('exige nome (prefixo da chave)', () => {
    expect(() => create({})).toThrow(/name/)
  })

  test('mesma empresa reaproveita; empresa diferente NÃO (isolamento app-layer)', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => ++n
    expect(await c.wrap(1, 'k', loader)).toBe(1)
    expect(await c.wrap(1, 'k', loader)).toBe(1)
    expect(await c.wrap(2, 'k', loader)).toBe(2)
    expect(await c.wrap(2, 'k', loader)).toBe(2)
  })

  test('sufixo diferente é entrada diferente', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => ++n
    expect(await c.wrap(1, 'a', loader)).toBe(1)
    expect(await c.wrap(1, 'b', loader)).toBe(2)
  })

  test('company_id inválido NÃO cacheia (nunca uma chave compartilhada entre empresas)', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => ++n
    expect(await c.wrap(null, 'k', loader)).toBe(1)
    expect(await c.wrap(null, 'k', loader)).toBe(2)
    expect(c.size()).toBe(0)
  })

  test('falha NÃO é cacheada — a chamada seguinte reconsulta', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => { n += 1; throw new Error('db caiu') }
    await expect(c.wrap(1, 'k', loader)).rejects.toThrow('db caiu')
    await expect(c.wrap(1, 'k', loader)).rejects.toThrow('db caiu')
    expect(n).toBe(2)
    expect(c.size()).toBe(0)
  })

  test('coalescing: chamadas concorrentes partilham UMA execução', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => { n += 1; await new Promise((r) => setTimeout(r, 10)); return n }
    const [a, b, d] = await Promise.all([c.wrap(1, 'k', loader), c.wrap(1, 'k', loader), c.wrap(1, 'k', loader)])
    expect(n).toBe(1)
    expect([a, b, d]).toEqual([1, 1, 1])
  })

  test('TTL expira', async () => {
    const c = create({ name: 'x', ttlMs: 20 })
    let n = 0
    const loader = async () => ++n
    expect(await c.wrap(1, 'k', loader)).toBe(1)
    await new Promise((r) => setTimeout(r, 35))
    expect(await c.wrap(1, 'k', loader)).toBe(2)
  })

  test('teto de entradas: a varredura descarta o excedente (sem leak)', async () => {
    const c = create({ name: 'x', ttlMs: 5000, max: 3 })
    for (let i = 1; i <= 10; i += 1) await c.wrap(i, 'k', async () => i)
    expect(c.size()).toBe(10)
    c._prune()
    expect(c.size()).toBe(3)
  })

  test('invalidate(company) derruba as entradas daquela empresa, só dela', async () => {
    const c = create({ name: 'x', ttlMs: 5000 })
    let n = 0
    const loader = async () => ++n
    await c.wrap(1, 'a', loader)
    await c.wrap(1, 'b', loader)
    await c.wrap(2, 'a', loader)
    c.invalidate(1)
    expect(c.size()).toBe(1)
    expect(await c.wrap(2, 'a', loader)).toBe(3) // empresa 2 intacta
  })
})

describe('whatsapp_instances — leitura cacheada do caminho de envio', () => {
  let svc
  let consultas

  beforeEach(() => {
    jest.resetModules()
    consultas = []
    jest.doMock('../config/supabase', () => ({
      from: (table) => {
        const ctx = { table, filtros: {} }
        const q = {
          select: (cols) => { ctx.cols = cols; return q },
          eq: (c, v) => { ctx.filtros[c] = v; return q },
          order: () => q,
          limit: () => q,
          maybeSingle: async () => {
            consultas.push(ctx)
            return {
              data: {
                id: 7,
                company_id: ctx.filtros.company_id,
                provider: 'ultramsg',
                ativo: true,
                is_default: true,
                instance_id: 'inst',
                instance_token: 'tkn',
              },
              error: null,
            }
          },
        }
        return q
      },
    }))
    svc = require('../services/whatsappInstanceService')
  })

  afterEach(() => { jest.resetModules(); jest.restoreAllMocks() })

  test('a 2a leitura da MESMA instância não vai ao banco', async () => {
    await svc.getWhatsappInstanceById(1, 7)
    const depoisDaPrimeira = consultas.length
    expect(depoisDaPrimeira).toBeGreaterThan(0)
    await svc.getWhatsappInstanceById(1, 7)
    expect(consultas.length).toBe(depoisDaPrimeira)
  })

  test('empresa diferente consulta de novo (nunca serve linha de outra empresa)', async () => {
    const a = await svc.getWhatsappInstanceById(1, 7)
    const b = await svc.getWhatsappInstanceById(2, 7)
    expect(a.instance.company_id).toBe(1)
    expect(b.instance.company_id).toBe(2)
  })

  test('includeCredentials faz parte da chave: leitura pública não recebe o token', async () => {
    const pub = await svc.getWhatsappInstanceById(1, 7, { includeCredentials: false })
    const priv = await svc.getWhatsappInstanceById(1, 7, { includeCredentials: true })
    expect(pub.instance.instance_token).toBeUndefined()
    expect(priv.instance.instance_token).toBe('tkn')
  })

  test('o objeto devolvido é uma CÓPIA — mutar não envenena o cache', async () => {
    const a = await svc.getWhatsappInstanceById(1, 7)
    a.instance.ativo = false
    const b = await svc.getWhatsappInstanceById(1, 7)
    expect(b.instance.ativo).toBe(true)
  })

  test('invalidateWhatsappInstanceCache força nova leitura', async () => {
    await svc.getWhatsappInstanceById(1, 7)
    const antes = consultas.length
    svc.invalidateWhatsappInstanceCache(1)
    await svc.getWhatsappInstanceById(1, 7)
    expect(consultas.length).toBeGreaterThan(antes)
  })

  test('os mutadores invalidam o cache (token novo não fica preso por um TTL)', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappInstanceService.js'), 'utf8')
    for (const fn of ['createWhatsappInstance', 'updateWhatsappInstance', 'setDefaultWhatsappInstance']) {
      const inicio = src.indexOf('async function ' + fn + '(')
      expect(inicio).toBeGreaterThan(-1)
      const resto = src.slice(inicio + 10)
      const proximo = resto.indexOf('\nasync function ')
      const corpo = proximo > 0 ? resto.slice(0, proximo) : resto
      expect(corpo).toContain('invalidateWhatsappInstanceCache(cid)')
    }
  })
})

describe('dedup por whatsapp_id não roda 2x no inbound', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'webhookZapiController.js'), 'utf8')

  test('a guarda de reentrega busca o select completo (para dar o que reaproveitar)', () => {
    const marca = "context: 'received.preprocess.idempotency'"
    const fim = src.indexOf(marca)
    expect(fim).toBeGreaterThan(-1)
    const bloco = src.slice(Math.max(0, fim - 600), fim)
    expect(bloco).toContain('select: WEBHOOK_MSG_SELECT')
  })

  test('a idempotência do insert reaproveita o HIT em vez de reconsultar', () => {
    expect(src).toContain('linhaJaProcessadaReentrega')
    const ini = src.indexOf('const reaproveitavel =')
    const fim = src.indexOf("context: 'received.idempotency'")
    expect(ini).toBeGreaterThan(-1)
    expect(fim).toBeGreaterThan(ini)
    const bloco = src.slice(ini, fim)
    expect(bloco).toContain('linhaJaProcessadaReentrega?.id')
    // O MISS continua consultando (proteção contra reentrega concorrente).
    expect(bloco).toContain('selectSingleMensagemByWhatsappId')
  })

  test('a flag de empresa do inbound é cacheada por company_id', () => {
    expect(src).toContain("_empresaFlagCache.wrap(company_id, 'separar_mensagens_disparadas'")
  })
})
