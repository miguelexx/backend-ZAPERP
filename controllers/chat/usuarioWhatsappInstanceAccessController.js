/**
 * Configuração admin: quais atendentes veem as conversas de cada número WhatsApp.
 * company_id vem só do JWT. Sem marcação para um atendente, a visão dele não muda.
 */

const supabase = require('../../config/supabase')
const { invalidateCountsCache } = require('../../services/chatListCountsService')
const { invalidateConversaVisibilityCacheEmpresa } = require('../../services/chat/access/conversationVisibilityService')
const { emitirParaUsuario } = require('../../services/chat/realtime/chatRealtimeGateway')
const {
  AcessoNumerosIndisponivel,
  instanciasPermitidasDoUsuario,
  listarVinculos,
  substituirAtendentesDoNumero,
} = require('../../services/chat/access/usuarioWhatsappInstanceAccess')

function statusDeErro(err) {
  return Number(err?.statusCode) || (err instanceof AcessoNumerosIndisponivel ? 503 : 500)
}

exports.listar = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    if (!Number.isInteger(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }

    const [{ data: instances, error: instErr }, { data: atendentes, error: userErr }] = await Promise.all([
      supabase
        .from('whatsapp_instances')
        .select('id, nome, display_phone, telefone_conectado, provider, ativo')
        .eq('company_id', company_id)
        .order('nome', { ascending: true }),
      supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .eq('perfil', 'atendente')
        .eq('ativo', true)
        .order('nome', { ascending: true }),
    ])
    if (instErr) {
      console.error('[acesso-numeros] instancias', instErr.message)
      return res.status(500).json({ error: 'Erro ao listar números' })
    }
    if (userErr) {
      console.error('[acesso-numeros] atendentes', userErr.message)
      return res.status(500).json({ error: 'Erro ao listar atendentes' })
    }

    let vinculos = []
    let configuracao_disponivel = true
    try {
      vinculos = await listarVinculos(company_id)
    } catch (err) {
      if (err instanceof AcessoNumerosIndisponivel || err?.statusCode === 503) {
        configuracao_disponivel = false
      } else {
        throw err
      }
    }

    const porInstancia = new Map()
    for (const row of vinculos) {
      const iid = Number(row.whatsapp_instance_id)
      const uid = Number(row.usuario_id)
      if (!porInstancia.has(iid)) porInstancia.set(iid, [])
      porInstancia.get(iid).push(uid)
    }

    return res.json({
      configuracao_disponivel,
      instances: (instances || []).map((inst) => ({
        id: inst.id,
        nome: inst.nome,
        display_phone: inst.display_phone,
        telefone_conectado: inst.telefone_conectado,
        provider: inst.provider,
        ativo: inst.ativo,
        atendente_ids: porInstancia.get(Number(inst.id)) || [],
      })),
      atendentes: atendentes || [],
    })
  } catch (err) {
    console.error('[acesso-numeros] listar', err?.message || err)
    return res.status(statusDeErro(err)).json({ error: err?.statusCode ? err.message : 'Erro ao carregar a configuração' })
  }
}

exports.salvar = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    const whatsapp_instance_id = Number(req.params?.id)
    const usuario_ids = req.body?.usuario_ids
    if (!Number.isInteger(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }
    if (!Array.isArray(usuario_ids)) {
      return res.status(400).json({ error: 'usuario_ids deve ser uma lista de atendentes' })
    }

    const resultado = await substituirAtendentesDoNumero({
      company_id,
      whatsapp_instance_id,
      usuario_ids,
    })

    invalidateConversaVisibilityCacheEmpresa(company_id)
    invalidateCountsCache(company_id)

    const io = req.app.get('io')
    if (io && resultado.afetados.length > 0) {
      await Promise.all(resultado.afetados.map(async (usuario_id) => {
        const permitidas = await instanciasPermitidasDoUsuario(company_id, usuario_id)
        emitirParaUsuario(io, usuario_id, 'acesso_numeros_atualizado', {
          company_id,
          sem_restricao: permitidas == null,
          whatsapp_instance_ids: permitidas ? [...permitidas] : [],
        })
      }))
    }

    return res.json({
      whatsapp_instance_id,
      atendente_ids: resultado.atendente_ids,
    })
  } catch (err) {
    const status = statusDeErro(err)
    if (status >= 500) console.error('[acesso-numeros] salvar', err?.message || err)
    return res.status(status).json({
      error: status === 500 ? 'Erro ao salvar a visão dos atendentes' : (err.message || 'Erro ao salvar'),
    })
  }
}
