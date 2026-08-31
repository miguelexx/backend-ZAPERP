'use strict'

const {
  LEXICO_PROMOCAO,
  LEXICO_FINANCEIRO,
  LEXICO_COMERCIAL_COMPRA,
  LEXICO_OPERACIONAL,
} = require('./lexicos')
const {
  normalizeSearchTerm,
  extrairTermosCandidatosDaPergunta,
  extrairTermosBuscaLivre,
} = require('./searchText')

/** Completa termos_busca com léxico fixo quando o modelo deixou vazio. */
function enrichTermosBuscaFromIntent(cls, question) {
  let termos = cls.termos_busca && cls.termos_busca.length ? [...cls.termos_busca] : []
  const merge = (lex) => {
    termos = [...new Set([...termos, ...lex])]
  }
  if (cls.intent === 'ATENDENTE_MAIS_MENSAGENS_COM_TEMA' && !termos.length) merge(LEXICO_PROMOCAO)
  if (cls.intent === 'CLIENTES_POR_TEMA_FINANCEIRO' && !termos.length) merge(LEXICO_FINANCEIRO)
  if (cls.intent === 'SINAIS_INTERESSE_COMPRA' && !termos.length) merge(LEXICO_COMERCIAL_COMPRA)
  if (cls.intent === 'CONVERSAS_POR_ASSUNTO_OPERACIONAL' && !termos.length) merge(LEXICO_OPERACIONAL)
  if (cls.intent === 'CHAT_INTERNO_POR_TEMA' && !termos.length) {
    const extra = extrairTermosCandidatosDaPergunta(question)
    termos = extra
  }
  return { ...cls, termos_busca: termos.length ? termos : cls.termos_busca }
}

function isBuscaConversasQuestion(question) {
  const q = normalizeSearchTerm(String(question || ''))
  if (!q) return false
  const fala = /\b(fala|falando|falam|falaram|menciona|mencionam|cita|citam|citou|comentam|comentaram|trata|tratam|sobre|assunto|tema)\b/.test(q)
  const alvo = /\b(conversa|conversas|mensagem|mensagens|cliente|clientes|atendimento|atendimentos)\b/.test(q)
  const busca = /\b(qual|quais|buscar|procure|procurar|localizar|ache|encontre|encontrar|liste|listar|mostre|mostrar)\b/.test(q)
  return fala && (alvo || busca)
}

function isRelatorioProdutividadeQuestion(question) {
  const q = normalizeSearchTerm(String(question || ''))
  if (!q) return false
  const exportar = /\b(planilha|csv|excel|xlsx|export|exportar|baixar|download|relatorio|relatorios)\b/.test(q)
  const produtividade = /\b(produtividade|desempenho|performance|atendentes|equipe|funcionarios|usuarios|ranking)\b/.test(q)
  return exportar && produtividade
}

function aplicarHeuristicasDeterministicas(cls, question) {
  const base = cls && typeof cls === 'object' ? cls : { intent: 'UNKNOWN' }
  if (isRelatorioProdutividadeQuestion(question)) {
    return { ...base, intent: 'RELATORIO_PRODUTIVIDADE_ATENDENTES' }
  }
  if (isBuscaConversasQuestion(question)) {
    const termos = base.termos_busca?.length ? base.termos_busca : extrairTermosBuscaLivre(question)
    if (termos?.length) {
      return { ...base, intent: 'BUSCA_CONTEUDO_MENSAGENS', termos_busca: termos }
    }
  }
  return base
}

module.exports = {
  enrichTermosBuscaFromIntent,
  isBuscaConversasQuestion,
  isRelatorioProdutividadeQuestion,
  aplicarHeuristicasDeterministicas,
}
