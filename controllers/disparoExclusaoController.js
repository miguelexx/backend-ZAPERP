/**
 * Controller de Exclusões — módulo Disparo de Mensagens (Etapa 7).
 * Lista global de telefones bloqueados por empresa.
 */

const supabase = require('../config/supabase')
const { validarTelefoneDisparo } = require('../helpers/disparoPhoneHelper')

const EXCLUSAO_SELECT = [
  'id', 'telefone_normalizado', 'telefone_original', 'motivo', 'origem',
  'ativo', 'criado_por', 'criado_em', 'removido_por', 'removido_em',
].join(', ')

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

function parseTelefonesEntrada(body = {}) {
  if (Array.isArray(body.telefones) && body.telefones.length) {
    return body.telefones.map((t) => String(t ?? '').trim()).filter(Boolean)
  }
  const texto = String(body.texto ?? body.conteudo ?? '').trim()
  if (!texto) return []
  return texto
    .split(/[\r\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean)
}

// ─── 1. Listar ───────────────────────────────────────────────────────────────

exports.listar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)

    const page = Math.max(1, positiveInt(req.query.page) ?? 1)
    const limit = Math.min(MAX_PAGE_LIMIT, positiveInt(req.query.limit) ?? DEFAULT_PAGE_LIMIT)
    const offset = (page - 1) * limit
    const search = String(req.query.search ?? '').trim().replace(/\D/g, '')

    let query = supabase
      .from('disparo_exclusoes')
      .select(EXCLUSAO_SELECT, { count: 'exact' })
      .eq('company_id', companyId)
      .eq('ativo', true)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)

    if (search) {
      query = query.ilike('telefone_normalizado', `%${search}%`)
    }

    const { data, error, count } = await query
    if (error) throw error

    res.json({
      page,
      limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit) || 0,
      itens: data ?? [],
    })
  } catch (err) {
    console.error('[disparo:exclusoes] listar', err)
    res.status(500).json({ error: 'Erro ao listar exclusões.' })
  }
}

// ─── 2. Adicionar ────────────────────────────────────────────────────────────

exports.adicionar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null

    const validacao = validarTelefoneDisparo(req.body?.telefone)
    if (!validacao.valido) {
      return res.status(422).json({ error: validacao.motivo || 'Telefone inválido.' })
    }

    const motivo = String(req.body?.motivo ?? '').trim().slice(0, 500) || null
    const agora = new Date().toISOString()

    const { data: existente } = await supabase
      .from('disparo_exclusoes')
      .select('id, ativo')
      .eq('company_id', companyId)
      .eq('telefone_normalizado', validacao.normalizado)
      .maybeSingle()

    if (existente?.ativo) {
      return res.status(409).json({ error: 'Telefone já está na lista de exclusão.' })
    }

    if (existente && !existente.ativo) {
      const { data, error } = await supabase
        .from('disparo_exclusoes')
        .update({
          ativo: true,
          motivo,
          origem: 'manual',
          telefone_original: validacao.original,
          criado_por: userId,
          criado_em: agora,
          removido_por: null,
          removido_em: null,
        })
        .eq('id', existente.id)
        .eq('company_id', companyId)
        .select(EXCLUSAO_SELECT)
        .single()
      if (error) throw error
      return res.status(201).json({ ok: true, reativado: true, exclusao: data })
    }

    const { data, error } = await supabase
      .from('disparo_exclusoes')
      .insert({
        company_id: companyId,
        telefone_normalizado: validacao.normalizado,
        telefone_original: validacao.original,
        motivo,
        origem: 'manual',
        ativo: true,
        criado_por: userId,
      })
      .select(EXCLUSAO_SELECT)
      .single()
    if (error) throw error

    res.status(201).json({ ok: true, exclusao: data })
  } catch (err) {
    console.error('[disparo:exclusoes] adicionar', err)
    res.status(500).json({ error: 'Erro ao adicionar exclusão.' })
  }
}

// ─── 3. Remover (soft delete) ────────────────────────────────────────────────

exports.remover = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const exclId = positiveInt(req.params.exclId)
    if (!exclId) return res.status(400).json({ error: 'ID de exclusão inválido.' })

    const agora = new Date().toISOString()

    const { data, error } = await supabase
      .from('disparo_exclusoes')
      .update({
        ativo: false,
        removido_por: userId,
        removido_em: agora,
      })
      .eq('id', exclId)
      .eq('company_id', companyId)
      .eq('ativo', true)
      .select(EXCLUSAO_SELECT)
      .maybeSingle()
    if (error) throw error

    if (!data) {
      return res.status(404).json({ error: 'Exclusão não encontrada ou já removida.' })
    }

    res.json({ ok: true, exclusao: data })
  } catch (err) {
    console.error('[disparo:exclusoes] remover', err)
    res.status(500).json({ error: 'Erro ao remover exclusão.' })
  }
}

// ─── 4. Importar em lote ─────────────────────────────────────────────────────

exports.importar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null

    const linhas = parseTelefonesEntrada(req.body ?? {})
    if (!linhas.length) {
      return res.status(422).json({ error: 'Informe telefones (array) ou texto com um número por linha.' })
    }

    const motivoPadrao = String(req.body?.motivo ?? '').trim().slice(0, 500) || 'Importação em lote'
    const agora = new Date().toISOString()

    const resultados = {
      total: linhas.length,
      adicionados: 0,
      reativados: 0,
      duplicados: 0,
      invalidos: [],
    }

    const normalizadosVistos = new Set()

    for (const linha of linhas) {
      const validacao = validarTelefoneDisparo(linha)
      if (!validacao.valido) {
        resultados.invalidos.push({ original: validacao.original, motivo: validacao.motivo })
        continue
      }

      if (normalizadosVistos.has(validacao.normalizado)) {
        resultados.duplicados += 1
        continue
      }
      normalizadosVistos.add(validacao.normalizado)

      const { data: existente } = await supabase
        .from('disparo_exclusoes')
        .select('id, ativo')
        .eq('company_id', companyId)
        .eq('telefone_normalizado', validacao.normalizado)
        .maybeSingle()

      if (existente?.ativo) {
        resultados.duplicados += 1
        continue
      }

      if (existente && !existente.ativo) {
        await supabase
          .from('disparo_exclusoes')
          .update({
            ativo: true,
            motivo: motivoPadrao,
            origem: 'importacao',
            telefone_original: validacao.original,
            criado_por: userId,
            criado_em: agora,
            removido_por: null,
            removido_em: null,
          })
          .eq('id', existente.id)
          .eq('company_id', companyId)
        resultados.reativados += 1
        continue
      }

      const { error: insErr } = await supabase
        .from('disparo_exclusoes')
        .insert({
          company_id: companyId,
          telefone_normalizado: validacao.normalizado,
          telefone_original: validacao.original,
          motivo: motivoPadrao,
          origem: 'importacao',
          ativo: true,
          criado_por: userId,
        })
      if (insErr) {
        resultados.invalidos.push({ original: validacao.original, motivo: insErr.message })
        continue
      }
      resultados.adicionados += 1
    }

    res.json({
      ok: true,
      ...resultados,
      processados_com_sucesso: resultados.adicionados + resultados.reativados,
    })
  } catch (err) {
    console.error('[disparo:exclusoes] importar', err)
    res.status(500).json({ error: 'Erro ao importar exclusões.' })
  }
}

exports._parseTelefonesEntrada = parseTelefonesEntrada
