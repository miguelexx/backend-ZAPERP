const express = require('express')
const router = express.Router()
const chatController = require('../controllers/chatController')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const { upload } = require('../middleware/upload')

// base: /chats

router.post('/contato', auth, chatController.criarContato);
router.post('/abrir-conversa', auth, chatController.abrirConversaCliente);
router.post("/grupos", auth, chatController.criarGrupo);
router.post("/comunidades", auth, chatController.criarComunidade);
router.get('/', auth, chatController.listarConversas)
router.get('/merge-duplicatas', chatController.paginaMergeDuplicatas)
router.post('/merge-duplicatas', auth, adminOnly, chatController.mergeConversasDuplicadas)
router.post('/sincronizar-contatos', auth, chatController.sincronizarContatosZapi)
router.post('/sincronizar-fotos-perfil', auth, chatController.sincronizarFotosPerfilZapi)
router.get('/zapi-status', auth, chatController.zapiStatus)
router.get('/:id', auth, chatController.detalharChat)

// Atendimento: todos os usuários autenticados (regras por setor no controller)
router.post('/puxar', auth, chatController.puxarChatFila)
router.post('/:id/assumir', auth, chatController.assumirChat)
router.post('/:id/encerrar', auth, chatController.encerrarChat)
router.post('/:id/reabrir', auth, chatController.reabrirChat)
router.post('/:id/transferir', auth, chatController.transferirChat)
router.post("/:id/tags", auth, chatController.adicionarTagConversa);
router.delete("/:id/tags/:tag_id", auth, chatController.removerTagConversa)

// Apenas admin: transferir conversa para outro setor (departamento)
router.put('/:id/departamento', auth, adminOnly, chatController.transferirSetor)

router.post("/:id/arquivo", auth, upload.single('file'), chatController.enviarArquivo)

router.post('/:id/mensagens', auth, chatController.enviarMensagemChat)
router.delete('/:id/mensagens/:mensagem_id', auth, chatController.excluirMensagem)
router.put('/:id/observacao', auth, chatController.atualizarObservacao)

// auditoria
router.get('/:id/atendimentos', auth, chatController.listarAtendimentos)

module.exports = router 