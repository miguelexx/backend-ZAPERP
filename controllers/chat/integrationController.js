/**
 * Integração/diagnóstico WhatsApp para a tela de atendimento: lista de instâncias, status da conexão,
 * sincronização de contatos e fotos de perfil.
 * Extraído de controllers/chatController.js (Fase 8 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js (inclui o alias legado zapiStatus).
 */

const supabase = require('../../config/supabase')
const { getStatus } = require('../../services/ultramsgIntegrationService')
const { getProvider } = require('../../services/providers')
const { listWhatsappInstances, sanitizeWhatsappInstance } = require('../../services/whatsappInstanceService')

exports.listWhatsappInstancesAtendimento = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const result = await listWhatsappInstances(company_id)
    if (result.error) return res.status(500).json({ error: result.error })
    const active = (result.instances || [])
      .filter((i) => i && i.ativo !== false)
      .map(sanitizeWhatsappInstance)
      .filter(Boolean)
    return res.json({
      instances: active,
      has_multiple_whatsapp_instances: active.length > 1,
      active_count: active.length,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar instâncias WhatsApp' })
  }
}

// =====================================================
// 3a) Status da conexão WhatsApp (UltraMsg)
// GET /chats/whatsapp-status — status para banner "WhatsApp conectado/desconectado"
// Usa empresa_zapi (instance_id, instance_token) por company_id. NUNCA ENV.
// Sem config → 200 { hasInstance:false, connected:false, configured:false }
// =====================================================
exports.whatsappStatus = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    // Z-API removida; banner "WhatsApp desconectado" oculto por padrão. Use HIDE_WHATSAPP_DISCONNECT_BANNER=0 para exibir.
    const hideBanner = process.env.HIDE_WHATSAPP_DISCONNECT_BANNER !== '0'
    // Usa UltraMsg como único provider WhatsApp; empresa_zapi armazena instance_id/token
    if (!company_id) {
      return res.json({ ok: true, hasInstance: false, connected: hideBanner, configured: false })
    }

    const { getStatus } = require('../../services/ultramsgIntegrationService')
    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
    const configResult = await getEmpresaWhatsappConfig(company_id)
    if (configResult.error || !configResult.config) {
      return res.json({ ok: true, hasInstance: false, connected: hideBanner, configured: false })
    }

    const statusResult = await getStatus(company_id)
    let connected = !!statusResult?.connected
    if (hideBanner) connected = true // Oculta banner (Z-API removida; sistema usa UltraMsg)
    const smartphoneConnected = !!statusResult?.smartphoneConnected
    return res.json({
      ok: true,
      hasInstance: true,
      connected,
      smartphoneConnected,
      configured: true,
      ...(statusResult?.error && { error: statusResult.error }),
      ...(statusResult?.needsRestore && { needsRestore: true })
    })
  } catch (err) {
    console.error('whatsappStatus:', err?.message || err)
    return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
  }
}

exports.zapiStatus = exports.whatsappStatus

// =====================================================
// 3b) Sincronizar contatos do celular (UltraMsg)
// Executa sync inline — compatível sem fila de jobs.
// =====================================================
exports.sincronizarContatosZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    // Quantidade atual no banco ANTES da sync (resposta imediata ao frontend).
    const { count: totalBanco } = await supabase
      .from('clientes')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', Number(company_id))

    const totalClientesBanco = Number(totalBanco || 0)

    // Enfileira job que o worker (iniciado no index.js) vai processar em background.
    // Continua mesmo se o usuário sair da tela.
    const { enqueue, JOB_TIPOS, resumeAll, recoverStaleRunningJobs } = require('../../services/queueManager')

    // Clique manual = intenção explícita de sincronizar. Dois estados silenciosos
    // impediam o botão de "puxar nada":
    //  1) processamento_pausado=true — o worker auto-pausa a empresa após falhas
    //     repetidas de job; enquanto pausado, getNextPendingJob ignora a fila e o
    //     job novo fica pendente para sempre. Retomamos aqui.
    //  2) job anterior travado em 'running' (crash/deploy) — bloqueia novo enqueue
    //     por jobDuplicado até a varredura de stale (10 min). Recuperamos agora.
    try { await resumeAll(company_id) } catch (e) { console.warn('[SYNC-CONTATOS] resumeAll:', e?.message || e) }
    try { await recoverStaleRunningJobs() } catch (e) { console.warn('[SYNC-CONTATOS] recoverStale:', e?.message || e) }

    const result = await enqueue(company_id, JOB_TIPOS.SYNC_CONTATOS, {
      reset: true,
      includeConversationCache: false
    })

    if (!result.ok) {
      const jaRodando = /enfileirado|execu/i.test(result.error || '')
      return res.json({
        ok: true,
        queued: false,
        running: jaRodando,
        message: jaRodando
          ? 'Sincronização já em andamento. Os contatos serão atualizados em breve.'
          : (result.error || 'Não foi possível iniciar sincronização'),
        total_contatos: totalClientesBanco,
        criados: 0,
        atualizados: 0,
        fotos_atualizadas: 0
      })
    }

    console.log(`[SYNC-CONTATOS] empresa=${company_id} job_id=${result.job_id} enfileirado — banco atual: ${totalClientesBanco}`)
    return res.json({
      ok: true,
      queued: true,
      running: true,
      job_id: result.job_id,
      message: 'Sincronização iniciada. Os contatos serão importados em lotes e a tela atualizará ao terminar.',
      total_contatos: totalClientesBanco,
      criados: 0,
      atualizados: 0,
      fotos_atualizadas: 0
    })
  } catch (err) {
    console.error('sincronizarContatosZapi:', err)
    return res.json({ ok: false, message: 'Erro ao iniciar sincronização de contatos', total_contatos: 0, criados: 0, atualizados: 0 })
  }
}

// =====================================================
// 3b.1) Debug sync de contatos — testa passo a passo sem salvar
// GET /chats/debug-sync-contatos
// =====================================================
exports.debugSyncContatos = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
    const ultramsgSvc = require('../../services/ultramsgIntegrationService')
    const { getProvider } = require('../../services/providers')

    const diag = { company_id, steps: [] }

    // Passo 1: Verificar credenciais na tabela empresa_zapi
    const { config, error: cfgError } = await getEmpresaWhatsappConfig(company_id)
    if (cfgError || !config) {
      diag.steps.push({ step: 'credenciais', ok: false, detail: cfgError || 'sem registro em empresa_zapi com ativo=true' })
      return res.json({ ok: false, diagnostico: diag })
    }
    diag.steps.push({
      step: 'credenciais',
      ok: true,
      detail: `instance_id=${config.instance_id} token=${config.instance_token ? config.instance_token.slice(0, 6) + '...' : 'VAZIO'} ativo=${config.ativo}`
    })

    // Passo 2: Verificar status da conexão
    const status = await ultramsgSvc.getStatus(company_id)
    diag.steps.push({
      step: 'conexao',
      ok: !!status.connected,
      detail: status.error ? `erro: ${status.error}` : `connected=${status.connected} smartphoneConnected=${status.smartphoneConnected}`
    })
    if (!status.connected) {
      return res.json({ ok: false, diagnostico: diag, mensagem: 'WhatsApp não está conectado. Escaneie o QR code em Integrações.' })
    }

    // Passo 3: Tentar buscar os primeiros 10 contatos da API UltraMSG
    const provider = getProvider()
    const gcr = await provider.getContacts(1, 10, { companyId: company_id })
    const primeiraLeva = gcr?.data != null ? gcr.data : (Array.isArray(gcr) ? gcr : [])
    diag.steps.push({
      step: 'buscar_contatos_api',
      ok: Array.isArray(primeiraLeva),
      contatos_retornados: Array.isArray(primeiraLeva) ? primeiraLeva.length : 0,
      amostra: Array.isArray(primeiraLeva)
        ? primeiraLeva.slice(0, 3).map(c => ({ name: c.name, phone: String(c.phone || c.id || '').slice(-12) }))
        : []
    })

    if (!Array.isArray(primeiraLeva) || primeiraLeva.length === 0) {
      return res.json({
        ok: false,
        diagnostico: diag,
        mensagem: 'UltraMSG retornou lista vazia. Verifique se o celular tem contatos salvos na agenda.'
      })
    }

    // Passo 4: Verificar quantos passam pelos filtros BR
    const { normalizePhoneBR } = require('../../helpers/phoneHelper')
    let passam = 0, falham = 0
    for (const c of primeiraLeva) {
      const phoneRaw = String(c.phone || c.id || '').replace(/\D/g, '')
      const norm = normalizePhoneBR(phoneRaw)
      if (norm && norm.startsWith('55') && (norm.length === 12 || norm.length === 13)) passam++
      else falham++
    }
    diag.steps.push({ step: 'filtro_br', passam, falham, total: primeiraLeva.length })

    return res.json({
      ok: true,
      diagnostico: diag,
      mensagem: `Tudo OK. ${primeiraLeva.length} contatos na primeira página. Use POST /chats/sincronizar-contatos para salvar todos.`
    })
  } catch (err) {
    console.error('debugSyncContatos:', err)
    return res.status(500).json({ error: err?.message || 'Erro interno' })
  }
}

// =====================================================
// 3c) Sincronizar fotos de perfil (Z-API Get profile-picture)
// Executa sync inline — compatível sem fila de jobs.
// =====================================================
exports.sincronizarFotosPerfilZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const provider = getProvider()
    if (!provider?.getProfilePicture && !provider?.getContactMetadata) {
      return res.status(501).json({ error: 'Sincronização de fotos disponível apenas com WhatsApp conectado.' })
    }

    // Verifica conexão: getStatus primeiro; se não conectado, fallback em getConnectionStatus (evita 503 falso)
    let connected = false
    const statusResult = await getStatus(Number(company_id))
    if (statusResult?.connected) {
      connected = true
    } else if (provider?.getConnectionStatus) {
      const conn = await provider.getConnectionStatus({ companyId: company_id })
      connected = !!conn?.connected
    }
    if (!connected) {
      // Retorna 200 com zeros em vez de 503 — evita toast de erro "WhatsApp não conectado" (Z-API removida)
      return res.json({ total: 0, atualizados: 0 })
    }

    const { syncFotosFullProgressiva } = require('../../services/syncFotosProgressivaService')
    // Botão "Sincronizar fotos": puxa TODAS as fotos de perfil (todos os clientes)
    const maxClients = Math.min(10000, Number(req.query.limit) || 10000)
    const result = await syncFotosFullProgressiva(company_id, { maxClients, onlySemFoto: false })

    return res.json({
      total: result.clientesProcessados ?? 0,
      atualizados: result.totalAtualizados ?? 0
    })
  } catch (err) {
    console.error('sincronizarFotosPerfilZapi:', err)
    return res.status(500).json({ error: 'Erro ao sincronizar fotos' })
  }
}
