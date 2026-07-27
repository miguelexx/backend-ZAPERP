#!/usr/bin/env node
/**
 * Diagnóstico e reparo de mensagens outbound que NÃO chegaram ao cliente.
 *
 * Motivo: com o WhatsApp/instância fora do ar, a UltraMSG ACEITA o POST (`sent:true` + id numérico de
 * fila) e apenas enfileira. A mensagem fica em `status='pending'` (relógio no atendimento) e o cliente
 * nunca recebe. Este script mostra, mensagem por mensagem, onde ela realmente está — e sabe reenviar
 * só o que comprovadamente não saiu.
 *
 * USO (rodar na VPS, dentro de backend/):
 *
 *   # 1) Diagnóstico — não envia nada, não altera nada
 *   node scripts/diagnosticar-entrega-mensagens.js --horas=72
 *   node scripts/diagnosticar-entrega-mensagens.js --conversa=1234
 *   node scripts/diagnosticar-entrega-mensagens.js --telefone=5534984080098
 *
 *   # 2) Reparo — reenvia APENAS o que o provedor não tem registro / está preso na fila
 *   node scripts/diagnosticar-entrega-mensagens.js --conversa=1234 --reenviar
 *
 * Proteção contra duplicidade: antes de reenviar, consulta a UltraMSG por referenceId (crm-<id>).
 *   - provedor já entregou (sent/delivered/read) -> NÃO reenvia, só corrige o status no banco
 *   - provedor tem na fila (queue)               -> pede resendById (destrava), não cria mensagem nova
 *   - provedor não tem registro                  -> reenvia de verdade (texto ou mídia de /uploads)
 */

require('dotenv').config()

const path = require('path')
const fs = require('fs')
const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { getUploadsRoot } = require('../config/uploadsRoot')
const {
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
  extractUltraMsgMessageId,
} = require('../helpers/whatsappMessageIdHelper')

const SUCESSO = ['sent', 'server', 'device', 'read', 'played', 'delivered']
const FALHA = ['unsent', 'invalid', 'expired', 'failed', 'error', 'erro']
const MIDIA_TIPOS = new Set(['voice', 'audio', 'imagem', 'video', 'arquivo', 'sticker'])

function parseArgs(argv) {
  const out = { horas: 72, reenviar: false, limite: 200 }
  for (const arg of argv.slice(2)) {
    const m = String(arg).match(/^--([a-zA-Z]+)(?:=(.*))?$/)
    if (!m) continue
    const [, key, value] = m
    if (key === 'reenviar') out.reenviar = true
    else if (key === 'conversa') out.conversa = Number(value)
    else if (key === 'company') out.company = Number(value)
    else if (key === 'telefone') out.telefone = String(value || '').replace(/\D/g, '')
    else if (key === 'horas') out.horas = Math.max(1, Number(value) || 72)
    else if (key === 'limite') out.limite = Math.max(1, Number(value) || 200)
    else if (key === 'mensagem') out.mensagem = Number(value)
  }
  return out
}

function statusDe(row) {
  return String(row?.status ?? '').trim().toLowerCase()
}

function resumoTexto(m) {
  return String(m.texto || m.nome_arquivo || m.url || '').replace(/\s+/g, ' ').slice(0, 58)
}

function resolveArquivoLocal(url) {
  const s = String(url || '').trim()
  if (!s.startsWith('/uploads/')) return null
  const filename = path.basename(s)
  if (!filename || filename === '.' || filename === '..') return null
  return path.join(getUploadsRoot(), filename)
}

async function consultarProvedor(m) {
  const provider = getProvider()
  if (!provider?.getMessages) return { consultado: false, lista: [] }
  const opts = { companyId: m.company_id, whatsappInstanceId: m.whatsapp_instance_id || undefined }
  const referenceId = buildCrmReferenceId(m.id)

  const tentativas = []
  if (referenceId) tentativas.push({ referenceId })
  for (const id of [m.provider_queue_id, m.whatsapp_id]) {
    const s = id == null ? '' : String(id).trim()
    if (s && isUltramsgNumericQueueId(s)) tentativas.push({ id: s })
  }

  for (const filtro of tentativas) {
    try {
      const res = await provider.getMessages({ ...opts, ...filtro, status: 'all', page: 1, limit: 5, sort: 'desc' })
      if (res?.ok && Array.isArray(res.data) && res.data.length) {
        return { consultado: true, lista: res.data, via: Object.keys(filtro)[0] }
      }
    } catch (e) {
      return { consultado: false, lista: [], erro: e?.message || String(e) }
    }
  }
  return { consultado: true, lista: [] }
}

function classificar(hit) {
  if (!hit.consultado) return { classe: 'INDETERMINADO', detalhe: hit.erro || 'consulta ao provedor falhou' }
  if (!hit.lista.length) return { classe: 'NUNCA_SAIU', detalhe: 'provedor não tem registro desta mensagem' }
  const st = hit.lista.map(statusDe)
  if (st.some((s) => SUCESSO.includes(s))) return { classe: 'ENTREGUE', detalhe: `provedor: ${st.join(',')}` }
  if (st.some((s) => s === 'queue')) return { classe: 'NA_FILA', detalhe: 'aguardando instância reconectar' }
  if (st.some((s) => FALHA.includes(s))) return { classe: 'FALHOU', detalhe: `provedor: ${st.join(',')}` }
  return { classe: 'INDETERMINADO', detalhe: `provedor: ${st.join(',')}` }
}

async function patch(m, updates) {
  const { error } = await supabase
    .from('mensagens')
    .update(updates)
    .eq('company_id', m.company_id)
    .eq('id', m.id)
  if (error) console.log(`      ! falha ao atualizar banco: ${error.message}`)
}

async function reenviarTexto(m, telefone) {
  const provider = getProvider()
  const texto = String(m.texto || '').trim()
  if (!texto) return { ok: false, error: 'mensagem sem texto' }
  return provider.sendText(telefone, texto, {
    companyId: m.company_id,
    conversaId: m.conversa_id,
    whatsappInstanceId: m.whatsapp_instance_id || undefined,
    referenceId: `crm-${m.id}`,
    sendOrigin: 'reparo_manual_script',
  })
}

async function reenviarMidia(m, telefone) {
  const provider = getProvider()
  const tipo = String(m.tipo || '').toLowerCase().trim()
  const filePath = resolveArquivoLocal(m.url)
  if (!filePath) return { ok: false, error: 'mídia sem /uploads (não é reenviável)' }
  if (!fs.existsSync(filePath)) return { ok: false, error: `arquivo ausente no disco: ${filePath}` }
  if (!provider.uploadMedia) return { ok: false, error: 'provider.uploadMedia indisponível' }

  const displayName = m.nome_arquivo || path.basename(filePath)
  const up = await provider.uploadMedia(filePath, displayName, {
    companyId: m.company_id,
    whatsappInstanceId: m.whatsapp_instance_id || undefined,
  })
  if (!up?.ok || !up?.url) return { ok: false, error: up?.error || 'upload para o CDN falhou' }

  const opts = {
    companyId: m.company_id,
    conversaId: m.conversa_id,
    whatsappInstanceId: m.whatsapp_instance_id || undefined,
    referenceId: `crm-${m.id}`,
    sendOrigin: 'reparo_manual_script',
    returnDetails: true,
    ...(tipo === 'voice' || tipo === 'audio' ? { audioMeta: { originalName: displayName } } : {}),
  }

  if (tipo === 'voice' && provider.sendVoice) return provider.sendVoice(telefone, up.url, opts)
  if (tipo === 'audio' && provider.sendAudio) return provider.sendAudio(telefone, up.url, opts)
  if (tipo === 'sticker' && provider.sendSticker) return provider.sendSticker(telefone, up.url, { ...opts, stickerAuthor: 'ZapERP' })
  if (tipo === 'imagem' && provider.sendImage) return provider.sendImage(telefone, up.url, '', opts)
  if (tipo === 'video' && provider.sendVideo) return provider.sendVideo(telefone, up.url, '', opts)
  if (provider.sendFile) return provider.sendFile(telefone, up.url, displayName, { ...opts, caption: '' })
  return { ok: false, error: 'método de envio indisponível para o tipo' }
}

async function main() {
  const args = parseArgs(process.argv)
  const provider = getProvider()

  console.log('==========================================================')
  console.log(' DIAGNÓSTICO DE ENTREGA — mensagens outbound presas')
  console.log('==========================================================')
  console.log(` modo: ${args.reenviar ? 'REPARO (vai reenviar)' : 'SOMENTE LEITURA'}`)
  console.log(` janela: últimas ${args.horas}h | limite: ${args.limite}`)
  if (args.conversa) console.log(` conversa_id: ${args.conversa}`)
  if (args.telefone) console.log(` telefone: ...${args.telefone.slice(-6)}`)
  if (args.mensagem) console.log(` mensagem_id: ${args.mensagem}`)
  console.log('')

  // ---------- 1) Mensagens presas ----------
  const desde = new Date(Date.now() - args.horas * 3600_000).toISOString()
  let q = supabase
    .from('mensagens')
    .select('id, company_id, conversa_id, tipo, status, status_mensagem, whatsapp_id, provider_queue_id, criado_em, autor_usuario_id, texto, url, nome_arquivo, whatsapp_instance_id')
    .eq('direcao', 'out')
    .in('status', ['pending', 'sending', 'erro'])
    .gte('criado_em', desde)
    .order('criado_em', { ascending: true })
    .limit(args.limite)

  if (args.company) q = q.eq('company_id', args.company)
  if (args.conversa) q = q.eq('conversa_id', args.conversa)
  if (args.mensagem) q = q.eq('id', args.mensagem)

  if (args.telefone) {
    let cq = supabase.from('conversas').select('id').ilike('telefone', `%${args.telefone.slice(-8)}%`).limit(50)
    if (args.company) cq = cq.eq('company_id', args.company)
    const { data: convs } = await cq
    const ids = (convs || []).map((c) => c.id)
    if (!ids.length) {
      console.log('Nenhuma conversa encontrada para esse telefone.')
      return
    }
    q = q.in('conversa_id', ids)
  }

  const { data: msgs, error } = await q
  if (error) {
    console.log('ERRO ao consultar mensagens:', error.message)
    process.exitCode = 1
    return
  }
  if (!msgs?.length) {
    console.log('✅ Nenhuma mensagem outbound presa (pending/sending/erro) na janela consultada.')
    return
  }

  // ---------- 2) Status da instância por empresa ----------
  const companies = [...new Set(msgs.map((m) => m.company_id))]
  console.log('--- STATUS DA INSTÂNCIA WHATSAPP ---')
  const connByCompany = new Map()
  for (const cid of companies) {
    let linha = `company ${cid}: `
    try {
      const st = await provider.getConnectionStatus({ companyId: cid })
      connByCompany.set(cid, st)
      linha += st?.configured === false
        ? '❌ SEM INSTÂNCIA CONFIGURADA'
        : st?.connected
          ? `✅ conectada${st.phone ? ` (${st.phone})` : ''}`
          : '⚠️  DESCONECTADA — mensagens ficam na fila e não chegam ao cliente'
    } catch (e) {
      linha += `erro ao consultar: ${e?.message || e}`
    }
    if (provider.getMessagesStatistics) {
      try {
        const stats = await provider.getMessagesStatistics({ companyId: cid })
        if (stats) linha += ` | fila UltraMSG: ${JSON.stringify(stats)}`
      } catch (_) {}
    }
    console.log(' ' + linha)
  }
  console.log('')

  // ---------- 3) Telefones das conversas ----------
  const convIds = [...new Set(msgs.map((m) => m.conversa_id))]
  const { data: convRows } = await supabase
    .from('conversas')
    .select('id, telefone, nome_contato_cache, cliente_id')
    .in('id', convIds)
  const convById = new Map((convRows || []).map((c) => [c.id, c]))

  // ---------- 4) Mensagem por mensagem ----------
  console.log(`--- ${msgs.length} MENSAGEM(NS) PRESA(S) ---`)
  const resumo = { ENTREGUE: 0, NA_FILA: 0, NUNCA_SAIU: 0, FALHOU: 0, INDETERMINADO: 0 }
  const acoes = { corrigido_status: 0, resend_solicitado: 0, reenviado: 0, falha_reenvio: 0, ignorado: 0 }

  for (const m of msgs) {
    const conv = convById.get(m.conversa_id)
    const idadeMin = Math.round((Date.now() - Date.parse(m.criado_em)) / 60000)
    console.log('')
    console.log(`[msg ${m.id}] conversa ${m.conversa_id} (${conv?.nome_contato_cache || '—'}) ${m.tipo} · ${m.status}/${m.status_mensagem} · há ${idadeMin}min`)
    console.log(`   texto: "${resumoTexto(m)}"`)
    console.log(`   whatsapp_id=${m.whatsapp_id || '-'} provider_queue_id=${m.provider_queue_id || '-'}`)

    if (isRealWhatsAppId(m.whatsapp_id)) {
      console.log('   → JÁ TEM ID REAL DO WHATSAPP: foi entregue; só o status ficou atrasado.')
      resumo.ENTREGUE++
      if (args.reenviar) {
        await patch(m, { status: 'sent', status_mensagem: 'sent' })
        acoes.corrigido_status++
        console.log('   ✔ status corrigido para sent')
      }
      continue
    }

    const hit = await consultarProvedor(m)
    const { classe, detalhe } = classificar(hit)
    resumo[classe]++
    console.log(`   → ${classe}: ${detalhe}${hit.via ? ` (via ${hit.via})` : ''}`)

    if (!args.reenviar) {
      acoes.ignorado++
      continue
    }

    const telefone = conv?.telefone || ''
    if (!telefone || telefone.startsWith('lid:')) {
      console.log('   ✖ sem telefone utilizável nesta conversa — não é possível reenviar')
      acoes.falha_reenvio++
      continue
    }

    if (classe === 'ENTREGUE') {
      const waId = extractUltraMsgMessageId(hit.lista[0])
      await patch(m, {
        status: 'sent',
        status_mensagem: 'sent',
        ...(isRealWhatsAppId(waId) ? { whatsapp_id: String(waId).trim() } : {}),
      })
      acoes.corrigido_status++
      console.log('   ✔ já entregue — status corrigido, NÃO reenviado')
      continue
    }

    if (classe === 'NA_FILA') {
      const queueId = [hit.lista[0]?.id, m.provider_queue_id, m.whatsapp_id]
        .map((v) => (v == null ? '' : String(v).trim()))
        .find((s) => s && isUltramsgNumericQueueId(s))
      if (queueId && provider.resendById) {
        const r = await provider.resendById(queueId, { companyId: m.company_id, whatsappInstanceId: m.whatsapp_instance_id || undefined })
        acoes.resend_solicitado++
        console.log(`   ✔ resendById(${queueId}) solicitado — ok=${r?.ok === true}`)
        console.log('     (se a instância estiver desconectada, só sai de fato após reconectar o WhatsApp)')
      } else {
        console.log('   ⓘ na fila sem queue id utilizável — reconecte o WhatsApp para a fila escoar')
        acoes.ignorado++
      }
      continue
    }

    if (classe === 'NUNCA_SAIU' || classe === 'FALHOU') {
      const conectada = connByCompany.get(m.company_id)?.connected === true
      if (!conectada) {
        console.log('   ⚠ instância desconectada — reenviar agora só recriaria fila. Reconecte o WhatsApp e rode de novo.')
        acoes.ignorado++
        continue
      }
      const ehMidia = MIDIA_TIPOS.has(String(m.tipo || '').toLowerCase().trim())
      const r = ehMidia ? await reenviarMidia(m, telefone) : await reenviarTexto(m, telefone)
      const ok = typeof r === 'boolean' ? r : r?.ok === true
      const newId = typeof r === 'object' && r?.messageId ? String(r.messageId).trim() : null
      if (ok) {
        await patch(m, {
          status: isRealWhatsAppId(newId) ? 'sent' : 'pending',
          status_mensagem: isRealWhatsAppId(newId) ? 'sent' : 'sending',
          ...(isRealWhatsAppId(newId) ? { whatsapp_id: newId } : {}),
          ...(newId && isUltramsgNumericQueueId(newId) ? { provider_queue_id: newId } : {}),
        })
        acoes.reenviado++
        console.log(`   ✔ REENVIADO (${ehMidia ? 'mídia' : 'texto'}) — provider id=${newId || 'sem id'}`)
      } else {
        acoes.falha_reenvio++
        console.log(`   ✖ falha no reenvio: ${(typeof r === 'object' && (r?.error || r?.blockedBy)) || 'desconhecido'}`)
      }
      continue
    }

    console.log('   ⓘ estado indeterminado — não reenviado (evita duplicar para o cliente)')
    acoes.ignorado++
  }

  console.log('')
  console.log('==========================================================')
  console.log(' RESUMO')
  console.log('==========================================================')
  console.log(' classificação:', resumo)
  console.log(' ações:', args.reenviar ? acoes : '(nenhuma — rode com --reenviar)')
  if (!args.reenviar && (resumo.NUNCA_SAIU || resumo.NA_FILA || resumo.FALHOU)) {
    console.log('')
    console.log(' Para entregar o que não chegou:')
    console.log('   1. Confirme que o WhatsApp está conectado (status acima).')
    console.log('   2. Rode o mesmo comando adicionando --reenviar')
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FALHA:', e)
    process.exit(1)
  })
