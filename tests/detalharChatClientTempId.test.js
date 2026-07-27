const fs = require('fs')
const path = require('path')

/**
 * A bolha otimista de áudio só funde com a linha confirmada quando há correlação explícita
 * por client_temp_id. Se o GET da conversa devolver as mensagens sem essa coluna, um refresh
 * logo depois do envio deixa a bolha otimista (pendente) ao lado da confirmada — o áudio
 * aparece duplicado no chat.
 */
describe('detalharChat: mensagens trazem client_temp_id', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../controllers/chatController.js'),
    'utf8'
  )

  test('o select paginado de mensagens inclui client_temp_id', () => {
    const selects = source.match(/const selectComRemetente = '[^']+'/g) || []
    expect(selects.length).toBeGreaterThan(0)
    const doDetalhe = selects.find((s) => s.includes('apagada_em'))
    expect(doDetalhe).toBeDefined()
    expect(doDetalhe).toContain('client_temp_id')
  })

  test('o fallback de compatibilidade continua reagindo a coluna inexistente', () => {
    // client_temp_id só existe após a migração 20260702090000; em banco antigo o select
    // primário falha e o código precisa cair no selectFallback.
    expect(source).toContain("includes('does not exist')")
  })
})
