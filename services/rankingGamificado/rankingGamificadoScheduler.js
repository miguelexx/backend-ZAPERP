'use strict'

/**
 * Agendador do ranking gamificado: abre ciclos e encerra (anunciando uma única vez) os que
 * venceram. Mesmo padrão dos demais *Scheduler.js (setInterval + guarda de reentrada, no
 * processo da API). O resultado é exato mesmo com atraso: a apuração usa a janela gravada no
 * ciclo, não a hora em que o tick rodou.
 *
 * Reinício: nada em memória é necessário — o estado vive em `ranking_ciclos`, e o UPDATE
 * condicional garante que um ciclo nunca é encerrado/anunciado duas vezes.
 */

const rankingService = require('./rankingGamificadoService')

let started = false
let timer = null
let running = false
let avisouTabelaAusente = false

function intervaloMs() {
  const raw = Number(process.env.RANKING_SCHEDULER_INTERVAL_SECONDS)
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 30
  return Math.max(15, Math.min(600, Math.round(seconds))) * 1000
}

async function runRankingCycle(io) {
  if (running) return { skipped: true }
  running = true
  let empresas = 0
  let encerrados = 0
  try {
    let ativas
    try {
      ativas = await rankingService.listarEmpresasAtivas()
    } catch (err) {
      if (rankingService.tabelaAusente(err)) {
        if (!avisouTabelaAusente) {
          avisouTabelaAusente = true
          console.warn('[rankingScheduler] tabela ranking_config ausente — aplique a migration 20261119120000_ranking_gamificado.sql')
        }
        return { ok: true, indisponivel: true }
      }
      throw err
    }
    for (const cfg of ativas) {
      empresas += 1
      try {
        await rankingService.garantirCicloAtual(cfg.company_id, cfg)
        const fechados = await rankingService.encerrarCiclosVencidos(cfg.company_id, { io, config: cfg })
        encerrados += fechados.length
      } catch (err) {
        // Uma empresa com problema não trava as outras.
        console.warn('[rankingScheduler] empresa', cfg.company_id, err?.message || err)
      }
    }
    return { ok: true, empresas, encerrados }
  } catch (err) {
    console.warn('[rankingScheduler] erro no ciclo:', err?.message || err)
    return { ok: false }
  } finally {
    running = false
  }
}

function startRankingGamificadoScheduler(io = null) {
  if (started) return
  started = true
  const ms = intervaloMs()
  timer = setInterval(() => {
    runRankingCycle(io).catch(() => {})
  }, ms)
  if (typeof timer.unref === 'function') timer.unref()
  setTimeout(() => {
    runRankingCycle(io).catch(() => {})
  }, 20 * 1000)
  console.log('[rankingScheduler] iniciado', { intervalSeconds: Math.round(ms / 1000) })
}

module.exports = { startRankingGamificadoScheduler, runRankingCycle }
