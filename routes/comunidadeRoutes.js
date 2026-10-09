/**
 * Rotas de Comunidades (WhatsApp Communities via Whapi). Base: /comunidades.
 * TODAS admin-only (auth + adminOnly). Router dedicado — não toca o caminho quente de chatRoutes.
 * Ordem importa: /operacoes* antes de /:cid (senão :cid captura "operacoes").
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const c = require('../controllers/comunidadeController')

// Operações (progresso da fila) — declarar ANTES de /:cid
router.get('/operacoes', auth, adminOnly, c.listarOperacoes)
router.get('/operacoes/:id', auth, adminOnly, c.obterOperacao)
router.post('/operacoes/:id/pausar', auth, adminOnly, c.pausarOperacao)
router.post('/operacoes/:id/retomar', auth, adminOnly, c.retomarOperacao)
router.post('/operacoes/:id/cancelar', auth, adminOnly, c.cancelarOperacao)

// Comunidades
router.get('/', auth, adminOnly, c.listarComunidades)
router.post('/', auth, adminOnly, c.criarComunidade)
router.get('/:cid', auth, adminOnly, c.obterComunidade)
router.get('/:cid/subgrupos', auth, adminOnly, c.listarSubgrupos)
router.patch('/:cid/settings', auth, adminOnly, c.configurarComunidade)
router.delete('/:cid', auth, adminOnly, c.desativarComunidade)

// Grupos
router.post('/:cid/grupos', auth, adminOnly, c.criarGrupoNaComunidade)
router.put('/:cid/grupos/:gid', auth, adminOnly, c.vincularGrupo)
router.delete('/:cid/grupos/:gid', auth, adminOnly, c.desvincularGrupo)

// Admins (direto — baixo risco)
router.post('/:cid/admins', auth, adminOnly, c.promoverAdmin)
router.delete('/:cid/admins', auth, adminOnly, c.rebaixarAdmin)

// Convite (ativo copiável — NÃO disparado em massa pelo sistema)
router.get('/:cid/convite', auth, adminOnly, c.obterConvite)
router.delete('/:cid/convite', auth, adminOnly, c.revogarConvite)

// Participantes em massa → FILA protegida (ultra-conservadora)
router.post('/:cid/participantes', auth, adminOnly, c.enfileirarParticipantes)
router.delete('/:cid/participantes', auth, adminOnly, c.enfileirarRemocao)

module.exports = router
