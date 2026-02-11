const express = require('express');
const router = express.Router();

const clienteController = require('../controllers/clienteController');
const auth = require('../middleware/auth');

router.use(auth);

// LISTAR
router.get('/', clienteController.listarClientes);

// PEGAR 1
router.get('/:id', clienteController.buscarClientePorId);

// CRIAR
router.post('/', clienteController.criarCliente);

// ATUALIZAR
router.put('/:id', clienteController.atualizarCliente);

// EXCLUIR
router.delete('/:id', clienteController.excluirCliente);

// VINCULAR TAG
router.post('/:id/tags', clienteController.vincularTag);

module.exports = router;
