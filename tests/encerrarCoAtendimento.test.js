/**
 * encerrarCoAtendimentoDaConversa — co-atendimento pertence a UM atendimento.
 * Sem isto os co-atendentes ficavam ativos para sempre e reapareciam na Minha fila deles
 * quando o mesmo cliente voltava e outra pessoa assumia.
 */
jest.mock('../config/supabase', () => ({ from: jest.fn() }))

const supabase = require('../config/supabase')
const { encerrarCoAtendimentoDaConversa } = require('../services/chat/access/conversationVisibilityService')

function chain(result) {
  const q = {}
  for (const m of ['eq', 'select', 'update']) q[m] = jest.fn(() => q)
  q.then = (ok, fail) => Promise.resolve(result).then(ok, fail)
  return q
}

beforeEach(() => jest.clearAllMocks())

test('desativa só os co-atendentes ativos da conversa, da empresa certa, com auditoria', async () => {
  const q = chain({ data: [{ id: 1 }, { id: 2 }], error: null })
  supabase.from.mockReturnValueOnce(q)
  const total = await encerrarCoAtendimentoDaConversa({ company_id: 7, conversa_id: 55, removido_por: 3 })
  expect(total).toBe(2)
  expect(supabase.from).toHaveBeenCalledWith('conversa_atendentes')
  expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ ativo: false, removido_por: 3, removido_em: expect.any(String) }))
  expect(q.eq).toHaveBeenCalledWith('company_id', 7)
  expect(q.eq).toHaveBeenCalledWith('conversa_id', 55)
  expect(q.eq).toHaveBeenCalledWith('ativo', true)
})

test('instalação sem colunas de auditoria: desativa sem elas', async () => {
  const semColuna = chain({ data: null, error: { message: 'column "removido_em" does not exist' } })
  const simples = chain({ data: [{ id: 1 }], error: null })
  supabase.from.mockReturnValueOnce(semColuna).mockReturnValueOnce(simples)
  const total = await encerrarCoAtendimentoDaConversa({ company_id: 7, conversa_id: 55 })
  expect(total).toBe(1)
  expect(simples.update).toHaveBeenCalledWith({ ativo: false })
})

test('nunca lança (o atendimento já foi gravado)', async () => {
  supabase.from.mockImplementationOnce(() => { throw new Error('rede') })
  await expect(encerrarCoAtendimentoDaConversa({ company_id: 7, conversa_id: 55 })).resolves.toBe(0)
  supabase.from.mockReturnValueOnce(chain({ data: null, error: { message: 'timeout' } }))
  await expect(encerrarCoAtendimentoDaConversa({ company_id: 7, conversa_id: 55 })).resolves.toBe(0)
})

test('sem empresa ou conversa não consulta nada', async () => {
  await expect(encerrarCoAtendimentoDaConversa({ company_id: null, conversa_id: 55 })).resolves.toBe(0)
  expect(supabase.from).not.toHaveBeenCalled()
})
