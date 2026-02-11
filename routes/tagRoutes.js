const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tagController = require('../controllers/tagController');

router.get('/', auth, tagController.listarTags);
router.post('/', auth, tagController.criarTag);
router.put('/:id', auth, tagController.atualizarTag);
router.delete('/:id', auth, tagController.excluirTag);

module.exports = router;
