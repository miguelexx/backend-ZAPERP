'use strict'

/**
 * Núcleo COMPARTILHADO da exclusão de conversa.
 *
 * Extraído de controllers/chat/conversationCleanupController.js sem alteração de comportamento,
 * para que a exclusão tenha UMA implementação usada por dois gatilhos:
 *   1. HTTP  — DELETE /chats/:id (atendente/admin apaga no ZapERP)
 *   2. Webhook — conversa apagada no WhatsApp (chats.delete da Whapi) e reconciliação
 *
 * REGRAS INVARIANTES (não relaxar):
 * - `company_id` sempre vem de fora já resolvido (JWT ou instância do webhook) — nunca do payload.
 *   Toda query filtra `company_id` explicitamente (SERVICE_ROLE bypassa RLS).
 * - A cascata NÃO fala com o provedor WhatsApp. Quem decide espelhar no WhatsApp é o chamador
 *   (o gatilho HTTP espelha; o gatilho de webhook NUNCA espelha — seria o loop de sincronização).
 * - O cadastro do cliente (contato) só é apagado quando pedido explicitamente. Exclusão vinda do
 *   WhatsApp nunca apaga contato/CRM/tags do contato.
 */

const supabase = require('../../../config/supabase')
const { emitirEventoEmpresaConversa } = require('../realtime/chatRealtimeGateway')

/** Tabelas opcionais (podem não existir em todo ambiente): erro de "não existe" é silenciado. */
async function softDeleteOptional(table, build) {
  try {
    const { error } = await build(supabase.from(table))
    if (error && !String(error.message || '').includes('does not exist')) {
      console.warn(`[apagarConversa] ${table}:`, error.message)
    }
  } catch (_) { /* tabela opcional */ }
}

/** O contato existe neste tenant? Usado para medir "contato preservado" depois da exclusão. */
async function contatoExiste(company_id, cliente_id) {
  const cid = Number(cliente_id)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const { data } = await supabase
    .from('clientes')
    .select('id')
    .eq('company_id', Number(company_id))
    .eq('id', cid)
    .maybeSingle()
  return !!data?.id
}

/**
 * Cascata de dependências + DELETE da conversa. Ordem preservada do controller original:
 * avaliações (por atendimento e por conversa) → tabelas satélite → atendimentos → histórico →
 * tags/bot_logs → mensagens → desvincula cliente → apaga a conversa.
 *
 * Não apaga o cadastro do cliente (ver `apagarCadastroDoCliente`).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function apagarDependenciasEConversa({ company_id, conversa_id }) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!Number.isFinite(cid) || cid <= 0) return { ok: false, error: 'company_id inválido' }
  if (!Number.isFinite(convId) || convId <= 0) return { ok: false, error: 'conversa_id inválido' }

  const { data: atendRows } = await supabase
    .from('atendimentos')
    .select('id')
    .eq('company_id', cid)
    .eq('conversa_id', convId)
  const atendIds = (atendRows || []).map((r) => r.id).filter(Boolean)
  if (atendIds.length > 0) {
    await supabase.from('avaliacoes_atendimento').delete().in('atendimento_id', atendIds)
  }
  await supabase.from('avaliacoes_atendimento').delete().eq('conversa_id', convId).eq('company_id', cid)

  await softDeleteOptional('mensagens_ocultas', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
  await softDeleteOptional('conversa_unreads', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
  await softDeleteOptional('conversa_atendentes', (q) => q.delete().eq('conversa_id', convId))
  await softDeleteOptional('conversa_usuario_prefs', (q) => q.delete().eq('conversa_id', convId))
  await supabase.from('atendimentos').delete().eq('company_id', cid).eq('conversa_id', convId)
  await supabase.from('historico_atendimentos').delete().eq('conversa_id', convId)
  await softDeleteOptional('conversa_tags', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
  await softDeleteOptional('bot_logs', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
  await supabase.from('mensagens').delete().eq('company_id', cid).eq('conversa_id', convId)

  await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('id', convId)

  const { error: errDel } = await supabase.from('conversas').delete().eq('company_id', cid).eq('id', convId)
  if (errDel) return { ok: false, error: errDel.message }
  return { ok: true }
}

/**
 * Apaga o CADASTRO do cliente e seus vínculos. Só é chamado quando o usuário pediu
 * `apagar_cliente=1` no endpoint HTTP — nunca por exclusão vinda do WhatsApp.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function apagarCadastroDoCliente({ company_id, cliente_id }) {
  const cid = Number(company_id)
  const clienteId = Number(cliente_id)
  if (!Number.isFinite(clienteId) || clienteId <= 0) return { ok: false, error: 'cliente_id inválido' }

  await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', clienteId)
  await softDeleteOptional('cliente_nomes_vinculados', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
  await softDeleteOptional('cliente_tags', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
  await softDeleteOptional('contato_opt_in', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
  await softDeleteOptional('contato_opt_out', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
  await softDeleteOptional('campanha_envios', (q) => q.delete().eq('cliente_id', clienteId))
  await softDeleteOptional('avaliacoes_atendimento', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
  await softDeleteOptional('crm_leads', (q) => q.update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', clienteId))

  const { error: errCli } = await supabase
    .from('clientes')
    .delete()
    .eq('company_id', cid)
    .eq('id', clienteId)
  if (errCli) return { ok: false, error: errCli.message }
  return { ok: true }
}

/**
 * Realtime da exclusão — MESMO par de eventos nos dois gatilhos, para o frontend não precisar
 * saber quem apagou:
 * - `conversa_apagada` (quem está com a conversa aberta fecha a thread)
 * - `atualizar_conversa { removida: true }` na room da empresa (todos os atendentes tiram da lista;
 *   é o único caminho company-wide — a resolução por visibilidade já não acha a conversa apagada)
 *
 * `origem`: 'usuario' (apagou no ZapERP) | 'whatsapp' (apagou no WhatsApp) | 'reconciliacao'.
 */
function emitirConversaApagada(io, {
  company_id,
  conversa_id,
  cliente_id = null,
  cliente_apagado = false,
  whatsapp_apagado = false,
  origem = 'usuario',
} = {}) {
  if (!io) return
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(convId) || convId <= 0) return

  emitirEventoEmpresaConversa(io, cid, convId, 'conversa_apagada', {
    id: convId,
    cliente_id,
    cliente_apagado,
    whatsapp_apagado,
    origem,
  })
  io.to(`empresa_${cid}`).emit('atualizar_conversa', {
    id: convId,
    removida: true,
    cliente_id,
    cliente_apagado,
    origem,
  })
}

module.exports = {
  softDeleteOptional,
  contatoExiste,
  apagarDependenciasEConversa,
  apagarCadastroDoCliente,
  emitirConversaApagada,
}
