/**
 * Origem persistente de conversas do módulo Disparo/Campanhas.
 */

const {
  atendimentoHumanoAtivo,
  deveMarcarAguardandoCampanha,
  devePularChatbotPorCampanha,
  visivelNoFiltroCampanhas,
  visivelNaMinhaFilaQuantoACampanha,
  isMissingAguardandoCampanhaColumn,
} = require('../helpers/disparoConversaOrigem')

describe('disparoConversaOrigem — regras', () => {
  test('conversa nova ou aberta sem atendente deve ir para Campanhas', () => {
    expect(deveMarcarAguardandoCampanha(null)).toBe(true)
    expect(deveMarcarAguardandoCampanha({
      status_atendimento: 'aberta',
      atendente_id: null,
    })).toBe(true)
    expect(deveMarcarAguardandoCampanha({
      status_atendimento: 'fechada',
      atendente_id: 9,
    })).toBe(true)
  })

  test('atendimento humano ativo não é reclassificado', () => {
    expect(atendimentoHumanoAtivo({
      status_atendimento: 'em_atendimento',
      atendente_id: 7,
    })).toBe(true)
    expect(deveMarcarAguardandoCampanha({
      status_atendimento: 'em_atendimento',
      atendente_id: 7,
    })).toBe(false)
    expect(deveMarcarAguardandoCampanha({
      status_atendimento: 'aguardando_cliente',
      atendente_id: 7,
    })).toBe(false)
    expect(deveMarcarAguardandoCampanha({
      status_atendimento: 'aberta',
      atendente_id: 7,
    })).toBe(true)
  })

  test('grupo e envio manual não entram no filtro Campanhas', () => {
    expect(deveMarcarAguardandoCampanha({ tipo: 'grupo' })).toBe(false)
    expect(visivelNoFiltroCampanhas({
      aguardando_resposta_campanha: true,
      tipo: 'grupo',
    })).toBe(false)
    expect(visivelNoFiltroCampanhas({
      aguardando_resposta_campanha: false,
      status_atendimento: 'aberta',
    })).toBe(false)
  })

  test('chatbot só é pulado com flag persistente, nunca pelo texto', () => {
    expect(devePularChatbotPorCampanha({
      aguardando_resposta_campanha: true,
    })).toBe(true)
    expect(devePularChatbotPorCampanha({
      aguardando_resposta_campanha: false,
    })).toBe(false)
    expect(devePularChatbotPorCampanha({
      aguardando_resposta_campanha: true,
      tipo: 'grupo',
    })).toBe(false)
  })

  test('após responder, some de Campanhas e fica aberta na fila', () => {
    const aguardando = { aguardando_resposta_campanha: true, status_atendimento: 'aberta' }
    expect(visivelNoFiltroCampanhas(aguardando)).toBe(true)
    expect(visivelNaMinhaFilaQuantoACampanha(aguardando)).toBe(false)

    const respondeu = { aguardando_resposta_campanha: false, status_atendimento: 'aberta', atendente_id: null }
    expect(visivelNoFiltroCampanhas(respondeu)).toBe(false)
    expect(visivelNaMinhaFilaQuantoACampanha(respondeu)).toBe(true)
  })

  test('empresas/instâncias diferentes não compartilham a flag', () => {
    const a = { company_id: 1, aguardando_resposta_campanha: true }
    const b = { company_id: 2, aguardando_resposta_campanha: false }
    expect(visivelNoFiltroCampanhas(a)).toBe(true)
    expect(visivelNoFiltroCampanhas(b)).toBe(false)
  })

  test('detecta coluna ausente sem derrubar o webhook', () => {
    expect(isMissingAguardandoCampanhaColumn({ code: 'PGRST204', message: 'column' })).toBe(true)
    expect(isMissingAguardandoCampanhaColumn({
      message: 'Could not find the aguardando_resposta_campanha column',
    })).toBe(true)
    expect(isMissingAguardandoCampanhaColumn({ message: 'timeout' })).toBe(false)
  })
})
