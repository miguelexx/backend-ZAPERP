/**
 * Diagnóstico + reparo do espelhamento de mídia ENVIADA (outbound) para o Cloudflare R2.
 *
 * Responde de forma concreta: "por que as mídias que EU envio não estão indo para o R2?"
 * Para cada mensagem outbound recente da empresa habilitada, mostra o estado real e tenta
 * espelhar, imprimindo o motivo exato quando não espelha.
 *
 * Uso (no servidor, com o .env configurado):
 *   node scripts/r2-diagnose-outbound.js            # últimas 30 mídias enviadas
 *   node scripts/r2-diagnose-outbound.js 100         # últimas 100
 *
 * Não altera nada além de espelhar mídia que já deveria estar no R2 (idempotente).
 */

require('../config/env').loadEnv?.()
try { require('dotenv').config() } catch (_) {}

const supabase = require('../config/supabase')
const { empresaUsaR2, isR2Configured, getR2CompanyIds } = require('../config/r2')
const { mirrorMensagemParaR2 } = require('../services/mediaR2MirrorService')
const { getUploadsRoot } = require('../config/uploadsRoot')
const fs = require('fs')
const path = require('path')

const LIMIT = Math.min(500, Math.max(1, Number(process.argv[2]) || 30))
const TIPOS = ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo']

function localExists(url) {
  const raw = String(url || '')
  if (!raw.startsWith('/uploads/')) return null
  const root = path.resolve(getUploadsRoot())
  const rel = raw.replace(/^\/uploads\//, '').split('?')[0]
  const abs = path.resolve(root, decodeURIComponent(rel))
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return false
  return fs.existsSync(abs)
}

async function main() {
  console.log('=== Diagnóstico R2 — mídia ENVIADA (outbound) ===\n')
  console.log('R2 configurado:', isR2Configured(), '| empresas habilitadas:', [...getR2CompanyIds()].join(', '), '\n')
  if (!isR2Configured()) {
    console.error('❌ R2 não configurado no .env — nada será espelhado. Preencha as credenciais R2_*.')
    process.exit(1)
  }

  const companyIds = [...getR2CompanyIds()]
  const { data: rows, error } = await supabase
    .from('mensagens')
    .select('id, company_id, tipo, direcao, status, status_mensagem, url, storage_backend, storage_key, criado_em')
    .in('company_id', companyIds)
    .eq('direcao', 'out')
    .in('tipo', TIPOS)
    .order('id', { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error('❌ Erro ao consultar mensagens:', error.message)
    console.error('   (se citar storage_backend/storage_key, a migration 20260813120000 não foi aplicada.)')
    process.exit(1)
  }

  if (!rows?.length) {
    console.log('Nenhuma mídia enviada encontrada para as empresas habilitadas.')
    return
  }

  const resumo = { total: rows.length, ja_no_r2: 0, espelhadas_agora: 0, pendentes_status: 0, sem_arquivo: 0, outros: 0 }

  for (const r of rows) {
    const st = r.status_mensagem || r.status || '?'
    const noR2 = r.storage_backend === 'r2' || String(r.url || '').startsWith('/media/r2/')
    const existeLocal = localExists(r.url)
    const usa = empresaUsaR2(r.company_id)

    let acao = ''
    if (noR2) {
      resumo.ja_no_r2 += 1
      acao = '✅ já no R2'
    } else if (!usa) {
      resumo.outros += 1
      acao = '➖ empresa não habilitada para R2'
    } else {
      // Tenta espelhar agora e reporta o motivo exato.
      const res = await mirrorMensagemParaR2({ supabase, company_id: r.company_id, mensagem_id: r.id })
      if (res.ok && res.key) { resumo.espelhadas_agora += 1; acao = `⬆️  ESPELHADA AGORA → ${res.key}` }
      else if (res.ignorado === 'status_nao_final') { resumo.pendentes_status += 1; acao = `⏳ status não-final (${st}) — mensagem ainda não confirmada como enviada` }
      else if (res.ignorado === 'arquivo_local_inexistente') { resumo.sem_arquivo += 1; acao = '⚠️  arquivo local não existe mais (não dá para espelhar)' }
      else if (res.ignorado === 'ja_espelhado') { resumo.ja_no_r2 += 1; acao = '✅ já no R2' }
      else { resumo.outros += 1; acao = `❓ ${res.ignorado || res.erro || 'motivo desconhecido'}` }
    }

    console.log(
      `#${r.id} | ${String(r.tipo).padEnd(7)} | status=${String(st).padEnd(9)} | ` +
      `local=${existeLocal === null ? 'n/a' : existeLocal ? 'sim' : 'NÃO'} | ${acao}`
    )
  }

  console.log('\n=== Resumo ===')
  console.log(resumo)
  console.log('')
  if (resumo.pendentes_status > 0) {
    console.log('👉 Há mídias em status NÃO-FINAL (pending/sending). Isso significa que a UltraMSG não confirmou o envio')
    console.log('   (webhook de status/ACK provavelmente não está configurado apontando para este backend).')
    console.log('   Enquanto a mensagem não é confirmada como enviada, ela NÃO é espelhada (de propósito).')
  }
  if (resumo.sem_arquivo > 0) {
    console.log('👉 Há mídias cujo arquivo local já sumiu (deploy recriou /uploads?). Essas não podem ser espelhadas.')
  }
  if (resumo.espelhadas_agora > 0) {
    console.log(`✅ ${resumo.espelhadas_agora} mídia(s) enviada(s) foram espelhadas AGORA para o R2 — o pipeline funciona.`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('Falhou:', e?.message || e); process.exit(1) })
