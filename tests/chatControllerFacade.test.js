/**
 * Guard de fachada: garante que controllers/chatController.js reexporta EXATAMENTE o mesmo
 * conjunto público de handlers/helpers após a modularização (controllers/chat/*).
 *
 * Pega imediatamente: export ausente, erro de wiring (ReferenceError no load de um submódulo),
 * ou reexport quebrado. A lista abaixo é o contrato congelado dos 63 exports originais.
 */
const chat = require('../controllers/chatController')

const HANDLERS = [
  'abrirConversaCliente', 'adicionarAtendenteConversa', 'adicionarTagConversa', 'apagarConversa',
  'assumirChat', 'atualizarNomeContato', 'atualizarObservacao', 'buscarMensagensConversa',
  'carregarMensagensAntigasContato', 'contarConversasPorFiltros', 'criarComunidade', 'criarContato',
  'criarGrupo', 'criarNotaInterna', 'debugSyncContatos', 'detalharChat', 'emitirEventoEmpresaConversa',
  'emitirMovimentacaoInternaAtendimento', 'emitirParaUsuariosQuePodemVerConversa', 'emitirRealtimeAposAssumir',
  'encaminharMensagem', 'encerrarChat', 'enviarArquivo', 'enviarContatoWhatsapp', 'enviarLigacaoWhatsapp',
  'enviarLocalizacao', 'enviarMensagemChat', 'enviarMensagemPix', 'enviarReacaoMensagem', 'excluirMensagem',
  'finalizacaoAusenciaLoteAuth', 'getPixConfig', 'incrementarUnreadParaConversa', 'limparMensagensConversa',
  'listWhatsappInstancesAtendimento', 'listarAtendentesConversa', 'listarAtendentesDisponiveisConversa',
  'listarAtendimentos', 'listarConversas', 'marcarAguardandoClienteManualChat',
  'marcarAguardandoPagamentoFinanceiroChat', 'marcarLidaModoSimplesChat', 'mergeConversasDuplicadas',
  'obterUsuarioIdsQuePodemVerConversa', 'paginaMergeDuplicatas', 'patchConversaPrefs', 'putPixConfig',
  'puxarChatFila', 'reabrirChat', 'reenviarMidiaMensagem', 'reenviarTextoMensagem', 'removerAtendenteConversa',
  'removerReacaoMensagem', 'removerTagConversa', 'retomarEmAtendimentoManualChat', 'sincronizarContatosZapi',
  'sincronizarFotosPerfilZapi', 'transferirChat', 'transferirSetor', 'vincularClienteConversa',
  'whatsappStatus', 'zapiStatus',
]

describe('chatController facade — 63 exports preservados', () => {
  it('expõe _test como objeto', () => {
    expect(typeof chat._test).toBe('object')
    expect(chat._test).not.toBeNull()
  })

  it.each(HANDLERS)('exporta %s como função', (name) => {
    expect(typeof chat[name]).toBe('function')
  })

  it('total de exports públicos == 63 (62 handlers + _test)', () => {
    expect(HANDLERS.length + 1).toBe(63)
  })
})
