/**
 * Chatbot de Triagem Profissional — ZapERP
 *
 * Roteador de atendimento automático: envia menu de setores, captura escolha do cliente,
 * vincula conversa ao departamento e transfere para usuários do setor.
 *
 * Configuração em ia_config.config.chatbot_triage (JSON estruturado).
 * Integrado ao webhook Z-API e Meta.
 *
 * RESTRIÇÃO: Atualiza apenas conversas (departamento, atendente), mensagens (respostas
 * do bot) e bot_logs. Nunca atualiza clientes.nome — nomes vêm só de Z-API sync e webhook.
 */

const supabase = require('../config/supabase')

/** Estrutura padrão do chatbot_triage em ia_config.config */
const DEFAULT_CHATBOT_CONFIG = {
  enabled: false,
  welcomeMessage: '',
  invalidOptionMessage: 'Opção inválida. Por favor, responda apenas com o número do setor desejado.',
  confirmSelectionMessage: 'Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.',
  sendOnlyFirstTime: true,
  fallbackToAI: false,
  businessHoursOnly: false,
  transferMode: 'departamento',
  tipo_distribuicao: 'round_robin', // round_robin | menor_carga
  reopenMenuCommand: '0',
  options: [],
}

/**
 * Valida e normaliza a configuração do chatbot.
 * @param {object} raw - Config bruto de ia_config.config.chatbot_triage
 * @returns {object} Config validada
 */
function validateChatbotConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  const opts = Array.isArray(raw.options) ? raw.options : []
  const activeOptions = opts.filter((o) => o && o.active !== false && o.departamento_id != null)
  if (activeOptions.length === 0 && raw.enabled) return null
  const tipoDist = String(raw.tipo_distribuicao || 'round_robin').trim().toLowerCase()
  const tipoDistribuicao = tipoDist === 'menor_carga' ? 'menor_carga' : 'round_robin'

  return {
    enabled: !!raw.enabled,
    welcomeMessage: String(raw.welcomeMessage || '').trim() || null,
    invalidOptionMessage: String(raw.invalidOptionMessage || DEFAULT_CHATBOT_CONFIG.invalidOptionMessage).trim(),
    confirmSelectionMessage: String(raw.confirmSelectionMessage || DEFAULT_CHATBOT_CONFIG.confirmSelectionMessage).trim(),
    sendOnlyFirstTime: raw.sendOnlyFirstTime !== false,
    fallbackToAI: !!raw.fallbackToAI,
    businessHoursOnly: !!raw.businessHoursOnly,
    transferMode: raw.transferMode || 'departamento',
    tipo_distribuicao: tipoDistribuicao,
    reopenMenuCommand: String(raw.reopenMenuCommand || '0').trim().toLowerCase(),
    options: opts.map((o) => ({
      key: String(o.key || '').trim(),
      label: String(o.label || '').trim() || 'Setor',
      departamento_id: o.departamento_id != null ? Number(o.departamento_id) : null,
      active: o.active !== false,
      tag_id: o.tag_id != null ? Number(o.tag_id) : null,
    })),
  }
}

/**
 * Busca configuração do chatbot para a empresa.
 * @param {number} company_id
 * @returns {Promise<object|null>} Config validada ou null
 */
async function getChatbotConfig(company_id) {
  if (!company_id) return null
  try {
    const { data, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()

    if (error) {
      console.warn('[chatbotTriage] getChatbotConfig: erro ao buscar ia_config', error.message)
      return null
    }
    if (!data?.config) {
      console.log('[chatbotTriage] getChatbotConfig: sem registro em ia_config para company_id', company_id)
      return null
    }
    const ct = data.config.chatbot_triage || data.config
    const validated = validateChatbotConfig(ct)
    if (!validated) {
      const opts = Array.isArray(ct?.options) ? ct.options : []
      const activeCount = opts.filter((o) => o && o.active !== false && o.departamento_id != null).length
      console.log('[chatbotTriage] getChatbotConfig: config inválida (enabled=', !!ct?.enabled, 'opcoes_ativas=', activeCount, ')')
    }
    return validated
  } catch (e) {
    console.warn('[chatbotTriage] getChatbotConfig:', e?.message || e)
    return null
  }
}

/**
 * Registra log do bot em bot_logs.
 */
async function logBotAction(company_id, conversa_id, tipo, detalhes = {}) {
  try {
    await supabase.from('bot_logs').insert({
      company_id,
      conversa_id: conversa_id || null,
      tipo,
      detalhes: typeof detalhes === 'object' ? detalhes : { raw: detalhes },
    })
  } catch (e) {
    console.warn('[chatbotTriage] logBotAction:', e?.message || e)
  }
}

/**
 * Verifica se já enviamos o menu para esta conversa (para sendOnlyFirstTime).
 */
async function wasMenuSentForConversa(supabaseClient, company_id, conversa_id) {
  const { data } = await supabaseClient
    .from('bot_logs')
    .select('id')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('tipo', 'menu_enviado')
    .limit(1)
    .maybeSingle()
  return !!data?.id
}

/**
 * Monta o texto do menu a partir das opções ativas.
 */
function buildMenuText(config) {
  const active = (config?.options || []).filter((o) => o && o.active !== false && o.departamento_id != null)
  if (!active.length) return ''
  const lines = active.map((o) => `${o.key} - ${o.label}`)
  return lines.join('\n')
}

/**
 * Monta a mensagem completa de boas-vindas (welcome + menu).
 * Se welcomeMessage já contiver o menu (ex: "1 - Atendimento"), usa como está.
 */
function buildWelcomeMessage(config) {
  const welcome = String(config?.welcomeMessage || '').trim()
  const menu = buildMenuText(config)
  if (!welcome && !menu) return null
  if (welcome && /\d+\s*-\s*\w+/.test(welcome)) return welcome
  if (!menu) return welcome
  return welcome ? `${welcome}\n\n${menu}\n\nResponda com o número da opção desejada.` : `${menu}\n\nResponda com o número da opção desejada.`
}

/**
 * Encontra a opção pelo key (ex: "1", "2").
 */
function findOptionByKey(config, texto) {
  const key = String(texto || '').trim()
  if (!key) return null
  const activeOptions = (config?.options || []).filter((o) => o && o.active !== false && o.departamento_id != null)
  return activeOptions.find((o) => String(o.key) === key)
}

/**
 * Transfere conversa para o departamento: atualiza conversa e atribui a um usuário do setor.
 * Respeita round_robin ou menor_carga se configurado; senão deixa aberta para o departamento.
 */
async function transferToDepartment(supabaseClient, company_id, conversa_id, departamento_id, config = {}) {
  const depId = Number(departamento_id)
  if (!depId) return { ok: false }

  const { data: dep } = await supabaseClient
    .from('departamentos')
    .select('id, nome')
    .eq('id', depId)
    .eq('company_id', company_id)
    .maybeSingle()

  if (!dep) return { ok: false }

  const transferMode = config.transferMode || 'departamento'

  const updatePayload = {
    departamento_id: depId,
    atendente_id: null,
    status_atendimento: 'aberta',
    ultima_atividade: new Date().toISOString(),
  }

  if (transferMode === 'departamento') {
    const { data: usuarios } = await supabaseClient
      .from('usuarios')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
      .eq('ativo', true)
      .order('id')

    const userIds = (usuarios || []).map((u) => u.id).filter(Boolean)
    if (userIds.length > 0) {
      const tipoDistribuicao = config.tipo_distribuicao || 'round_robin'
      let escolhido = null
      if (tipoDistribuicao === 'menor_carga') {
        const { data: cargas } = await supabaseClient
          .from('conversas')
          .select('atendente_id')
          .eq('company_id', company_id)
          .eq('status_atendimento', 'em_atendimento')
          .in('atendente_id', userIds)

        const contagem = {}
        userIds.forEach((id) => { contagem[id] = 0 })
        ;(cargas || []).forEach((c) => {
          if (c?.atendente_id) contagem[c.atendente_id] = (contagem[c.atendente_id] || 0) + 1
        })
        const menor = userIds.reduce((a, b) => (contagem[a] <= contagem[b] ? a : b))
        escolhido = menor
      } else {
        const { data: ultima } = await supabaseClient
          .from('conversas')
          .select('atendente_id')
          .eq('company_id', company_id)
          .eq('departamento_id', depId)
          .not('atendente_id', 'is', null)
          .order('atendente_atribuido_em', { ascending: false })
          .limit(1)
          .maybeSingle()
        const lastId = ultima?.atendente_id
        const idx = lastId ? userIds.indexOf(lastId) + 1 : 0
        escolhido = userIds[idx % userIds.length]
      }
      if (escolhido) {
        updatePayload.atendente_id = escolhido
        updatePayload.status_atendimento = 'em_atendimento'
        updatePayload.atendente_atribuido_em = new Date().toISOString()
      }
    }
  }

  const { error } = await supabaseClient
    .from('conversas')
    .update(updatePayload)
    .eq('id', conversa_id)
    .eq('company_id', company_id)

  if (error) {
    console.warn('[chatbotTriage] transferToDepartment:', error.message)
    return { ok: false }
  }

  await supabaseClient.from('atendimentos').insert({
    conversa_id,
    de_usuario_id: null,
    para_usuario_id: updatePayload.atendente_id || null,
    acao: 'transferiu',
    observacao: `Chatbot: direcionado para ${dep.nome}`,
    company_id,
  })

  return { ok: true, departamento_nome: dep.nome }
}

/**
 * Aplica tag na conversa (opcional).
 */
async function applyTagIfConfigured(supabaseClient, company_id, conversa_id, tag_id) {
  if (!tag_id) return
  try {
    await supabaseClient.from('conversa_tags').insert({
      conversa_id,
      tag_id: Number(tag_id),
      company_id,
    })
  } catch (e) {
    if (String(e?.code || '') !== '23505') console.warn('[chatbotTriage] applyTag:', e?.message || e)
  }
}

/**
 * Processa mensagem recebida do cliente no contexto do chatbot de triagem.
 * Chamado pelo webhook quando: !fromMe, !isGroup, departamento_id == null.
 *
 * @param {object} ctx
 * @param {number} ctx.company_id
 * @param {number} ctx.conversa_id
 * @param {string} ctx.telefone - Para envio
 * @param {string} ctx.texto - Mensagem do cliente
 * @param {object} ctx.supabase - Cliente Supabase
 * @param {Function} ctx.sendMessage - async (phone, message, opts) => { ok, messageId }
 * @param {object} [ctx.opts] - { phoneNumberId } para Meta, { companyId } para Z-API
 * @returns {Promise<{ handled: boolean, departamento_id?: number }>}
 */
async function processIncomingMessage(ctx) {
  const { company_id, conversa_id, telefone, texto, supabase: supabaseClient, sendMessage, opts = {} } = ctx
  if (!company_id || !conversa_id || !telefone || !sendMessage) {
    console.log('[chatbotTriage] skip: falta company_id, conversa_id, telefone ou sendMessage')
    return { handled: false }
  }
  if (String(telefone).startsWith('lid:')) {
    console.log('[chatbotTriage] skip: telefone é LID (não é possível enviar via Z-API)')
    return { handled: false }
  }

  const config = await getChatbotConfig(company_id)
  if (!config) {
    console.log('[chatbotTriage] skip: config não encontrada ou inválida para company_id', company_id)
    return { handled: false }
  }
  if (!config.enabled) {
    console.log('[chatbotTriage] skip: chatbot desativado')
    return { handled: false }
  }
  if (!config.options?.length) {
    console.log('[chatbotTriage] skip: nenhuma opção configurada')
    return { handled: false }
  }

  const sb = supabaseClient || supabase
  const textoNorm = String(texto || '').trim().toLowerCase()
  const welcomeFull = buildWelcomeMessage(config)
  const menuOnly = buildMenuText(config)

  const isReopenCommand = config.reopenMenuCommand && textoNorm === config.reopenMenuCommand.toLowerCase()
  const option = findOptionByKey(config, textoNorm) || findOptionByKey(config, texto)

  if (option) {
    const depId = option.departamento_id
    const result = await transferToDepartment(sb, company_id, conversa_id, depId, config)
    if (!result.ok) return { handled: false }

    await applyTagIfConfigured(sb, company_id, conversa_id, option.tag_id)

    const nomeSetor = result.departamento_nome || option.label || 'setor'
    const confirmMsg = (config.confirmSelectionMessage || '').replace(/\{\{departamento\}\}/gi, nomeSetor)
    const msgToSend = confirmMsg || `Seu atendimento foi direcionado para ${option.label}. Em instantes nossa equipe dará continuidade.`
    await sendMessage(telefone, msgToSend, opts)

    await sb.from('mensagens').insert({
      conversa_id,
      texto: msgToSend,
      direcao: 'out',
      company_id,
      status: 'enviada',
    })

    await logBotAction(company_id, conversa_id, 'opcao_valida', {
      opcao_key: option.key,
      departamento_id: depId,
      departamento_nome: option.label,
    })

    return { handled: true, departamento_id: depId }
  }

  if (isReopenCommand) {
    const msg = welcomeFull || menuOnly
    if (msg) {
      await sendMessage(telefone, msg, opts)
      await sb.from('mensagens').insert({
        conversa_id,
        texto: msg,
        direcao: 'out',
        company_id,
        status: 'enviada',
      })
      await logBotAction(company_id, conversa_id, 'menu_reenviado', { comando: textoNorm })
    }
    return { handled: true }
  }

  const menuAlreadySent = await wasMenuSentForConversa(sb, company_id, conversa_id)
  const shouldSendWelcome = !menuAlreadySent || !config.sendOnlyFirstTime

  if (shouldSendWelcome) {
    const msg = welcomeFull || menuOnly
    if (msg) {
      console.log('[chatbotTriage] enviando menu de boas-vindas', { conversa_id, company_id })
      await sendMessage(telefone, msg, opts)
      await sb.from('mensagens').insert({
        conversa_id,
        texto: msg,
        direcao: 'out',
        company_id,
        status: 'enviada',
      })
      await logBotAction(company_id, conversa_id, 'menu_enviado', { opcoes: config.options.map((o) => o.key) })
    } else {
      console.warn('[chatbotTriage] menu vazio — welcomeMessage e menu (opções) estão vazios. Verifique a configuração.')
    }
    return { handled: true }
  }

  const invalidMsg = config.invalidOptionMessage || 'Opção inválida. Por favor, responda apenas com o número do setor desejado.'
  const fullInvalid = `${invalidMsg}\n\n${menuOnly}\n\nResponda com o número da opção desejada.`
  await sendMessage(telefone, fullInvalid, opts)
  await sb.from('mensagens').insert({
    conversa_id,
    texto: fullInvalid,
    direcao: 'out',
    company_id,
    status: 'enviada',
  })
  await logBotAction(company_id, conversa_id, 'opcao_invalida', { texto_recebido: texto?.slice(0, 100) })

  return { handled: true }
}

module.exports = {
  DEFAULT_CHATBOT_CONFIG,
  validateChatbotConfig,
  getChatbotConfig,
  processIncomingMessage,
  logBotAction,
  buildWelcomeMessage,
  buildMenuText,
  findOptionByKey,
  transferToDepartment,
}
