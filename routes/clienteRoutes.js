const express = require('express');
const router = express.Router();

const clienteController = require('../controllers/clienteController');
const clienteImportController = require('../controllers/clienteImportController');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { destructiveLimiter } = require('../middleware/rateLimit');
const { uploadXlsx } = require('../middleware/uploadXlsx');

router.use(auth);

// LISTAR
router.get('/', clienteController.listarClientes);

// IMPORTAR POR PLANILHA (.xlsx) — restrito a admin; caminhos literais antes de /:id
router.post('/importar/preview', adminOnly, uploadXlsx, clienteImportController.previewImportacao);
router.post('/importar', adminOnly, destructiveLimiter, uploadXlsx, clienteImportController.confirmarImportacao);

// APAGAR TODOS (deve vir antes de /:id)
router.delete('/todos', adminOnly, destructiveLimiter, clienteController.apagarTodosClientes);

// PEGAR 1
router.get('/:id', clienteController.buscarClientePorId);

// TAGS DO CLIENTE
router.get('/:id/tags', clienteController.listarTagsCliente);

// CRIAR
router.post('/', clienteController.criarCliente);

// ATUALIZAR
router.put('/:id', clienteController.atualizarCliente);

// EXCLUIR
router.delete('/:id', adminOnly, destructiveLimiter, clienteController.excluirCliente);

// VINCULAR TAG
router.post('/:id/tags', clienteController.vincularTag);

// DESVINCULAR TAG
router.delete('/:id/tags/:tagId', clienteController.desvincularTag);

module.exports = router;
