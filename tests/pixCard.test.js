const {
  buildPixMessageFromConfig,
  buildPixReplyMeta,
  buildPixInteractivePayload,
  PIX_COPY_BUTTON_LABEL,
} = require('../services/chat/outbound/pixConfig')

const CFG = {
  tipo_chave: 'cnpj',
  chave_pix: '15439535000130',
  nome_recebedor: 'Nova Suprema',
  mensagem_padrao: 'Envie o comprovante, por favor.',
}

describe('Pix — cartão nativo (Whapi copy button)', () => {
  test('buildPixInteractivePayload monta botão copy com a chave em copy_code', () => {
    const p = buildPixInteractivePayload(CFG)
    expect(p.type).toBe('button')
    expect(p.action.buttons).toHaveLength(1)
    const btn = p.action.buttons[0]
    expect(btn.type).toBe('copy')
    expect(btn.copy_code).toBe('15439535000130')
    expect(btn.title).toBe(PIX_COPY_BUTTON_LABEL)
    // O corpo traz a chave por extenso (robusto se o botão não copiar no aparelho).
    expect(p.body).toContain('15439535000130')
    expect(p.body).toContain('Nova Suprema')
  })

  test('buildPixReplyMeta expõe os campos usados pela bolha do CRM', () => {
    const { pix } = buildPixReplyMeta(CFG)
    expect(pix.chave_pix).toBe('15439535000130')
    expect(pix.nome_recebedor).toBe('Nova Suprema')
    expect(pix.tipo_label).toBe('CNPJ')
    expect(pix.mensagem_padrao).toBe('Envie o comprovante, por favor.')
    expect(pix.copy_label).toBe(PIX_COPY_BUTTON_LABEL)
  })

  test('sem mensagem_padrao → meta.mensagem_padrao é null e corpo não quebra', () => {
    const { pix } = buildPixReplyMeta({ ...CFG, mensagem_padrao: '' })
    expect(pix.mensagem_padrao).toBeNull()
    expect(buildPixMessageFromConfig({ ...CFG, mensagem_padrao: '' })).toContain('Chave Pix: 15439535000130')
  })
})
