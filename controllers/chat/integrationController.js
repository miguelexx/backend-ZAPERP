/**
 * Integração/diagnóstico WhatsApp para a tela de atendimento: lista de instâncias, status da conexão,
 * sincronização de contatos e fotos de perfil.
 * Extraído de controllers/chatController.js (Fase 8 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js (inclui o alias legado zapiStatus).
 */

const supabase = require('../../config/supabase')
const { getStatus } = require('../../services/ultramsgIntegrationService')
const { getProvider } = require('../../services/providers')
const { resolveCompanyWhatsappProvider } = require('../../services/chat/identity/conversationAddressService')
const { listWhatsappInstances, sanitizeWhatsappInstance } = require('../../services/whatsappInstanceService')

const WHAPI_STATUS_MAX_INSTANCES = 8
const WHAPI_LIVE_UP = new Set(['AUTH', 'CONNECTED', 'READY'])
const WHAPI_AMBIGUOUS_HEALTH = new Set(['', 'NOT_CONFIGURED', 'ERROR', 'UNKNOWN'])

function isActiveWhapiInstance(inst) {
  return Boolean(
    inst
    && inst.ativo !== false
    && String(inst.provider || '').trim().toLowerCase() === 'whapi'
  )
}

function healthStatus(result) {
  return String(result?.status || '').trim().toUpperCase()
}

function isLiveWhapiUp(result) {
  if (!result) return false
  if (result.connected === true) return true
  return WHAPI_LIVE_UP.has(healthStatus(result))
}

/** Só AUTH perdido de verdade — não “sem default” / timeout / health vazio. */
function isProvenWhapiSessionDown(result) {
  if (!result || isLiveWhapiUp(result)) return false
  if (WHAPI_AMBIGUOUS_HEALTH.has(healthStatus(result))) return false
  return result.connected === false
}

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
    if (!company_id) {
      return res.json({ ok: true, hasInstance: false, connected: hideBanner, configured: false })
    }

    const { getStatus } = require('../../services/ultramsgIntegrationService')
    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
    const { getProvider } = require('../../services/providers')
    const { resolveCompanyWhatsappProvider } = require('../../services/chat/identity/conversationAddressService')
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)

    if (instanceProvider === 'whapi') {
      const statusResult = await getProvider({ provider: 'whapi' }).getConnectionStatus({ companyId: company_id })
      let connected = !!statusResult?.connected
      if (hideBanner) connected = true
      return res.json({
        ok: true,
        hasInstance: true,
        connected,
        smartphoneConnected: connected,
        configured: true,
        provider: 'whapi',
        ...(statusResult?.error && { error: statusResult.error }),
      })
    }

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
// 3a.1) Status dedicado do canal Whapi (tela vermelha de desconexão)
// GET /chats/whapi-status — disponível a QUALQUER usuário autenticado.
//
// Diferente de whatsappStatus, este endpoint NÃO é afetado por
// HIDE_WHATSAPP_DISCONNECT_BANNER: ele existe justamente para alimentar o
// overlay vermelho de "canal desconectado" do frontend.
//
// Regra à prova de falso-positivo (pintar o sistema inteiro de vermelho é
// disruptivo): só devolve `connected:false` quando o provider da empresa é
// Whapi E TODOS os canais Whapi ativos estão comprovadamente fora do AUTH.
// Com 2+ números, consulta cada instância (não a default da empresa): em
// produção, 2 canais sem is_default faziam getConnectionStatus({companyId})
// falhar e o overlay acendia mesmo com os dois AUTH. Em QUALQUER outra
// situação (provider diferente, sem empresa, pelo menos 1 AUTH, erro de
// rede/consulta) devolve `connected:true`, de modo que o overlay jamais
// aparece por engano.
// =====================================================
exports.whapiChannelStatus = async (req, res) => {
  const safe = { ok: true, isWhapi: false, connected: true, status: null }
  try {
    const company_id = Number(req.user?.company_id)
    // company_id inválido (NaN, 0, negativo) → fail-safe; nunca consultar o banco com NaN.
    if (!Number.isFinite(company_id) || company_id <= 0) return res.json(safe)

    const { resolveCompanyWhatsappProvider } = require('../../services/chat/identity/conversationAddressService')
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)
    if (instanceProvider !== 'whapi') {
      return res.json({ ...safe, provider: instanceProvider || null })
    }

    const listed = await listWhatsappInstances(company_id)
    if (listed?.error) return res.json(safe)

    const whapiActive = (listed.instances || [])
      .filter(isActiveWhapiInstance)
      .slice(0, WHAPI_STATUS_MAX_INSTANCES)

    if (!whapiActive.length) {
      // Classificada como Whapi, mas sem linha ativa para checar → não pintar vermelho.
      return res.json({ ok: true, isWhapi: true, connected: true, status: null, provider: 'whapi' })
    }

    const { getProvider } = require('../../services/providers')
    const whapi = getProvider({ provider: 'whapi' })
    // Checa CADA canal ativo com whatsappInstanceId. Em produção, 2+ Whapi sem
    // is_default faz getConnectionStatus({ companyId }) falhar (NO_DEFAULT_INSTANCE)
    // e o overlay vermelho acendia mesmo com todos AUTH.
    // wakeup (default): canal ocioso responde AUTH de verdade.
    const results = await Promise.all(whapiActive.map((inst) =>
      whapi.getConnectionStatus({
        companyId: company_id,
        whatsappInstanceId: inst.id,
      }).catch(() => null)
    ))

    const firstUp = results.find((r) => isLiveWhapiUp(r))
    if (firstUp) {
      return res.json({
        ok: true,
        isWhapi: true,
        connected: true,
        status: firstUp.status || 'AUTH',
        provider: 'whapi',
      })
    }

    const allProvenDown = results.length === whapiActive.length
      && results.every((r) => isProvenWhapiSessionDown(r))
    if (allProvenDown) {
      return res.json({
        ok: true,
        isWhapi: true,
        connected: false,
        status: results[0]?.status || null,
        provider: 'whapi',
      })
    }

    // not_configured / error / timeout / health vazio → fail-safe, overlay não acende.
    return res.json({ ok: true, isWhapi: true, connected: true, status: null, provider: 'whapi' })
  } catch (err) {
    console.error('whapiChannelStatus:', err?.message || err)
    // Erro ⇒ nunca acusa desconexão (evita overlay vermelho por falha transitória).
    return res.json(safe)
  }
}

// =====================================================
// 3b) Sincronizar contatos do celular (UltraMsg)
// Executa sync inline — compatível sem fila de jobs.
// =====================================================
exports.sincronizarContatosZapi = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ ok: false, error: 'Não autenticado' })
  try {
    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
    const { resolveCompanyWhatsappProvider } = require('../../services/chat/identity/conversationAddressService')
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)
    if (instanceProvider !== 'whapi') {
      const { config, error } = await getEmpresaWhatsappConfig(company_id)
      if (error || !config) return res.status(400).json({ ok: false, error: 'Configure a instância WhatsApp em Integrações antes de sincronizar.' })
    }
    const { enqueue, JOB_TIPOS, getActiveJob, recoverStaleRunningJobs } = require('../../services/queueManager')
    await recoverStaleRunningJobs(company_id)
    const result = await enqueue(company_id, JOB_TIPOS.SYNC_CONTATOS, {
      reset: true, manual: true, includePhotos: true, includeConversationCache: false,
    })
    if (!result.ok) {
      const active = await getActiveJob(company_id, JOB_TIPOS.SYNC_CONTATOS)
      if (active) {
        // Jobs criados antes deste fluxo podiam ficar pendentes sob pausa operacional.
        // O clique autoriza somente este job; não retoma a fila inteira da empresa.
        const { error: updateError } = await supabase.from('jobs').update({
          payload: { ...active.payload, manual: true, includePhotos: true, reset: true, includeConversationCache: false },
        }).eq('company_id', Number(company_id)).eq('id', active.id).eq('tipo', JOB_TIPOS.SYNC_CONTATOS)
        if (updateError) throw updateError
        return res.json({ ok: true, running: true, queued: active.status === 'pending',
          job_id: active.id, message: 'Sincronização já em andamento.' })
      }
      return res.status(500).json({ ok: false, error: 'Não foi possível iniciar a sincronização. Verifique a fila de processamento.' })
    }
    return res.status(202).json({ ok: true, queued: true, running: true, job_id: result.job_id,
      message: 'Sincronização iniciada. Importando nomes e fotos disponíveis; a lista será atualizada automaticamente.' })
  } catch {
    return res.status(500).json({ ok: false, error: 'Erro ao iniciar sincronização de contatos.' })
  }
}

// Para a importação de contatos em andamento (pending → cancela; running → cancel_requested).
// O worker checa a flag a cada lote e encerra preservando os contatos já importados.
exports.cancelarSincronizacaoContatos = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ ok: false, error: 'Não autenticado' })
  try {
    const { requestCancelJob, JOB_TIPOS } = require('../../services/queueManager')
    const result = await requestCancelJob(company_id, JOB_TIPOS.SYNC_CONTATOS)
    if (!result.ok) {
      if (result.notFound) {
        return res.status(404).json({ ok: false, error: 'Nenhuma importação de contatos em andamento.' })
      }
      return res.status(500).json({ ok: false, error: result.error || 'Não foi possível cancelar a importação.' })
    }
    return res.json({
      ok: true,
      job_id: result.job_id,
      status: result.status,
      cancelado: result.cancelled === true,
      cancelando: result.cancel_requested === true,
      message: result.cancelled === true
        ? 'Importação cancelada.'
        : 'Cancelamento solicitado. A importação será interrompida em instantes.',
    })
  } catch {
    return res.status(500).json({ ok: false, error: 'Erro ao cancelar a importação de contatos.' })
  }
}

// Leitura autenticada: acompanha o job mesmo após sair da página/perder o Socket.
exports.statusSincronizacaoContatos = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ ok: false, error: 'Não autenticado' })
  const jobId = req.query?.job_id
  if (jobId != null && !/^[1-9]\d*$/.test(String(jobId))) return res.status(400).json({ error: 'Job inválido.' })
  try {
    let query = supabase.from('jobs').select('id, status, resultado_json, erro, atualizado_em')
      .eq('company_id', Number(company_id)).eq('tipo', 'sync_contatos')
    if (jobId) query = query.eq('id', Number(jobId))
    const { data: job, error } = await query.order('criado_em', { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    if (!job) return res.json({ ok: true, running: false, status: 'idle' })
    const { data: checkpoint } = await supabase.from('checkpoints_sync').select('detalhes_json')
      .eq('company_id', Number(company_id)).eq('tipo', 'contact_sync').maybeSingle()
    const { contactSyncStatus } = require('../../helpers/contactSyncStatus')
    return res.json(contactSyncStatus(job, checkpoint?.detalhes_json))
  } catch {
    return res.status(500).json({ ok: false, error: 'Não foi possível consultar o progresso da sincronização.' })
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
    const { resolveCompanyWhatsappProvider } = require('../../services/chat/identity/conversationAddressService')

    const diag = { company_id, steps: [] }
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)

    if (instanceProvider !== 'whapi') {
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

      const status = await ultramsgSvc.getStatus(company_id)
      diag.steps.push({
        step: 'conexao',
        ok: !!status.connected,
        detail: status.error ? `erro: ${status.error}` : `connected=${status.connected} smartphoneConnected=${status.smartphoneConnected}`
      })
      if (!status.connected) {
        return res.json({ ok: false, diagnostico: diag, mensagem: 'WhatsApp não está conectado. Escaneie o QR code em Integrações.' })
      }
    } else {
      const status = await getProvider({ provider: 'whapi' }).getConnectionStatus({ companyId: company_id })
      diag.steps.push({
        step: 'credenciais',
        ok: !!status?.ok || !!status?.connected,
        detail: 'provider=whapi (token não exibido)',
      })
      diag.steps.push({
        step: 'conexao',
        ok: !!status?.connected,
        detail: status?.error ? `erro: ${status.error}` : `connected=${!!status?.connected} status=${status?.status || ''}`,
      })
      if (!status?.connected) {
        return res.json({ ok: false, diagnostico: diag, mensagem: 'Canal Whapi não está AUTH. Conecte a sessão no painel Whapi.' })
      }
    }
    const provider = getProvider({ provider: instanceProvider })
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
        mensagem: 'A API retornou lista vazia. Verifique se o celular tem contatos salvos na agenda.'
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

    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)
    const provider = getProvider({ provider: instanceProvider })
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
