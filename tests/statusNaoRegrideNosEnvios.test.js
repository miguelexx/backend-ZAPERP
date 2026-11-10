/**
 * Doc 29 §3 item 2 — STATUS NÃO PODE REGREDIR nas gravações pós-provedor.
 *
 * O ACK/eco do provedor pode chegar ANTES de o controller gravar o resultado do envio. Quando
 * isso acontece a linha já está em sent/delivered/read e a gravação do envio ("pending"/"sent")
 * rebaixava o tique — de forma PERMANENTE, porque o ACK que a corrigiria já foi consumido.
 *
 * Os caminhos de envio têm de passar pelo `gravarResultadoDoEnvio`, que condiciona o UPDATE a
 * `status IN (pending, sending, erro, failed)` e, quando a linha já avançou, grava só os ids
 * (perder o `whatsapp_id` aqui quebraria a correlação de ACK mais tarde).
 *
 * Sem a correção estes testes falham: o UPDATE sai sem filtro de status (`filtroStatus: false`).
 */

const mockAtualizacoes = []
let mockStatusAtualDaLinha

function mockNovaChain(table) {
  const ctx = { table, update: null, filtroStatus: false }
  const chain = {
    update(patch) {
      ctx.update = patch
      return chain
    },
    eq() { return chain },
    in(col, valores) {
      if (col === 'status') { ctx.filtroStatus = true; ctx.statusAceitos = valores }
      return chain
    },
    select() { return chain },
    maybeSingle: async () => ({ data: null, error: null }),
    then(resolve) {
      mockAtualizacoes.push({ ...ctx })
      // Simula a corrida: a linha já está adiante, logo o UPDATE condicional não casa nada.
      const jaAvancada = ctx.filtroStatus && !ctx.statusAceitos.includes(mockStatusAtualDaLinha)
      return Promise.resolve({ data: jaAvancada ? [] : [{ id: 55 }], error: null }).then(resolve)
    },
  }
  return chain
}

jest.mock('../config/supabase', () => ({
  from: (table) => {
    const chain = mockNovaChain(table)
    return {
      update: chain.update,
      select: () => {
        const q = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }
        return q
      },
    }
  },
}))

const { gravarResultadoDoEnvio, STATUS_AINDA_ABERTOS } = require('../services/chat/outbound/outboundResultPersistence')

beforeEach(() => {
  mockAtualizacoes.length = 0
  mockStatusAtualDaLinha = 'pending'
})

describe('doc 29 §3 item 2 — gravação pós-provedor é condicional', () => {
  test('a lista de status "ainda abertos" cobre pending/sending e as falhas reenviáveis', () => {
    expect(STATUS_AINDA_ABERTOS).toEqual(expect.arrayContaining(['pending', 'sending', 'erro', 'failed']))
    // Nenhum status já resolvido pode estar na lista — senão o UPDATE voltaria a rebaixar.
    for (const resolvido of ['sent', 'delivered', 'read', 'played']) {
      expect(STATUS_AINDA_ABERTOS).not.toContain(resolvido)
    }
  })

  test('linha ainda aberta: grava status + ids com o filtro de status aplicado', async () => {
    mockStatusAtualDaLinha = 'pending'
    const r = await gravarResultadoDoEnvio({
      company_id: 1, mensagem_id: 55, status: 'sent', status_mensagem: 'sent', whatsapp_id: 'WA-1',
    })
    expect(r.ok).toBe(true)
    expect(r.jaAvancada).toBeUndefined()
    expect(mockAtualizacoes[0].filtroStatus).toBe(true)
    expect(mockAtualizacoes[0].update).toMatchObject({ status: 'sent', whatsapp_id: 'WA-1' })
  })

  test('ACK chegou primeiro (delivered): o status NÃO é rebaixado e o id é preservado', async () => {
    mockStatusAtualDaLinha = 'delivered'
    const r = await gravarResultadoDoEnvio({
      company_id: 1, mensagem_id: 55, status: 'pending', status_mensagem: 'sending', whatsapp_id: 'WA-1',
    })
    expect(r.jaAvancada).toBe(true)
    // 1ª tentativa condicionada (não casou) + 2ª gravando SÓ os ids.
    expect(mockAtualizacoes).toHaveLength(2)
    expect(mockAtualizacoes[1].update).toEqual({ whatsapp_id: 'WA-1' })
    expect(mockAtualizacoes[1].update.status).toBeUndefined()
  })
})

describe('doc 29 §3 item 2 — os caminhos de envio usam o helper (sem UPDATE cru de status)', () => {
  const fs = require('fs')
  const path = require('path')

  const alvos = [
    ['outboundController.js', 5],
    ['forwardController.js', 1],
    ['pixController.js', 1],
    ['retryController.js', 1],
  ]

  test.each(alvos)('%s grava o resultado do envio via gravarResultadoDoEnvio', (arquivo, minimo) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'chat', arquivo), 'utf8')
    expect(src).toContain("require('../../services/chat/outbound/outboundResultPersistence')")
    const usos = src.match(/gravarResultadoDoEnvio\(\{/g) || []
    expect(usos.length).toBeGreaterThanOrEqual(minimo)
  })

  test.each([
    'outboundController.js',
    'forwardController.js',
    'pixController.js',
    'retryController.js',
    'textMessageController.js',
    'mediaMessageController.js',
  ])('%s não tem UPDATE de status pós-provedor sem guarda', (arquivo) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'chat', arquivo), 'utf8')
    // `status: nextStatus` só aparecia nos UPDATEs incondicionais; o payload de socket usa
    // `status: nextStatus` dentro de emits, que não têm `.from('mensagens')` antes.
    const updatesCrus = src.match(/from\('mensagens'\)\s*\n?\s*\.update\(\{[^}]*status:\s*nextStatus/g) || []
    expect(updatesCrus).toEqual([])
  })
})
