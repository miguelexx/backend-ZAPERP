/**
 * Sincronização progressiva de fotos de perfil.
 * Processa em lotes com delay para evitar sobrecarga na Z-API.
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getStatus } = require('./ultramsgIntegrationService')
const { getConfig, isProcessamentoPausado } = require('./configOperacionalService')
const { chooseBestName } = require('../helpers/contactEnrichment')
const { clienteTemNomeProtegido } = require('../helpers/clienteNomeProtecao')
const { marcarSchemaNomeProtecaoIndisponivel } = require('../helpers/clienteNomeColunas')

const BATCH_SIZE = 50
const DELAY_MS = 250

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Processa um lote de clientes (fotos e metadados).
 * @param {number} company_id
 * @param {object} opts - { offset, limit }
 */
async function syncFotosProgressiva(company_id, opts = {}) {
  if (!company_id) return { total: 0, atualizados: 0, processados: 0 }

  const provider = getProvider()
  if (!provider?.getProfilePicture && !provider?.getContactMetadata) {
    return { total: 0, atualizados: 0, processados: 0, error: 'Z-API não disponível' }
  }

  // Fallback: se getStatus diz não conectado, tentar provider.getConnectionStatus
  const statusResult = await getStatus(company_id)
  let connected = !!statusResult?.connected
  if (!connected) {
    const provider = getProvider()
    if (provider?.getConnectionStatus) {
      const conn = await provider.getConnectionStatus({ companyId: company_id })
      connected = !!conn?.connected
    }
  }
  if (!connected) {
    return { total: 0, atualizados: 0, processados: 0, error: 'WhatsApp não conectado' }
  }

  if (await isProcessamentoPausado(company_id)) {
    return { total: 0, atualizados: 0, processados: 0, error: 'Processamento pausado' }
  }

  const limit = Math.min(BATCH_SIZE, opts.limit || BATCH_SIZE)
  const offset = Math.max(0, opts.offset || 0)
  // onlySemFoto: false = puxar TODAS as fotos (clientes com e sem foto). true = só quem não tem foto.
  const onlySemFoto = opts.onlySemFoto === true

  const cols = 'id, telefone, nome, pushname, foto_perfil, nome_protegido'
  const colsBase = 'id, telefone, nome, pushname, foto_perfil'

  function buildQuery(selectCols) {
    let q = supabase
      .from('clientes')
      .select(selectCols)
      .eq('company_id', company_id)
      .not('telefone', 'is', null)
      .order('id', { ascending: true })
    if (onlySemFoto) {
      q = q.or('foto_perfil.is.null,foto_perfil.eq.,foto_perfil.eq.null')
    }
    return q
  }

  let { data: clientes, error: errClientes } = await buildQuery(cols).range(offset, offset + limit - 1)
  if (errClientes && marcarSchemaNomeProtecaoIndisponivel(errClientes)) {
    const retry = await buildQuery(colsBase).range(offset, offset + limit - 1)
    clientes = retry.data
  }

  if (!clientes?.length) return { total: 0, atualizados: 0, processados: 0 }

  let atualizados = 0
  const cid = Number(company_id)

  for (const cl of clientes) {
    const phone = (cl.telefone || '').trim().replace(/\D/g, '')
    if (!phone) continue

    try {
      const nomeDb = String(cl.nome || '').trim()
      const pushDb = String(cl.pushname || '').trim()
      const fotoDb = String(cl.foto_perfil || '').trim()
      const missingName = !nomeDb || nomeDb === phone
      const missingFoto = !fotoDb || fotoDb.toLowerCase() === 'null'

      const [meta, fotoUrl] = await Promise.all([
        provider.getContactMetadata ? provider.getContactMetadata(phone, { companyId: cid }) : Promise.resolve(null),
        provider.getProfilePicture ? provider.getProfilePicture(phone, { companyId: cid }) : Promise.resolve(null)
      ])

      const metaNome = String(meta?.name || meta?.short || meta?.notify || meta?.vname || '').trim()
      const metaPush = String(meta?.notify || '').trim()
      const metaImgRaw = meta?.imgUrl || meta?.photo || meta?.profilePicture || ''
      const metaImg = metaImgRaw && String(metaImgRaw).startsWith('http') ? metaImgRaw : null
      const fotoFinal = (fotoUrl && String(fotoUrl).startsWith('http') ? fotoUrl : null) || metaImg

      const updates = {}
      // Só grava nome quando a API trouxe um nome real; NUNCA usar o telefone como nome.
      if (metaNome && !clienteTemNomeProtegido(cl)) {
        const { name: bestNome } = chooseBestName(nomeDb || null, metaNome, 'syncUltramsg', { fromMe: false, company_id: cid, telefoneTail: phone.slice(-6) })
        if (bestNome && bestNome !== nomeDb) updates.nome = bestNome
      } else if (!clienteTemNomeProtegido(cl) && nomeDb && nomeDb === phone) {
        // Limpa legado: contatos que nasceram com o telefone gravado no campo nome.
        updates.nome = null
      }
      if (!pushDb && metaPush) updates.pushname = metaPush
      if (fotoFinal) updates.foto_perfil = fotoFinal

      if (Object.keys(updates).length > 0) {
        let upd = await supabase.from('clientes').update(updates).eq('id', cl.id).eq('company_id', cid)
        if (upd.error && String(upd.error.message || '').includes('pushname')) {
          delete updates.pushname
          if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', cl.id).eq('company_id', cid)
        }
        if (!upd.error) atualizados++
      }

      await sleep(DELAY_MS)
    } catch (e) {
      if (e?.code === 'ZAPI_NOT_CONNECTED') throw e
    }
  }

  return { total: clientes.length, atualizados, processados: clientes.length }
}

/**
 * Executa sync completo de fotos em lotes (para o worker).
 * Por padrão processa TODOS os clientes (onlySemFoto: false) para puxar todas as fotos.
 */
async function syncFotosFullProgressiva(company_id, opts = {}) {
  const config = await getConfig(company_id)
  const batchSize = Math.min(100, config.lote_max || BATCH_SIZE)
  const maxClients = opts.maxClients ?? 10000
  const onlySemFoto = opts.onlySemFoto === true

  let offset = 0
  let totalAtualizados = 0

  while (offset < maxClients) {
    if (await isProcessamentoPausado(company_id)) break

    const result = await syncFotosProgressiva(company_id, { offset, limit: batchSize, onlySemFoto })
    if (result.error) break
    totalAtualizados += result.atualizados || 0

    if (!result.processados || result.processados < batchSize) break
    offset += batchSize
  }

  return { totalAtualizados, clientesProcessados: offset }
}

module.exports = { syncFotosProgressiva, syncFotosFullProgressiva }
