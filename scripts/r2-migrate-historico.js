/**
 * Migração em massa das mídias ANTIGAS (histórico em /uploads) para o Cloudflare R2.
 *
 * Move TODO o histórico da(s) empresa(s) habilitada(s) de uma vez, em lotes, com progresso e
 * relatório final. Seguro, idempotente e resumível.
 *
 * Uso (no servidor, com o .env configurado):
 *   node scripts/r2-migrate-historico.js            # todas as empresas habilitadas (default: só a 1)
 *   node scripts/r2-migrate-historico.js 1          # só a company_id 1
 *
 * GARANTIAS (nada fica incorreto / imagens continuam funcionando):
 *   - A url no banco só é trocada para /media/r2/<key> DEPOIS de o objeto estar no R2 e verificado
 *     (upload + HEAD conferindo tamanho). Se qualquer etapa falhar, a url permanece /uploads e a
 *     imagem continua sendo servida do disco — nada quebra.
 *   - Idempotente: já migrado (storage_key preenchido) é pulado. Pode rodar quantas vezes quiser.
 *   - Resumível: usa cursor por id; se interromper, rode de novo que continua de onde parou.
 *   - NÃO apaga o arquivo local. A liberação de espaço é um passo separado e opcional
 *     (scripts/r2-disk-cleanup.js), para você validar as imagens no R2 antes de remover o disco.
 */

require('../config/env').loadEnv?.()
try { require('dotenv').config() } catch (_) {}

const supabase = require('../config/supabase')
const { isR2Configured, getR2CompanyIds } = require('../config/r2')
const { mirrorMensagemParaR2 } = require('../services/mediaR2MirrorService')

const TIPOS = ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo']
const BATCH = Math.min(500, Math.max(1, Number(process.env.R2_MIGRATE_BATCH) || 100))

function parseCompanyArg() {
  const a = Number(process.argv[2])
  return Number.isFinite(a) && a > 0 ? [a] : [...getR2CompanyIds()]
}

async function main() {
  console.log('=== Migração do histórico de mídia → Cloudflare R2 ===\n')
  if (!isR2Configured()) {
    console.error('❌ R2 não configurado no .env. Preencha R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET.')
    process.exit(1)
  }

  const companyIds = parseCompanyArg()
  console.log('Empresas:', companyIds.join(', '), '| lote:', BATCH, '\n')

  const total = {
    lidas: 0, migradas: 0, ja_no_r2: 0, sem_arquivo: 0, status_ignorado: 0, erros: 0,
  }
  let lastId = 0

  for (;;) {
    const { data: rows, error } = await supabase
      .from('mensagens')
      .select('id, company_id')
      .in('company_id', companyIds)
      .in('tipo', TIPOS)
      .is('storage_key', null)
      .like('url', '/uploads/%')
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(BATCH)

    if (error) {
      console.error('❌ Erro na consulta:', error.message)
      if (/storage_key|storage_backend|url_legado|does not exist|42703|schema cache/i.test(error.message)) {
        console.error('   → A migration 20260813120000_mensagens_storage_r2.sql precisa ser aplicada antes.')
      }
      process.exit(1)
    }

    if (!rows?.length) break

    for (const r of rows) {
      total.lidas += 1
      lastId = Math.max(lastId, Number(r.id))
      try {
        const res = await mirrorMensagemParaR2({ supabase, company_id: r.company_id, mensagem_id: r.id })
        if (res.ok && res.key) total.migradas += 1
        else if (res.ignorado === 'ja_espelhado') total.ja_no_r2 += 1
        else if (res.ignorado === 'arquivo_local_inexistente') total.sem_arquivo += 1
        else if (res.ignorado === 'status_nao_final') total.status_ignorado += 1
        else total.erros += 1
      } catch (e) {
        total.erros += 1
        console.warn('  erro na mensagem', r.id, '-', e?.message || e)
      }
    }

    console.log(`… processadas ${total.lidas} | migradas ${total.migradas} | já no R2 ${total.ja_no_r2} | sem arquivo ${total.sem_arquivo} | erros ${total.erros}`)
  }

  console.log('\n=== Relatório final ===')
  console.log(`Mensagens lidas (candidatas): ${total.lidas}`)
  console.log(`✅ Migradas agora para o R2:   ${total.migradas}`)
  console.log(`   Já estavam no R2:           ${total.ja_no_r2}`)
  console.log(`⚠️  Sem arquivo local (perdido): ${total.sem_arquivo}`)
  console.log(`   Erros (vão retentar):        ${total.erros}`)
  console.log('')
  if (total.sem_arquivo > 0) {
    console.log('Obs.: "sem arquivo local" = o /uploads foi recriado por um deploy antigo e o arquivo sumiu;')
    console.log('      não há como migrar o que não existe mais no disco (a url segue como está).')
  }
  if (total.erros > 0) {
    console.log('Rode o script de novo para retentar os que deram erro (idempotente, continua de onde parou).')
  }
  console.log('Depois de validar que as imagens abrem do R2, rode scripts/r2-disk-cleanup.js para liberar espaço.')
}

main().then(() => process.exit(0)).catch((e) => { console.error('Falhou:', e?.message || e); process.exit(1) })
