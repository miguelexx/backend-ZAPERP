const supabase = require('../config/supabase')

const MOVIMENTACAO_INTERNA_TIPO = 'movimentacao_interna_atendimento'
const MOVIMENTACAO_INTERNA_RODAPE = 'Mensagem invisível para o cliente.'

function nomeUsuario(userMap, id, fallback = 'Usuário') {
  if (id == null) return fallback
  const raw = userMap?.[Number(id)] ?? userMap?.[String(id)]
  const nome = raw != null ? String(raw).trim() : ''
  return nome || fallback
}

function buildMensagemInternaMovimentacao(atendimento, userMap = {}) {
  if (!atendimento || !['assumiu', 'transferiu'].includes(String(atendimento.acao || '').toLowerCase())) {
    return null
  }

  const acao = String(atendimento.acao || '').toLowerCase()
  const deNome = nomeUsuario(userMap, atendimento.de_usuario_id, 'Usuário')
  const paraNome = nomeUsuario(
    userMap,
    atendimento.para_usuario_id,
    acao === 'assumiu' ? (deNome || 'Atendente') : 'Atendente'
  )
  const origemLabel = deNome === 'Usuário' ? 'Usuário' : `Usuário ${deNome}`
  const destinoLabel = paraNome === 'Atendente' ? 'Atendente' : `Atendente ${paraNome}`
  const corpo = acao === 'transferiu'
    ? `${origemLabel} transferiu este atendimento para ${destinoLabel}.`
    : `${destinoLabel} assumiu este atendimento.`

  return {
    id: `internal-movement-${atendimento.id}`,
    atendimento_id: atendimento.id != null ? Number(atendimento.id) : null,
    conversa_id: Number(atendimento.conversa_id),
    company_id: atendimento.company_id != null ? Number(atendimento.company_id) : null,
    texto: `✨ Movimentação interna\n${corpo}`,
    direcao: 'system',
    tipo: MOVIMENTACAO_INTERNA_TIPO,
    status: 'internal',
    whatsapp_id: null,
    criado_em: atendimento.criado_em,
    autor_usuario_id: null,
    fromMe: false,
    mensagem_interna: true,
    visibilidade_perfis: ['admin', 'supervisor'],
    movimentacao_interna: {
      titulo: 'Movimentação interna',
      corpo,
      rodape: MOVIMENTACAO_INTERNA_RODAPE,
      acao,
      de_usuario_id: atendimento.de_usuario_id != null ? Number(atendimento.de_usuario_id) : null,
      para_usuario_id: atendimento.para_usuario_id != null ? Number(atendimento.para_usuario_id) : null,
      de_usuario_nome: deNome,
      para_usuario_nome: paraNome,
    },
  }
}

async function listarMensagensInternasMovimentacao({ company_id, conversa_id }) {
  const { data: rows, error } = await supabase
    .from('atendimentos')
    .select('id, company_id, conversa_id, acao, observacao, criado_em, de_usuario_id, para_usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .in('acao', ['assumiu', 'transferiu'])
    .order('criado_em', { ascending: true })

  if (error) {
    console.warn('[atendimentosRegistroService] listar movimentacoes internas:', error?.message || error)
    return []
  }

  const userIds = new Set()
  ;(rows || []).forEach((row) => {
    if (row.de_usuario_id != null) userIds.add(Number(row.de_usuario_id))
    if (row.para_usuario_id != null) userIds.add(Number(row.para_usuario_id))
  })

  const userMap = {}
  const ids = [...userIds].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length > 0) {
    const { data: usuarios, error: errUsuarios } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', Number(company_id))
      .in('id', ids)
    if (!errUsuarios) {
      ;(usuarios || []).forEach((u) => { userMap[Number(u.id)] = u.nome || '' })
    }
  }

  return (rows || [])
    .map((row) => buildMensagemInternaMovimentacao(row, userMap))
    .filter(Boolean)
}

async function registrarAtendimento({
  conversa_id,
  company_id,
  acao,
  de_usuario_id,
  para_usuario_id = null,
  observacao = null
}) {
  const { data, error } = await supabase
    .from('atendimentos')
    .insert({
      conversa_id: Number(conversa_id),
      company_id: Number(company_id),
      acao,
      de_usuario_id: de_usuario_id != null ? Number(de_usuario_id) : null,
      para_usuario_id: para_usuario_id != null ? Number(para_usuario_id) : null,
      observacao
    })
    .select('id, company_id, conversa_id, acao, observacao, criado_em, de_usuario_id, para_usuario_id')
    .single()
  if (error) return { error, atendimento: null }
  return { error: null, atendimento: data }
}

module.exports = {
  MOVIMENTACAO_INTERNA_TIPO,
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
}
