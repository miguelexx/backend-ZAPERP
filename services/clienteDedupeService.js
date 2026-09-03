/**
 * Deduplicação SEGURA de clientes por identidade WhatsApp (mesmo número com/sem o 9º dígito).
 *
 * Contexto: a importação da agenda casava telefone EXATO, então o mesmo contato salvo em
 * dois formatos (ex.: 553484165218 vs 5534984165218) virava dois clientes. O bloco antigo
 * de limpeza só reapontava `conversas.cliente_id` e apagava o duplicado — como as demais
 * tabelas têm FK `ON DELETE CASCADE` / `SET NULL`, isso PERDIA dados (lead de CRM, opt-in/
 * opt-out de LGPD, histórico de disparo, nome protegido) ou FALHAVA (avaliações, NO ACTION).
 *
 * Este serviço reaponta TODAS as tabelas que referenciam clientes.id (do duplicado para o
 * canônico) antes de excluir, preserva campos vazios do canônico e roda em DRY-RUN por
 * padrão: só grava quando `apply === true`.
 *
 * Isolamento multi-tenant: sempre filtra `company_id` na leitura/escrita de clientes; o
 * reaponte por `cliente_id` já é escopado porque os ids vêm dos clientes daquela empresa.
 */

const supabase = require('../config/supabase')
const { whatsappIdentityKey } = require('../helpers/phoneHelper')

/**
 * Tabelas com FK `cliente_id → clientes.id` (schema.sql + migrations).
 * Todas reapontadas do duplicado para o canônico ANTES de excluir o duplicado.
 * Reaponte por `cliente_id` (id global/serial), sem depender de `company_id` na tabela filha
 * — algumas não têm essa coluna, e os ids já pertencem à empresa correta.
 */
const CLIENTE_REF_TABLES = [
  'conversas',
  'crm_leads',
  'helpdesk_tickets',
  'contato_opt_in',
  'contato_opt_out',
  'campanha_envios',
  'disparo_campanha_destinatarios',
  'avaliacoes_atendimento',
  'cliente_nomes_vinculados',
]

const CLIENTE_COLS = 'id, telefone, nome, pushname, foto_perfil, email, empresa, wa_id, nome_protegido'
const CLIENTE_COLS_BASE = 'id, telefone, nome, pushname, foto_perfil, email, empresa, wa_id'

function isPreenchido(v) {
  const s = v != null ? String(v).trim() : ''
  return s !== '' && s.toLowerCase() !== 'null'
}

/**
 * Escolhe o cliente que permanece (canônico) no grupo de duplicados.
 * Prioridade: mais conversas vinculadas > nome protegido > nome mais longo > menor id (mais antigo).
 */
function pickCanonical(rows, convCountById) {
  return [...rows].sort((a, b) => {
    const ca = convCountById.get(a.id) || 0
    const cb = convCountById.get(b.id) || 0
    if (cb !== ca) return cb - ca
    const pa = a.nome_protegido === true ? 1 : 0
    const pb = b.nome_protegido === true ? 1 : 0
    if (pb !== pa) return pb - pa
    const na = (a.nome || '').trim().length
    const nb = (b.nome || '').trim().length
    if (nb !== na) return nb - na
    return (a.id || 0) - (b.id || 0)
  })[0]
}

/**
 * Preenche APENAS campos vazios do canônico com o primeiro valor não-vazio dos duplicados.
 * Nunca sobrescreve dado existente; nunca troca o nome de um contato com nome protegido.
 */
function buildCanonicalFieldPatch(canonical, dups) {
  const patch = {}
  const cols = ['nome', 'pushname', 'foto_perfil', 'email', 'empresa', 'wa_id']
  for (const col of cols) {
    if (isPreenchido(canonical[col])) continue
    for (const d of dups) {
      if (isPreenchido(d[col])) {
        patch[col] = String(d[col]).trim()
        break
      }
    }
  }
  if (canonical.nome_protegido === true) delete patch.nome
  return patch
}

/**
 * Reaponta (ou apenas conta, em dry-run) as referências dos duplicados para o canônico.
 * Cada tabela é isolada em try/catch: uma ausente/indisponível não aborta as demais.
 */
async function repointReferences(fromIds, toId, { apply }) {
  const actions = []
  for (const table of CLIENTE_REF_TABLES) {
    try {
      if (!apply) {
        const { count, error } = await supabase
          .from(table)
          .select('cliente_id', { count: 'exact', head: true })
          .in('cliente_id', fromIds)
        if (error) { actions.push({ table, error: error.message }); continue }
        if (count) actions.push({ table, rows: count })
      } else {
        const { error } = await supabase
          .from(table)
          .update({ cliente_id: toId })
          .in('cliente_id', fromIds)
        if (error) actions.push({ table, error: error.message })
      }
    } catch (e) {
      actions.push({ table, error: e?.message || String(e) })
    }
  }
  return actions
}

async function carregarClientes(cid) {
  const first = await supabase
    .from('clientes')
    .select(CLIENTE_COLS)
    .eq('company_id', cid)
    .not('telefone', 'like', 'lid:%')
  if (!first.error) return first.data || []
  // Schema sem coluna nome_protegido (ambientes antigos) → tenta sem ela.
  const retry = await supabase
    .from('clientes')
    .select(CLIENTE_COLS_BASE)
    .eq('company_id', cid)
    .not('telefone', 'like', 'lid:%')
  if (retry.error) throw new Error(retry.error.message || 'Falha ao carregar clientes')
  return retry.data || []
}

/**
 * Deduplica clientes de uma empresa por identidade WhatsApp.
 * @param {number} companyId
 * @param {object} opts - { apply?: boolean }  (apply=false → dry-run, não grava nada)
 * @returns {Promise<{
 *   apply: boolean, ok: boolean, grupos: number, duplicados: number,
 *   clientesRemovidos: number, canonicals: object[], errors: string[]
 * }>}
 */
async function dedupeClientesForCompany(companyId, opts = {}) {
  const apply = opts.apply === true
  const cid = Number(companyId)
  const report = { apply, ok: false, grupos: 0, duplicados: 0, clientesRemovidos: 0, canonicals: [], errors: [] }
  if (!cid) { report.errors.push('company_id ausente'); return report }

  let clientes
  try {
    clientes = await carregarClientes(cid)
  } catch (e) {
    report.errors.push(e?.message || String(e))
    return report
  }

  const byKey = new Map()
  for (const cl of clientes) {
    const key = whatsappIdentityKey(cl.telefone) || String(cl.telefone || '').replace(/\D/g, '')
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(cl)
  }

  for (const [key, list] of byKey) {
    if (list.length <= 1) continue

    const ids = list.map((c) => c.id).filter(Boolean)
    const convCountById = new Map()
    try {
      const { data: convs } = await supabase
        .from('conversas')
        .select('cliente_id')
        .eq('company_id', cid)
        .in('cliente_id', ids)
      for (const r of convs || []) {
        convCountById.set(r.cliente_id, (convCountById.get(r.cliente_id) || 0) + 1)
      }
    } catch (_) { /* contagem é só heurística de escolha; segue sem ela */ }

    const canonical = pickCanonical(list, convCountById)
    const dups = list.filter((c) => c.id !== canonical.id)
    const dupIds = dups.map((c) => c.id).filter(Boolean)
    if (dupIds.length === 0) continue

    report.grupos++
    report.duplicados += dupIds.length

    const refs = await repointReferences(dupIds, canonical.id, { apply })
    const fieldPatch = buildCanonicalFieldPatch(canonical, dups)

    if (apply && Object.keys(fieldPatch).length > 0) {
      try {
        const { error } = await supabase
          .from('clientes')
          .update(fieldPatch)
          .eq('id', canonical.id)
          .eq('company_id', cid)
        // email/wa_id podem ter unique próprio; se falhar, tenta sem eles em vez de abortar.
        if (error) {
          const seguro = { ...fieldPatch }
          delete seguro.email
          delete seguro.wa_id
          if (Object.keys(seguro).length > 0) {
            const retry = await supabase.from('clientes').update(seguro).eq('id', canonical.id).eq('company_id', cid)
            if (retry.error) report.errors.push(`patch ${canonical.id}: ${retry.error.message}`)
          } else {
            report.errors.push(`patch ${canonical.id}: ${error.message}`)
          }
        }
      } catch (e) {
        report.errors.push(`patch ${canonical.id}: ${e?.message || e}`)
      }
    }

    if (apply) {
      // Reaponte já feito acima: nenhum FILHO deve mais apontar para os duplicados,
      // então o DELETE não cai em CASCADE nem em NO ACTION. Se ainda assim falhar
      // (FK desconhecida), o duplicado é preservado e reportado — sem perda de dados.
      try {
        const { error } = await supabase.from('clientes').delete().eq('company_id', cid).in('id', dupIds)
        if (error) {
          report.errors.push(`delete [${dupIds.join(',')}]: ${error.message}`)
        } else {
          report.clientesRemovidos += dupIds.length
        }
      } catch (e) {
        report.errors.push(`delete [${dupIds.join(',')}]: ${e?.message || e}`)
      }
    }

    report.canonicals.push({
      key,
      canonicalId: canonical.id,
      canonicalNome: canonical.nome || null,
      canonicalTelefone: canonical.telefone,
      conversas: convCountById.get(canonical.id) || 0,
      duplicados: dups.map((d) => ({ id: d.id, telefone: d.telefone, nome: d.nome || null })),
      referencias: refs,
      camposPreenchidos: fieldPatch,
    })
  }

  report.ok = true
  return report
}

module.exports = {
  CLIENTE_REF_TABLES,
  pickCanonical,
  buildCanonicalFieldPatch,
  dedupeClientesForCompany,
}
