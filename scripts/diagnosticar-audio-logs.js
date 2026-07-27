#!/usr/bin/env node
/**
 * Lê os logs de produção e mede o que só o mundo real pode responder sobre áudio —
 * SOMENTE LEITURA, streaming (não carrega o log inteiro na memória).
 *
 * Perguntas que ele responde:
 *  - com que frequência uma gravação chega cortada ao servidor (o bug dos 30s → 3s)?
 *  - isso está concentrado em UMA empresa/atendente ou está espalhado?
 *  - o ffmpeg está disponível no host (transcode falhando = "grave novamente" ao atendente)?
 *  - mídia RECEBIDA está chegando cortada da UltraMsg?
 *  - qual o volume real de áudio por dia (base para dimensionar disco)?
 *
 * Uso na VPS:
 *   node scripts/diagnosticar-audio-logs.js
 *   node scripts/diagnosticar-audio-logs.js --dias 7
 *   node scripts/diagnosticar-audio-logs.js /caminho/out.log /caminho/error.log
 *
 * Sem argumentos, procura os logs padrão do PM2 (~/.pm2/logs/<app>-out.log e -error.log).
 * Logs já rotacionados em .gz não são lidos: descompacte antes se precisar do histórico.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const APP = 'whatsapp-plataforma-backend'

const MARCADORES = [
  {
    chave: 'envio_cortado',
    padrao: 'Envio abortado: gravação chegou incompleta',
    titulo: 'ENVIO recusado — gravação chegou cortada ao servidor',
    grave: true,
  },
  {
    chave: 'envio_transcode',
    padrao: 'Envio abortado: transcode falhou',
    titulo: 'ENVIO recusado — ffmpeg não conseguiu converter',
    grave: true,
  },
  {
    chave: 'transcode_falhou',
    padrao: '[ULTRAMSG][AUDIO] transcode falhou',
    titulo: 'Transcode falhou (ffmpeg indisponível ou entrada ilegível)',
    grave: true,
  },
  {
    chave: 'recebido_cortado',
    padrao: '[inboundMediaPersist] download incompleto',
    titulo: 'RECEBIMENTO — mídia do cliente chegou cortada (não persistida)',
    grave: true,
  },
  {
    chave: 'recebido_vazio',
    padrao: '[inboundMediaPersist] corpo vazio',
    titulo: 'RECEBIMENTO — corpo vazio (não persistido)',
    grave: true,
  },
  {
    chave: 'transcode_ok',
    padrao: '[ULTRAMSG][AUDIO] transcode ok',
    titulo: 'Áudios enviados e convertidos com sucesso',
    grave: false,
  },
  {
    chave: 'proxy_206_sem_range',
    padrao: 'origem devolveu 206 sem Content-Range',
    titulo: 'Proxy — origem violou o protocolo de Range (áudio pode não tocar)',
    grave: true,
  },
  {
    chave: 'uploads_404',
    padrao: '[uploads] 404 - arquivo não encontrado',
    titulo: 'Arquivo pedido não existe mais em /uploads (áudio mudo na bolha)',
    grave: true,
  },
]

function parseArgs(argv) {
  const arquivos = []
  let dias = 30
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dias') {
      const n = Number(argv[i + 1])
      if (Number.isFinite(n) && n > 0) dias = n
      i += 1
    } else if (!a.startsWith('--')) {
      arquivos.push(a)
    }
  }
  return { arquivos, dias }
}

function logsPadrao() {
  const base = path.join(os.homedir(), '.pm2', 'logs')
  return [path.join(base, `${APP}-out.log`), path.join(base, `${APP}-error.log`)].filter((p) => {
    try { return fs.existsSync(p) } catch { return false }
  })
}

/**
 * PM2 com `time: true` carimba a data em TODA linha — inclusive nas linhas de continuação
 * de um objeto impresso em várias linhas. Por isso não basta "linha com data = registro
 * novo": é preciso olhar o que vem DEPOIS do carimbo. O util.inspect do Node indenta as
 * linhas internas e fecha com `}`/`]`, então esse é o critério de continuação.
 */
const RE_TS = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:[ \t]?/
const RE_CONTINUACAO = /^(?:[ \t]|[}\])])/

function num(registro, campo) {
  const m = registro.match(new RegExp(`${campo}:\\s*'?(-?\\d+)'?`))
  return m ? Number(m[1]) : null
}

async function lerArquivo(arquivo, aoRegistro) {
  const rl = readline.createInterface({
    input: fs.createReadStream(arquivo, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let atual = null
  let dia = null
  const fechar = () => {
    if (atual != null) aoRegistro(atual, dia)
    atual = null
  }
  for await (const linha of rl) {
    const m = linha.match(RE_TS)
    // `conteudo` é a linha sem o carimbo do PM2 (ou a linha crua, se não houver carimbo).
    const conteudo = m ? linha.slice(m[0].length) : linha
    const continuacao = RE_CONTINUACAO.test(conteudo)
    if (continuacao && atual != null) {
      atual += '\n' + conteudo
      continue
    }
    fechar()
    atual = conteudo
    if (m) dia = m[1]
  }
  fechar()
}

function humanoMs(ms) {
  if (!Number.isFinite(ms)) return '?'
  return `${(ms / 1000).toFixed(1)}s`
}

async function main() {
  const { arquivos: passados, dias } = parseArgs(process.argv.slice(2))
  const arquivos = passados.length ? passados : logsPadrao()

  if (!arquivos.length) {
    console.error('Nenhum log encontrado. Passe os caminhos como argumento:')
    console.error('  node scripts/diagnosticar-audio-logs.js ~/.pm2/logs/*-out.log ~/.pm2/logs/*-error.log')
    console.error('Para descobrir onde estão:  pm2 describe ' + APP + ' | grep -i "log path"')
    process.exit(1)
  }

  const limite = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10)

  const stats = new Map(
    MARCADORES.map((m) => [m.chave, { total: 0, porDia: new Map(), porEmpresa: new Map(), amostras: [] }])
  )
  let registros = 0
  let semData = 0

  for (const arquivo of arquivos) {
    if (arquivo.endsWith('.gz')) {
      console.warn(`(ignorado, compactado: ${arquivo})`)
      continue
    }
    if (!fs.existsSync(arquivo)) {
      console.warn(`(não encontrado: ${arquivo})`)
      continue
    }
    await lerArquivo(arquivo, (registro, dia) => {
      registros += 1
      if (dia == null) semData += 1
      else if (dia < limite) return

      for (const marc of MARCADORES) {
        if (!registro.includes(marc.padrao)) continue
        const s = stats.get(marc.chave)
        s.total += 1
        const k = dia || 'sem-data'
        s.porDia.set(k, (s.porDia.get(k) || 0) + 1)
        const cid = num(registro, 'company_id')
        if (cid != null) s.porEmpresa.set(cid, (s.porEmpresa.get(cid) || 0) + 1)
        if (s.amostras.length < 5) {
          s.amostras.push({
            dia: k,
            company_id: cid,
            conversa_id: num(registro, 'conversa_id'),
            gravadoMs: num(registro, 'gravadoMs'),
            recebidoMs: num(registro, 'recebidoMs'),
          })
        }
      }
    })
  }

  const l = (s = '') => console.log(s)
  l('='.repeat(66))
  l(`DIAGNÓSTICO DE ÁUDIO NOS LOGS — últimos ${dias} dias`)
  l('='.repeat(66))
  l(`Arquivos lidos: ${arquivos.join(', ')}`)
  l(`Registros percorridos: ${registros}${semData ? ` (${semData} sem data — PM2 sem time:true?)` : ''}`)
  l()

  const enviados = stats.get('transcode_ok').total
  const cortados = stats.get('envio_cortado').total
  const transcodeRuim = stats.get('envio_transcode').total + stats.get('transcode_falhou').total

  for (const marc of MARCADORES) {
    const s = stats.get(marc.chave)
    if (s.total === 0) continue
    l(`${marc.grave ? '[!]' : '[ ]'} ${marc.titulo}`)
    l(`    ocorrências: ${s.total}`)
    const diasOrd = [...s.porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    if (diasOrd.length <= 20) {
      for (const [d, n] of diasOrd) l(`      ${d}  ${n}`)
    } else {
      for (const [d, n] of diasOrd.slice(-14)) l(`      ${d}  ${n}`)
      l(`      (${diasOrd.length - 14} dia(s) anteriores omitidos)`)
    }
    if (s.porEmpresa.size) {
      const emp = [...s.porEmpresa.entries()].sort((a, b) => b[1] - a[1])
      l(`    por empresa: ${emp.map(([c, n]) => `company_id ${c}: ${n}`).join(' | ')}`)
      // Só conclui concentração com amostra suficiente: com 1 ou 2 casos, "tudo numa
      // empresa" é o esperado por acaso e apontaria o dedo para o cliente errado.
      const MIN_AMOSTRA_CONCENTRACAO = 5
      if (s.total < MIN_AMOSTRA_CONCENTRACAO) {
        l(`      (amostra pequena: ${s.total} caso(s) — insuficiente para concluir concentração)`)
      } else if (emp.length === 1) {
        l('      >>> CONCENTRADO EM UMA EMPRESA — investigar rede/aparelhos desse cliente.')
      } else if (emp[0][1] > s.total * 0.7) {
        l(`      >>> ${((emp[0][1] / s.total) * 100).toFixed(0)}% em company_id ${emp[0][0]} — investigar esse cliente primeiro.`)
      } else {
        l('      >>> espalhado entre empresas — não é ambiente de um cliente só.')
      }
    }
    if (marc.chave === 'envio_cortado' && s.amostras.length) {
      l('    amostras (gravado → recebido):')
      for (const a of s.amostras) {
        l(`      ${a.dia} company_id ${a.company_id ?? '?'} conversa ${a.conversa_id ?? '?'}: ${humanoMs(a.gravadoMs)} → ${humanoMs(a.recebidoMs)}`)
      }
    }
    l()
  }

  l('-'.repeat(66))
  l('LEITURA DOS NÚMEROS')
  l('-'.repeat(66))
  if (enviados === 0 && cortados === 0) {
    l('Nenhum áudio no período. Ou o log é novo/rotacionado, ou a correção ainda')
    l('não foi para produção. Confira a data do arquivo antes de concluir algo.')
  } else {
    l(`Áudios enviados com sucesso: ${enviados}`)
    l(`Gravações recusadas por chegarem cortadas: ${cortados}`)
    if (enviados + cortados > 0) {
      const pct = ((cortados / (enviados + cortados)) * 100).toFixed(2)
      l(`Taxa de corte: ${pct}%`)
      if (cortados === 0) {
        l('  → Nada foi cortado. A vigia do microfone no navegador está segurando o problema')
        l('    antes de chegar ao servidor (é o resultado esperado).')
      } else if (Number(pct) < 1) {
        l('  → Taxa baixa: casos pontuais (microfone desconectado, rede ruim no envio).')
        l('    O atendente foi avisado para gravar de novo — nenhum contato recebeu áudio cortado.')
      } else {
        l('  → Taxa ALTA. Algo está cortando gravações de forma sistemática. Olhe a coluna')
        l('    "por empresa" acima e as amostras: se concentra em uma empresa, o problema é')
        l('    de rede/aparelho lá; se está espalhado, há mecanismo de perda ainda não coberto.')
      }
    }
  }
  if (transcodeRuim > 0) {
    l()
    l(`[!] ${transcodeRuim} falha(s) de transcode. Se for recorrente, o ffmpeg do host está`)
    l('    indisponível ou quebrado — nesse estado o atendente recebe "grave novamente" e')
    l('    NENHUM áudio é enviado. Confira ffmpeg-static / FFMPEG_PATH na VPS.')
  }
  const rec = stats.get('recebido_cortado').total + stats.get('recebido_vazio').total
  if (rec > 0) {
    l()
    l(`[!] ${rec} mídia(s) recebida(s) chegaram cortadas da UltraMsg e não foram salvas.`)
    l('    A varredura de retry tenta de novo por 7 dias. Se o número for alto e persistente,')
    l('    é rede da VPS para o CDN da UltraMsg — mídia antiga pode se perder quando o link expira.')
  }
  if (stats.get('uploads_404').total > 0) {
    l()
    l(`[!] ${stats.get('uploads_404').total} pedido(s) a arquivos que não existem mais em /uploads.`)
    l('    Isso é áudio mudo na tela do atendente. Causa comum: UPLOADS_DIR não persistente')
    l('    (deploy recriou a pasta). Confira com scripts/diagnosticar-uploads.js.')
  }
  l()
  l('Nada foi alterado. Somente leitura.')
}

main().catch((e) => {
  console.error('Falha ao analisar logs:', e?.message || e)
  process.exit(1)
})
