'use strict'

/**
 * Saúde do ACK por canal — "este número parou de confirmar entrega?" (F8 do doc 33).
 *
 * Por que existe: em 15/10/2026 um canal deixou de entregar `statuses[]` (evento desligado no
 * painel, channel-store recriado, id de outro canal) e NINGUÉM foi avisado. O sintoma chegou
 * como alarme falso em massa — toda mensagem virando "não foi possível enviar" 2 h depois. A
 * causa daquilo foi corrigida (`erro` só com evidência), mas a ausência de ACK em si continuava
 * invisível: a varredura cura as linhas e segue em silêncio.
 *
 * Como mede (sem coluna nova, sem migration): numa janela recente, quantas mensagens OUT do canal
 * foram aceitas pelo provedor (têm `whatsapp_id`) e quantas chegaram a delivered/read/played.
 * Zero confirmações com volume relevante = o canal não está mandando ACK.
 *
 * Tudo filtrado por `company_id` — o isolamento é app-layer (SERVICE_ROLE bypassa RLS).
 */

const supabaseClient = require('../config/supabase')
const { STATUS_ALIASES, statusRank, canonStatusForEmit } = require('../helpers/messageStatusHelper')

/** Apelidos que contam como "o provedor confirmou entrega" (delivered, read, played + variantes). */
const STATUS_CONFIRMADOS = STATUS_ALIASES.filter(
  (a) => statusRank(a) >= statusRank('delivered') && canonStatusForEmit(a) !== 'erro'
)

function parseIntEnv(name, fallback, { min, max }) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Janela observada. Curta demais acusa canal ocioso; longa demais demora a acusar. */
function getJanelaMinutos() {
  return parseIntEnv('ACK_HEALTH_WINDOW_MINUTES', 120, { min: 15, max: 1440 })
}

/** Volume mínimo para opinar. Abaixo disso, "sem dados" — não é alarme. */
function getVolumeMinimo() {
  return parseIntEnv('ACK_HEALTH_MIN_ENVIADAS', 5, { min: 1, max: 1000 })
}

/**
 * Teto de linhas lidas por canal. Existe por medição: com `count: 'exact'` (3 por canal) a
 * varredura dos 21 canais levou **24 s** — caro demais para rodar de meia em meia hora. Lendo
 * só o `status` de até N linhas recentes e contando em memória, é UMA consulta por canal, com
 * limite. "Zero confirmadas" continua exato (se a leitura volta vazia de confirmação, é zero);
 * a TAXA passa a ser da amostra, o que basta para o estado `parcial`.
 */
function getAmostraMax() {
  return parseIntEnv('ACK_HEALTH_SAMPLE_MAX', 300, { min: 20, max: 2000 })
}

/**
 * Avalia um canal.
 * @returns {{ estado: 'ok'|'parcial'|'sem_ack'|'sem_dados', enviadas, confirmadas, janela_minutos,
 *             taxa_confirmacao, ultimo_ack_em: string|null, mensagem: string }}
 */
async function avaliarCanal({ company_id, whatsapp_instance_id, janelaMinutos = null, incluirUltimoAck = true }) {
  if (company_id == null) throw new Error('company_id obrigatório')
  const janela = janelaMinutos || getJanelaMinutos()
  const desde = new Date(Date.now() - janela * 60_000).toISOString()

  const amostraMax = getAmostraMax()
  let amostraQuery = supabaseClient
    .from('mensagens')
    .select('status')
    .eq('company_id', Number(company_id))
    .eq('direcao', 'out')
    .gte('criado_em', desde)
    .not('whatsapp_id', 'is', null) // sem id = o provedor nem aceitou; não dá para esperar ACK
    .order('criado_em', { ascending: false })
    .limit(amostraMax)
  if (whatsapp_instance_id != null) amostraQuery = amostraQuery.eq('whatsapp_instance_id', Number(whatsapp_instance_id))

  const { data: amostra, error: erroAmostra } = await amostraQuery
  if (erroAmostra) throw new Error(erroAmostra.message || 'erro ao ler mensagens do canal')
  const linhas = Array.isArray(amostra) ? amostra : []
  const confirmados = new Set(STATUS_CONFIRMADOS.map((v) => String(v).toLowerCase()))
  const enviadas = linhas.length
  const confirmadas = linhas.filter((l) => confirmados.has(String(l?.status ?? '').toLowerCase())).length
  const amostraTruncada = enviadas >= amostraMax

  // Último ACK observado no canal (independe da janela): ajuda a datar o início do problema.
  // Medido em 500–600 ms por canal porque não tem recorte de tempo — por isso a varredura
  // periódica NÃO pede (passa `incluirUltimoAck: false`); só o endaponto sob demanda pede.
  let ultimoAckEm = null
  if (incluirUltimoAck) {
    let q = supabaseClient
      .from('mensagens')
      .select('criado_em')
      .eq('company_id', Number(company_id))
      .eq('direcao', 'out')
      .in('status', STATUS_CONFIRMADOS)
      .order('criado_em', { ascending: false })
      .limit(1)
    if (whatsapp_instance_id != null) q = q.eq('whatsapp_instance_id', Number(whatsapp_instance_id))
    const { data } = await q
    ultimoAckEm = Array.isArray(data) && data[0]?.criado_em ? data[0].criado_em : null
  }

  const minimo = getVolumeMinimo()
  const taxa = enviadas > 0 ? confirmadas / enviadas : 0

  let estado = 'ok'
  let mensagem = 'O canal está confirmando entrega normalmente.'
  if (enviadas < minimo) {
    estado = 'sem_dados'
    mensagem = `Poucas mensagens na janela (${enviadas} de ${minimo} necessárias) — sem conclusão.`
  } else if (confirmadas === 0) {
    estado = 'sem_ack'
    mensagem =
      `Nenhuma das ${enviadas} mensagens${amostraTruncada ? ' mais recentes' : ''} enviadas nas últimas ${janela} min foi confirmada. ` +
      'Verifique no painel do canal se o evento "statuses" está ligado e se o webhook aponta para /webhooks/whapi.'
  } else if (taxa < 0.5) {
    estado = 'parcial'
    mensagem = `Só ${confirmadas} de ${enviadas} mensagens foram confirmadas nas últimas ${janela} min.`
  }

  return {
    estado,
    enviadas,
    confirmadas,
    taxa_confirmacao: Number(taxa.toFixed(3)),
    janela_minutos: janela,
    ultimo_ack_em: ultimoAckEm,
    // Honestidade sobre a medida: acima do teto, `enviadas`/`confirmadas` são da amostra das mais
    // recentes, não totais da janela.
    amostra_truncada: amostraTruncada,
    amostra_max: amostraMax,
    mensagem,
  }
}

/** Avisos no log limitados a 1 por canal por hora (não poluir o PM2 a cada ciclo). */
const INTERVALO_AVISO_MS = 60 * 60_000
const _avisados = new Map()

function _deveAvisar(chave, agora = Date.now()) {
  const ultimo = _avisados.get(chave) || 0
  if (agora - ultimo < INTERVALO_AVISO_MS) return false
  if (_avisados.size > 200) _avisados.clear()
  _avisados.set(chave, agora)
  return true
}

/**
 * Avalia TODOS os canais Whapi (opcionalmente de uma empresa) e loga quem está sem ACK.
 * Pensado para rodar junto dos jobs periódicos; nunca lança (o chamador não pode cair por isso).
 */
async function varrerSaudeDeAck({ company_id = null } = {}) {
  const resultados = []
  try {
    let q = supabaseClient.from('whatsapp_instances').select('id, company_id, nome').eq('provider', 'whapi')
    if (company_id != null) q = q.eq('company_id', Number(company_id))
    const { data: instancias, error } = await q
    if (error) {
      console.warn('[ACK_HEALTH] não foi possível listar canais:', error.message)
      return { ok: false, resultados }
    }
    for (const inst of instancias || []) {
      try {
        const r = await avaliarCanal({
          company_id: inst.company_id,
          whatsapp_instance_id: inst.id,
          incluirUltimoAck: false,
        })
        resultados.push({ whatsapp_instance_id: inst.id, company_id: inst.company_id, nome: inst.nome || null, ...r })
        if (r.estado === 'sem_ack' && _deveAvisar(`${inst.company_id}:${inst.id}`)) {
          console.warn('[ACK_HEALTH] ⚠️ canal sem confirmação de entrega', {
            company_id: inst.company_id,
            whatsapp_instance_id: inst.id,
            enviadas: r.enviadas,
            janela_minutos: r.janela_minutos,
            ultimo_ack_em: r.ultimo_ack_em,
          })
        }
      } catch (e) {
        console.warn('[ACK_HEALTH] falha ao avaliar canal', inst.id, '-', e?.message || e)
      }
    }
    return { ok: true, resultados }
  } catch (e) {
    console.warn('[ACK_HEALTH] varredura falhou:', e?.message || e)
    return { ok: false, resultados }
  }
}

module.exports = {
  avaliarCanal,
  varrerSaudeDeAck,
  STATUS_CONFIRMADOS,
  _test: { resetAvisos: () => _avisados.clear(), deveAvisar: _deveAvisar, INTERVALO_AVISO_MS },
}
