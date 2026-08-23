/**
 * Checklist centralizado da Etapa 6 — classificação: aprovado | aviso | bloqueio.
 * Sem envio real. Revalidação de instâncias deve usar dados atuais do banco.
 */

const crypto = require('crypto')

const DECLARACAO_AUTORIZACAO =
  'Confirmo que os destinatários selecionados possuem autorização ou relação legítima para receber esta comunicação e que o conteúdo está de acordo com as regras aplicáveis.'

const SEVERIDADE = { APROVADO: 'aprovado', AVISO: 'aviso', BLOQUEIO: 'bloqueio' }

function item(codigo, severidade, titulo, detalhe, etapa = null, comoCorrigir = null) {
  return {
    codigo,
    severidade,
    titulo,
    detalhe,
    etapa, // id do step do wizard: info|destinatarios|instancias|mensagens|limites
    como_corrigir: comoCorrigir,
  }
}

/**
 * Monta checklist a partir de um contexto já carregado.
 * @param {object} ctx
 */
function montarChecklist(ctx) {
  const itens = []
  const {
    companyIdToken,
    campanha,
    isAdmin,
    destinatarios = [],
    instanciasStatus = [],
    variacoes = [],
    limites = null,
    janelas = [],
    conflitos = { conflito_impeditivo: false, conflitos: [] },
    midiasInvalidas = [],
    varsAusentesCount = 0,
    autorizacaoAceita = false,
  } = ctx

  // Empresa / admin
  if (Number(campanha?.company_id) !== Number(companyIdToken)) {
    itens.push(item('empresa', SEVERIDADE.BLOQUEIO, 'Campanha de outra empresa',
      'A campanha não pertence à empresa autenticada.', null, null))
  } else {
    itens.push(item('empresa', SEVERIDADE.APROVADO, 'Isolamento por empresa', 'Campanha pertence à empresa do token.'))
  }

  if (!isAdmin) {
    itens.push(item('admin', SEVERIDADE.BLOQUEIO, 'Sem permissão de administrador',
      'Apenas administradores podem confirmar o disparo.', null, null))
  } else {
    itens.push(item('admin', SEVERIDADE.APROVADO, 'Administrador autorizado', 'Usuário com perfil admin.'))
  }

  const ativos = destinatarios.filter((d) => d.status !== 'excluido')
  const total = ativos.length

  if (total < 1) {
    itens.push(item('dest_total', SEVERIDADE.BLOQUEIO, 'Sem destinatários válidos',
      'É necessário ao menos um destinatário.', 'destinatarios', 'Adicione contatos ou importe uma planilha.'))
  } else {
    itens.push(item('dest_total', SEVERIDADE.APROVADO, 'Destinatários válidos', `${total} destinatário(s).`))
  }

  // Duplicatas de telefone (não excluídos)
  const fones = new Map()
  let dups = 0
  for (const d of ativos) {
    const t = d.telefone_normalizado
    if (!t) continue
    fones.set(t, (fones.get(t) || 0) + 1)
  }
  for (const c of fones.values()) if (c > 1) dups += c - 1
  if (dups > 0) {
    itens.push(item('dest_dup', SEVERIDADE.BLOQUEIO, 'Telefones duplicados',
      `${dups} duplicata(s) detectada(s).`, 'destinatarios', 'Remova destinatários duplicados.'))
  } else if (total > 0) {
    itens.push(item('dest_dup', SEVERIDADE.APROVADO, 'Sem duplicatas de telefone', 'Telefones únicos na campanha.'))
  }

  const semInst = ativos.filter((d) => !d.instancia_id).length
  if (semInst > 0) {
    itens.push(item('dest_inst', SEVERIDADE.BLOQUEIO, 'Destinatários sem instância',
      `${semInst} sem instância atribuída.`, 'instancias', 'Confirme a distribuição de instâncias.'))
  } else if (total > 0) {
    itens.push(item('dest_inst', SEVERIDADE.APROVADO, 'Todos com instância', 'Cada destinatário tem uma instância.'))
  }

  const semVar = ativos.filter((d) => !d.variacao_id).length
  if (semVar > 0) {
    itens.push(item('dest_var', SEVERIDADE.BLOQUEIO, 'Destinatários sem variação',
      `${semVar} sem variação atribuída.`, 'mensagens', 'Confirme a distribuição das mensagens.'))
  } else if (total > 0) {
    itens.push(item('dest_var', SEVERIDADE.APROVADO, 'Todos com variação', 'Cada destinatário tem exatamente uma variação.'))
  }

  if (!campanha?.distribuicao_confirmada) {
    itens.push(item('dist_inst', SEVERIDADE.BLOQUEIO, 'Distribuição de instâncias não confirmada',
      'Etapa 3 pendente.', 'instancias', 'Confirme a distribuição na etapa Instâncias.'))
  } else {
    itens.push(item('dist_inst', SEVERIDADE.APROVADO, 'Distribuição de instâncias confirmada', 'Etapa 3 ok.'))
  }

  if (!campanha?.variacao_confirmada) {
    itens.push(item('dist_msg', SEVERIDADE.BLOQUEIO, 'Distribuição de mensagens não confirmada',
      'Etapa 4 pendente.', 'mensagens', 'Confirme a distribuição na etapa Mensagens.'))
  } else {
    itens.push(item('dist_msg', SEVERIDADE.APROVADO, 'Distribuição de mensagens confirmada', 'Etapa 4 ok.'))
  }

  if (!campanha?.limites_confirmados) {
    itens.push(item('lim_conf', SEVERIDADE.BLOQUEIO, 'Limites/horários não confirmados',
      'Etapa 5 pendente.', 'limites', 'Confirme a configuração na etapa Limites.'))
  } else {
    itens.push(item('lim_conf', SEVERIDADE.APROVADO, 'Limites/horários confirmados', 'Etapa 5 ok.'))
  }

  const revisoes = []
  if (campanha?.distribuicao_revisao) revisoes.push('instâncias')
  if (campanha?.variacao_revisao) revisoes.push('mensagens')
  if (campanha?.limites_revisao) revisoes.push('limites')
  if (revisoes.length) {
    itens.push(item('revisao', SEVERIDADE.BLOQUEIO, 'Etapas necessitando revisão',
      `Revisão pendente: ${revisoes.join(', ')}.`, revisoes[0] === 'instâncias' ? 'instancias' : revisoes[0] === 'mensagens' ? 'mensagens' : 'limites',
      'Reabra a etapa marcada e confirme novamente.'))
  } else {
    itens.push(item('revisao', SEVERIDADE.APROVADO, 'Nenhuma revisão pendente', 'Todas as etapas confirmadas estão atualizadas.'))
  }

  const inativas = (instanciasStatus || []).filter((i) => i.ativo === false)
  const statusDuvidoso = (instanciasStatus || []).filter((i) => {
    if (i.ativo === false) return false
    const st = String(i.status || '').toLowerCase()
    return !['connected', 'authenticated', 'standby'].includes(st)
  })
  if (inativas.length) {
    itens.push(item('inst_conn', SEVERIDADE.BLOQUEIO, 'Instâncias inativas',
      inativas.map((i) => `${i.nome || i.id} (${i.status})`).join('; '),
      'instancias', 'Reative a instância nas configurações WhatsApp.'))
  } else if (statusDuvidoso.length) {
    itens.push(item('inst_conn', SEVERIDADE.AVISO, 'Status de conexão não confirmado no banco',
      statusDuvidoso.map((i) => `${i.nome || i.id} (${i.status || 'unknown'})`).join('; ')
      + ' — se o atendimento já usa a instância, pode confirmar e enviar.',
      'instancias', 'Opcional: reconecte no painel UltraMSG; o envio tenta mesmo assim.'))
  } else if ((instanciasStatus || []).length) {
    itens.push(item('inst_conn', SEVERIDADE.APROVADO, 'Instâncias ativas', 'Todas as selecionadas estão ativas.'))
  } else {
    itens.push(item('inst_conn', SEVERIDADE.BLOQUEIO, 'Nenhuma instância selecionada',
      'Selecione ao menos uma instância.', 'instancias', 'Volte à etapa Instâncias.'))
  }

  if (varsAusentesCount > 0) {
    itens.push(item('vars', SEVERIDADE.BLOQUEIO, 'Variáveis sem valor',
      `${varsAusentesCount} ocorrência(s) de variável sem valor e sem padrão.`,
      'mensagens', 'Defina valores padrão ou complete os dados dos destinatários.'))
  } else {
    itens.push(item('vars', SEVERIDADE.APROVADO, 'Variáveis resolvidas', 'Nenhuma variável obrigatória pendente.'))
  }

  if (midiasInvalidas.length) {
    itens.push(item('midia', SEVERIDADE.BLOQUEIO, 'Mídias inválidas ou inacessíveis',
      midiasInvalidas.map((m) => m.motivo).join('; '),
      'mensagens', 'Substitua ou remova as mídias com problema.'))
  } else {
    itens.push(item('midia', SEVERIDADE.APROVADO, 'Mídias válidas', 'Referências de mídia presentes e coerentes com o tipo.'))
  }

  // Formatos — aviso se MOV/AVI (compatibilidade UltraMSG não confirmada)
  const tiposRisco = (variacoes || []).filter((v) => {
    const n = String(v.midia_nome_original || '').toLowerCase()
    const mime = String(v.midia_mime || '').toLowerCase()
    return n.endsWith('.mov') || n.endsWith('.avi') || mime.includes('quicktime') || mime.includes('x-msvideo')
  })
  if (tiposRisco.length) {
    itens.push(item('formato', SEVERIDADE.AVISO, 'Formatos com compatibilidade não confirmada',
      `${tiposRisco.length} variação(ões) com MOV/AVI — confirme com o provedor antes do envio (Etapa 7).`,
      'mensagens', 'Prefira MP4 quando possível.'))
  } else {
    itens.push(item('formato', SEVERIDADE.APROVADO, 'Formatos de mídia aceitáveis', 'Sem formatos de risco conhecidos.'))
  }

  const ativas = (variacoes || []).filter((v) => v.ativa !== false)
  if (!ativas.length) {
    itens.push(item('vars_ativas', SEVERIDADE.BLOQUEIO, 'Nenhuma variação ativa',
      'Crie ao menos uma variação ativa.', 'mensagens', 'Ative ou crie uma variação.'))
  } else {
    itens.push(item('vars_ativas', SEVERIDADE.APROVADO, 'Variações ativas', `${ativas.length} variação(ões) ativa(s).`))
  }

  if (!limites) {
    itens.push(item('limites', SEVERIDADE.BLOQUEIO, 'Limites não configurados',
      'Configure a Etapa 5.', 'limites', 'Preencha e confirme os limites.'))
  } else if (
    !(limites.intervalo_min_sec > 0) ||
    limites.intervalo_min_sec > limites.intervalo_max_sec ||
    !(limites.limite_por_hora > 0) ||
    !(limites.limite_por_dia > 0)
  ) {
    itens.push(item('limites', SEVERIDADE.BLOQUEIO, 'Limites inválidos',
      'Intervalos ou limites inconsistentes.', 'limites', 'Corrija intervalos e limites.'))
  } else {
    itens.push(item('limites', SEVERIDADE.APROVADO, 'Limites e intervalos válidos', 'Configuração coerente.'))
  }

  const janelasAtivas = (janelas || []).filter((j) => j.ativo !== false && j.instancia_id == null)
  if (!janelasAtivas.length) {
    itens.push(item('janelas', SEVERIDADE.BLOQUEIO, 'Sem janela de horário',
      'É necessário ao menos um período ativo.', 'limites', 'Configure dias e horários na Etapa 5.'))
  } else {
    itens.push(item('janelas', SEVERIDADE.APROVADO, 'Janelas de horário configuradas',
      `${janelasAtivas.length} período(s) ativo(s).`))
  }

  if (limites?.inicio_modo === 'agendado') {
    if (!limites.agendado_para) {
      itens.push(item('agenda', SEVERIDADE.BLOQUEIO, 'Agendamento incompleto',
        'Modo agendado sem data/hora.', 'limites', 'Defina a data/hora ou mude para início imediato.'))
    } else {
      const t = Date.parse(limites.agendado_para)
      if (!Number.isFinite(t) || t < Date.now() - 60_000) {
        itens.push(item('agenda', SEVERIDADE.BLOQUEIO, 'Agendamento no passado ou inválido',
          'Ajuste a data/hora futura.', 'limites', 'Escolha um horário futuro dentro das janelas.'))
      } else {
        itens.push(item('agenda', SEVERIDADE.APROVADO, 'Agendamento válido',
          `Agendado para ${limites.agendado_para} (${limites.fuso_horario || 'UTC'}).`))
      }
    }
  } else {
    itens.push(item('agenda', SEVERIDADE.APROVADO, 'Início após confirmação futura',
      'Modo imediato — o envio real ocorrerá na Etapa 7, não agora.'))
  }

  if (conflitos?.conflito_impeditivo) {
    itens.push(item('conflito', SEVERIDADE.BLOQUEIO, 'Conflito impeditivo de campanhas',
      `${(conflitos.conflitos || []).length} conflito(s) nas mesmas instâncias.`,
      'limites', 'Resolva campanhas em execução/agendadas na mesma instância.'))
  } else if ((conflitos?.conflitos || []).length) {
    itens.push(item('conflito', SEVERIDADE.AVISO, 'Possíveis sobreposições',
      'Há outras campanhas relacionadas às mesmas instâncias.',
      'limites', 'Revise o planejamento antes de confirmar.'))
  } else {
    itens.push(item('conflito', SEVERIDADE.APROVADO, 'Sem conflitos impeditivos', 'Nenhuma outra campanha bloqueia as instâncias.'))
  }

  if (!autorizacaoAceita) {
    itens.push(item('autorizacao', SEVERIDADE.BLOQUEIO, 'Autorização não confirmada',
      'Marque a declaração de responsabilidade.', 'revisao',
      'Aceite a declaração na tela de Revisão.'))
  } else {
    itens.push(item('autorizacao', SEVERIDADE.APROVADO, 'Autorização confirmada', 'Declaração aceita pelo administrador.'))
  }

  const bloqueios = itens.filter((i) => i.severidade === SEVERIDADE.BLOQUEIO)
  const avisos = itens.filter((i) => i.severidade === SEVERIDADE.AVISO)
  const aprovados = itens.filter((i) => i.severidade === SEVERIDADE.APROVADO)

  return {
    itens,
    bloqueios,
    avisos,
    aprovados,
    ok: bloqueios.length === 0,
    totais: {
      aprovados: aprovados.length,
      avisos: avisos.length,
      bloqueios: bloqueios.length,
    },
  }
}

function mascararTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '')
  if (d.length < 8) return '****'
  return `${d.slice(0, 4)}****${d.slice(-4)}`
}

/**
 * Payload canônico para hash (sem PII completa, sem tokens).
 */
function montarPayloadHash({
  campanhaId,
  companyId,
  nome,
  instanciaIds,
  variacaoIds,
  limites,
  janelas,
  totalDest,
  distribuicaoModo,
  variacaoModo,
}) {
  return {
    v: 1,
    campanha_id: campanhaId,
    company_id: companyId,
    nome,
    instancias: [...(instanciaIds || [])].sort((a, b) => a - b),
    variacoes: [...(variacaoIds || [])].sort((a, b) => a - b),
    total_destinatarios: totalDest,
    distribuicao_modo: distribuicaoModo || null,
    variacao_modo: variacaoModo || null,
    limites: limites
      ? {
          limite_por_hora: limites.limite_por_hora,
          limite_por_dia: limites.limite_por_dia,
          intervalo_min_sec: limites.intervalo_min_sec,
          intervalo_max_sec: limites.intervalo_max_sec,
          lote_tamanho: limites.lote_tamanho,
          pausa_lote_min_sec: limites.pausa_lote_min_sec,
          pausa_lote_max_sec: limites.pausa_lote_max_sec,
          fuso: limites.fuso_horario,
          inicio_modo: limites.inicio_modo,
          agendado_para: limites.agendado_para || null,
          data_limite: limites.data_limite || null,
        }
      : null,
    janelas: (janelas || [])
      .filter((j) => j.instancia_id == null)
      .map((j) => ({
        d: j.dia_semana,
        i: String(j.hora_inicio).slice(0, 8),
        f: String(j.hora_fim).slice(0, 8),
        a: j.ativo !== false,
      }))
      .sort((a, b) => a.d - b.d || a.i.localeCompare(b.i)),
  }
}

function hashConfig(payload) {
  const json = JSON.stringify(payload)
  return crypto.createHash('sha256').update(json).digest('hex')
}

module.exports = {
  DECLARACAO_AUTORIZACAO,
  SEVERIDADE,
  montarChecklist,
  mascararTelefone,
  montarPayloadHash,
  hashConfig,
}
