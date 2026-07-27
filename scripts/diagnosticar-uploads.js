#!/usr/bin/env node
/**
 * Diagnóstico do diretório de mídias (/uploads) — SOMENTE LEITURA.
 *
 * Responde, com números, as perguntas que decidem a política de retenção:
 *  - quanto está ocupado hoje, e por qual tipo de mídia;
 *  - quanto entra por dia (e, no ritmo atual, quantos dias até o volume encher);
 *  - quanto do espaço é histórico antigo (o que uma retenção liberaria de fato);
 *  - quais empresas mais consomem (mídia recebida traz o company_id no nome).
 *
 * NÃO apaga, não move e não escreve nada. Pode rodar em produção com o app no ar.
 *
 * Uso na VPS:
 *   cd /caminho/do/backend && node scripts/diagnosticar-uploads.js
 *   node scripts/diagnosticar-uploads.js --json        # saída para máquina
 *   UPLOADS_DIR=/mnt/dados/uploads node scripts/diagnosticar-uploads.js
 */

const fs = require('fs')
const path = require('path')

const JSON_OUT = process.argv.includes('--json')

const EXT_AUDIO = new Set(['.ogg', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.amr', '.webm'])
const EXT_IMAGEM = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'])
const EXT_VIDEO = new Set(['.mp4', '.mov', '.avi', '.3gp', '.m4v', '.mkv', '.mpeg', '.ogv'])
const EXT_DOC = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.rar', '.7z'])

/** .webm é ambíguo (áudio do MediaRecorder ou vídeo); classifica pelo prefixo do nome. */
function categoria(nome) {
  const ext = path.extname(nome).toLowerCase()
  if (ext === '.webm') return 'ambiguo_webm'
  if (EXT_AUDIO.has(ext)) return 'audio'
  if (EXT_IMAGEM.has(ext)) return 'imagem'
  if (EXT_VIDEO.has(ext)) return 'video'
  if (EXT_DOC.has(ext)) return 'documento'
  return 'outro'
}

/** Mídia recebida é gravada como `inbound-c<company>-m<mensagem>-<rand>.ext`. */
function companyIdDoNome(nome) {
  const m = String(nome).match(/^inbound-c(\d+)-m\d+/i)
  return m ? Number(m[1]) : null
}

function humano(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(bytes) || 0
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

function espacoLivre(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const s = fs.statfsSync(dir)
    const total = Number(s.blocks) * Number(s.bsize)
    const livre = Number(s.bavail) * Number(s.bsize)
    if (!Number.isFinite(total) || total <= 0) return null
    return { total, livre, usado: total - livre }
  } catch {
    return null
  }
}

const FAIXAS = [
  { rotulo: 'até 3 dias', maxDias: 3 },
  { rotulo: '3 a 7 dias', maxDias: 7 },
  { rotulo: '7 a 30 dias', maxDias: 30 },
  { rotulo: '30 a 90 dias', maxDias: 90 },
  { rotulo: 'mais de 90 dias', maxDias: Infinity },
]

function main() {
  const { getUploadsRoot } = require('../config/uploadsRoot')
  const root = getUploadsRoot()
  const uploadsDirDefinido = Boolean(String(process.env.UPLOADS_DIR || '').trim())

  if (!fs.existsSync(root)) {
    console.error(`Diretório de uploads não existe: ${root}`)
    process.exit(1)
  }

  let entradas
  try {
    entradas = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    console.error(`Não foi possível ler ${root}: ${e.message}`)
    process.exit(1)
  }

  const agora = Date.now()
  const porCategoria = new Map()
  const porFaixa = FAIXAS.map((f) => ({ ...f, arquivos: 0, bytes: 0 }))
  const porEmpresa = new Map()
  const porDia = new Map()
  let arquivos = 0
  let bytes = 0
  let inboundArquivos = 0
  let inboundBytes = 0
  let maisAntigo = null
  let ilegiveis = 0

  for (const ent of entradas) {
    if (!ent.isFile()) continue
    const nome = ent.name
    let st
    try {
      st = fs.statSync(path.join(root, nome))
    } catch {
      ilegiveis += 1
      continue
    }

    arquivos += 1
    bytes += st.size

    const cat = categoria(nome)
    const c = porCategoria.get(cat) || { arquivos: 0, bytes: 0 }
    c.arquivos += 1
    c.bytes += st.size
    porCategoria.set(cat, c)

    const idadeDias = (agora - st.mtimeMs) / 86400000
    for (const faixa of porFaixa) {
      if (idadeDias <= faixa.maxDias) {
        faixa.arquivos += 1
        faixa.bytes += st.size
        break
      }
    }
    if (maisAntigo == null || st.mtimeMs < maisAntigo) maisAntigo = st.mtimeMs

    const cid = companyIdDoNome(nome)
    if (cid != null) {
      inboundArquivos += 1
      inboundBytes += st.size
      const e = porEmpresa.get(cid) || { arquivos: 0, bytes: 0 }
      e.arquivos += 1
      e.bytes += st.size
      porEmpresa.set(cid, e)
    }

    // Ritmo de entrada: só os últimos 14 dias, que é o que representa o uso atual.
    if (idadeDias <= 14) {
      const dia = new Date(st.mtimeMs).toISOString().slice(0, 10)
      const d = porDia.get(dia) || { arquivos: 0, bytes: 0 }
      d.arquivos += 1
      d.bytes += st.size
      porDia.set(dia, d)
    }
  }

  const dias = [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  // Descarta o dia corrente (incompleto) para a média não sair subestimada.
  const hoje = new Date(agora).toISOString().slice(0, 10)
  const diasCompletos = dias.filter(([d]) => d !== hoje)
  const bytesPorDia = diasCompletos.length
    ? Math.round(diasCompletos.reduce((s, [, v]) => s + v.bytes, 0) / diasCompletos.length)
    : null

  const disco = espacoLivre(root)
  const diasAteEncher =
    disco && bytesPorDia && bytesPorDia > 0 ? Math.floor(disco.livre / bytesPorDia) : null

  const empresas = [...porEmpresa.entries()]
    .map(([company_id, v]) => ({ company_id, ...v }))
    .sort((a, b) => b.bytes - a.bytes)

  const relatorio = {
    diretorio: root,
    uploads_dir_configurado: uploadsDirDefinido,
    arquivos,
    bytes,
    ilegiveis,
    mais_antigo: maisAntigo ? new Date(maisAntigo).toISOString() : null,
    recebidos: { arquivos: inboundArquivos, bytes: inboundBytes },
    por_categoria: Object.fromEntries([...porCategoria.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
    por_faixa_de_idade: porFaixa.map((f) => ({ faixa: f.rotulo, arquivos: f.arquivos, bytes: f.bytes })),
    por_dia_ultimos_14: Object.fromEntries(dias),
    media_bytes_por_dia: bytesPorDia,
    disco,
    dias_ate_encher: diasAteEncher,
    top_empresas_recebidos: empresas.slice(0, 10),
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(relatorio, null, 2))
    return
  }

  const l = (s = '') => console.log(s)
  l('='.repeat(62))
  l('DIAGNÓSTICO DE /uploads (somente leitura)')
  l('='.repeat(62))
  l(`Diretório: ${root}`)
  if (!uploadsDirDefinido) {
    l('  ATENÇÃO: UPLOADS_DIR não está definido. O diretório fica dentro da pasta')
    l('  do app — um deploy que recrie a pasta APAGA todas as mídias.')
  }
  l(`Total: ${arquivos} arquivos, ${humano(bytes)}`)
  if (ilegiveis) l(`  (${ilegiveis} arquivo(s) não puderam ser lidos)`)
  if (maisAntigo) l(`Mais antigo: ${new Date(maisAntigo).toISOString().slice(0, 10)}`)
  l()

  l('Por tipo de mídia:')
  for (const [cat, v] of [...porCategoria.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const pct = bytes ? ((v.bytes / bytes) * 100).toFixed(1) : '0.0'
    l(`  ${String(cat).padEnd(14)} ${String(v.arquivos).padStart(7)} arq  ${humano(v.bytes).padStart(9)}  ${pct.padStart(5)}%`)
  }
  l('  (ambiguo_webm = .webm; pode ser áudio do navegador ou vídeo)')
  l()

  l('Por idade (o que uma retenção liberaria):')
  let acumulado = 0
  for (const f of porFaixa) {
    acumulado += f.bytes
    const pct = bytes ? ((f.bytes / bytes) * 100).toFixed(1) : '0.0'
    l(`  ${f.rotulo.padEnd(16)} ${String(f.arquivos).padStart(7)} arq  ${humano(f.bytes).padStart(9)}  ${pct.padStart(5)}%`)
  }
  const maisDe7 = porFaixa.slice(2).reduce((s, f) => s + f.bytes, 0)
  const maisDe30 = porFaixa.slice(3).reduce((s, f) => s + f.bytes, 0)
  l(`  → apagar acima de 7 dias liberaria  ${humano(maisDe7)}`)
  l(`  → apagar acima de 30 dias liberaria ${humano(maisDe30)}`)
  l()

  l('Ritmo de entrada (últimos 14 dias):')
  if (!dias.length) {
    l('  nenhum arquivo recente — sem dados para projetar crescimento')
  } else {
    for (const [dia, v] of dias) {
      l(`  ${dia}  ${String(v.arquivos).padStart(6)} arq  ${humano(v.bytes).padStart(9)}${dia === hoje ? '  (hoje, parcial)' : ''}`)
    }
    if (bytesPorDia != null) l(`  média/dia (dias completos): ${humano(bytesPorDia)}`)
  }
  l()

  if (disco) {
    const pctUso = ((disco.usado / disco.total) * 100).toFixed(1)
    l('Volume:')
    l(`  total ${humano(disco.total)} | usado ${humano(disco.usado)} (${pctUso}%) | livre ${humano(disco.livre)}`)
    if (diasAteEncher != null) {
      l(`  No ritmo atual, o volume enche em ~${diasAteEncher} dias.`)
      if (diasAteEncher < 60) l('  >>> ATENÇÃO: margem curta. Disco cheio = áudio deixa de ser enviado E')
      if (diasAteEncher < 60) l('  >>> a mídia recebida se perde de vez quando o link da UltraMsg expira (~24h).')
    }
  } else {
    l('Volume: não foi possível ler o espaço livre neste sistema.')
    l('  Rode:  df -h ' + root)
  }
  l()

  if (empresas.length) {
    l('Empresas que mais ocupam (só mídia RECEBIDA, que traz company_id no nome):')
    for (const e of empresas.slice(0, 10)) {
      l(`  company_id ${String(e.company_id).padStart(5)}  ${String(e.arquivos).padStart(7)} arq  ${humano(e.bytes).padStart(9)}`)
    }
    l(`  (mídia ENVIADA não tem company_id no nome: ${humano(bytes - inboundBytes)} não atribuídos)`)
  }
  l()
  l('='.repeat(62))
  l('Nada foi apagado. Envie esta saída antes de decidir política de retenção:')
  l('a escolha é entre aumentar o volume, apagar histórico (áudio antigo deixa')
  l('de tocar) ou mover para armazenamento de objetos.')
  l('='.repeat(62))
}

main()
