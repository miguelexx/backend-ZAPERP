'use strict'

/**
 * Monitor do alarme "Aguardar cliente".
 *
 * Enquanto uma conversa está em `aguardando_cliente` com alarme ativo
 * (aguardando_cliente_prazo_desde não nulo), este serviço escala uma etiqueta
 * automática conforme o tempo em relação ao prazo escolhido:
 *
 *   nível 'aguardando'   → dentro do prazo            → ⏳ Aguardando cliente (azul)
 *   nível 'atrasado'     → prazo vencido (< +24h)     → ⏰ Cliente atrasado (âmbar)
 *   nível 'sem_resposta' → prazo vencido há +24h      → 🚨 Cliente sem resposta (vermelho)
 *
 * A etiqueta do nível atual SUBSTITUI a anterior (só uma por vez). Ao vencer o
 * prazo (entrada em 'atrasado'/'sem_resposta') o atendente responsável é
 * notificado (evento de socket → card + som no frontend).
 *
 * LIMPEZA: qualquer conversa que saiu de `aguardando_cliente` mas ainda tem
 * alarme (prazo_desde não nulo) tem as etiquetas automáticas removidas e as
 * colunas do alarme zeradas. Isso cobre TODAS as saídas (retomar, encerrar,
 * cliente respondeu, transferência) sem tocar nesses fluxos.
 *
 * As etiquetas usam a MESMA tabela `tags`/`conversa_tags` das etiquetas manuais
 * e emitem os mesmos eventos (tag_adicionada/tag_removida), então a UI atualiza
 * sozinha, sem código novo de front para as etiquetas.
 */

const supabase = require('../config/supabase')
const {
  emitirEventoEmpresaConversa,
  emitirConversaAtualizada,
  emitirSincronizacaoListaConversas,
  emitirParaUsuario,
} = require('./chat/realtime/chatRealtimeGateway')

const DAY_MS = 24 * 60 * 60 * 1000

// Definição dos níveis (nome estável = identidade da etiqueta automática).
const NIVEIS = {
  aguardando: { key: 'aguardando', nome: '⏳ Aguardando cliente', cor: '#2563eb' },
  atrasado: { key: 'atrasado', nome: '⏰ Cliente atrasado', cor: '#d97706' },
  sem_resposta: { key: 'sem_resposta', nome: '🚨 Cliente sem resposta', cor: '#dc2626' },
}
const NOMES_AUTO = Object.values(NIVEIS).map((n) => n.nome)
const ACAO_HISTORICO = 'aguardando_cliente_etiqueta_tempo'

// Cache de ids das etiquetas automáticas por empresa (evita ensure a cada ciclo).
const CACHE_TTL_MS = 60_000
const tagCache = new Map() // company_id -> { expires, byKey: {aguardando,atrasado,sem_resposta}, ids:Set }

function nivelPara(now, prazoAteMs) {
  if (!Number.isFinite(prazoAteMs)) return 'aguardando'
  if (now < prazoAteMs) return 'aguardando'
  if (now < prazoAteMs + DAY_MS) return 'atrasado'
  return 'sem_resposta'
}

/**
 * Garante que as 3 etiquetas automáticas existem para a empresa e devolve o mapa
 * key→{id,nome,cor} e o Set de todos os ids automáticos.
 */
async function ensureAutoTags(companyId) {
  const cid = Number(companyId)
  const now = Date.now()
  const hit = tagCache.get(cid)
  if (hit && hit.expires > now) return hit

  const { data: existentes, error } = await supabase
    .from('tags')
    .select('id, nome, cor')
    .eq('company_id', cid)
    .in('nome', NOMES_AUTO)
  if (error) throw error

  const porNome = new Map((existentes || []).map((t) => [t.nome, t]))
  const byKey = {}
  const ids = new Set()

  for (const def of Object.values(NIVEIS)) {
    let tag = porNome.get(def.nome)
    if (!tag) {
      const { data: criada, error: insErr } = await supabase
        .from('tags')
        .insert({ nome: def.nome, cor: def.cor, company_id: cid })
        .select('id, nome, cor')
        .single()
      // Corrida: outra instância criou ao mesmo tempo → relê.
      if (insErr) {
        const { data: relida } = await supabase
          .from('tags')
          .select('id, nome, cor')
          .eq('company_id', cid)
          .eq('nome', def.nome)
          .maybeSingle()
        tag = relida || null
      } else {
        tag = criada
      }
    }
    if (tag) {
      byKey[def.key] = tag
      ids.add(Number(tag.id))
    }
  }

  const entry = { expires: now + CACHE_TTL_MS, byKey, ids }
  tagCache.set(cid, entry)
  return entry
}

/** Remove da conversa quaisquer etiquetas automáticas exceto `keepTagId`. Emite tag_removida. */
async function removerAutoTagsExceto(io, companyId, conversaId, autoIds, keepTagId = null) {
  const alvo = [...autoIds].filter((id) => id !== Number(keepTagId))
  if (alvo.length === 0) return
  const { data: vinculos } = await supabase
    .from('conversa_tags')
    .select('tag_id')
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .in('tag_id', alvo)
  const presentes = (vinculos || []).map((v) => Number(v.tag_id))
  if (presentes.length === 0) return
  await supabase
    .from('conversa_tags')
    .delete()
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .in('tag_id', presentes)
  if (io) {
    for (const tagId of presentes) {
      emitirEventoEmpresaConversa(io, companyId, conversaId, io.EVENTS?.TAG_REMOVIDA || 'tag_removida', {
        conversa_id: Number(conversaId),
        tag_id: Number(tagId),
      })
    }
  }
}

/** Adiciona a etiqueta do nível (se ainda não vinculada). Emite tag_adicionada. */
async function adicionarAutoTag(io, companyId, conversaId, tag) {
  if (!tag?.id) return
  const { data: existente } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .eq('tag_id', tag.id)
    .maybeSingle()
  if (existente) return
  const { error } = await supabase
    .from('conversa_tags')
    .insert([{ conversa_id: conversaId, tag_id: tag.id, company_id: companyId }])
  if (error && error.code !== '23505') throw error
  if (io) {
    emitirEventoEmpresaConversa(io, companyId, conversaId, io.EVENTS?.TAG_ADICIONADA || 'tag_adicionada', {
      conversa_id: Number(conversaId),
      tag: { id: tag.id, nome: tag.nome, cor: tag.cor },
    })
  }
}

/**
 * Aplica/escala as etiquetas das conversas em aguardando_cliente com alarme.
 * @returns {Promise<{ok:boolean, escaladas:number, vencidas:number, error?:string}>}
 */
async function escalarEtiquetas(io, opts = {}) {
  const nowIso = new Date().toISOString()
  const now = Date.now()
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000)

  const { data: rows, error } = await supabase
    .from('conversas')
    .select('id, company_id, atendente_id, aguardando_cliente_prazo_ate, aguardando_cliente_nivel, nome_contato_cache')
    .eq('status_atendimento', 'aguardando_cliente')
    .not('aguardando_cliente_prazo_desde', 'is', null)
    .limit(limit)
  if (error) return { ok: false, escaladas: 0, vencidas: 0, error: error.message }

  let escaladas = 0
  let vencidas = 0

  for (const conv of rows || []) {
    const prazoAteMs = conv.aguardando_cliente_prazo_ate
      ? new Date(conv.aguardando_cliente_prazo_ate).getTime()
      : NaN
    const alvo = nivelPara(now, prazoAteMs)
    const atual = conv.aguardando_cliente_nivel || null
    if (alvo === atual) continue

    try {
      const { byKey, ids } = await ensureAutoTags(conv.company_id)
      const tagAlvo = byKey[alvo]
      if (!tagAlvo) continue

      await removerAutoTagsExceto(io, conv.company_id, conv.id, ids, tagAlvo.id)
      await adicionarAutoTag(io, conv.company_id, conv.id, tagAlvo)

      const { data: updated } = await supabase
        .from('conversas')
        .update({ aguardando_cliente_nivel: alvo })
        .eq('company_id', conv.company_id)
        .eq('id', conv.id)
        .eq('status_atendimento', 'aguardando_cliente')
        .select('id')
        .maybeSingle()
      if (!updated?.id) continue

      escaladas++
      await supabase.from('historico_atendimentos').insert({
        conversa_id: conv.id,
        usuario_id: null,
        acao: ACAO_HISTORICO,
        observacao: `Etiqueta automática "${tagAlvo.nome}" aplicada (prazo ${conv.aguardando_cliente_prazo_ate || 'n/d'})`,
      })

      if (io) {
        emitirConversaAtualizada(
          io,
          conv.company_id,
          conv.id,
          { id: Number(conv.id), aguardando_cliente_nivel: alvo },
          { skipAtualizarConversa: true }
        )
        emitirSincronizacaoListaConversas(io, conv.company_id, conv.id)
      }

      // Vencimento: primeira vez que sai de "dentro do prazo".
      const venceu = atual === null || atual === 'aguardando'
      if ((alvo === 'atrasado' || alvo === 'sem_resposta') && venceu) {
        vencidas++
        if (io && conv.atendente_id != null) {
          emitirParaUsuario(io, conv.atendente_id, 'aguardando_cliente_prazo_vencido', {
            conversa_id: Number(conv.id),
            company_id: Number(conv.company_id),
            nivel: alvo,
            contato: conv.nome_contato_cache || null,
            prazo_ate: conv.aguardando_cliente_prazo_ate || null,
          })
        }
      }
    } catch (e) {
      console.warn('[aguardandoClienteMonitor] erro ao escalar', conv.id, e?.message || e)
    }
  }

  return { ok: true, escaladas, vencidas }
}

/**
 * Remove etiquetas automáticas e zera o alarme de conversas que já NÃO estão em
 * aguardando_cliente (qualquer saída), sem tocar nos fluxos de saída.
 */
async function limparAlarmesEncerrados(io, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000)
  const { data: rows, error } = await supabase
    .from('conversas')
    .select('id, company_id, status_atendimento')
    .not('aguardando_cliente_prazo_desde', 'is', null)
    .neq('status_atendimento', 'aguardando_cliente')
    .limit(limit)
  if (error) return { ok: false, limpas: 0, error: error.message }

  let limpas = 0
  for (const conv of rows || []) {
    try {
      const { ids } = await ensureAutoTags(conv.company_id)
      await removerAutoTagsExceto(io, conv.company_id, conv.id, ids, null)
      await supabase
        .from('conversas')
        .update({
          aguardando_cliente_prazo_desde: null,
          aguardando_cliente_prazo_ate: null,
          aguardando_cliente_prazo_origem: null,
          aguardando_cliente_nivel: null,
        })
        .eq('company_id', conv.company_id)
        .eq('id', conv.id)
      limpas++
      if (io) {
        emitirConversaAtualizada(
          io,
          conv.company_id,
          conv.id,
          { id: Number(conv.id), aguardando_cliente_nivel: null, aguardando_cliente_prazo_ate: null },
          { skipAtualizarConversa: true }
        )
      }
    } catch (e) {
      console.warn('[aguardandoClienteMonitor] erro ao limpar', conv.id, e?.message || e)
    }
  }
  return { ok: true, limpas }
}

/** Um ciclo completo: escala etiquetas + limpa alarmes encerrados. */
async function runAguardandoClienteMonitor(io, opts = {}) {
  const escal = await escalarEtiquetas(io, opts)
  const limp = await limparAlarmesEncerrados(io, opts)
  return {
    ok: escal.ok && limp.ok,
    escaladas: escal.escaladas || 0,
    vencidas: escal.vencidas || 0,
    limpas: limp.limpas || 0,
    error: escal.error || limp.error || null,
  }
}

module.exports = {
  runAguardandoClienteMonitor,
  escalarEtiquetas,
  limparAlarmesEncerrados,
  nivelPara,
  NIVEIS,
  NOMES_AUTO,
  ACAO_HISTORICO,
  _clearTagCache: () => tagCache.clear(),
}
