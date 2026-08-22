/**
 * Controller de Instâncias — módulo Disparo de Mensagens (Etapa 3).
 * Gerencia: seleção de instâncias, distribuição, preview e confirmação.
 * Nunca expõe instance_token ou client_token.
 */

const supabase = require('../config/supabase')
const { statusPermiteEdicao, mensagemBloqueioEdicao } = require('../helpers/disparoStatusHelper')

// ─── Helpers locais ──────────────────────────────────────────────────────────

function positiveInt(v) {
  const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' }); return false
  }
  return true
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select('id, status, company_id, distribuicao_modo, distribuicao_confirmada, distribuicao_revisao')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) { res.status(404).json({ error: 'Campanha não encontrada.' }); return null }
  return data
}


const INSTANCIA_SELECT = [
  'id', 'company_id', 'nome', 'descricao', 'instance_id',
  'telefone_conectado', 'display_phone', 'ativo', 'is_default',
  'status', 'status_at', 'ultimo_webhook_em', 'criado_em', 'atualizado_em',
].join(', ')

const BATCH_SIZE = 500
const MODOS_VALIDOS = new Set(['equilibrada', 'quantidade', 'percentual', 'manual'])

// ─── 1. Listar instâncias disponíveis da empresa ──────────────────────────────

/**
 * GET /disparo/campanhas/:id/instancias/disponiveis
 * Lista instâncias da empresa, marcando as já selecionadas para a campanha.
 */
exports.listarInstanciasDisponiveis = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const [{ data: instancias, error: iErr }, { data: selecionadas, error: sErr }] = await Promise.all([
      supabase.from('whatsapp_instances')
        .select(INSTANCIA_SELECT)
        .eq('company_id', companyId)
        .eq('ativo', true)
        .order('is_default', { ascending: false })
        .order('nome', { ascending: true }),
      supabase.from('disparo_campanha_instancias')
        .select('instancia_id, quantidade, percentual, ordem, distribuicao, ativa')
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId),
    ])

    if (iErr) throw iErr
    if (sErr) throw sErr

    const selMap = new Map((selecionadas ?? []).map(s => [s.instancia_id, s]))

    // Obtém contagem de destinatários por instância
    const { data: contagens } = await supabase
      .from('disparo_campanha_destinatarios')
      .select('instancia_id')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')

    const contagemPorInstancia = (contagens ?? []).reduce((m, r) => {
      if (r.instancia_id) m.set(r.instancia_id, (m.get(r.instancia_id) ?? 0) + 1)
      return m
    }, new Map())

    const result = await Promise.all((instancias ?? []).map(async (inst) => {
      const sel = selMap.get(inst.id)
      let statusLive = inst.status || 'unknown'
      let conectada = statusLive === 'connected' && inst.ativo !== false

      // Status no banco pode ficar desatualizado (ex.: "unknown") enquanto o atendimento já usa a instância.
      // Consulta leve ao UltraMSG para refletir conexão real na UI de seleção.
      if (inst.ativo) {
        try {
          const { getStatus } = require('../services/ultramsgIntegrationService')
          const live = await getStatus(companyId, { whatsappInstanceId: inst.id })
          if (live && !live.error) {
            if (live.connected === true) {
              statusLive = 'connected'
              conectada = true
              if (inst.status !== 'connected') {
                supabase
                  .from('whatsapp_instances')
                  .update({ status: 'connected', status_at: new Date().toISOString() })
                  .eq('id', inst.id)
                  .eq('company_id', companyId)
                  .then(() => {})
                  .catch(() => {})
              }
            } else if (statusLive === 'connected') {
              statusLive = 'disconnected'
              conectada = false
            }
          }
        } catch (_) { /* best-effort */ }
      }

      return {
        ...inst,
        status: statusLive,
        selecionada: !!sel,
        ativa_na_campanha: sel?.ativa ?? false,
        quantidade_configurada: sel?.quantidade ?? null,
        percentual_configurado: sel?.percentual ?? null,
        ordem: sel?.ordem ?? 0,
        destinatarios_atribuidos: contagemPorInstancia.get(inst.id) ?? 0,
        /** Pode ser marcada na campanha (instância ativa da empresa). */
        selecionavel: inst.ativo === true,
        /** Conectada de fato (banco ou status live). */
        conectada,
        /** Compat: seleção liberada para ativas; aviso visual se não conectada. */
        disponivel: inst.ativo === true,
      }
    }))

    res.json({ instancias: result })
  } catch (err) {
    console.error('[disparo:instancias] listarDisponiveis', err)
    res.status(500).json({ error: 'Erro ao listar instâncias.' })
  }
}

// ─── 2. Selecionar instâncias para a campanha ─────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/selecionar
 * Body: { instancia_ids: number[] }
 * Adiciona instâncias à campanha (upsert).
 */
exports.selecionarInstancias = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar instâncias nesta fase da campanha.' })
    }

    const ids = (Array.isArray(req.body.instancia_ids) ? req.body.instancia_ids : [])
      .map(positiveInt).filter(Boolean)
    if (!ids.length) return res.status(400).json({ error: 'Nenhuma instância informada.' })

    // Valida que pertencem à empresa
    const { data: validas, error: vErr } = await supabase
      .from('whatsapp_instances')
      .select('id')
      .in('id', ids)
      .eq('company_id', companyId)
      .eq('ativo', true)
    if (vErr) throw vErr

    const validasIds = (validas ?? []).map(i => i.id)
    if (!validasIds.length) return res.status(400).json({ error: 'Nenhuma instância válida encontrada.' })

    // Busca as já existentes para não duplicar
    const { data: existentes } = await supabase
      .from('disparo_campanha_instancias')
      .select('instancia_id')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
    const existentesSet = new Set((existentes ?? []).map(e => e.instancia_id))

    const novas = validasIds.filter(id => !existentesSet.has(id))
    if (novas.length) {
      const rows = novas.map((id, i) => ({
        company_id: companyId,
        campanha_id: campanhaId,
        instancia_id: id,
        ordem: (existentesSet.size + i),
        ativa: true,
      }))
      const { error: insErr } = await supabase.from('disparo_campanha_instancias').insert(rows)
      if (insErr) throw insErr
    }

    // Marca revisão se havia distribuição confirmada
    if (campanha.distribuicao_confirmada && novas.length) {
      await supabase.from('disparo_campanhas')
        .update({ distribuicao_revisao: true, atualizado_em: new Date().toISOString() })
        .eq('id', campanhaId).eq('company_id', companyId)
    }

    res.json({ adicionadas: novas.length, total: existentesSet.size + novas.length })
  } catch (err) {
    console.error('[disparo:instancias] selecionarInstancias', err)
    res.status(500).json({ error: 'Erro ao selecionar instâncias.' })
  }
}

// ─── 3. Remover instância da campanha ─────────────────────────────────────────

/**
 * DELETE /disparo/campanhas/:id/instancias/:instanciaId
 */
exports.removerInstancia = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const instanciaId = positiveInt(req.params.instanciaId)
    if (!campanhaId || !instanciaId) return res.status(400).json({ error: 'IDs inválidos.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar instâncias nesta fase.' })
    }

    // Remove da tabela de instâncias
    const { error: dErr } = await supabase
      .from('disparo_campanha_instancias')
      .delete()
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('instancia_id', instanciaId)
    if (dErr) throw dErr

    // Desvincula destinatários que estavam nessa instância
    await supabase
      .from('disparo_campanha_destinatarios')
      .update({ instancia_id: null })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('instancia_id', instanciaId)

    if (campanha.distribuicao_confirmada) {
      await supabase.from('disparo_campanhas')
        .update({ distribuicao_revisao: true, atualizado_em: new Date().toISOString() })
        .eq('id', campanhaId).eq('company_id', companyId)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[disparo:instancias] removerInstancia', err)
    res.status(500).json({ error: 'Erro ao remover instância.' })
  }
}

// ─── 4. Preview de distribuição ───────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/preview-distribuicao
 * Body: { modo: string, configuracoes: [{ instancia_id, quantidade?, percentual? }] }
 * Retorna o plano sem gravar nada.
 */
exports.previewDistribuicao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const modo = String(req.body.modo ?? '').trim()
    if (!MODOS_VALIDOS.has(modo)) {
      return res.status(400).json({ error: `Modo inválido. Use: ${[...MODOS_VALIDOS].join(', ')}.` })
    }

    const configuracoes = Array.isArray(req.body.configuracoes) ? req.body.configuracoes : []
    const { plano, erros } = await calcularPreviewDistribuicao(campanhaId, companyId, modo, configuracoes)

    res.json({ plano, erros, modo })
  } catch (err) {
    console.error('[disparo:instancias] previewDistribuicao', err)
    res.status(500).json({ error: 'Erro ao calcular preview.' })
  }
}

// ─── 5. Confirmar distribuição ────────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/confirmar-distribuicao
 * Body: { modo, configuracoes, preservar_existentes? }
 * Idempotente: pode ser chamado múltiplas vezes com segurança.
 */
exports.confirmarDistribuicao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível distribuir nesta fase.' })
    }

    const modo = String(req.body.modo ?? '').trim()
    if (!MODOS_VALIDOS.has(modo)) {
      return res.status(400).json({ error: `Modo inválido. Use: ${[...MODOS_VALIDOS].join(', ')}.` })
    }

    const configuracoes = Array.isArray(req.body.configuracoes) ? req.body.configuracoes : []
    const preservar = req.body.preservar_existentes === true

    const { plano, erros } = await calcularPreviewDistribuicao(campanhaId, companyId, modo, configuracoes, preservar)

    if (erros.length) {
      return res.status(422).json({ error: erros[0], erros, plano })
    }
    if (plano.nao_atribuidos > 0 && modo !== 'manual') {
      return res.status(422).json({
        error: `${plano.nao_atribuidos} destinatário(s) sem instância atribuída.`,
        plano,
        erros,
      })
    }

    // Aplica a distribuição
    await aplicarDistribuicao(campanhaId, companyId, modo, plano, configuracoes, preservar)

    // Atualiza campanha
    await supabase.from('disparo_campanhas')
      .update({
        distribuicao_modo: modo,
        distribuicao_confirmada: true,
        distribuicao_revisao: false,
        status: 'configurando',
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', campanhaId).eq('company_id', companyId)

    res.json({ ok: true, plano, modo })
  } catch (err) {
    console.error('[disparo:instancias] confirmarDistribuicao', err)
    res.status(500).json({ error: 'Erro ao confirmar distribuição.' })
  }
}

// ─── 6. Resumo por instância ──────────────────────────────────────────────────

/**
 * GET /disparo/campanhas/:id/instancias/resumo
 */
exports.resumoInstancias = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const [{ data: instConfigs }, { data: contagens }, { data: totalRow }] = await Promise.all([
      supabase.from('disparo_campanha_instancias')
        .select('instancia_id, quantidade, percentual, ordem')
        .eq('campanha_id', campanhaId).eq('company_id', companyId),
      supabase.from('disparo_campanha_destinatarios')
        .select('instancia_id')
        .eq('campanha_id', campanhaId).eq('company_id', companyId)
        .neq('status', 'excluido'),
      supabase.from('disparo_campanha_destinatarios')
        .select('id', { count: 'exact', head: true })
        .eq('campanha_id', campanhaId).eq('company_id', companyId)
        .neq('status', 'excluido'),
    ])

    const totalDest = totalRow?.count ?? 0
    const contagemMap = (contagens ?? []).reduce((m, r) => {
      const key = r.instancia_id ?? '__sem_instancia__'
      m.set(key, (m.get(key) ?? 0) + 1)
      return m
    }, new Map())

    // Busca nomes das instâncias
    const instIds = (instConfigs ?? []).map(c => c.instancia_id)
    let instNomes = {}
    if (instIds.length) {
      const { data: instData } = await supabase
        .from('whatsapp_instances')
        .select('id, nome, status, display_phone, telefone_conectado')
        .in('id', instIds)
        .eq('company_id', companyId)
      instNomes = (instData ?? []).reduce((m, i) => { m[i.id] = i; return m }, {})
    }

    const instancias = (instConfigs ?? []).map(c => {
      const inst = instNomes[c.instancia_id] ?? {}
      const atribuidos = contagemMap.get(c.instancia_id) ?? 0
      return {
        instancia_id: c.instancia_id,
        nome: inst.nome ?? `#${c.instancia_id}`,
        status: inst.status ?? 'unknown',
        display_phone: inst.display_phone ?? inst.telefone_conectado,
        quantidade_configurada: c.quantidade,
        percentual_configurado: c.percentual,
        destinatarios_atribuidos: atribuidos,
        percentual_real: totalDest > 0 ? Math.round(atribuidos / totalDest * 100) : 0,
      }
    })

    res.json({
      total_destinatarios: totalDest,
      sem_instancia: contagemMap.get('__sem_instancia__') ?? 0,
      distribuicao_confirmada: campanha.distribuicao_confirmada,
      distribuicao_revisao: campanha.distribuicao_revisao,
      distribuicao_modo: campanha.distribuicao_modo,
      instancias,
    })
  } catch (err) {
    console.error('[disparo:instancias] resumoInstancias', err)
    res.status(500).json({ error: 'Erro ao buscar resumo.' })
  }
}

// ─── 7. Destinatários não atribuídos ─────────────────────────────────────────

/**
 * GET /disparo/campanhas/:id/destinatarios/nao-atribuidos
 */
exports.destinatariosNaoAtribuidos = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30))
    const offset = (page - 1) * limit

    const { data, error, count } = await supabase
      .from('disparo_campanha_destinatarios')
      .select('id, nome, telefone_normalizado, origem', { count: 'exact' })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')
      .is('instancia_id', null)
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)

    if (error) throw error

    res.json({ destinatarios: data ?? [], total: count ?? 0, page, limit })
  } catch (err) {
    console.error('[disparo:instancias] destinatariosNaoAtribuidos', err)
    res.status(500).json({ error: 'Erro ao listar destinatários sem atribuição.' })
  }
}

// ─── 8. Atribuição manual ─────────────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/atribuir-manual
 * Body: { destinatario_ids: number[], instancia_id: number }
 */
exports.atribuirManual = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível atribuir nesta fase.' })
    }

    const instanciaId = positiveInt(req.body.instancia_id)
    if (!instanciaId) return res.status(400).json({ error: 'instancia_id inválido.' })

    const destIds = (Array.isArray(req.body.destinatario_ids) ? req.body.destinatario_ids : [])
      .map(positiveInt).filter(Boolean)
    if (!destIds.length) return res.status(400).json({ error: 'Nenhum destinatário informado.' })

    // Valida que a instância pertence à empresa e está na campanha
    const { data: instCheck } = await supabase
      .from('disparo_campanha_instancias')
      .select('instancia_id')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('instancia_id', instanciaId)
      .maybeSingle()
    if (!instCheck) return res.status(400).json({ error: 'Instância não faz parte desta campanha.' })

    // Atualiza em lotes
    let atribuidos = 0
    for (let i = 0; i < destIds.length; i += BATCH_SIZE) {
      const batch = destIds.slice(i, i + BATCH_SIZE)
      const { error } = await supabase
        .from('disparo_campanha_destinatarios')
        .update({ instancia_id: instanciaId })
        .in('id', batch)
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId)
        .neq('status', 'excluido')
      if (error) throw error
      atribuidos += batch.length
    }

    res.json({ atribuidos })
  } catch (err) {
    console.error('[disparo:instancias] atribuirManual', err)
    res.status(500).json({ error: 'Erro ao atribuir destinatários.' })
  }
}

// ─── 9. Mover destinatários entre instâncias ──────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/mover
 * Body: { destinatario_ids: number[], instancia_destino_id: number }
 */
exports.moverDestinatarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível mover destinatários nesta fase.' })
    }

    const destinoId = positiveInt(req.body.instancia_destino_id)
    if (!destinoId) return res.status(400).json({ error: 'instancia_destino_id inválido.' })

    const { data: check } = await supabase
      .from('disparo_campanha_instancias')
      .select('instancia_id')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('instancia_id', destinoId)
      .maybeSingle()
    if (!check) return res.status(400).json({ error: 'Instância de destino não faz parte desta campanha.' })

    const ids = (Array.isArray(req.body.destinatario_ids) ? req.body.destinatario_ids : [])
      .map(positiveInt).filter(Boolean)
    if (!ids.length) return res.status(400).json({ error: 'Nenhum destinatário informado.' })

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const { error } = await supabase
        .from('disparo_campanha_destinatarios')
        .update({ instancia_id: destinoId })
        .in('id', ids.slice(i, i + BATCH_SIZE))
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId)
        .neq('status', 'excluido')
      if (error) throw error
    }

    res.json({ movidos: ids.length })
  } catch (err) {
    console.error('[disparo:instancias] moverDestinatarios', err)
    res.status(500).json({ error: 'Erro ao mover destinatários.' })
  }
}

// ─── 10. Recalcular distribuição ──────────────────────────────────────────────

/**
 * POST /disparo/campanhas/:id/instancias/recalcular
 * Limpa distribuição atual, permite que admin refaça o preview + confirmar.
 */
exports.recalcularDistribuicao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível recalcular nesta fase.' })
    }

    // Desvincula todos os destinatários
    await supabase.from('disparo_campanha_destinatarios')
      .update({ instancia_id: null })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')

    // Reseta flags da campanha
    await supabase.from('disparo_campanhas')
      .update({ distribuicao_confirmada: false, distribuicao_revisao: false, atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId).eq('company_id', companyId)

    res.json({ ok: true })
  } catch (err) {
    console.error('[disparo:instancias] recalcularDistribuicao', err)
    res.status(500).json({ error: 'Erro ao recalcular distribuição.' })
  }
}

// ─── Algoritmos de distribuição ───────────────────────────────────────────────

/**
 * Calcula o plano de distribuição sem persistir.
 */
async function calcularPreviewDistribuicao(campanhaId, companyId, modo, configuracoes, preservar = false) {
  const erros = []

  // Total de destinatários válidos
  const { data: totalData, count: totalCount } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id, instancia_id', { count: 'exact' })
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')

  const total = totalCount ?? 0
  const todos = totalData ?? []

  // Instâncias selecionadas para a campanha
  const { data: instConfigs } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id, ordem, ativa')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('ordem', { ascending: true })
    .order('instancia_id', { ascending: true })

  const instanciasAtivas = (instConfigs ?? []).filter(i => i.ativa).map(i => i.instancia_id)

  if (!instanciasAtivas.length) {
    erros.push('Selecione ao menos uma instância antes de distribuir.')
    return { plano: { total, instancias: [], nao_atribuidos: total }, erros }
  }

  // Verifica status (conectadas) das instâncias — revalida ao vivo se o banco estiver desatualizado
  const { data: instStatus } = await supabase
    .from('whatsapp_instances')
    .select('id, nome, status, display_phone, telefone_conectado, ativo')
    .in('id', instanciasAtivas)
    .eq('company_id', companyId)
  const statusMap = (instStatus ?? []).reduce((m, i) => { m[i.id] = i; return m }, {})

  try {
    const { getStatus } = require('../services/ultramsgIntegrationService')
    await Promise.all(instanciasAtivas.map(async (id) => {
      const row = statusMap[id]
      if (!row || row.status === 'connected') return
      try {
        const live = await getStatus(companyId, { whatsappInstanceId: id })
        if (live?.connected === true) {
          statusMap[id] = { ...row, status: 'connected' }
          supabase
            .from('whatsapp_instances')
            .update({ status: 'connected', status_at: new Date().toISOString() })
            .eq('id', id)
            .eq('company_id', companyId)
            .then(() => {})
            .catch(() => {})
        }
      } catch (_) { /* ignore */ }
    }))
  } catch (_) { /* getStatus indisponível */ }

  const desconectadas = instanciasAtivas.filter(id => statusMap[id]?.status !== 'connected')
  if (desconectadas.length) {
    desconectadas.forEach(id => {
      const inst = statusMap[id]
      erros.push(`Instância "${inst?.nome ?? id}" está desconectada (status: ${inst?.status ?? 'desconhecido'}).`)
    })
  }

  // Contagem de destinatários já atribuídos (para modo preservar)
  const preservarMap = new Map()
  if (preservar) {
    for (const d of todos) {
      if (d.instancia_id && instanciasAtivas.includes(d.instancia_id)) {
        preservarMap.set(d.instancia_id, (preservarMap.get(d.instancia_id) ?? 0) + 1)
      }
    }
  }

  let distribuicao // { instanciaId: quantidade }
  const configMap = new Map((configuracoes ?? []).map(c => [Number(c.instancia_id), c]))

  if (modo === 'equilibrada') {
    distribuicao = distribuirEquilibrado(instanciasAtivas, total, preservarMap, preservar)
  } else if (modo === 'quantidade') {
    const { dist, errosQ } = distribuirQuantidade(instanciasAtivas, total, configMap, preservarMap, preservar)
    distribuicao = dist; erros.push(...errosQ)
  } else if (modo === 'percentual') {
    const { dist, errosP } = distribuirPercentual(instanciasAtivas, total, configMap, preservarMap, preservar)
    distribuicao = dist; erros.push(...errosP)
  } else {
    // manual: só mostra estado atual
    distribuicao = new Map(instanciasAtivas.map(id => [id, preservarMap.get(id) ?? 0]))
  }

  const instanciasPlan = instanciasAtivas.map(id => ({
    instancia_id: id,
    nome: statusMap[id]?.nome ?? `#${id}`,
    status: statusMap[id]?.status ?? 'unknown',
    display_phone: statusMap[id]?.display_phone ?? statusMap[id]?.telefone_conectado,
    quantidade: distribuicao.get(id) ?? 0,
    percentual: total > 0 ? +((distribuicao.get(id) ?? 0) / total * 100).toFixed(1) : 0,
    preservado: preservarMap.get(id) ?? 0,
  }))

  const atribuidos = instanciasPlan.reduce((s, i) => s + i.quantidade, 0)
  const nao_atribuidos = total - atribuidos

  return {
    plano: {
      total,
      atribuidos,
      nao_atribuidos,
      instancias: instanciasPlan,
      modo,
    },
    erros,
  }
}

function distribuirEquilibrado(instancias, total, preservarMap, preservar) {
  const m = new Map()
  const livres = preservar
    ? total - [...preservarMap.values()].reduce((s, v) => s + v, 0)
    : total
  const instLivres = preservar
    ? instancias.filter(id => !preservarMap.has(id))
    : instancias

  if (preservar) instancias.forEach(id => { if (preservarMap.has(id)) m.set(id, preservarMap.get(id)) })

  if (!instLivres.length) return m

  const base = Math.floor(livres / instLivres.length)
  const extras = livres % instLivres.length

  instLivres.forEach((id, i) => m.set(id, base + (i < extras ? 1 : 0)))
  return m
}

function distribuirQuantidade(instancias, total, configMap, preservarMap, preservar) {
  const m = new Map()
  const erros = []

  instancias.forEach(id => {
    const cfg = configMap.get(id)
    let qtd = Number(cfg?.quantidade ?? 0)
    if (preservar && preservarMap.has(id)) qtd = preservarMap.get(id)
    if (qtd < 0) { erros.push(`Quantidade inválida para instância ${id}.`); qtd = 0 }
    m.set(id, qtd)
  })

  const soma = [...m.values()].reduce((s, v) => s + v, 0)
  if (soma !== total) {
    erros.push(`A soma das quantidades (${soma}) não é igual ao total de destinatários (${total}).`)
  }

  return { dist: m, errosQ: erros }
}

function distribuirPercentual(instancias, total, configMap, preservarMap, preservar) {
  const m = new Map()
  const erros = []

  const somaPerc = instancias.reduce((s, id) => {
    if (preservar && preservarMap.has(id)) return s
    const pct = Number(configMap.get(id)?.percentual ?? 0)
    return s + pct
  }, 0)

  const instLivres = preservar ? instancias.filter(id => !preservarMap.has(id)) : instancias

  if (Math.abs(somaPerc - 100) > 0.01 && instLivres.length) {
    erros.push(`A soma dos percentuais (${somaPerc.toFixed(2)}%) deve ser exatamente 100%.`)
  }

  if (preservar) instancias.forEach(id => { if (preservarMap.has(id)) m.set(id, preservarMap.get(id)) })

  const livres = preservar
    ? total - [...preservarMap.values()].reduce((s, v) => s + v, 0)
    : total

  // Calcula floor para todos, depois distribui o restante ao de maior percentual
  const floors = instLivres.map(id => {
    const pct = Number(configMap.get(id)?.percentual ?? 0)
    return { id, pct, qtd: Math.floor(livres * pct / 100) }
  })
  const somaFloor = floors.reduce((s, f) => s + f.qtd, 0)
  const resto = livres - somaFloor

  // Ordena por (pct * total - floor) descrescente para distribuir o restante
  const sorted = [...floors].sort((a, b) => {
    const ra = (a.pct * livres / 100) - a.qtd
    const rb = (b.pct * livres / 100) - b.qtd
    return rb - ra
  })
  sorted.forEach((f, i) => { f.qtd += (i < resto ? 1 : 0) })

  floors.forEach(f => m.set(f.id, f.qtd))

  return { dist: m, errosP: erros }
}

/**
 * Aplica a distribuição calculada no banco (operação em lote).
 */
async function aplicarDistribuicao(campanhaId, companyId, modo, plano, configuracoes, preservar) {
  const instanciasPlano = plano.instancias

  // Atualiza as configurações em disparo_campanha_instancias
  const configMap = new Map((configuracoes ?? []).map(c => [Number(c.instancia_id), c]))
  for (const inst of instanciasPlano) {
    const cfg = configMap.get(inst.instancia_id) ?? {}
    await supabase.from('disparo_campanha_instancias')
      .update({
        distribuicao: modo,
        quantidade: modo === 'quantidade' ? inst.quantidade : null,
        percentual: modo === 'percentual' ? (cfg.percentual ?? null) : null,
      })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('instancia_id', inst.instancia_id)
  }

  if (modo === 'manual') return // atribuição manual feita pelo endpoint específico

  // Reseta instâncias dos destinatários (apenas os não preservados)
  if (!preservar) {
    await supabase.from('disparo_campanha_destinatarios')
      .update({ instancia_id: null })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')
  }

  // Busca IDs dos destinatários sem instância (após reset)
  const { data: livres } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
    .is('instancia_id', null)
    .order('id', { ascending: true })

  const ids = (livres ?? []).map(r => r.id)
  let offset = 0

  for (const inst of instanciasPlano) {
    const qtd = inst.quantidade - (preservar ? inst.preservado ?? 0 : 0)
    if (qtd <= 0) continue
    const chunk = ids.slice(offset, offset + qtd)
    offset += qtd
    if (!chunk.length) continue

    for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
      const batch = chunk.slice(i, i + BATCH_SIZE)
      await supabase.from('disparo_campanha_destinatarios')
        .update({ instancia_id: inst.instancia_id })
        .in('id', batch)
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId)
    }
  }
}
