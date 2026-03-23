/**
 * Chatbot de Triagem Profissional — ZapERP
 *
 * Roteador de atendimento automático: envia menu de setores, captura escolha do cliente,
 * vincula conversa ao departamento e transfere para usuários do setor.
 *
 * Configuração em ia_config.config.chatbot_triage (JSON estruturado).
 * Integrado ao webhook UltraMSG (via webhookZapiController).
 *
 * RESTRIÇÃO: Atualiza apenas conversas (departamento, atendente), mensagens (respostas
 * do bot) e bot_logs. Nunca atualiza clientes.nome — nomes vêm só de sync e webhook.
 */

const supabase = require('../config/supabase')

/** Último envio por company_id — throttling para respeitar intervalo configurável. */
const lastChatbotSendPerCompany = new Map()

/**
 * Aguarda o intervalo configurado desde o último envio do chatbot (por empresa).
 * @param {number} company_id
 * @param {number} intervaloSegundos - Configurado pelo usuário (0 = sem delay)
 */
async function throttleChatbotSend(company_id, intervaloSegundos) {
  const delayMs = Math.max(0, Number(intervaloSegundos) || 0) * 1000
  if (delayMs <= 0) return
  const key = company_id ?? 'default'
  const last = lastChatbotSendPerCompany.get(key) || 0
  const elapsed = Date.now() - last
  if (elapsed < delayMs) {
    await new Promise((r) => setTimeout(r, delayMs - elapsed))
  }
}

/**
 * Verifica se o horário atual está dentro do horário comercial configurado.
 * Suporta janelas que atravessam meia-noite (ex: 22:00 a 06:00).
 * @param {string} horarioInicio - "HH:mm" (ex: "09:00")
 * @param {string} horarioFim - "HH:mm" (ex: "18:00")
 * @param {Date} [now] - Data/hora a verificar (default: agora, fuso do servidor)
 * @returns {boolean}
 */
function isWithinBusinessHours(horarioInicio, horarioFim, now = new Date()) {
  if (!horarioInicio || !horarioFim) return true
  const [hIni, mIni] = String(horarioInicio).split(':').map(Number)
  const [hFim, mFim] = String(horarioFim).split(':').map(Number)
  const minutosAgora = now.getHours() * 60 + now.getMinutes()
  const minutosIni = (hIni || 0) * 60 + (mIni || 0)
  const minutosFim = (hFim || 0) * 60 + (mFim || 0)
  if (minutosIni <= minutosFim) return minutosAgora >= minutosIni && minutosAgora <= minutosFim
  return minutosAgora >= minutosIni || minutosAgora <= minutosFim
}

/**
 * Verifica se a data/hora atual está fora do atendimento (dia da semana desativado ou data específica fechada).
 * @param {number[]} diasSemanaDesativados - Dias que não trabalha: 0=dom, 1=seg, ..., 6=sáb
 * @param {string[]} datasEspecificasFechadas - Datas YYYY-MM-DD (feriados, recesso)
 * @param {Date} [now] - Data/hora a verificar
 * @returns {boolean} true se está fora (dia desativado ou data fechada)
 */
function isOutsideBusinessDays(diasSemanaDesativados, datasEspecificasFechadas, now = new Date()) {
  const diaSemana = now.getDay() // 0=domingo, 6=sábado
  const diasOff = Array.isArray(diasSemanaDesativados) ? diasSemanaDesativados : [0, 6]
  if (diasOff.includes(diaSemana)) return true
  const hoje = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const datasFechadas = Array.isArray(datasEspecificasFechadas) ? datasEspecificasFechadas : []
  return datasFechadas.some((d) => String(d).trim() === hoje)
}

/**
 * Envia mensagem pelo chatbot com throttle (intervalo configurável por empresa).
 */
async function sendWithThrottle(sendMessage, telefone, msg, opts, company_id, intervaloSegundos) {
  await throttleChatbotSend(company_id, intervaloSegundos)
  try {
    return await sendMessage(telefone, msg, opts)
  } finally {
    lastChatbotSendPerCompany.set(company_id ?? 'default', Date.now())
  }
}

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
  tipo_distribuicao: 'fila', // fila = primeiro a assumir | round_robin | menor_carga
  reopenMenuCommand: '0',
  options: [],
  // Mensagem de finalização (enviada ao clicar "Finalizar conversa")
  enviarMensagemFinalizacao: false,
  mensagemFinalizacao: 'Atendimento finalizado com sucesso. (Segue seu protocolo: {{protocolo}}.\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.)',
  // Intervalo entre envios do chatbot (segundos) — evita bloqueio WhatsApp/UltraMSG. 0 = sem delay.
  intervaloEnvioSegundos: 3,
  // Mensagem fora do horário comercial — cliente envia msg fora do horário → recebe esta mensagem em vez do menu
  foraHorarioEnabled: false,
  horarioInicio: '09:00',
  horarioFim: '18:00',
  mensagemForaHorario: 'Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!',
  // Dias da semana em que NÃO trabalha (0=domingo, 1=segunda, ..., 6=sábado). Ex: [0,6] = fim de semana
  diasSemanaDesativados: [0, 6],
  // Datas específicas fechadas (YYYY-MM-DD) — feriados, recesso etc.
  datasEspecificasFechadas: [],
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
  const tipoDist = String(raw.tipo_distribuicao || 'fila').trim().toLowerCase()
  const tipoDistribuicao = tipoDist === 'menor_carga' ? 'menor_carga' : (tipoDist === 'round_robin' ? 'round_robin' : 'fila')

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
    enviarMensagemFinalizacao: !!raw.enviarMensagemFinalizacao,
    mensagemFinalizacao: String(raw.mensagemFinalizacao || DEFAULT_CHATBOT_CONFIG.mensagemFinalizacao || '').trim() || DEFAULT_CHATBOT_CONFIG.mensagemFinalizacao,
    foraHorarioEnabled: !!raw.foraHorarioEnabled,
    horarioInicio: (() => {
      const v = String(raw.horarioInicio || DEFAULT_CHATBOT_CONFIG.horarioInicio || '09:00').trim()
      return /^\d{1,2}:\d{2}$/.test(v) ? v : '09:00'
    })(),
    horarioFim: (() => {
      const v = String(raw.horarioFim || DEFAULT_CHATBOT_CONFIG.horarioFim || '18:00').trim()
      return /^\d{1,2}:\d{2}$/.test(v) ? v : '18:00'
    })(),
    mensagemForaHorario: String(raw.mensagemForaHorario || DEFAULT_CHATBOT_CONFIG.mensagemForaHorario || '').trim() || DEFAULT_CHATBOT_CONFIG.mensagemForaHorario,
    diasSemanaDesativados: (() => {
      const arr = raw.diasSemanaDesativados
      if (!Array.isArray(arr)) return DEFAULT_CHATBOT_CONFIG.diasSemanaDesativados || [0, 6]
      return arr.filter((d) => Number.isInteger(Number(d)) && d >= 0 && d <= 6).map(Number)
    })(),
    datasEspecificasFechadas: (() => {
      const arr = raw.datasEspecificasFechadas
      if (!Array.isArray(arr)) return []
      return arr.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d).trim())).map((d) => String(d).trim())
    })(),
    intervaloEnvioSegundos: (() => {
      const v = raw.intervaloEnvioSegundos ?? DEFAULT_CHATBOT_CONFIG.intervaloEnvioSegundos ?? 3
      const n = Number(v)
      return Number.isFinite(n) ? Math.max(0, Math.min(60, Math.round(n))) : 3
    })(),
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
    return validateChatbotConfig(ct)
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
 * Reseta o estado do chatbot para uma conversa (ex: após reabertura).
 * Remove logs de menu_enviado, opcao_valida etc. para que o fluxo reinicie do zero.
 * Chamado pelo webhook quando conversa fechada é reaberta por nova mensagem do cliente.
 */
async function resetChatbotStateForConversa(supabaseClient, company_id, conversa_id) {
  if (!conversa_id || !company_id) return
  try {
    const { error } = await (supabaseClient || supabase)
      .from('bot_logs')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
    if (error) {
      console.warn('[chatbotTriage] resetChatbotStateForConversa:', error.message)
      return
    }
    console.log('[chatbotTriage] 🔄 Estado do chatbot resetado para conversa reaberta', { conversa_id, company_id })
  } catch (e) {
    console.warn('[chatbotTriage] resetChatbotStateForConversa:', e?.message || e)
  }
}

/**
 * Verifica se já enviamos o menu para esta conversa (para sendOnlyFirstTime).
 */
async function wasMenuSentForConversa(supabaseClient, company_id, conversa_id) {
  try {
    const { data } = await supabaseClient
      .from('bot_logs')
      .select('id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('tipo', 'menu_enviado')
      .limit(1)
      .maybeSingle()
    return !!data?.id
  } catch (e) {
    console.warn('[chatbotTriage] wasMenuSentForConversa: erro ao verificar bot_logs', e?.message)
    return false
  }
}

/**
 * Verifica se o cliente já selecionou uma opção válida nesta conversa.
 * Evita processar a mesma seleção duas vezes em caso de reentrada.
 */
async function wasOptionSelectedForConversa(supabaseClient, company_id, conversa_id) {
  try {
    const { data } = await supabaseClient
      .from('bot_logs')
      .select('id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('tipo', 'opcao_valida')
      .limit(1)
      .maybeSingle()
    return !!data?.id
  } catch (e) {
    console.warn('[chatbotTriage] wasOptionSelectedForConversa: erro ao verificar bot_logs', e?.message)
    return false
  }
}

/**
 * Verifica se o texto parece mensagem do bot (menu, opção inválida, confirmação, fora do horário).
 * Usado para detectar se a última mensagem 'out' foi do bot ou do operador humano.
 */
function looksLikeBotMessage(texto, config) {
  const t = String(texto || '').trim()
  if (!t) return false
  const lower = t.toLowerCase()
  // Padrões típicos do bot
  if (lower.includes('opção inválida') || lower.includes('opcao invalida')) return true
  if (config?.invalidOptionMessage && t.includes(config.invalidOptionMessage.slice(0, 40))) return true
  if (lower.includes('responda com o número') || lower.includes('responda apenas com o número')) return true
  if (lower.includes('perfeito!') || lower.includes('seu atendimento foi direcionado')) return true
  if (/\d+\s*-\s*[\w\s]+/.test(t) && (lower.includes('vendas') || lower.includes('atendimento') || lower.includes('financeiro') || lower.includes('compras') || lower.includes('diretoria') || lower.includes('rh'))) return true
  if (config?.mensagemForaHorario && t.includes(String(config.mensagemForaHorario || '').slice(0, 30))) return true
  return false
}

/**
 * Verifica se o operador humano enviou mensagem recentemente (pelo celular ou painel).
 * Se a última mensagem 'out' não parece ser do bot, considera que humano está conversando.
 */
async function hasHumanIntervenedRecently(supabaseClient, company_id, conversa_id, config) {
  try {
    const { data: ultimas } = await supabaseClient
      .from('mensagens')
      .select('id, direcao, texto, criado_em')
      .eq('conversa_id', conversa_id)
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .limit(10)

    if (!ultimas || ultimas.length === 0) return false
    const ultimaOut = ultimas.find((m) => m.direcao === 'out')
    if (!ultimaOut) return false
    if (looksLikeBotMessage(ultimaOut.texto, config)) return false
    return true
  } catch (e) {
    console.warn('[chatbotTriage] hasHumanIntervenedRecently:', e?.message || e)
    return false
  }
}

/** Quantidade máxima de vezes que a mensagem "opção inválida" pode ser enviada por conversa. */
const MAX_OPCAO_INVALIDA_ENVIOS = 2

/**
 * Conta quantas vezes já enviamos a mensagem de opção inválida para esta conversa.
 */
async function countOpcaoInvalidaSent(supabaseClient, company_id, conversa_id) {
  try {
    const { count, error } = await supabaseClient
      .from('bot_logs')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('tipo', 'opcao_invalida')

    if (error) {
      console.warn('[chatbotTriage] countOpcaoInvalidaSent:', error.message)
      return 0
    }
    return Number(count) || 0
  } catch (e) {
    console.warn('[chatbotTriage] countOpcaoInvalidaSent:', e?.message || e)
    return 0
  }
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
 * Monta a mensagem de finalização substituindo placeholders.
 * @param {string} template - Template com {{protocolo}}, {{nome_atendente}}
 * @param {object} vars - { protocolo, nome_atendente }
 */
function buildMensagemFinalizacao(template, vars = {}) {
  if (!template || typeof template !== 'string') return null
  return template
    .replace(/\{\{protocolo\}\}/gi, String(vars.protocolo ?? ''))
    .replace(/\{\{nome_atendente\}\}/gi, String(vars.nome_atendente ?? ''))
    .trim()
}

/**
 * Monta a mensagem completa de boas-vindas (welcome + menu).
 * Se welcomeMessage já contiver o menu completo, usa APENAS o que foi configurado.
 * Detecta: "1 - Label", "1️⃣ Label", ou múltiplas linhas numeradas.
 */
function buildWelcomeMessage(config) {
  const welcome = String(config?.welcomeMessage || '').trim()
  const menu = buildMenuText(config)
  if (!welcome && !menu) return null
  if (!menu) return welcome
  // Se welcomeMessage foi configurado e já contém menu (ex: "1 - X", "1️⃣ X", múltiplas opções), usar APENAS a mensagem configurada
  if (welcome) {
    const jaTemMenuComHifen = /\d+\s*[-–—]\s*[\w\sáàâãéèêíìîóòôõúùûç]+/i.test(welcome) // "1 - Vendas e Atendimento"
    const jaTemMenuEmoji = /[1-9]\uFE0F?\u20E3?\s*[\w\sáàâãéèêíìîóòôõúùûç]+/i.test(welcome) // "1️⃣ Vendas e Atendimento"
    const linhasNumeradas = welcome.split('\n').filter((l) => /^\s*\d/.test(l.trim()))
    const jaTemMultiplasOpcoes = linhasNumeradas.length >= 2
    if (jaTemMenuComHifen || jaTemMenuEmoji || jaTemMultiplasOpcoes) {
      return welcome
    }
  }
  // Welcome sem menu → concatenar menu gerado das opções
  return welcome ? `${welcome}\n\n${menu}\n\nResponda com o número da opção desejada.` : `${menu}\n\nResponda com o número da opção desejada.`
}

/**
 * Encontra a opção pelo key (ex: "1", "2") ou por label (ex: "Atendimento", "Vendas").
 * Suporta:
 *   - Match exato por key (ex: "1" == "1")
 *   - Match case-insensitive por key (ex: "A" == "a")
 *   - Match por label case-insensitive (ex: "comercial" == "Comercial")
 *   - Match por key numérico (ex: 1 == "1")
 */
function findOptionByKey(config, texto) {
  const key = String(texto || '').trim()
  if (!key) return null
  const activeOptions = (config?.options || []).filter(
    (o) => o && o.active !== false && o.departamento_id != null && String(o.key || '').trim()
  )
  if (!activeOptions.length) return null

  // 1. Match exato (case-sensitive)
  const exactMatch = activeOptions.find((o) => String(o.key).trim() === key)
  if (exactMatch) return exactMatch

  // 2. Match case-insensitive por key
  const keyLower = key.toLowerCase()
  const caseInsensitiveMatch = activeOptions.find(
    (o) => String(o.key).trim().toLowerCase() === keyLower
  )
  if (caseInsensitiveMatch) return caseInsensitiveMatch

  // 3. Match por label case-insensitive (ex: cliente digitou "Comercial")
  return activeOptions.find((o) => String(o.label || '').trim().toLowerCase() === keyLower) || null
}

/**
 * Transfere conversa para o departamento: atualiza conversa e opcionalmente atribui a um usuário.
 * tipo_distribuicao:
 *   - 'fila': deixa aberta na fila — todos do setor veem, primeiro a clicar "Assumir" ganha
 *   - 'round_robin' | 'menor_carga': atribui automaticamente a um usuário do setor
 */
async function transferToDepartment(supabaseClient, company_id, conversa_id, departamento_id, config = {}) {
  const depId = Number(departamento_id)
  if (!depId) return { ok: false }

  let dep = null
  try {
    const { data, error } = await supabaseClient
      .from('departamentos')
      .select('id, nome')
      .eq('id', depId)
      .eq('company_id', company_id)
      .maybeSingle()

    if (error) {
      console.warn('[chatbotTriage] transferToDepartment: erro ao buscar departamento', { depId, company_id, error: error.message })
    } else {
      dep = data
    }
  } catch (e) {
    console.warn('[chatbotTriage] transferToDepartment: exceção ao buscar departamento', { depId, company_id, erro: e?.message })
  }

  if (!dep) {
    console.warn('[chatbotTriage] transferToDepartment: departamento não encontrado para company_id', { depId, company_id })
    return { ok: false }
  }

  const transferMode = config.transferMode || 'departamento'
  const tipoDistribuicao = config.tipo_distribuicao || 'fila'

  const updatePayload = {
    departamento_id: depId,
    atendente_id: null,
    status_atendimento: 'aberta',
    ultima_atividade: new Date().toISOString(),
  }

  // 'fila': não atribui — conversa fica aberta para todos do setor; primeiro a assumir ganha
  if (transferMode === 'departamento' && tipoDistribuicao !== 'fila') {
    let userIds = []
    const { data: udRows } = await supabaseClient
      .from('usuario_departamentos')
      .select('usuario_id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (Array.isArray(udRows) && udRows.length > 0) {
      const ids = [...new Set(udRows.map((r) => r.usuario_id))].filter(Boolean)
      const { data: usuarios } = await supabaseClient
        .from('usuarios')
        .select('id')
        .eq('company_id', company_id)
        .in('id', ids)
        .eq('ativo', true)
      userIds = (usuarios || []).map((u) => u.id).filter(Boolean)
    }
    if (userIds.length === 0) {
      const { data: usuariosLegado } = await supabaseClient
        .from('usuarios')
        .select('id')
        .eq('company_id', company_id)
        .eq('departamento_id', depId)
        .eq('ativo', true)
      userIds = (usuariosLegado || []).map((u) => u.id).filter(Boolean)
    }
    if (userIds.length > 0) {
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
 * @param {boolean} [ctx.conversaReabertaAposFinalizacao] - true quando cliente mandou msg em conversa fechada e reabrimos — enviar boas-vindas novamente
 * @returns {Promise<{ handled: boolean, departamento_id?: number }>}
 */
async function processIncomingMessage(ctx) {
  const { company_id, conversa_id, telefone, texto, supabase: supabaseClient, sendMessage, opts = {}, conversaReabertaAposFinalizacao = false } = ctx
  
  console.log('[chatbotTriage] 🤖 INÍCIO DO PROCESSAMENTO', {
    company_id,
    conversa_id,
    telefone: String(telefone || '').slice(-8),
    texto: String(texto || '').slice(0, 50),
    conversaReabertaAposFinalizacao,
    timestamp: new Date().toISOString()
  })
  
  if (!company_id || !conversa_id || !telefone || !sendMessage) {
    console.log('[chatbotTriage] ❌ skip: falta company_id, conversa_id, telefone ou sendMessage')
    return { handled: false }
  }
  if (String(telefone).startsWith('lid:')) {
    console.log('[chatbotTriage] ❌ skip: telefone é LID (não é possível enviar via Z-API)')
    return { handled: false }
  }

  // Human takeover: não processar se atendente já está conversando com o cliente
  try {
    const { data: conv } = await (supabaseClient || supabase)
      .from('conversas')
      .select('atendente_id, departamento_id')
      .eq('id', conversa_id)
      .eq('company_id', company_id)
      .maybeSingle()
    if (conv?.atendente_id != null) {
      console.log('[chatbotTriage] ❌ skip: atendente assumiu a conversa — chatbot desativado', { conversa_id, atendente_id: conv.atendente_id })
      return { handled: false }
    }
  } catch (e) {
    console.warn('[chatbotTriage] Erro ao verificar atendente_id:', e?.message || e)
    return { handled: false }
  }

  const config = await getChatbotConfig(company_id)
  if (!config) {
    console.log('[chatbotTriage] ❌ skip: config não encontrada ou inválida para company_id', company_id)
    return { handled: false }
  }
  if (!config.enabled) {
    console.log('[chatbotTriage] ❌ skip: chatbot desativado para company_id', company_id)
    return { handled: false }
  }
  if (!config.options?.length) {
    console.log('[chatbotTriage] ❌ skip: nenhuma opção configurada para company_id', company_id)
    return { handled: false }
  }
  
  console.log('[chatbotTriage] ✅ configuração válida encontrada', {
    company_id,
    enabled: config.enabled,
    totalOpcoes: config.options.length,
    sendOnlyFirstTime: config.sendOnlyFirstTime,
    foraHorarioEnabled: config.foraHorarioEnabled
  })

  // Mensagem fora do horário: se ativado e fora do horário ou dia desativado, envia mensagem e não processa o menu
  if (config.foraHorarioEnabled && config.mensagemForaHorario) {
    const foraDia = isOutsideBusinessDays(config.diasSemanaDesativados, config.datasEspecificasFechadas)
    const dentroHorario = isWithinBusinessHours(config.horarioInicio, config.horarioFim)
    if (foraDia || !dentroHorario) {
      console.log('[chatbotTriage] fora do horário comercial — enviando mensagem', {
        conversa_id, company_id, horario: `${config.horarioInicio}-${config.horarioFim}`, foraDia
      })
      const sb = supabaseClient || supabase
      try {
        await sendWithThrottle(sendMessage, telefone, config.mensagemForaHorario, opts, company_id, config.intervaloEnvioSegundos)
        await sb.from('mensagens').insert({
          conversa_id,
          texto: config.mensagemForaHorario,
          direcao: 'out',
          company_id,
          status: 'sent',
        })
        await logBotAction(company_id, conversa_id, 'fora_horario', {
          horario_inicio: config.horarioInicio,
          horario_fim: config.horarioFim,
          dias_semana_desativados: config.diasSemanaDesativados,
          data_fechada: foraDia,
        })
      } catch (e) {
        console.error('[chatbotTriage] ❌ Erro ao enviar mensagem fora do horário:', e?.message || e)
      }
      return { handled: true }
    }
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

    let depNome = option.label || 'setor'

    if (!result.ok) {
      // Fallback: transferToDepartment falhou (departamento não encontrado ou erro de DB).
      // Tenta atualização direta para não deixar o cliente sem resposta.
      console.warn('[chatbotTriage] ⚠️ transferToDepartment falhou — tentando atualização direta da conversa', {
        depId, conversa_id, company_id
      })
      try {
        const { error: directErr } = await sb
          .from('conversas')
          .update({
            departamento_id: depId,
            atendente_id: null,
            status_atendimento: 'aberta',
            ultima_atividade: new Date().toISOString(),
          })
          .eq('id', conversa_id)
          .eq('company_id', company_id)

        if (directErr) {
          console.error('[chatbotTriage] ❌ Falha crítica ao atribuir departamento (fallback direto):', directErr.message)
        } else {
          console.log('[chatbotTriage] ✅ Departamento atribuído via fallback direto', { depId, conversa_id })
        }
      } catch (e) {
        console.error('[chatbotTriage] ❌ Exceção no fallback direto de departamento:', e?.message || e)
      }
    } else {
      depNome = result.departamento_nome || option.label || 'setor'
    }

    await applyTagIfConfigured(sb, company_id, conversa_id, option.tag_id)

    const confirmMsg = (config.confirmSelectionMessage || '').replace(/\{\{departamento\}\}/gi, depNome)
    const msgToSend = confirmMsg || `Seu atendimento foi direcionado para ${depNome}. Em instantes nossa equipe dará continuidade.`

    console.log('[chatbotTriage] ✅ Enviando confirmação de seleção', {
      conversa_id, company_id, opcao: option.key, depNome, transfer_ok: result.ok
    })

    try {
      await sendWithThrottle(sendMessage, telefone, msgToSend, opts, company_id, config.intervaloEnvioSegundos)
      await sb.from('mensagens').insert({
        conversa_id,
        texto: msgToSend,
        direcao: 'out',
        company_id,
        status: 'sent',
      })
    } catch (sendErr) {
      console.error('[chatbotTriage] ❌ Erro ao enviar mensagem de confirmação:', sendErr?.message || sendErr)
    }

    await logBotAction(company_id, conversa_id, 'opcao_valida', {
      opcao_key: option.key,
      departamento_id: depId,
      departamento_nome: depNome,
      transfer_ok: result.ok,
    })

    return { handled: true, departamento_id: depId }
  }

  if (isReopenCommand) {
    const msg = welcomeFull || menuOnly
    if (msg) {
      try {
        await sendWithThrottle(sendMessage, telefone, msg, opts, company_id, config.intervaloEnvioSegundos)
        await sb.from('mensagens').insert({
          conversa_id,
          texto: msg,
          direcao: 'out',
          company_id,
          status: 'sent',
        })
        await logBotAction(company_id, conversa_id, 'menu_reenviado', { comando: textoNorm })
      } catch (e) {
        console.error('[chatbotTriage] ❌ Erro ao reenviar menu:', e?.message || e)
      }
    }
    return { handled: true }
  }

  const menuAlreadySent = await wasMenuSentForConversa(sb, company_id, conversa_id)

  // Verificar se esta é a primeira mensagem do cliente na conversa.
  // Usa bot_logs como fonte primária: se o menu foi enviado, não é mais a "primeira" mensagem.
  // Fallback: verificar mensagens (limit 10 para maior precisão).
  let isPrimeiraMensagemCliente = false
  if (!menuAlreadySent) {
    try {
      const { data: mensagensAnteriores } = await sb
        .from('mensagens')
        .select('id, direcao')
        .eq('conversa_id', conversa_id)
        .eq('company_id', company_id)
        .order('criado_em', { ascending: true })
        .limit(10)

      // É primeira mensagem se: sem histórico OU todas as mensagens são do cliente (nenhuma resposta do bot ainda)
      isPrimeiraMensagemCliente =
        !mensagensAnteriores ||
        mensagensAnteriores.length === 0 ||
        mensagensAnteriores.every((m) => m.direcao === 'in')
    } catch (e) {
      console.warn('[chatbotTriage] Erro ao verificar mensagens anteriores:', e?.message)
      isPrimeiraMensagemCliente = true // Assume primeira mensagem em caso de erro — melhor enviar menu do que ignorar
    }
  }

  console.log('[chatbotTriage] análise da conversa', {
    conversa_id,
    company_id,
    menuAlreadySent,
    conversaReabertaAposFinalizacao,
    isPrimeiraMensagemCliente,
  })

  // Determinar se deve enviar boas-vindas (menu de triagem):
  // 1. Conversa reaberta após finalização — SEMPRE enviar
  // 2. Primeira mensagem do cliente E (menu ainda não enviado OU sendOnlyFirstTime=false)
  const shouldSendWelcome =
    conversaReabertaAposFinalizacao ||
    (isPrimeiraMensagemCliente && (!menuAlreadySent || !config.sendOnlyFirstTime))

  if (shouldSendWelcome) {
    const msg = welcomeFull || menuOnly
    if (msg) {
      const motivo = conversaReabertaAposFinalizacao ? 'conversa_reaberta' : 'primeira_mensagem'
      console.log('[chatbotTriage] enviando menu de boas-vindas', { conversa_id, company_id, motivo })
      try {
        await sendWithThrottle(sendMessage, telefone, msg, opts, company_id, config.intervaloEnvioSegundos)
        await sb.from('mensagens').insert({
          conversa_id,
          texto: msg,
          direcao: 'out',
          company_id,
          status: 'sent',
        })
        await logBotAction(company_id, conversa_id, 'menu_enviado', {
          opcoes: config.options.map((o) => o.key),
          motivo,
        })
      } catch (e) {
        console.error('[chatbotTriage] ❌ Erro ao enviar menu de boas-vindas:', e?.message || e)
      }
    } else {
      console.warn('[chatbotTriage] ⚠️ menu vazio — welcomeMessage e opções estão vazios. Verifique a configuração.')
    }
    return { handled: true }
  }

  // Opção inválida: menu já foi enviado mas o cliente não digitou uma opção válida
  // Regra 1: Se o operador humano enviou mensagem recentemente (celular ou painel), não se intrometer
  const humanIntervened = await hasHumanIntervenedRecently(sb, company_id, conversa_id, config)
  if (humanIntervened) {
    console.log('[chatbotTriage] ❌ skip opção inválida: operador humano está conversando — chatbot não se intromete', {
      conversa_id,
      company_id,
    })
    return { handled: true }
  }

  // Regra 2: Enviar no máximo 2 vezes por conversa — evita spam
  const opcaoInvalidaCount = await countOpcaoInvalidaSent(sb, company_id, conversa_id)
  if (opcaoInvalidaCount >= MAX_OPCAO_INVALIDA_ENVIOS) {
    console.log('[chatbotTriage] ❌ skip opção inválida: limite atingido (máx 2)', {
      conversa_id,
      company_id,
      count: opcaoInvalidaCount,
    })
    return { handled: true }
  }

  const invalidMsg =
    config.invalidOptionMessage || 'Opção inválida. Por favor, responda apenas com o número do setor desejado.'
  const menuText = buildMenuText(config)
  const fullInvalid = menuText
    ? `${invalidMsg}\n\n${menuText}\n\nResponda com o número da opção desejada.`
    : invalidMsg

  console.log('[chatbotTriage] enviando mensagem de opção inválida', {
    conversa_id,
    company_id,
    textoRecebido: String(texto || '').slice(0, 50),
    enviadoNumero: opcaoInvalidaCount + 1,
    maxEnvio: MAX_OPCAO_INVALIDA_ENVIOS,
  })

  try {
    await sendWithThrottle(sendMessage, telefone, fullInvalid, opts, company_id, config.intervaloEnvioSegundos)
    await sb.from('mensagens').insert({
      conversa_id,
      texto: fullInvalid,
      direcao: 'out',
      company_id,
      status: 'sent',
    })
    await logBotAction(company_id, conversa_id, 'opcao_invalida', {
      texto_recebido: texto?.slice(0, 100),
      opcoes_validas: config.options.filter((o) => o.active !== false).map((o) => o.key),
    })
  } catch (e) {
    console.error('[chatbotTriage] ❌ Erro ao enviar mensagem de opção inválida:', e?.message || e)
  }

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
  buildMensagemFinalizacao,
  findOptionByKey,
  transferToDepartment,
  resetChatbotStateForConversa,
  wasMenuSentForConversa,
  wasOptionSelectedForConversa,
}
