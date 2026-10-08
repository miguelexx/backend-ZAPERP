/**
 * Admin da empresa define, POR NUMERO WhatsApp, quais usuarios veem as conversas
 * daquele numero. Tabela: whatsapp_instance_visibilidade (ver migration).
 *
 * Regras:
 *   - Numero sem linha salva = todos veem (padrao de hoje).
 *   - PUT substitui o conjunto EXATO daquele numero (array vazio = "Todos veem").
 *   - company_id SEMPRE do JWT. Instancia/usuarios validados contra a empresa do token.
 *
 * Rotas montadas sob supervisorOrAdmin (quem ja administra a empresa).
 */

const supabase = require('../config/supabase')
const {
  listWhatsappInstances,
  getWhatsappInstanceById,
} = require('../services/whatsappInstanceService')
const {
  invalidateCompanyVisibilityCache,
  carregarCompanyVisibilitySemCache,
} = require('../services/chat/access/whatsappInstanceVisibilityService')
const { invalidateConversaVisibilityCacheByCompany } = require('../services/chat/access/conversationVisibilityService')
const { invalidateCountsCache } = require('../services/chatListCountsService')

function parseUsuarioIds(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const v of raw) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

// GET /integrations/whatsapp/visibilidade
// Devolve os numeros ativos, os usuarios ativos e quem esta marcado em cada numero.
exports.getVisibilidade = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const [{ instances, error: listErr }, usuariosRes, mapRes] = await Promise.all([
      listWhatsappInstances(company_id),
      supabase
        .from('usuarios')
        .select('id, nome, email, perfil')
        .eq('company_id', Number(company_id))
        .eq('ativo', true)
        .order('nome', { ascending: true }),
      carregarCompanyVisibilitySemCache(company_id),
    ])

    if (listErr) return res.status(500).json({ error: listErr })
    if (usuariosRes.error) return res.status(500).json({ error: 'Erro ao listar usuários' })

    const porNumero = mapRes?.porNumero || new Map()
    const usuarios = (usuariosRes.data || []).map((u) => ({
      id: Number(u.id),
      nome: u.nome ?? null,
      email: u.email ?? null,
      perfil: u.perfil ?? null,
    }))

    // Só numeros reais (id numerico, ativos). Instancia legada (id null) nao tem visibilidade.
    const numeros = (instances || [])
      .filter((i) => i && i.ativo !== false && i.id != null)
      .map((i) => {
        const set = porNumero.get(Number(i.id))
        const marcados = set ? [...set] : []
        return {
          whatsapp_instance_id: Number(i.id),
          nome: i.nome ?? null,
          provider: i.provider ?? null,
          display_phone: i.display_phone ?? null,
          telefone_conectado: i.telefone_conectado ?? null,
          is_default: i.is_default === true,
          todos_veem: marcados.length === 0,
          usuarios_marcados: marcados,
        }
      })

    return res.json({
      numeros,
      usuarios,
      has_multiple_whatsapp_instances: numeros.length > 1,
    })
  } catch (err) {
    console.error('getVisibilidade:', err?.message || err)
    return res.status(500).json({ error: 'Erro ao carregar visibilidade por número' })
  }
}

// PUT /integrations/whatsapp/instances/:id/visibilidade  { usuario_ids: [..] }
// Os ids enviados sao EXATAMENTE quem ve o numero. [] = "Todos veem" (apaga as linhas).
exports.putVisibilidade = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const cid = Number(company_id)
    const instanceId = Number(req.params?.id)
    if (!Number.isInteger(instanceId) || instanceId <= 0) {
      return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
    }

    // Instancia precisa pertencer a ESTA empresa e estar ativa (403/404 sem vazar dado).
    const { instance, error: instErr } = await getWhatsappInstanceById(cid, instanceId, { requireActive: true })
    if (instErr || !instance) {
      return res.status(404).json({ error: 'Número WhatsApp não encontrado nesta empresa' })
    }

    const usuarioIds = parseUsuarioIds(req.body?.usuario_ids)

    // Mantem apenas usuarios ativos da mesma empresa (defesa; a RPC tambem filtra).
    let usuariosValidos = []
    if (usuarioIds.length > 0) {
      const { data: rows, error } = await supabase
        .from('usuarios')
        .select('id')
        .eq('company_id', cid)
        .eq('ativo', true)
        .in('id', usuarioIds)
      if (error) return res.status(500).json({ error: 'Erro ao validar usuários' })
      usuariosValidos = (rows || []).map((r) => Number(r.id))
    }

    // Substituicao atomica via RPC (DELETE + INSERT numa transacao). Fallback para
    // DELETE+INSERT sequencial caso a funcao ainda nao exista no banco.
    const rpc = await supabase.rpc('set_whatsapp_instance_visibilidade', {
      p_company: cid,
      p_instance: instanceId,
      p_user_ids: usuariosValidos,
    })

    if (rpc.error) {
      const msg = String(rpc.error.message || '')
      const code = String(rpc.error.code || '')
      const missingFn = code === 'PGRST202' || msg.includes('set_whatsapp_instance_visibilidade') || msg.toLowerCase().includes('function')
      if (!missingFn) {
        console.error('putVisibilidade rpc:', msg)
        return res.status(500).json({ error: 'Erro ao salvar visibilidade do número' })
      }
      // Fallback sem RPC (tabela existe, funcao nao): apaga e reinsere.
      const del = await supabase
        .from('whatsapp_instance_visibilidade')
        .delete()
        .eq('company_id', cid)
        .eq('whatsapp_instance_id', instanceId)
      if (del.error) {
        console.error('putVisibilidade delete:', del.error.message)
        return res.status(500).json({ error: 'Erro ao salvar visibilidade do número' })
      }
      if (usuariosValidos.length > 0) {
        const ins = await supabase
          .from('whatsapp_instance_visibilidade')
          .insert(usuariosValidos.map((uid) => ({
            company_id: cid,
            whatsapp_instance_id: instanceId,
            usuario_id: uid,
          })))
        if (ins.error) {
          console.error('putVisibilidade insert:', ins.error.message)
          return res.status(500).json({ error: 'Erro ao salvar visibilidade do número' })
        }
      }
    }

    // Invalida todos os caches afetados para a tela atualizar sem esperar o TTL.
    invalidateCompanyVisibilityCache(cid)
    invalidateConversaVisibilityCacheByCompany(cid)
    invalidateCountsCache(cid)

    const todosVeem = usuariosValidos.length === 0

    // Realtime: quem perdeu acesso dropa as conversas do numero; quem ganhou recarrega.
    const io = req.app?.get?.('io') || null
    if (io) {
      io.to(`empresa_${cid}`).emit('whatsapp_instance_visibilidade_atualizada', {
        company_id: cid,
        whatsapp_instance_id: instanceId,
        usuario_ids: usuariosValidos,
        todos_veem: todosVeem,
      })
    }

    return res.json({
      ok: true,
      whatsapp_instance_id: instanceId,
      usuarios_marcados: usuariosValidos,
      todos_veem: todosVeem,
    })
  } catch (err) {
    console.error('putVisibilidade:', err?.message || err)
    return res.status(500).json({ error: 'Erro ao salvar visibilidade do número' })
  }
}
