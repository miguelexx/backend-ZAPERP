'use strict'

// ── Léxico e expansão de termos (sem SQL; só listas fixas controladas) ─────────
const LEXICO_PROMOCAO = [
  'promocao', 'promoção', 'desconto', 'oferta', 'cupom', 'black friday', 'liquidacao', 'liquidação',
  'lancamento', 'lançamento', 'preco especial', 'preço especial', 'cashback',
  'produto', 'produtos', 'catalogo', 'catálogo', 'venda', 'vendas',
]
const LEXICO_FINANCEIRO = [
  'nota fiscal', 'nota fiscal eletronica', 'nf-e', 'nfe', 'danfe', 'nfs-e', 'nfse',
  'boleto', 'segunda via', 'cobranca', 'cobrança', 'pagamento', 'fatura', 'duplicata',
  'vencimento', 'pix', 'transferencia', 'transferência', 'comprovante', 'inadimplencia', 'inadimplência',
]
const LEXICO_COMERCIAL_COMPRA = [
  'orcamento', 'orçamento', 'proposta comercial', 'proposta', 'fechar pedido', 'fechar negocio', 'fechar negócio',
  'comprar', 'compra', 'pedido', 'contrato', 'assinatura', 'parcelamento', 'parcelas', 'entrada e saldo',
  'valor total', 'forma de pagamento', 'condicao comercial', 'condição comercial', 'venda',
]
const LEXICO_OPERACIONAL = [
  'suporte', 'chamado', 'ticket', 'protocolo', 'erro', 'instabilidade', 'sistema fora', 'nao funciona',
  'não funciona', 'acesso', 'login', 'senha', 'permissao', 'permissão', 'bug', 'lentidao', 'lentidão',
]
const STOPWORDS_EXTRAIR = new Set([
  'como', 'qual', 'quais', 'sobre', 'entre', 'para', 'pelo', 'pela', 'esse', 'essa', 'isso', 'fala', 'falaram',
  'funcionario', 'funcionários', 'cliente', 'atendimento', 'conversa', 'mensagem', 'chat', 'interno', 'interna',
  'me', 'de', 'da', 'do', 'das', 'dos', 'um', 'uma', 'no', 'na', 'nos', 'nas', 'foi', 'ser', 'tem', 'ter',
])

const LEXICO_CORDIAL_POSITIVO = [
  'bom dia', 'boa tarde', 'boa noite', 'por favor', 'obrigado', 'obrigada', 'agradeco', 'agradeço',
  'fico a disposicao', 'fico à disposição', 'gentileza', 'poderia', 'por gentileza', 'combinado',
]
const LEXICO_CORDIAL_NEGATIVO = [
  'nao posso ajudar', 'não posso ajudar', 'problema seu', 'se vira', 'tanto faz', 'ja expliquei', 'já expliquei',
  'nao vou', 'não vou', 'nao quero', 'não quero', 'inaceitavel', 'inaceitável',
]

module.exports = {
  LEXICO_PROMOCAO,
  LEXICO_FINANCEIRO,
  LEXICO_COMERCIAL_COMPRA,
  LEXICO_OPERACIONAL,
  STOPWORDS_EXTRAIR,
  LEXICO_CORDIAL_POSITIVO,
  LEXICO_CORDIAL_NEGATIVO,
}
