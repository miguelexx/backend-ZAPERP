/**
 * Configuração/mensagem Pix da empresa (validação de payload e montagem da mensagem).
 * Extraído de controllers/chatController.js (Fase 6 da modularização) sem alteração de comportamento.
 */

function sanitizePixConfigPayload(body = {}) {
  const allowedTipos = new Set(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'])
  const tipo_chave = String(body?.tipo_chave || '').trim().toLowerCase()
  const chave_pix = String(body?.chave_pix || '').trim()
  const nome_recebedor = String(body?.nome_recebedor || '').trim()
  const mensagem_padrao = String(body?.mensagem_padrao || '').trim()

  if (!allowedTipos.has(tipo_chave)) {
    return { ok: false, status: 400, error: 'tipo_chave inválido. Use: cpf, cnpj, email, telefone ou aleatoria.' }
  }
  if (!chave_pix) {
    return { ok: false, status: 400, error: 'chave_pix é obrigatória.' }
  }
  if (!nome_recebedor) {
    return { ok: false, status: 400, error: 'nome_recebedor é obrigatório.' }
  }

  return {
    ok: true,
    data: {
      tipo_chave,
      chave_pix: chave_pix.slice(0, 200),
      nome_recebedor: nome_recebedor.slice(0, 120),
      mensagem_padrao: mensagem_padrao ? mensagem_padrao.slice(0, 500) : null,
    }
  }
}

function formatPixTipoLabel(tipo) {
  const t = String(tipo || '').trim().toLowerCase()
  if (t === 'cpf') return 'CPF'
  if (t === 'cnpj') return 'CNPJ'
  if (t === 'email') return 'E-mail'
  if (t === 'telefone') return 'Telefone'
  if (t === 'aleatoria') return 'Chave aleatória'
  return t || 'Chave Pix'
}

function buildPixMessageFromConfig(cfg) {
  const tipoLabel = formatPixTipoLabel(cfg?.tipo_chave)
  const extra = cfg?.mensagem_padrao ? `\n\n${String(cfg.mensagem_padrao).trim()}` : ''
  return [
    'Segue a chave Pix para pagamento:',
    '',
    `Nome: ${String(cfg?.nome_recebedor || '').trim()}`,
    `Tipo da chave: ${tipoLabel}`,
    `Chave Pix: ${String(cfg?.chave_pix || '').trim()}`,
    extra,
    '',
    'Após o pagamento, por favor envie o comprovante por aqui.'
  ].join('\n').trim()
}

// Título do botão de copiar — o WhatsApp limita o texto do botão (~20 chars).
const PIX_COPY_BUTTON_LABEL = 'Copiar chave Pix'

/**
 * Metadados do cartão Pix persistidos em mensagens.reply_meta.pix — usados pela bolha do CRM
 * para renderizar o mesmo cartão que o cliente recebe (com botão "Copiar chave Pix").
 */
function buildPixReplyMeta(cfg) {
  return {
    pix: {
      nome_recebedor: String(cfg?.nome_recebedor || '').trim(),
      tipo_chave: String(cfg?.tipo_chave || '').trim().toLowerCase(),
      tipo_label: formatPixTipoLabel(cfg?.tipo_chave),
      chave_pix: String(cfg?.chave_pix || '').trim(),
      mensagem_padrao: cfg?.mensagem_padrao ? String(cfg.mensagem_padrao).trim() : null,
      copy_label: PIX_COPY_BUTTON_LABEL,
    },
  }
}

/**
 * Payload da mensagem interativa Whapi (botão de copiar) → provider.sendInteractive.
 * O corpo já contém a chave por extenso: mesmo que o botão de copiar não funcione no
 * aparelho do cliente, a chave continua visível/copiável no texto (robusto).
 * Contrato Whapi: action.buttons[{ type:'copy', title, id, copy_code }]. Ver doc 25 §26.
 */
function buildPixInteractivePayload(cfg) {
  const chave = String(cfg?.chave_pix || '').trim()
  return {
    type: 'button',
    header: 'Pagamento via Pix',
    body: buildPixMessageFromConfig(cfg),
    action: {
      buttons: [
        {
          type: 'copy',
          id: 'pix_copy',
          title: PIX_COPY_BUTTON_LABEL,
          copy_code: chave,
        },
      ],
    },
  }
}

module.exports = {
  sanitizePixConfigPayload,
  formatPixTipoLabel,
  buildPixMessageFromConfig,
  buildPixReplyMeta,
  buildPixInteractivePayload,
  PIX_COPY_BUTTON_LABEL,
}
