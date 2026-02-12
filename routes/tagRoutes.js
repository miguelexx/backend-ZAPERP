const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const tagController = require('../controllers/tagController');

router.get('/', auth, tagController.listarTags);
// Apenas admin pode CRIAR/EDITAR/EXCLUIR tags do sistema (evita “poluição” de tags)
router.post('/', auth, adminOnly, tagController.criarTag);
router.put('/:id', auth, adminOnly, tagController.atualizarTag);
router.delete('/:id', auth, adminOnly, tagController.excluirTag);

module.exports = router;
