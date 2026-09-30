'use strict'

// GET /crm/contatos?companyId=<id>&busca=<texto>
//
// Endpoint server-to-server para o CRM Avançado buscar contatos (clientes) da empresa
// no ZapERP. Autenticado por x-zaperp-secret === ZAP_SSO_SECRET (comparação segura).
//
// Busca por nome OU telefone contendo `busca` (case-insensitive, acento/format-safe via
// buildClienteSearchOr — mesma construção .or() da listagem de clientes, que trata as
// variantes de telefone BR e escapa o termo p/ PostgREST). Sem `busca` → mais recentes.
//
// CONTRATO: 200 { contatos: [ { nome, telefone(só dígitos) } ] } (máx ~20).
//   401 segredo ausente/divergente · 400 companyId inválido · 503 ZAP_SSO_SECRET ausente.
//   Falha/timeout no banco → 200 { contatos: [] } (o CRM só mostra "sem resultados").
//   Nunca retorna tokens nem outros dados sensíveis do cliente (só nome + telefone).

const supabase = require('../config/supabase')
const { segredoConfere } = require('../helpers/zaperpSecret')
const { buildClienteSearchOr } = require('../helpers/chatSearchHelper')

const LIMITE = 20
const QUERY_TIMEOUT_MS = 5000

// Corre `promise` contra um timer; se estourar, resolve com `fallback` (não rejeita).
function comTimeout(promise, ms, fallback) {
  let timer
  const limite = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback).finally(() => clearTimeout(timer)),
    limite,
  ])
}

async function listarContatos(req, res) {
  const segredo = process.env.ZAP_SSO_SECRET
  if (!segredo) {
    return res.status(503).json({ error: 'Integração não configurada (ZAP_SSO_SECRET).' })
  }
  if (!segredoConfere(req.headers['x-zaperp-secret'], segredo)) {
    return res.status(401).json({ error: 'Segredo inválido.' })
  }

  const companyId = Number(req.query?.companyId)
  if (!Number.isFinite(companyId) || companyId <= 0) {
    return res.status(400).json({ error: 'companyId inválido.' })
  }

  const busca = req.query?.busca != null ? String(req.query.busca).trim() : ''

  try {
    let query = supabase
      .from('clientes')
      .select('nome, pushname, telefone')
      .eq('company_id', companyId)
      .order('id', { ascending: false })
      .limit(LIMITE)

    // Com termo: filtra por nome/pushname/telefone. Sem termo: os mais recentes (order id desc).
    if (busca) {
      query = query.or(buildClienteSearchOr(busca))
    }

    const { data, error } = await comTimeout(query, QUERY_TIMEOUT_MS, { data: [], error: null })
    if (error) throw error

    const contatos = (data || [])
      .map((c) => {
        const bruto = String(c?.telefone || '').trim()
        // Ignora placeholders de LID (conversa sem telefone real).
        if (!bruto || bruto.toLowerCase().startsWith('lid:')) return null
        const telefone = bruto.replace(/\D/g, '')
        if (telefone.length < 8) return null
        const nome =
          (c?.nome && String(c.nome).trim()) ||
          (c?.pushname && String(c.pushname).trim()) ||
          telefone
        return { nome, telefone }
      })
      .filter(Boolean)

    return res.status(200).json({ contatos })
  } catch (err) {
    console.error('[crm:contatos] company=', companyId, err?.message)
    return res.status(200).json({ contatos: [] })
  }
}

module.exports = { listarContatos }
