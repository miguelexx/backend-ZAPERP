/**
 * Triagem Interativa Whapi — renderer (Seam A) + resolver (Seam B), funções puras.
 * Sem DB nem rede. Prova: id UUID estável casa independente do label; poll casa por label;
 * modos poll/list/button montam o payload certo. Ver doc 26.
 */

const renderer = require('../services/whapiTriage/whapiTriageRenderer')

function cfg(overrides = {}) {
  return {
    enabled: true,
    mode: 'list',
    body_text: 'Selecione o setor desejado.',
    button_label: 'Selecionar setor',
    header_text: null,
    footer_text: null,
    confirm_message: null,
    fallback_to_text: true,
    options: [
      { id: 'uuid-fin', label: 'Financeiro', departamento_id: 5, tag_id: null, ordem: 0, active: true },
      { id: 'uuid-sup', label: 'Suporte', departamento_id: 7, tag_id: null, ordem: 1, active: true },
      { id: 'uuid-off', label: 'Desativado', departamento_id: 9, tag_id: null, ordem: 2, active: false },
    ],
    ...overrides,
  }
}

describe('whapiTriageRenderer', () => {
  test('buildInteractivePayload (list) usa id UUID estável nas rows e ignora inativas', () => {
    const p = renderer.buildInteractivePayload(cfg({ mode: 'list' }))
    expect(p.type).toBe('list')
    expect(p.action.list.label).toBe('Selecionar setor')
    expect(p.action).not.toHaveProperty('label')
    expect(p.body).toBe('Selecione o setor desejado.') // string; provider.sendInteractive normaliza p/ {text}
    const rows = p.action.list.sections[0].rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'uuid-fin', title: 'Financeiro' })
    expect(rows.map((r) => r.id)).not.toContain('uuid-off')
  })

  test('buildTriageReplyMeta espelha lista e botões no ZapERP', () => {
    expect(renderer.buildTriageReplyMeta(cfg()).whapi_triage.button_label).toBe('Selecionar setor')
    expect(renderer.buildTriageReplyMeta(cfg({ mode: 'list' })).whapi_triage.options)
      .toEqual([{ id: 'uuid-fin', title: 'Financeiro' }, { id: 'uuid-sup', title: 'Suporte' }])
    expect(renderer.buildTriageReplyMeta(cfg({ mode: 'button' })).whapi_triage.options)
      .toEqual([{ id: 'uuid-fin', title: 'Financeiro' }, { id: 'uuid-sup', title: 'Suporte' }])
    const pollMeta = renderer.buildTriageReplyMeta(cfg({ mode: 'poll' }))
    expect(pollMeta.poll).toMatchObject({ title: 'Selecione o setor desejado.', count: 1 })
    expect(pollMeta.whapi_triage.options).toHaveLength(2)
  })

  test('buildInteractivePayload (button) limita a 3 e usa quick_reply', () => {
    const p = renderer.buildInteractivePayload(cfg({
      mode: 'button',
      options: [
        { id: 'a', label: 'A', departamento_id: 1, ordem: 0, active: true },
        { id: 'b', label: 'B', departamento_id: 2, ordem: 1, active: true },
        { id: 'c', label: 'C', departamento_id: 3, ordem: 2, active: true },
        { id: 'd', label: 'D', departamento_id: 4, ordem: 3, active: true },
      ],
    }))
    expect(p.type).toBe('button')
    expect(p.action.buttons).toHaveLength(3)
    expect(p.action.buttons[0]).toMatchObject({ type: 'quick_reply', id: 'a', title: 'A' })
  })

  test('buildPollPayload desambigua labels repetidos e mantém ordem', () => {
    const p = renderer.buildPollPayload(cfg({
      options: [
        { id: 'x', label: 'Vendas', departamento_id: 1, ordem: 0, active: true },
        { id: 'y', label: 'Vendas', departamento_id: 2, ordem: 1, active: true },
      ],
    }))
    expect(p.count).toBe(1)
    expect(p.options).toEqual(['Vendas', 'Vendas (2)'])
  })
})

describe('whapiTriageService.resolveSelectedOption (Seam B)', () => {
  let resolveSelectedOption
  beforeAll(() => {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({}))
    jest.doMock('../services/chatbotTriageService', () => ({
      transferToDepartment: jest.fn(),
      logBotAction: jest.fn(),
      wasMenuSentForConversa: jest.fn(),
      wasOptionSelectedForConversa: jest.fn(),
    }))
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../helpers/whatsappMessageIdHelper', () => ({ isRealWhatsAppId: () => true }))
    resolveSelectedOption = require('../services/whapiTriage/whapiTriageService').resolveSelectedOption
  })
  afterAll(() => jest.resetModules())

  test('casa por interactiveReplyId (id estável) mesmo com label divergente', () => {
    const opt = resolveSelectedOption({ interactiveReplyId: 'uuid-sup', interactiveReplyTitle: 'Texto Trocado' }, cfg())
    expect(opt?.departamento_id).toBe(7)
  })

  test('casa por título quando não há id', () => {
    const opt = resolveSelectedOption({ interactiveReplyTitle: 'financeiro' }, cfg())
    expect(opt?.id).toBe('uuid-fin')
  })

  test('casa voto de enquete por label (inclui desambiguado)', () => {
    const c = cfg({
      mode: 'poll',
      options: [
        { id: 'x', label: 'Vendas', departamento_id: 1, ordem: 0, active: true },
        { id: 'y', label: 'Vendas', departamento_id: 2, ordem: 1, active: true },
      ],
    })
    expect(resolveSelectedOption({ pollVoteOptions: ['Vendas (2)'] }, c)?.departamento_id).toBe(2)
    expect(resolveSelectedOption({ pollVoteOptions: ['Vendas'] }, c)?.departamento_id).toBe(1)
  })

  test('não casa opção inativa nem texto livre', () => {
    expect(resolveSelectedOption({ interactiveReplyId: 'uuid-off' }, cfg())).toBeNull()
    expect(resolveSelectedOption({ interactiveReplyTitle: 'qualquer coisa' }, cfg())).toBeNull()
  })
})
