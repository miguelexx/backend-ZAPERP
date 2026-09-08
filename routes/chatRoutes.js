const express = require('express')
const router = express.Router()
const chatController = require('../controllers/chatController')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const { uploadArquivo } = require('../middleware/upload')
const { destructiveLimiter } = require('../middleware/rateLimit')

// base: /chats

router.post('/contato', auth, chatController.criarContato);
router.post('/abrir-conversa', auth, chatController.abrirConversaCliente);
router.post("/grupos", auth, chatController.criarGrupo);
router.get("/grupos/convite", auth, chatController.consultarConviteGrupo);
router.post("/grupos/entrar", auth, chatController.entrarPorConviteGrupo);
router.post("/comunidades", auth, chatController.criarComunidade);
router.post('/finalizacao-ausencia-lote', auth, supervisorOrAdmin, chatController.finalizacaoAusenciaLoteAuth)
router.get('/whatsapp-instances', auth, chatController.listWhatsappInstancesAtendimento);
router.get('/counts', auth, chatController.contarConversasPorFiltros)
router.get('/', auth, chatController.listarConversas)
router.get('/merge-duplicatas', auth, adminOnly, chatController.paginaMergeDuplicatas)
router.get('/merge-duplicatas/preview', auth, adminOnly, chatController.previewDuplicatasContatos)
router.post('/merge-duplicatas', auth, adminOnly, destructiveLimiter, chatController.mergeConversasDuplicadas)
router.post('/sincronizar-contatos', auth, chatController.sincronizarContatosZapi)
router.post('/sincronizar-contatos/cancelar', auth, require('../controllers/chat/integrationController').cancelarSincronizacaoContatos)
router.get('/sincronizar-contatos/status', auth, require('../controllers/chat/integrationController').statusSincronizacaoContatos)
router.get('/debug-sync-contatos', auth, chatController.debugSyncContatos)
router.post('/sincronizar-fotos-perfil', auth, chatController.sincronizarFotosPerfilZapi)
router.get('/whatsapp-status', auth, chatController.whatsappStatus)
router.get('/zapi-status', auth, chatController.whatsappStatus) // alias para compatibilidade
router.get('/pix-config', auth, chatController.getPixConfig)
router.put('/pix-config', auth, chatController.putPixConfig)
router.get('/:id/messages/search', auth, chatController.buscarMensagensConversa)
router.get('/:id/presenca', auth, chatController.obterPresencaConversa)
router.get('/:id/atendentes-disponiveis', auth, chatController.listarAtendentesDisponiveisConversa)
router.get('/:id/atendentes', auth, chatController.listarAtendentesConversa)
router.post('/:id/atendentes', auth, chatController.adicionarAtendenteConversa)
router.delete('/:id/atendentes/:usuario_id', auth, chatController.removerAtendenteConversa)
router.post('/:id/notas-internas', auth, chatController.criarNotaInterna)
router.get('/:id', auth, chatController.detalharChat)

// Atendimento: todos os usuários autenticados (regras por setor no controller)
router.post('/puxar', auth, chatController.puxarChatFila)
router.post('/:id/assumir', auth, chatController.assumirChat)
router.post('/:id/encerrar', auth, chatController.encerrarChat)
router.post('/:id/reabrir', auth, chatController.reabrirChat)
router.post('/:id/marcar-lida-modo-simples', auth, chatController.marcarLidaModoSimplesChat)
router.post('/:id/aguardando-cliente', auth, chatController.marcarAguardandoClienteManualChat)
router.post('/:id/aguardando-pagamento', auth, chatController.marcarAguardandoPagamentoFinanceiroChat)
router.post('/:id/retomar-atendimento', auth, chatController.retomarEmAtendimentoManualChat)
router.post('/:id/transferir', auth, chatController.transferirChat)
router.post("/:id/tags", auth, chatController.adicionarTagConversa);
router.delete("/:id/tags/:tag_id", auth, chatController.removerTagConversa)

// Todos os usuários: transferir conversa para outro setor (departamento)
router.put('/:id/departamento', auth, chatController.transferirSetor)

router.post("/:id/arquivo", auth, uploadArquivo, chatController.enviarArquivo)

router.post('/:id/mensagens/sync-old', auth, chatController.carregarMensagensAntigasContato)
router.post('/:id/mensagens', auth, chatController.enviarMensagemChat)
router.post('/:id/pix', auth, chatController.enviarMensagemPix)
router.post('/:id/encaminhar', auth, chatController.encaminharMensagem)
router.delete('/:id/mensagens/:mensagem_id', auth, chatController.excluirMensagem)
router.patch('/:id/mensagens/:mensagem_id', auth, chatController.editarMensagem)
router.post('/:id/mensagens/:mensagem_id/reacao', auth, chatController.enviarReacaoMensagem)
router.delete('/:id/mensagens/:mensagem_id/reacao', auth, chatController.removerReacaoMensagem)
// Reenvio manual de mensagem com falha: reutiliza a mesma linha, sem criar registro novo
router.post('/:id/mensagens/:mensagem_id/retry-text', auth, chatController.reenviarTextoMensagem)
router.post('/:id/mensagens/:mensagem_id/retry-media', auth, chatController.reenviarMidiaMensagem)
router.post('/:id/contatos', auth, chatController.enviarContatoWhatsapp)
router.post('/:id/localizacao', auth, chatController.enviarLocalizacao)
router.post('/:id/ligacao', auth, chatController.enviarLigacaoWhatsapp)
router.post('/:id/enquete', auth, chatController.enviarEnquete)
router.get('/:id/grupo', auth, chatController.obterGrupo)
router.put('/:id/grupo', auth, chatController.atualizarGrupo)
router.patch('/:id/grupo/settings', auth, chatController.atualizarConfigGrupo)
router.post('/:id/grupo/sair', auth, chatController.sairGrupo)
router.get('/:id/grupo/convite', auth, chatController.obterConviteGrupo)
router.delete('/:id/grupo/convite', auth, chatController.revogarConviteGrupo)
router.post('/:id/grupo/convite/enviar', auth, chatController.enviarConviteGrupo)
router.put('/:id/grupo/foto', auth, chatController.definirFotoGrupo)
router.delete('/:id/grupo/foto', auth, chatController.removerFotoGrupo)
router.get('/:id/grupo/solicitacoes', auth, chatController.listarSolicitacoesGrupo)
router.post('/:id/grupo/solicitacoes', auth, chatController.aprovarSolicitacaoGrupo)
router.delete('/:id/grupo/solicitacoes', auth, chatController.rejeitarSolicitacaoGrupo)
router.get('/:id/participantes', auth, chatController.listarParticipantesGrupo)
router.post('/:id/participantes', auth, chatController.adicionarParticipantesGrupo)
router.delete('/:id/participantes', auth, chatController.removerParticipantesGrupo)
router.post('/:id/grupo/admins', auth, chatController.promoverAdminGrupo)
router.delete('/:id/grupo/admins', auth, chatController.rebaixarAdminGrupo)
router.put('/:id/cliente', auth, chatController.vincularClienteConversa)
router.put('/:id/vincular-cliente', auth, chatController.vincularClienteConversa)
router.put('/:id/observacao', auth, chatController.atualizarObservacao)
router.put('/:id/nome-contato', auth, chatController.atualizarNomeContato)

// Menu da lista (silenciar / fixar / favoritar / limpar / apagar) — ver migration conversa_usuario_prefs
router.patch('/:id/prefs', auth, chatController.patchConversaPrefs)
router.post('/:id/limpar-mensagens', auth, adminOnly, destructiveLimiter, chatController.limparMensagensConversa)
router.delete('/:id', auth, adminOnly, destructiveLimiter, chatController.apagarConversa)

// auditoria
router.get('/:id/atendimentos', auth, chatController.listarAtendimentos)

module.exports = router
