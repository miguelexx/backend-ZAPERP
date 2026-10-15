/**
 * Reparo RETROATIVO da mídia recebida sem o `link` do provedor (passivo do banco).
 *
 * O QUE FAZ: encontra as conversas que têm mídia quebrada e, para cada uma, chama
 * `syncOldMessagesForConversation` — exatamente o mesmo caminho do botão "Buscar histórico" e do
 * backfill automático (`inboundMediaBackfillService`). Não existe pipeline novo aqui: este script
 * só decide QUAIS conversas chamar, em que ritmo, e mostra o resultado.
 *
 * O reparo em si (services/oldMessagesSyncService.js):
 *   • casa a linha do banco com a do histórico por `whatsapp_id`;
 *   • só PROMOVE campos (`buildPlaceholderRepairPatch`): placeholder → texto real, linha sem URL →
 *     URL do provedor + tipo + nome_arquivo. URL utilizável nunca é sobrescrita;
 *   • insere o que não existe (é assim que a foto DESCARTADA pelo webhook volta a existir);
 *   • agenda a cópia para /uploads (por isso: RODAR NA VPS — ver AVISOS).
 * Idempotente por construção: rodar de novo não duplica e não desfaz nada.
 *
 * USO (na VPS, onde está o .env de produção e o disco /uploads):
 *   node scripts/reparar-midia-sem-link.js --company-id=1                    # DRY-RUN (padrão)
 *   node scripts/reparar-midia-sem-link.js --company-id=1 --conversa=12345   # teste em 1 conversa
 *   node scripts/reparar-midia-sem-link.js --company-id=1 --apply            # executa
 *
 * OPÇÕES
 *   --company-id=N      OBRIGATÓRIO. Isolamento app-layer: nada roda sem empresa explícita.
 *   --apply             Sem ela, o script só lista o que faria (dry-run).
 *   --dias=45           Janela de seleção. 45 = o que a Whapi devolve (CONTACT_HISTORY_WINDOW_DAYS).
 *                       Acima disso, em canal Whapi, o provedor não tem o que devolver.
 *   --limite=50         Máximo de conversas por execução (teto de consumo da conta).
 *   --pausa-ms=1500     Pausa entre conversas. Não baixe sem motivo: protege a conta WhatsApp.
 *   --falhas-max=5      Disjuntor: aborta após N conversas seguidas com erro do provedor.
 *   --conversa=ID       Repara só essa conversa (ignora a seleção automática).
 *   --modo=linhas|lacunas|ambos   Que passivo procurar (padrão: linhas).
 *                       linhas  = linhas quebradas no banco (áudio mudo, placeholder sem URL);
 *                       lacunas = conversas cuja `ultima_atividade` é mais nova que a última
 *                                 mensagem — pista das mídias DESCARTADAS, que não têm linha.
 *   --lacuna-min-seg=120  Lacuna mínima para considerar suspeita (modo lacunas).
 *   --scan-lacunas=300    Quantas conversas recentes examinar no modo lacunas.
 *   --espera-final-ms=15000  Espera no fim para as cópias de mídia em voo terminarem.
 *   --json              Imprime o resumo final como JSON (para colar em relatório).
 *
 * AVISOS
 *   1. RODAR NA VPS. O reparo que traz URL remota agenda download para /uploads; rodando na
 *      máquina de desenvolvimento o arquivo cai no disco local e o banco passa a apontar para um
 *      /uploads/... que não existe no servidor.
 *   2. Consome cota do provedor (1 chamada de histórico por conversa, com paginação).
 *   3. Mensagens inseridas não emitem socket (io=null): o atendente vê após recarregar. As que
 *      ganham mídia emitem `nova_mensagem` quando a cópia conclui.
 *   4. `conversas.ultima_atividade` pode AVANÇAR (só para frente) quando uma mensagem nova é
 *      inserida — a conversa sobe na lista. É o comportamento do serviço, não deste script.
 *   5. Não aplica migration, não altera schema, não apaga nada.
 *
 * Diagnóstico antes/depois: supabase/scripts_manuais/diagnostico/MIDIA_SEM_LINK_PASSIVO.sql
 * Contexto completo: docs/ai-handoff/31-REPARO-RETROATIVO-MIDIA-SEM-LINK.md
 */

const MEDIA_TIPOS = ['imagem', 'video', 'audio', 'voice', 'sticker', 'arquivo', 'documento']

/** Mesmos textos de PLACEHOLDER_TEXTS (oldMessagesSyncService) — a lista canônica do reparo. */
const PLACEHOLDER_TEXTS = [
  '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
  '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)',
  '(arquivo)', '(documento)',
]

/** Espelha `temUrlUtilizavel()` do oldMessagesSyncService: o que o frontend consegue renderizar. */
function temUrlUtilizavel(url) {
  const u = String(url || '').trim()
  return u.startsWith('https://') || u.startsWith('http://') || u.startsWith('/uploads/') || u.startsWith('/media/r2/')
}

/**
 * A linha está quebrada? Sem URL utilizável E (tipo de mídia OU texto de placeholder).
 * Linha já apagada (para todos / pelo cliente) não é estrago: não entra.
 */
function linhaQuebrada(row) {
  if (!row) return false
  if (row.apagada_para_todos === true || row.apagada_pelo_cliente === true) return false
  if (temUrlUtilizavel(row.url)) return false
  const tipo = String(row.tipo || '').toLowerCase().trim()
  if (MEDIA_TIPOS.includes(tipo)) return true
  return PLACEHOLDER_TEXTS.includes(String(row.texto || '').trim().toLowerCase())
}

/** Só é reparável pelo histórico quem tem `whatsapp_id` — é a chave de casamento do reparo. */
function linhaReparavel(row) {
  return linhaQuebrada(row) && !!String(row?.whatsapp_id || '').trim()
}

/**
 * Agrupa as linhas quebradas por conversa e ordena pelas mais recentes primeiro
 * (mídia recente é a que o atendimento ainda precisa).
 */
function agruparPorConversa(rows) {
  const porConversa = new Map()
  for (const row of rows || []) {
    if (!linhaQuebrada(row)) continue
    const id = Number(row.conversa_id)
    if (!Number.isFinite(id)) continue
    const atual = porConversa.get(id) || {
      conversa_id: id,
      linhas: 0,
      reparaveis: 0,
      sem_whatsapp_id: 0,
      tipos: new Set(),
      mais_recente: null,
    }
    atual.linhas += 1
    if (linhaReparavel(row)) atual.reparaveis += 1
    else atual.sem_whatsapp_id += 1
    atual.tipos.add(String(row.tipo || 'texto'))
    const ts = row.criado_em ? Date.parse(`${String(row.criado_em).replace(' ', 'T').replace(/Z?$/, '')}Z`) : NaN
    if (Number.isFinite(ts) && (atual.mais_recente == null || ts > atual.mais_recente)) atual.mais_recente = ts
    porConversa.set(id, atual)
  }
  return [...porConversa.values()]
    .map((c) => ({ ...c, tipos: [...c.tipos].sort() }))
    .sort((a, b) => (b.mais_recente || 0) - (a.mais_recente || 0))
}

/** Parse dos argumentos --chave=valor / --flag. Devolve { opts, erros }. */
function parseArgs(argv) {
  const raw = {}
  for (const arg of argv || []) {
    if (!String(arg).startsWith('--')) continue
    const [chave, ...resto] = String(arg).slice(2).split('=')
    raw[chave] = resto.length ? resto.join('=') : 'true'
  }

  const erros = []
  const num = (chave, padrao, { min, max }) => {
    if (raw[chave] == null) return padrao
    const n = Number(raw[chave])
    if (!Number.isFinite(n)) {
      erros.push(`--${chave} precisa ser número (recebi "${raw[chave]}").`)
      return padrao
    }
    return Math.max(min, Math.min(max, Math.floor(n)))
  }

  const companyId = Number(raw['company-id'])
  if (!Number.isFinite(companyId) || companyId <= 0) {
    erros.push('--company-id=N é obrigatório (nenhuma query de negócio roda sem empresa explícita).')
  }

  const modo = String(raw.modo || 'linhas').toLowerCase()
  if (!['linhas', 'lacunas', 'ambos'].includes(modo)) {
    erros.push(`--modo precisa ser linhas, lacunas ou ambos (recebi "${raw.modo}").`)
  }

  const conversa = raw.conversa != null ? Number(raw.conversa) : null
  if (raw.conversa != null && (!Number.isFinite(conversa) || conversa <= 0)) {
    erros.push(`--conversa precisa ser o id numérico da conversa (recebi "${raw.conversa}").`)
  }

  return {
    erros,
    opts: {
      companyId: Number.isFinite(companyId) ? companyId : null,
      apply: raw.apply === 'true',
      json: raw.json === 'true',
      dias: num('dias', 45, { min: 1, max: 365 }),
      limite: num('limite', 50, { min: 1, max: 1000 }),
      pausaMs: num('pausa-ms', 1500, { min: 0, max: 60_000 }),
      falhasMax: num('falhas-max', 5, { min: 1, max: 100 }),
      lacunaMinSeg: num('lacuna-min-seg', 120, { min: 10, max: 86_400 }),
      scanLacunas: num('scan-lacunas', 300, { min: 1, max: 5000 }),
      esperaFinalMs: num('espera-final-ms', 15_000, { min: 0, max: 300_000 }),
      conversa: Number.isFinite(conversa) && conversa > 0 ? conversa : null,
      modo,
    },
  }
}

/**
 * Erro de dados da própria conversa (sem telefone/JID utilizável) × erro do provedor.
 * Só o segundo alimenta o disjuntor: uma sequência de conversas criadas apenas com LID interno
 * não é motivo para abortar o lote inteiro.
 */
function erroEhDaConversa(mensagem) {
  const m = String(mensagem || '').toLowerCase()
  return m.includes('sem telefone')
    || m.includes('sem identificador')
    || m.includes('conversa nao encontrada')
    || m.includes('conversa não encontrada')
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function cutoffIsoUtc(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------------------------
// Daqui para baixo: I/O. Acima: puros (exercitados por tests/reparoMidiaSemLinkScript.test.js).
// ---------------------------------------------------------------------------------------------

/** Linhas quebradas da empresa na janela. Duas queries (tipo OU texto) unidas em memória. */
async function buscarLinhasQuebradas(supabase, { companyId, dias, conversaId }) {
  const SELECT = 'id, conversa_id, tipo, texto, url, whatsapp_id, criado_em, apagada_para_todos, apagada_pelo_cliente'
  const desde = cutoffIsoUtc(dias)

  // Ordem importa: no supabase-js v2, `order()`/`limit()` devolvem um TransformBuilder que já NÃO
  // tem `in()`/`eq()`. Todo filtro entra ANTES — senão estoura "q.in is not a function".
  const consulta = (coluna, valores) => {
    let q = supabase
      .from('mensagens')
      .select(SELECT)
      .eq('company_id', companyId)
      .gte('criado_em', desde)
      .in(coluna, valores)
    if (conversaId) q = q.eq('conversa_id', conversaId)
    return q.order('criado_em', { ascending: false }).limit(5000)
  }

  const [porTipo, porTexto] = await Promise.all([
    consulta('tipo', MEDIA_TIPOS),
    consulta('texto', PLACEHOLDER_TEXTS),
  ])

  if (porTipo.error) throw new Error(`consulta por tipo: ${porTipo.error.message}`)
  if (porTexto.error) throw new Error(`consulta por texto: ${porTexto.error.message}`)

  const porId = new Map()
  for (const row of [...(porTipo.data || []), ...(porTexto.data || [])]) porId.set(row.id, row)
  return [...porId.values()]
}

/**
 * Conversas com lacuna: `ultima_atividade` mais nova que a última mensagem gravada.
 * É PISTA, não prova — ACK, reação, edição e mensagem apagada também movem a atividade.
 */
async function buscarConversasComLacuna(supabase, { companyId, dias, lacunaMinSeg, scanLacunas }) {
  const desde = cutoffIsoUtc(dias)
  const { data: conversas, error } = await supabase
    .from('conversas')
    .select('id, telefone, ultima_atividade')
    .eq('company_id', companyId)
    .gte('ultima_atividade', desde)
    .order('ultima_atividade', { ascending: false })
    .limit(scanLacunas)

  if (error) throw new Error(`consulta de conversas: ${error.message}`)

  const achadas = []
  for (const conversa of conversas || []) {
    const { data: ultima, error: errMsg } = await supabase
      .from('mensagens')
      .select('criado_em')
      .eq('company_id', companyId)
      .eq('conversa_id', conversa.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (errMsg || !ultima?.criado_em) continue

    // criado_em é `timestamp without time zone` gravado em UTC: o sufixo Z é obrigatório, senão
    // o Date local introduz 3h de diferença e TODA conversa pareceria ter lacuna.
    const msgMs = Date.parse(`${String(ultima.criado_em).replace(' ', 'T').replace(/Z?$/, '')}Z`)
    const atividadeMs = Date.parse(conversa.ultima_atividade)
    if (!Number.isFinite(msgMs) || !Number.isFinite(atividadeMs)) continue

    const lacunaSeg = Math.round((atividadeMs - msgMs) / 1000)
    if (lacunaSeg > lacunaMinSeg) {
      achadas.push({ conversa_id: Number(conversa.id), telefone: conversa.telefone, lacuna_seg: lacunaSeg })
    }
  }
  return achadas.sort((a, b) => b.lacuna_seg - a.lacuna_seg)
}

async function main() {
  const { opts, erros } = parseArgs(process.argv.slice(2))
  if (erros.length) {
    console.error('❌ Argumentos inválidos:')
    for (const e of erros) console.error(`   • ${e}`)
    console.error('\n   Exemplo: node scripts/reparar-midia-sem-link.js --company-id=1')
    process.exit(1)
  }

  const supabase = require('../config/supabase')
  const { listWhatsappInstances } = require('../services/whatsappInstanceService')
  const { syncOldMessagesForConversation, CONTACT_HISTORY_WINDOW_DAYS } = require('../services/oldMessagesSyncService')

  console.log('=== Reparo retroativo — mídia recebida sem `link` do provedor ===')
  console.log(`empresa=${opts.companyId} · modo=${opts.modo} · janela=${opts.dias}d · limite=${opts.limite} conversas · pausa=${opts.pausaMs}ms`)
  console.log(opts.apply ? '>>> MODO APPLY: vai chamar o provedor e gravar.' : '>>> DRY-RUN: nada será chamado nem gravado (use --apply para executar).')
  console.log('')

  const instancias = await listWhatsappInstances(opts.companyId).catch((e) => ({ error: e?.message || String(e) }))
  if (instancias?.error) {
    console.warn(`⚠️  Não listei as instâncias (${instancias.error}) — segue, mas sem saber o provider.`)
  } else {
    const ativas = (instancias.instances || []).filter((i) => i && i.ativo !== false)
    console.log(`Instâncias ativas: ${ativas.map((i) => `${i.id}:${i.provider}${i.is_default ? '(default)' : ''}`).join(', ') || '(nenhuma)'}`)
    if (ativas.some((i) => String(i.provider).toLowerCase() === 'whapi') && opts.dias > CONTACT_HISTORY_WINDOW_DAYS) {
      console.warn(`⚠️  --dias=${opts.dias} acima da janela Whapi (${CONTACT_HISTORY_WINDOW_DAYS}d): o provedor não devolve nada mais antigo. Conversas fora da janela vão aparecer como "sem alteração".`)
    }
    console.log('')
  }

  /** @type {Array<{conversa_id:number, motivo:string, detalhe:string}>} */
  const alvos = []

  if (opts.conversa) {
    const linhas = await buscarLinhasQuebradas(supabase, { companyId: opts.companyId, dias: opts.dias, conversaId: opts.conversa })
    const grupo = agruparPorConversa(linhas)[0]
    alvos.push({
      conversa_id: opts.conversa,
      motivo: 'conversa_informada',
      detalhe: grupo
        ? `${grupo.linhas} linha(s) quebrada(s), ${grupo.reparaveis} reparável(is) [${grupo.tipos.join(',')}]`
        : 'nenhuma linha quebrada encontrada na janela (ainda vale a tentativa: pode haver mídia descartada sem linha)',
    })
  } else {
    if (opts.modo === 'linhas' || opts.modo === 'ambos') {
      const linhas = await buscarLinhasQuebradas(supabase, { companyId: opts.companyId, dias: opts.dias, conversaId: null })
      const grupos = agruparPorConversa(linhas)
      console.log(`Linhas quebradas na janela: ${linhas.filter(linhaQuebrada).length} em ${grupos.length} conversa(s).`)
      for (const g of grupos) {
        alvos.push({
          conversa_id: g.conversa_id,
          motivo: 'linhas_quebradas',
          detalhe: `${g.linhas} linha(s), ${g.reparaveis} com whatsapp_id, ${g.sem_whatsapp_id} sem [${g.tipos.join(',')}]`,
        })
      }
    }

    if (opts.modo === 'lacunas' || opts.modo === 'ambos') {
      const lacunas = await buscarConversasComLacuna(supabase, {
        companyId: opts.companyId,
        dias: opts.dias,
        lacunaMinSeg: opts.lacunaMinSeg,
        scanLacunas: opts.scanLacunas,
      })
      console.log(`Conversas com lacuna (> ${opts.lacunaMinSeg}s entre ultima_atividade e última mensagem): ${lacunas.length} de ${opts.scanLacunas} examinadas.`)
      console.log('   (pista, não prova: ACK, reação, edição e mensagem apagada também movem a atividade)')
      const jaListadas = new Set(alvos.map((a) => a.conversa_id))
      for (const l of lacunas) {
        if (jaListadas.has(l.conversa_id)) continue
        alvos.push({ conversa_id: l.conversa_id, motivo: 'lacuna_atividade', detalhe: `lacuna de ${l.lacuna_seg}s` })
      }
    }
  }

  const selecionados = alvos.slice(0, opts.limite)
  console.log('')
  console.log(`Alvos: ${alvos.length} conversa(s); vou processar ${selecionados.length} (limite ${opts.limite}).`)
  console.log('')
  for (const alvo of selecionados) {
    console.log(`  conversa ${alvo.conversa_id} · ${alvo.motivo} · ${alvo.detalhe}`)
  }

  if (!selecionados.length) {
    console.log('\n✅ Nada a reparar com esses filtros.')
    return
  }

  if (!opts.apply) {
    console.log('')
    console.log(`DRY-RUN encerrado: NENHUMA chamada ao provedor, NENHUMA gravação.`)
    console.log(`Para executar: node scripts/reparar-midia-sem-link.js --company-id=${opts.companyId} --modo=${opts.modo} --dias=${opts.dias} --limite=${opts.limite} --apply`)
    return
  }

  const resumo = {
    conversas: 0,
    inseridas: 0,
    atualizadas: 0,
    ignoradas: 0,
    sem_alteracao: 0,
    sem_identificador: 0,
    erros: [],
  }
  let falhasSeguidas = 0

  console.log('')
  for (const [indice, alvo] of selecionados.entries()) {
    const prefixo = `[${indice + 1}/${selecionados.length}] conversa ${alvo.conversa_id}`
    const res = await syncOldMessagesForConversation(opts.companyId, alvo.conversa_id, {
      io: null,
      source: 'script_reparo_midia_sem_link',
    }).catch((e) => ({ ok: false, error: e?.message || String(e) }))

    resumo.conversas += 1

    if (res?.ok !== true) {
      const motivo = String(res?.error || 'erro desconhecido').slice(0, 160)
      if (erroEhDaConversa(motivo)) {
        resumo.sem_identificador += 1
        console.log(`${prefixo} ⏭️  pulada: ${motivo}`)
        if (indice < selecionados.length - 1) await sleep(0)
        continue
      }
      falhasSeguidas += 1
      resumo.erros.push({ conversa_id: alvo.conversa_id, error: motivo })
      console.log(`${prefixo} ❌ ${motivo}`)
      if (falhasSeguidas >= opts.falhasMax) {
        console.error(`\n🛑 Disjuntor: ${falhasSeguidas} falhas seguidas (--falhas-max=${opts.falhasMax}). Abortando para não insistir contra o provedor.`)
        break
      }
    } else {
      falhasSeguidas = 0
      const inseridas = res.messagesInserted || 0
      const atualizadas = res.messagesUpdated || 0
      resumo.inseridas += inseridas
      resumo.atualizadas += atualizadas
      resumo.ignoradas += res.messagesSkipped || 0
      if (inseridas === 0 && atualizadas === 0) resumo.sem_alteracao += 1
      console.log(`${prefixo} ✅ inseridas=${inseridas} atualizadas=${atualizadas} ignoradas=${res.messagesSkipped || 0} lidas=${res.messagesFetched || 0}`)
    }

    if (indice < selecionados.length - 1) await sleep(opts.pausaMs)
  }

  if (opts.esperaFinalMs > 0 && (resumo.inseridas > 0 || resumo.atualizadas > 0)) {
    console.log(`\n⏳ Aguardando ${opts.esperaFinalMs}ms para as cópias de mídia em voo (/uploads) terminarem...`)
    await sleep(opts.esperaFinalMs)
    console.log('   O que não terminou aqui é retomado pelo scheduler de retry da API (roda a cada 1 min).')
  }

  console.log('')
  console.log('=== Resumo ===')
  console.log(`conversas processadas : ${resumo.conversas}`)
  console.log(`mensagens inseridas   : ${resumo.inseridas}   (mídia que o webhook havia descartado)`)
  console.log(`mensagens atualizadas : ${resumo.atualizadas}   (linha que ganhou URL/tipo/texto)`)
  console.log(`mensagens ignoradas   : ${resumo.ignoradas}   (já estavam completas)`)
  console.log(`sem alteração         : ${resumo.sem_alteracao} conversa(s) — provedor não tinha nada novo (fora da janela ou histórico não guardado)`)
  console.log(`puladas (sem telefone): ${resumo.sem_identificador} conversa(s) — só LID interno / sem JID: nada a buscar`)
  console.log(`erros                 : ${resumo.erros.length}`)
  for (const e of resumo.erros.slice(0, 10)) console.log(`   • conversa ${e.conversa_id}: ${e.error}`)
  console.log('')
  console.log('Confira o antes/depois com a consulta 10 de supabase/scripts_manuais/diagnostico/MIDIA_SEM_LINK_PASSIVO.sql')
  if (opts.json) console.log(`\nJSON: ${JSON.stringify(resumo)}`)
}

if (require.main === module) {
  require('../config/env').loadEnv?.()
  try { require('dotenv').config() } catch (_) {}
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('❌ Falha no script:', e?.message || e)
      process.exit(1)
    })
}

module.exports = {
  MEDIA_TIPOS,
  PLACEHOLDER_TEXTS,
  temUrlUtilizavel,
  linhaQuebrada,
  linhaReparavel,
  agruparPorConversa,
  parseArgs,
  cutoffIsoUtc,
  erroEhDaConversa,
  // Recebem o client por parâmetro de propósito: dá para exercitar a forma das queries em teste.
  buscarLinhasQuebradas,
  buscarConversasComLacuna,
}
