'use strict'

/** overview aninhado (GENERAL_CHAT) ou métricas na raiz (METRICS_OVERVIEW). */
function overviewLikePayload(data) {
  if (!data || typeof data !== 'object') return null
  if (data.overview && typeof data.overview === 'object') return data.overview
  if (data.totalConversas != null || data.ticketsAbertos != null || data.atendimentosHoje != null) return data
  return null
}

/**
 * Evita resposta textual negando atividade quando o payload tem totais > 0.
 */
function sanearRespostaContradicaoMetricas(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  if (intent !== 'GENERAL_CHAT' && intent !== 'METRICS_OVERVIEW') return answer
  const ov = overviewLikePayload(data)
  if (!ov || typeof ov !== 'object') return answer
  const tc = Number(ov.totalConversas)
  const mr = Number(ov.mensagensRecebidas)
  const me = Number(ov.mensagensEnviadas)
  const ta = Number(ov.ticketsAbertos)
  const ch = Number(ov.conversasHoje)
  const cf = Number(ov.conversasFechadas)
  const tem = (tc > 0) || (mr > 0) || (me > 0) || (ta > 0) || (ch > 0) || (cf > 0)
  if (!tem) return answer
  const pat = /(n(ao|ão)\s+h(ouve|á|existem)|sem\s+(conversas?|atendimentos?|registros?)|n(enhum|uma)\s+conversa|zero\s+(conversas?|atividade)|nada\s+(registrad|consta)|não\s+houve\s+(atendimentos?|conversas?)|não\s+há\s+(conversas?|atendimentos?|registros?)|não\s+consta|não\s+existem\s+conversas?|inexistente)/i
  if (!pat.test(answer)) return answer
  const ah = ov.atendimentosHoje ?? 0
  return `${answer.trim()}\n\n**Correção automática (dados do painel):** Há totais positivos no escopo retornado: totalConversas (amostra): ${tc}, conversasHoje: ${ch}, conversasFechadas: ${cf}, ticketsAbertos: ${ta}, mensagens recebidas/enviadas (totais na tabela mensagens): ${mr} / ${me}. O valor atendimentosHoje (${ah}) refere-se só a eventos na tabela atendimentos desde hoje, não substitui conversas nem mensagens.`
}

function evidenciaConversasOuMensagens(data, intent) {
  const nm = Array.isArray(data?.mensagens) ? data.mensagens.length : 0
  if (nm > 0) return { tipo: 'mensagens', n: nm, label: 'mensagens' }
  const nc = Array.isArray(data?.conversas) ? data.conversas.length : 0
  if (nc > 0) return { tipo: 'conversas', n: nc, label: 'conversas' }
  if (intent === 'ATENDIMENTOS_TRANSFERIDOS') {
    const nt = Array.isArray(data?.transferencias) ? data.transferencias.length : 0
    if (nt > 0) return { tipo: 'transferencias', n: nt, label: 'transferencias' }
  }
  if (intent === 'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE') {
    const ns = Array.isArray(data?.clientes_sem_resposta) ? data.clientes_sem_resposta.length : 0
    if (ns > 0) return { tipo: 'clientes_sem_resposta', n: ns, label: 'clientes_sem_resposta' }
  }
  if (intent === 'RELATORIO_ATENDENTE_COMPLETO') {
    const h = data?.historico_conversas
    const nhc = Array.isArray(h?.conversas) ? h.conversas.length : 0
    if (nhc > 0) return { tipo: 'historico_conversas', n: nhc, label: 'historico_conversas.conversas' }
  }
  return null
}

/** Evita negar interação quando o payload já traz mensagens ou conversas. */
function sanearNegacaoComEvidenciaMensagens(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const intents = new Set([
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'HISTORICO_ATENDENTE',
    'DETALHES_CONVERSA',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
    'RELATORIO_PRODUTIVIDADE_ATENDENTES',
  ])
  if (!intents.has(intent)) return answer
  const ev = evidenciaConversasOuMensagens(data, intent)
  if (!ev) return answer
  const pat = /(n(ao|ão)\s+(encontr|há)|sem\s+(conversa|mensagens|transfer(ê|e)ncia)|nenhuma\s+(conversa|mensagem|transfer(ê|e)ncia)|não\s+houve\s+(conversa|mensagem)|não\s+existe\s+conversa|não\s+encontramos)/i
  if (!pat.test(answer)) return answer
  const onde =
    ev.tipo === 'mensagens'
      ? 'Dados.mensagens'
      : ev.tipo === 'transferencias'
        ? 'Dados.transferencias'
        : `Dados.${ev.label}`
  const idHint =
    ev.tipo === 'transferencias'
      ? 'atendimento_id / conversa_id'
      : ev.tipo === 'clientes_sem_resposta'
        ? 'conversa_id / cliente_id'
        : 'conversa_id / mensagem_id'
  return `${answer.trim()}\n\n**Correção automática:** O retorno inclui ${ev.n} registro(s) em ${onde}; o texto não pode negar esse fato. Cite ${idHint} ao resumir.`
}

/** Acrescenta nota se o texto usar "hoje"/"ontem" sem recorte permitir. */
function sanearLinguagemTemporalIndevida(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const rt = data?.recorte_temporal
  if (!rt || typeof rt !== 'object') return answer
  const comMensagens = [
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'ANALISE_TOM_ATENDENTE',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
  ].includes(intent)
  const comRecorteConversas = ['HISTORICO_CLIENTE', 'HISTORICO_ATENDENTE', 'DETALHES_CONVERSA'].includes(intent)
  if (!comMensagens && !comRecorteConversas) return answer
  if (rt.pode_usar_hoje_no_texto === true) return answer
  const pat = /\b(hoje|ontem|nesta (manhã|tarde|noite) de hoje|conversa de hoje|mensagens de hoje)\b/i
  if (!pat.test(answer)) return answer
  const de = rt.primeiro_data_exibicao || rt.primeiro_dia_calendario
  const ate = rt.ultimo_data_exibicao || rt.ultimo_dia_calendario
  return `${answer.trim()}\n\n**Correção temporal:** As mensagens analisadas vão de **${de}** a **${ate}** (${rt.fuso}). Não use "hoje"/"ontem" para esse recorte.`
}

function sanearRespostaContagensInconsistentes(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const r = data?.resumo_operacional_ia
  if (!r || typeof r !== 'object') return answer
  const tc = Number(r.total_clientes_unicos)
  const tm = Number(r.total_mensagens)
  const tconv = Number(r.total_conversas)
  const extras = []
  const intentsOk = [
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'HISTORICO_ATENDENTE',
    'DETALHES_CONVERSA',
    'BUSCA_CONTEUDO_MENSAGENS',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'SINAIS_INTERESSE_COMPRA',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
    'RELATORIO_PRODUTIVIDADE_ATENDENTES',
  ]
  if (!intentsOk.includes(intent)) return answer

  if (tc > 1 && /\b(um único|somente um|apenas um|foi um cliente|era um cliente)\b/i.test(answer)) {
    extras.push(`**Verificação:** Os dados indicam ${tc} clientes distintos (resumo_operacional_ia.total_clientes_unicos).`)
  }
  if (tconv > 1 && /\b(uma única conversa|somente uma conversa|foi uma conversa)\b/i.test(answer)) {
    extras.push(`**Verificação:** Os dados indicam ${tconv} conversas (resumo_operacional_ia.total_conversas).`)
  }
  if (tm > 5 && /\b(apenas uma mensagem|somente uma mensagem|uma mensagem\b)\b/i.test(answer) && !String(answer).includes(String(tm))) {
    extras.push(`**Verificação:** O total de mensagens/evidências no período é ${tm}.`)
  }
  if (!extras.length) return answer
  return `${answer.trim()}\n\n${extras.join('\n')}`
}

module.exports = {
  overviewLikePayload,
  sanearRespostaContradicaoMetricas,
  evidenciaConversasOuMensagens,
  sanearNegacaoComEvidenciaMensagens,
  sanearLinguagemTemporalIndevida,
  sanearRespostaContagensInconsistentes,
}
