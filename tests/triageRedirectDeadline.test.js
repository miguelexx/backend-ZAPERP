jest.mock('../services/chatbotTriageService', () => ({
  DEFAULT_CHATBOT_CONFIG: {},
  transferToDepartment: jest.fn().mockResolvedValue({ ok: true, departamento_id: 5 }),
  logBotAction: jest.fn(),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({ emitirMudancaSetorRealtime: jest.fn() }))

const supabase = require('../config/supabase')
const { transferToDepartment } = require('../services/chatbotTriageService')
const { redirectConversasByNoResponse } = require('../services/triageRedirectService')

function setup(logs, { recentQueryError = false } = {}) {
  supabase.from.mockImplementation((table) => {
    let filters = [], recent = false
    const q = {}
    for (const method of ['select', 'order', 'limit']) q[method] = () => q
    q.eq = q.is = (k, v) => { filters.push((r) => r[k] === v); return q }
    q.in = (k, vs) => { filters.push((r) => vs.includes(r[k])); return q }
    q.lt = (k, v) => { filters.push((r) => r[k] < v); return q }
    q.gte = (k, v) => { recent = true; filters.push((r) => r[k] >= v); return q }
    q.then = (resolve, reject) => {
      let rows = []
      if (table === 'ia_config') rows = [{ company_id: 77, config: { chatbot_triage: {
        enabled: true, redirecionar_sem_resposta_ativo: true,
        redirecionar_sem_resposta_departamento_id: 5, redirecionar_sem_resposta_minutos: 5,
      } } }]
      if (table === 'bot_logs') rows = logs
      if (table === 'conversas') rows = [{ id: 901, company_id: 77, departamento_id: null, atendente_id: null, status_atendimento: 'aberta' }]
      return Promise.resolve(recent && recentQueryError
        ? { data: null, error: { message: 'indisponível' } }
        : { data: rows.filter((r) => filters.every((f) => f(r))) }).then(resolve, reject)
    }
    return q
  })
  transferToDepartment.mockClear()
}
function menu(ageMinutes, tipo = 'menu_enviado') {
  return { company_id: 77, conversa_id: 901, tipo, criado_em: new Date(Date.now() - ageMinutes * 60000).toISOString() }
}

test.each(['menu_enviado', 'menu_reenviado'])('aguarda prazo do último %s, mesmo havendo menu antigo', async (tipo) => {
  setup([menu(20), menu(1, tipo)])
  await redirectConversasByNoResponse(null)
  expect(transferToDepartment).not.toHaveBeenCalled()
})

test.each(['menu_enviado', 'menu_reenviado'])('continua redirecionando %s realmente vencido', async (tipo) => {
  setup([menu(20, tipo)])
  await redirectConversasByNoResponse(null)
  expect(transferToDepartment).toHaveBeenCalledTimes(1)
})

test('não redireciona quando falha a verificação de menu recente', async () => {
  setup([menu(20)], { recentQueryError: true })
  await redirectConversasByNoResponse(null)
  expect(transferToDepartment).not.toHaveBeenCalled()
})
