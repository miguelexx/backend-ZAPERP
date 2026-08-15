/**
 * Libera espaço no disco (VPS): remove os arquivos locais de /uploads cuja mídia JÁ está no
 * Cloudflare R2 (storage_backend='r2'), respeitando a janela de segurança. Restart-safe e idempotente.
 *
 * Também serve de CERTIFICAÇÃO: mostra quanto espaço /uploads ocupa antes e depois.
 *
 * Uso (no servidor, com o .env configurado):
 *   node scripts/r2-disk-cleanup.js
 *
 * Não remove nada que ainda não esteja confirmado no R2. Só apaga staging já espelhado.
 */

require('../config/env').loadEnv?.()
try { require('dotenv').config() } catch (_) {}

const fs = require('fs')
const path = require('path')
const { getUploadsRoot } = require('../config/uploadsRoot')
const { isR2Configured, getR2CompanyIds, getLocalCleanupDelayMs } = require('../config/r2')
const { runR2LocalCleanup } = require('../services/mediaR2MirrorService')
const supabase = require('../config/supabase')

function dirStats(dir) {
  let files = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name))
        if (st.isFile()) { files += 1; bytes += st.size }
      } catch (_) {}
    }
  } catch (_) {}
  return { files, bytes }
}

const fmt = (b) => {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function main() {
  const root = getUploadsRoot()
  console.log('=== Liberação de espaço (staging local já no R2) ===\n')
  console.log('Pasta /uploads:', root)
  console.log('R2 configurado:', isR2Configured(), '| empresas:', [...getR2CompanyIds()].join(', '))
  console.log('Janela de segurança:', Math.round(getLocalCleanupDelayMs() / 60000), 'min (arquivos mais novos que isso são mantidos)\n')

  if (!isR2Configured()) {
    console.error('❌ R2 não configurado — nada a fazer.')
    process.exit(1)
  }

  const antes = dirStats(root)
  console.log(`ANTES: ${antes.files} arquivo(s), ${fmt(antes.bytes)} em /uploads\n`)

  let totalPurged = 0
  for (let i = 0; i < 1000; i += 1) {
    const r = await runR2LocalCleanup(supabase)
    totalPurged += r.purged
    if (r.purged === 0) break
    console.log(`  lote: ${r.purged} arquivo(s) purgado(s) (acumulado ${totalPurged})`)
  }

  const depois = dirStats(root)
  const liberado = Math.max(0, antes.bytes - depois.bytes)

  console.log('\n=== Resultado ===')
  console.log(`Arquivos purgados (já no R2): ${totalPurged}`)
  console.log(`DEPOIS: ${depois.files} arquivo(s), ${fmt(depois.bytes)} em /uploads`)
  console.log(`Espaço liberado: ${fmt(liberado)}`)
  if (depois.files > 0) {
    console.log('\nObs.: arquivos restantes são (a) mídia dentro da janela de segurança, (b) mídia ainda')
    console.log('não espelhada no R2 (falha/retry), ou (c) arquivos sem mídia correspondente (ex.: logos).')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('Falhou:', e?.message || e); process.exit(1) })
