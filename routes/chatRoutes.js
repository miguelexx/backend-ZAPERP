const express = require('express')
const router = express.Router()
const chatController = require('../controllers/chatController')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const { uploadArquivo } = require('../middleware/upload')

// base: /chats

router.post('/contato', auth, chatController.criarContato);
router.post('/abrir-conversa', auth, chatController.abrirConversaCliente);
router.post("/grupos", auth, chatController.criarGrupo);
router.post("/comunidades", auth, chatController.criarComunidade);
router.get('/', auth, chatController.listarConversas)
router.get('/merge-duplicatas', auth, adminOnly, chatController.paginaMergeDuplicatas)
router.post('/merge-duplicatas', auth, adminOnly, chatController.mergeConversasDuplicadas)
router.post('/sincronizar-contatos', auth, chatController.sincronizarContatosZapi)
router.get('/debug-sync-contatos', auth, chatController.debugSyncContatos)
router.post('/sincronizar-fotos-perfil', auth, chatController.sincronizarFotosPerfilZapi)
router.get('/whatsapp-status', auth, chatController.whatsappStatus)
router.get('/zapi-status', auth, chatController.whatsappStatus) // alias para compatibilidade
router.get('/:id', auth, chatController.detalharChat)

// Atendimento: todos os usuários autenticados (regras por setor no controller)
router.post('/puxar', auth, chatController.puxarChatFila)
router.post('/:id/assumir', auth, chatController.assumirChat)
router.post('/:id/encerrar', auth, chatController.encerrarChat)
router.post('/:id/reabrir', auth, chatController.reabrirChat)
router.post('/:id/aguardando-cliente', auth, chatController.marcarAguardandoClienteManualChat)
router.post('/:id/retomar-atendimento', auth, chatController.retomarEmAtendimentoManualChat)
router.post('/:id/transferir', auth, chatController.transferirChat)
router.post("/:id/tags", auth, chatController.adicionarTagConversa);
router.delete("/:id/tags/:tag_id", auth, chatController.removerTagConversa)

// Todos os usuários: transferir conversa para outro setor (departamento)
router.put('/:id/departamento', auth, chatController.transferirSetor)

router.post("/:id/arquivo", auth, uploadArquivo, chatController.enviarArquivo)

router.post('/:id/mensagens', auth, chatController.enviarMensagemChat)
router.post('/:id/encaminhar', auth, chatController.encaminharMensagem)
router.delete('/:id/mensagens/:mensagem_id', auth, chatController.excluirMensagem)
router.post('/:id/mensagens/:mensagem_id/reacao', auth, chatController.enviarReacaoMensagem)
router.delete('/:id/mensagens/:mensagem_id/reacao', auth, chatController.removerReacaoMensagem)
router.post('/:id/contatos', auth, chatController.enviarContatoWhatsapp)
router.post('/:id/localizacao', auth, chatController.enviarLocalizacao)
router.post('/:id/ligacao', auth, chatController.enviarLigacaoWhatsapp)
router.put('/:id/observacao', auth, chatController.atualizarObservacao)

// Menu da lista (silenciar / fixar / favoritar / limpar / apagar) — ver migration conversa_usuario_prefs
router.patch('/:id/prefs', auth, chatController.patchConversaPrefs)
router.post('/:id/limpar-mensagens', auth, chatController.limparMensagensConversa)
router.delete('/:id', auth, chatController.apagarConversa)

// auditoria
router.get('/:id/atendimentos', auth, chatController.listarAtendimentos)

module.exports = router 