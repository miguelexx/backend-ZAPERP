/**
 * Controller de Variações de Mensagem — módulo Disparo de Mensagens (Etapa 4).
 * CRUD de variações, upload de mídia, catálogo de variáveis, preview, distribuição e confirmação.
 * Nunca armazena base64 no banco; usa R2 (ou disco) para mídias.
 */

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const supabase = require('../config/supabase')
const { empresaUsaR2, getPresignExpiresSeconds } = require('../config/r2')
const { putObject, deleteObject, presignGetUrl } = require('../services/storage/r2Client')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function positiveInt(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
function cleanText(v, max = 5000) { return typeof v === 'string' ? v.slice(0, max) : '' }

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' }); return false
  }
  return true
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select('id, status, company_id, variacao_modo, variacao_confirmada, variacao_revisao, variacao_padrao_valores')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) { res.status(404).json({ error: 'Campanha não encontrada.' }); return null }
  return data
}

function statusPermiteEdicao(status) { return status === 'rascunho' || status === 'configurando' }

const MODOS_VARIACAO = new Set(['unica', 'equilibrada', 'percentual', 'manual'])
const TIPOS_MENSAGEM = new Set(['texto', 'imagem', 'video', 'audio', 'documento'])
const BATCH_SIZE = 500

/** Variáveis proibidas (proteção contra acesso a propriedades de objeto). */
const VAR_BLACKLIST = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'])

/** Normaliza o nome de uma variável para chave segura e consistente. */
function normalizarChaveVar(chave) {
  return String(chave ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

/** Substitui variáveis {{chave}} de um texto usando os dados do destinatário e os padrões. */
function substituirVariaveis(texto, destinatario, valoresPadrao = {}) {
  if (!texto || typeof texto !== 'string') return texto
  return texto.replace(/\{\{([^{}]{1,100})\}\}/g, (match, rawChave) => {
    const chave = normalizarChaveVar(rawChave)
    if (!chave || VAR_BLACKLIST.has(chave)) return `[${rawChave}?]`
    // Fontes em ordem de precedência: variaveis JSONB > nome/telefone > padrão da campanha
    const vars = {
      nome: String(destinatario.nome ?? ''),
      telefone: String(destinatario.telefone_normalizado ?? ''),
      ...(destinatario.variaveis ?? {}),
    }
    const valor = vars[chave] ?? valoresPadrao[chave] ?? valoresPadrao[rawChave.trim().toLowerCase()]
    if (valor !== undefined && valor !== null && String(valor) !== '') return String(valor)
    // Fallback padrão normalizado
    const chaveAlt = normalizarChaveVar(rawChave)
    const valorAlt = valoresPadrao[chaveAlt]
    if (valorAlt !== undefined && valorAlt !== null && String(valorAlt) !== '') return String(valorAlt)
    // Nunca retorna {{variavel}} em produção — retorna marcador visível para auditoria
    return `[${chave || rawChave}?]`
  })
}

/** Extrai nomes de variáveis {{chave}} usadas em um texto. */
function extrairVariaveisUsadas(texto) {
  const regex = /\{\{([^{}]{1,100})\}\}/g
  const vars = new Set()
  let m
  while ((m = regex.exec(texto || '')) !== null) {
    const chave = normalizarChaveVar(m[1])
    if (chave && !VAR_BLACKLIST.has(chave)) vars.add(chave)
  }
  return [...vars]
}

// ─── Armazenamento de mídia ────────────────────────────────────────────────────

/** Retorna URL acessível para uma variação (R2 presign ou caminho de disco). */
function buildMidiaUrl(variacao) {
  if (variacao.midia_storage_key) {
    return `/media/r2/${variacao.midia_storage_key}`
  }
  if (variacao.midia_url_disco) {
    return `/uploads/${variacao.midia_url_disco}`
  }
  return null
}

async function salvarMidiaVariacao(companyId, campanhaId, variacaoId, midiaInfo) {
  if (!midiaInfo) return { storage_key: null, url_disco: null }
  const { buffer, nomeOriginal, mime, ext, tamanho } = midiaInfo
  const uuid = crypto.randomBytes(12).toString('hex')
  const nomeArquivo = `${uuid}${ext ? '.' + ext : ''}`

  if (empresaUsaR2(companyId)) {
    const key = `media/disparo/${companyId}/${campanhaId}/${variacaoId}/${nomeArquivo}`
    await putObject(key, buffer, mime || 'application/octet-stream')
    return { storage_key: key, url_disco: null }
  }

  // Fallback: disco local
  const { getUploadsRoot } = require('../config/uploadsRoot')
  const dir = path.join(getUploadsRoot(), 'disparo', String(companyId), String(campanhaId), String(variacaoId))
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, nomeArquivo)
  fs.writeFileSync(filePath, buffer)
  const relPath = path.join('disparo', String(companyId), String(campanhaId), String(variacaoId), nomeArquivo).replace(/\\/g, '/')
  return { storage_key: null, url_disco: relPath }
}

async function removerMidiaVariacao(variacao) {
  try {
    if (variacao.midia_storage_key) {
      await deleteObject(variacao.midia_storage_key)
    } else if (variacao.midia_url_disco) {
      const { getUploadsRoot } = require('../config/uploadsRoot')
      const p = path.join(getUploadsRoot(), variacao.midia_url_disco)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
  } catch (e) {
    console.warn('[disparo:variacoes] removerMidia falhou silenciosamente:', e?.message)
  }
}

// ─── Seleção pública dos campos (sem expor caminhos internos) ─────────────────

function formatarVariacao(v) {
  return {
    id: v.id,
    campanha_id: v.campanha_id,
    nome: v.nome,
    tipo_mensagem: v.tipo_mensagem,
    texto: v.texto,
    legenda: v.legenda,
    midia_url: buildMidiaUrl(v),
    midia_nome_original: v.midia_nome_original,
    midia_mime: v.midia_mime,
    midia_tamanho: v.midia_tamanho,
    ordem: v.ordem,
    peso: v.peso,
    percentual: v.percentual,
    ativa: v.ativa,
    criado_por: v.criado_por,
    criado_em: v.criado_em,
    atualizado_em: v.atualizado_em,
  }
}

// ─── 1. Listar variações ──────────────────────────────────────────────────────

exports.listarVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { data, error } = await supabase
      .from('disparo_campanha_variacoes')
      .select('*')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .order('ordem', { ascending: true })
      .order('id', { ascending: true })
    if (error) throw error

    res.json({ variacoes: (data ?? []).map(formatarVariacao), campanha })
  } catch (e) { console.error('[disparo:variacoes] listarVariacoes', e); res.status(500).json({ error: 'Erro ao listar variações.' }) }
}

// ─── 2. Criar variação ────────────────────────────────────────────────────────

exports.criarVariacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível criar variação nesta fase.' })

    const tipo = String(req.body.tipo_mensagem || 'texto').trim()
    if (!TIPOS_MENSAGEM.has(tipo)) return res.status(400).json({ error: `Tipo inválido. Use: ${[...TIPOS_MENSAGEM].join(', ')}.` })

    // Próxima ordem
    const { count } = await supabase.from('disparo_campanha_variacoes')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId).eq('company_id', companyId)

    const nome = cleanText(req.body.nome || `Variação ${String.fromCharCode(65 + (count || 0))}`, 100)
    const row = {
      company_id: companyId,
      campanha_id: campanhaId,
      nome,
      tipo_mensagem: tipo,
      texto: cleanText(req.body.texto || '', 5000) || null,
      legenda: cleanText(req.body.legenda || '', 1024) || null,
      ordem: (count ?? 0),
      peso: Math.max(0.01, Number(req.body.peso) || 100),
      ativa: true,
      criado_por: req.user.id ?? null,
    }

    const { data, error } = await supabase.from('disparo_campanha_variacoes').insert(row).select('*').single()
    if (error) throw error

    await marcarRevisaoVariacoes(campanhaId, companyId, campanha)

    res.status(201).json(formatarVariacao(data))
  } catch (e) { console.error('[disparo:variacoes] criarVariacao', e); res.status(500).json({ error: 'Erro ao criar variação.' }) }
}

// ─── 3. Editar variação ───────────────────────────────────────────────────────

exports.editarVariacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const varId = positiveInt(req.params.varId)
    if (!campanhaId || !varId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível editar variação nesta fase.' })

    const existing = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!existing) return res.status(404).json({ error: 'Variação não encontrada.' })

    const updates = {}
    if (req.body.nome !== undefined) updates.nome = cleanText(req.body.nome, 100)
    if (req.body.texto !== undefined) updates.texto = cleanText(req.body.texto, 5000) || null
    if (req.body.legenda !== undefined) updates.legenda = cleanText(req.body.legenda, 1024) || null
    if (req.body.tipo_mensagem !== undefined) {
      if (!TIPOS_MENSAGEM.has(req.body.tipo_mensagem)) return res.status(400).json({ error: 'Tipo inválido.' })
      updates.tipo_mensagem = req.body.tipo_mensagem
    }
    if (req.body.peso !== undefined) updates.peso = Math.max(0.01, Number(req.body.peso) || 100)
    if (req.body.percentual !== undefined) updates.percentual = req.body.percentual === null ? null : Math.max(0, Math.min(100, Number(req.body.percentual)))
    if (req.body.ativa !== undefined) updates.ativa = Boolean(req.body.ativa)
    updates.atualizado_em = new Date().toISOString()

    const { data, error } = await supabase.from('disparo_campanha_variacoes')
      .update(updates).eq('id', varId).eq('campanha_id', campanhaId).eq('company_id', companyId)
      .select('*').single()
    if (error) throw error

    await marcarRevisaoVariacoes(campanhaId, companyId, campanha)

    res.json(formatarVariacao(data))
  } catch (e) { console.error('[disparo:variacoes] editarVariacao', e); res.status(500).json({ error: 'Erro ao editar variação.' }) }
}

// ─── 4. Duplicar variação ─────────────────────────────────────────────────────

exports.duplicarVariacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const varId = positiveInt(req.params.varId)
    if (!campanhaId || !varId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível duplicar nesta fase.' })

    const original = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!original) return res.status(404).json({ error: 'Variação não encontrada.' })

    const { count } = await supabase.from('disparo_campanha_variacoes')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId).eq('company_id', companyId)

    const copia = {
      company_id: companyId,
      campanha_id: campanhaId,
      nome: `${original.nome} (cópia)`.slice(0, 100),
      tipo_mensagem: original.tipo_mensagem,
      texto: original.texto,
      legenda: original.legenda,
      // Mídia: apenas referencia a mesma chave (não duplica o arquivo)
      midia_storage_key: original.midia_storage_key,
      midia_url_disco: original.midia_url_disco,
      midia_nome_original: original.midia_nome_original,
      midia_mime: original.midia_mime,
      midia_tamanho: original.midia_tamanho,
      ordem: count ?? 0,
      peso: original.peso,
      percentual: null,
      ativa: true,
      criado_por: req.user.id ?? null,
    }

    const { data, error } = await supabase.from('disparo_campanha_variacoes').insert(copia).select('*').single()
    if (error) throw error

    res.status(201).json(formatarVariacao(data))
  } catch (e) { console.error('[disparo:variacoes] duplicarVariacao', e); res.status(500).json({ error: 'Erro ao duplicar.' }) }
}

// ─── 5. Excluir variação ──────────────────────────────────────────────────────

exports.excluirVariacao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const varId = positiveInt(req.params.varId)
    if (!campanhaId || !varId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível excluir nesta fase.' })

    const existing = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!existing) return res.status(404).json({ error: 'Variação não encontrada.' })

    // Verifica se algum destinatário a referencia
    const { count: usadas } = await supabase.from('disparo_campanha_destinatarios')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId).eq('company_id', companyId).eq('variacao_id', varId)
    if ((usadas ?? 0) > 0) {
      return res.status(422).json({
        error: `Esta variação está atribuída a ${usadas} destinatário(s). Redistribua antes de excluir.`,
        usadas,
      })
    }

    const { error } = await supabase.from('disparo_campanha_variacoes')
      .delete().eq('id', varId).eq('campanha_id', campanhaId).eq('company_id', companyId)
    if (error) throw error

    // Remove mídia se não houver mais referências (a cópia também apagaria... verificar)
    // Para segurança, só remove se storage_key for único
    if (existing.midia_storage_key) {
      const { count: refs } = await supabase.from('disparo_campanha_variacoes')
        .select('id', { count: 'exact', head: true })
        .eq('campanha_id', campanhaId).eq('midia_storage_key', existing.midia_storage_key)
      if ((refs ?? 0) === 0) await removerMidiaVariacao(existing)
    } else if (existing.midia_url_disco) {
      await removerMidiaVariacao(existing)
    }

    await marcarRevisaoVariacoes(campanhaId, companyId, campanha)

    res.json({ ok: true })
  } catch (e) { console.error('[disparo:variacoes] excluirVariacao', e); res.status(500).json({ error: 'Erro ao excluir.' }) }
}

// ─── 6. Reordenar variações ───────────────────────────────────────────────────

exports.reordenarVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const ordem = Array.isArray(req.body.ordem) ? req.body.ordem : []
    for (let i = 0; i < ordem.length; i++) {
      const id = positiveInt(ordem[i])
      if (!id) continue
      await supabase.from('disparo_campanha_variacoes')
        .update({ ordem: i, atualizado_em: new Date().toISOString() })
        .eq('id', id).eq('campanha_id', campanhaId).eq('company_id', companyId)
    }
    res.json({ ok: true })
  } catch (e) { console.error('[disparo:variacoes] reordenarVariacoes', e); res.status(500).json({ error: 'Erro ao reordenar.' }) }
}

// ─── 7. Upload de mídia ───────────────────────────────────────────────────────

exports.uploadMidia = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const varId = positiveInt(req.params.varId)
    if (!campanhaId || !varId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível alterar mídia nesta fase.' })

    if (!req.disparoMidia) return res.status(400).json({ error: 'Nenhum arquivo enviado.' })

    const { nomeOriginal, mime, tamanho, tipoMensagem, ext } = req.disparoMidia

    // Busca variação existente para remover mídia antiga
    const existing = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!existing) return res.status(404).json({ error: 'Variação não encontrada.' })
    if (existing.midia_storage_key || existing.midia_url_disco) {
      await removerMidiaVariacao(existing)
    }

    const { storage_key, url_disco } = await salvarMidiaVariacao(companyId, campanhaId, varId, req.disparoMidia)

    const { data, error } = await supabase.from('disparo_campanha_variacoes')
      .update({
        tipo_mensagem: tipoMensagem,
        midia_storage_key: storage_key,
        midia_url_disco: url_disco,
        midia_nome_original: nomeOriginal,
        midia_mime: mime,
        midia_tamanho: tamanho,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', varId).eq('campanha_id', campanhaId).eq('company_id', companyId)
      .select('*').single()
    if (error) throw error

    res.json(formatarVariacao(data))
  } catch (e) { console.error('[disparo:variacoes] uploadMidia', e); res.status(500).json({ error: 'Erro ao fazer upload.' }) }
}

// ─── 8. Remover mídia ─────────────────────────────────────────────────────────

exports.removerMidia = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const varId = positiveInt(req.params.varId)
    if (!campanhaId || !varId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível remover mídia nesta fase.' })

    const existing = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!existing) return res.status(404).json({ error: 'Variação não encontrada.' })

    await removerMidiaVariacao(existing)

    const { data, error } = await supabase.from('disparo_campanha_variacoes')
      .update({
        midia_storage_key: null, midia_url_disco: null,
        midia_nome_original: null, midia_mime: null, midia_tamanho: null,
        tipo_mensagem: 'texto', atualizado_em: new Date().toISOString(),
      })
      .eq('id', varId).eq('campanha_id', campanhaId).eq('company_id', companyId)
      .select('*').single()
    if (error) throw error

    res.json(formatarVariacao(data))
  } catch (e) { console.error('[disparo:variacoes] removerMidia', e); res.status(500).json({ error: 'Erro ao remover mídia.' }) }
}

// ─── 9. Catálogo de variáveis ─────────────────────────────────────────────────

exports.catalogoVariaveis = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    // Total de destinatários ativos
    const { count: total } = await supabase.from('disparo_campanha_destinatarios')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')

    // Amostra de destinatários para extrair chaves do JSONB variaveis
    const { data: amostra } = await supabase.from('disparo_campanha_destinatarios')
      .select('nome, telefone_normalizado, variaveis')
      .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')
      .not('variaveis', 'is', null).limit(500)

    // Coleta todas as chaves únicas do JSONB
    const chaveInfo = {}
    for (const d of amostra ?? []) {
      if (!d.variaveis || typeof d.variaveis !== 'object') continue
      for (const [k, v] of Object.entries(d.variaveis)) {
        const cn = normalizarChaveVar(k)
        if (!cn || VAR_BLACKLIST.has(cn)) continue
        if (!chaveInfo[cn]) chaveInfo[cn] = { chave: cn, exemplo: null, total_com_valor: 0 }
        if (v !== null && v !== '') {
          chaveInfo[cn].total_com_valor++
          if (!chaveInfo[cn].exemplo) chaveInfo[cn].exemplo = String(v).slice(0, 100)
        }
      }
    }

    // Variáveis do sistema sempre disponíveis
    const vars = [
      { chave: 'nome', descricao: 'Nome do destinatário', sistema: true, total_com_valor: total ?? 0, sem_valor: 0, exemplo: amostra?.[0]?.nome ?? null },
      { chave: 'telefone', descricao: 'Número de telefone normalizado', sistema: true, total_com_valor: total ?? 0, sem_valor: 0, exemplo: amostra?.[0]?.telefone_normalizado ?? null },
      ...Object.values(chaveInfo).map(cv => ({
        ...cv,
        sistema: false,
        sem_valor: Math.max(0, (total ?? 0) - cv.total_com_valor),
      })),
    ]

    res.json({
      variaveis: vars,
      total_destinatarios: total ?? 0,
      valores_padrao: campanha.variacao_padrao_valores ?? {},
    })
  } catch (e) { console.error('[disparo:variacoes] catalogoVariaveis', e); res.status(500).json({ error: 'Erro ao carregar catálogo.' }) }
}

// ─── 10. Destinatários sem determinada variável ───────────────────────────────

exports.destinatariosSemVariavel = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const chaveRaw = String(req.params.chave ?? req.query.chave ?? '').trim()
    if (!campanhaId || !chaveRaw) return res.status(400).json({ error: 'Parâmetros inválidos.' })
    const chave = normalizarChaveVar(chaveRaw)
    if (!chave || VAR_BLACKLIST.has(chave)) return res.status(400).json({ error: 'Nome de variável inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Number(req.query.limit) || 30)

    // Sistema: nome e telefone sempre têm valor
    if (chave === 'nome' || chave === 'telefone') {
      return res.json({ destinatarios: [], total: 0, chave })
    }

    const { data, count } = await supabase.from('disparo_campanha_destinatarios')
      .select('id, nome, telefone_normalizado', { count: 'exact' })
      .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')
      .or(`variaveis.is.null,variaveis->>${chave}.is.null`)
      .order('id').range((page - 1) * limit, page * limit - 1)

    res.json({ destinatarios: data ?? [], total: count ?? 0, chave, page, limit })
  } catch (e) { console.error('[disparo:variacoes] destinatariosSemVariavel', e); res.status(500).json({ error: 'Erro.' }) }
}

// ─── 11. Definir valores padrão ───────────────────────────────────────────────

exports.salvarValoresPadrao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível alterar padrões nesta fase.' })

    const body = req.body?.valores ?? req.body ?? {}
    if (typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Formato inválido.' })

    // Valida e limpa cada par chave/valor
    const padrao = {}
    for (const [k, v] of Object.entries(body)) {
      const cn = normalizarChaveVar(k)
      if (!cn || VAR_BLACKLIST.has(cn)) continue
      padrao[cn] = String(v ?? '').slice(0, 500)
    }

    await supabase.from('disparo_campanhas')
      .update({ variacao_padrao_valores: padrao, atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId).eq('company_id', companyId)

    res.json({ ok: true, valores_padrao: padrao })
  } catch (e) { console.error('[disparo:variacoes] salvarValoresPadrao', e); res.status(500).json({ error: 'Erro ao salvar padrões.' }) }
}

// ─── 12. Preview para um destinatário ────────────────────────────────────────

exports.previewDestinatario = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const destId = positiveInt(req.params.destId)
    if (!campanhaId || !destId) return res.status(400).json({ error: 'IDs inválidos.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { data: dest } = await supabase.from('disparo_campanha_destinatarios')
      .select('id, nome, telefone_normalizado, variaveis, variacao_id, instancia_id')
      .eq('id', destId).eq('campanha_id', campanhaId).eq('company_id', companyId).maybeSingle()
    if (!dest) return res.status(404).json({ error: 'Destinatário não encontrado.' })

    const variacaoId = positiveInt(req.query.variacao_id) || dest.variacao_id
    let variacao = null
    if (variacaoId) {
      variacao = await obterVariacaoPorId(variacaoId, campanhaId, companyId)
    }

    const padrao = campanha.variacao_padrao_valores ?? {}
    const textoOriginal = variacao?.texto ?? ''
    const legendaOriginal = variacao?.legenda ?? ''
    const textoSubstituido = substituirVariaveis(textoOriginal, dest, padrao)
    const legendaSubstituida = substituirVariaveis(legendaOriginal, dest, padrao)

    const varsUsadasTexto = extrairVariaveisUsadas(textoOriginal)
    const varsUsadasLegenda = extrairVariaveisUsadas(legendaOriginal)
    const varsUsadas = [...new Set([...varsUsadasTexto, ...varsUsadasLegenda])]

    const varsAusentes = varsUsadas.filter(chave => {
      if (chave === 'nome' || chave === 'telefone') return false
      const vars = { ...dest.variaveis }
      return !(vars[chave] || padrao[chave])
    })

    res.json({
      destinatario: { id: dest.id, nome: dest.nome, telefone: dest.telefone_normalizado },
      variacao: variacao ? formatarVariacao(variacao) : null,
      texto_original: textoOriginal,
      texto_substituido: textoSubstituido,
      legenda_original: legendaOriginal,
      legenda_substituida: legendaSubstituida,
      variaveis_usadas: varsUsadas,
      variaveis_ausentes: varsAusentes,
      instancia_id: dest.instancia_id,
    })
  } catch (e) { console.error('[disparo:variacoes] previewDestinatario', e); res.status(500).json({ error: 'Erro ao gerar preview.' }) }
}

// ─── 13. Preview de distribuição das variações ───────────────────────────────

exports.previewDistribuicaoVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const modo = String(req.body.modo ?? '').trim()
    if (!MODOS_VARIACAO.has(modo)) return res.status(400).json({ error: `Modo inválido. Use: ${[...MODOS_VARIACAO].join(', ')}.` })

    const configuracoes = Array.isArray(req.body.configuracoes) ? req.body.configuracoes : []
    const { plano, erros } = await calcularPreviewVariacoes(campanhaId, companyId, modo, configuracoes)

    res.json({ plano, erros, modo })
  } catch (e) { console.error('[disparo:variacoes] previewDistribuicao', e); res.status(500).json({ error: 'Erro ao calcular preview.' }) }
}

// ─── 14. Confirmar distribuição das variações ────────────────────────────────

exports.confirmarDistribuicaoVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível confirmar nesta fase.' })

    const modo = String(req.body.modo ?? '').trim()
    if (!MODOS_VARIACAO.has(modo)) return res.status(400).json({ error: `Modo inválido.` })

    const configuracoes = Array.isArray(req.body.configuracoes) ? req.body.configuracoes : []
    const { plano, erros } = await calcularPreviewVariacoes(campanhaId, companyId, modo, configuracoes)

    if (erros.length) return res.status(422).json({ error: erros[0], erros, plano })
    if ((plano.sem_variacao ?? 0) > 0 && modo !== 'manual') {
      return res.status(422).json({ error: `${plano.sem_variacao} destinatário(s) sem variação.`, plano, erros })
    }

    await aplicarDistribuicaoVariacoes(campanhaId, companyId, modo, plano, configuracoes)

    await supabase.from('disparo_campanhas')
      .update({ variacao_modo: modo, variacao_confirmada: true, variacao_revisao: false, status: 'configurando', atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId).eq('company_id', companyId)

    res.json({ ok: true, plano, modo })
  } catch (e) { console.error('[disparo:variacoes] confirmarDistribuicao', e); res.status(500).json({ error: 'Erro ao confirmar.' }) }
}

// ─── 15. Atribuição manual de variação ───────────────────────────────────────

exports.atribuirVariacaoManual = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível atribuir nesta fase.' })

    const varId = positiveInt(req.body.variacao_id)
    if (!varId) return res.status(400).json({ error: 'variacao_id inválido.' })
    const destIds = (Array.isArray(req.body.destinatario_ids) ? req.body.destinatario_ids : []).map(positiveInt).filter(Boolean)
    if (!destIds.length) return res.status(400).json({ error: 'Nenhum destinatário informado.' })

    const varOk = await obterVariacaoPorId(varId, campanhaId, companyId)
    if (!varOk) return res.status(400).json({ error: 'Variação não pertence a esta campanha.' })

    for (let i = 0; i < destIds.length; i += BATCH_SIZE) {
      await supabase.from('disparo_campanha_destinatarios')
        .update({ variacao_id: varId })
        .in('id', destIds.slice(i, i + BATCH_SIZE))
        .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')
    }

    res.json({ atribuidos: destIds.length })
  } catch (e) { console.error('[disparo:variacoes] atribuirManual', e); res.status(500).json({ error: 'Erro ao atribuir.' }) }
}

// ─── 16. Resumo das mensagens ─────────────────────────────────────────────────

exports.resumoMensagens = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const [{ data: variacoes }, { count: total }, { data: contagens }] = await Promise.all([
      supabase.from('disparo_campanha_variacoes').select('*')
        .eq('campanha_id', campanhaId).eq('company_id', companyId)
        .order('ordem').order('id'),
      supabase.from('disparo_campanha_destinatarios').select('id', { count: 'exact', head: true })
        .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido'),
      supabase.from('disparo_campanha_destinatarios').select('variacao_id')
        .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido'),
    ])

    const contagemMap = (contagens ?? []).reduce((m, r) => {
      const k = r.variacao_id ?? '__sem_variacao__'
      m.set(k, (m.get(k) ?? 0) + 1); return m
    }, new Map())

    const totalN = total ?? 0
    const variacoesResumo = (variacoes ?? []).map(v => ({
      ...formatarVariacao(v),
      destinatarios_atribuidos: contagemMap.get(v.id) ?? 0,
      percentual_real: totalN > 0 ? +((contagemMap.get(v.id) ?? 0) / totalN * 100).toFixed(1) : 0,
    }))

    res.json({
      total_destinatarios: totalN,
      sem_variacao: contagemMap.get('__sem_variacao__') ?? 0,
      variacao_confirmada: campanha.variacao_confirmada,
      variacao_revisao: campanha.variacao_revisao,
      variacao_modo: campanha.variacao_modo,
      variacoes: variacoesResumo,
    })
  } catch (e) { console.error('[disparo:variacoes] resumo', e); res.status(500).json({ error: 'Erro ao gerar resumo.' }) }
}

// ─── 17. Recalcular distribuição ──────────────────────────────────────────────

exports.recalcularDistribuicaoVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID inválido.' })
    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) return res.status(422).json({ error: 'Não é possível recalcular nesta fase.' })

    await supabase.from('disparo_campanha_destinatarios')
      .update({ variacao_id: null })
      .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')

    await supabase.from('disparo_campanhas')
      .update({ variacao_confirmada: false, variacao_revisao: false, atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId).eq('company_id', companyId)

    res.json({ ok: true })
  } catch (e) { console.error('[disparo:variacoes] recalcular', e); res.status(500).json({ error: 'Erro.' }) }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

async function obterVariacaoPorId(id, campanhaId, companyId) {
  const { data } = await supabase.from('disparo_campanha_variacoes')
    .select('*').eq('id', id).eq('campanha_id', campanhaId).eq('company_id', companyId).maybeSingle()
  return data
}

async function marcarRevisaoVariacoes(campanhaId, companyId, campanha) {
  if (campanha?.variacao_confirmada) {
    await supabase.from('disparo_campanhas')
      .update({ variacao_revisao: true, atualizado_em: new Date().toISOString() })
      .eq('id', campanhaId).eq('company_id', companyId).eq('variacao_confirmada', true)
  }
}

// ─── Algoritmos de distribuição das variações ─────────────────────────────────

async function calcularPreviewVariacoes(campanhaId, companyId, modo, configuracoes) {
  const erros = []
  const { count: total } = await supabase.from('disparo_campanha_destinatarios')
    .select('id', { count: 'exact', head: true })
    .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')
  const N = total ?? 0

  const { data: variacoes } = await supabase.from('disparo_campanha_variacoes')
    .select('id, nome, tipo_mensagem, ativa, ordem')
    .eq('campanha_id', campanhaId).eq('company_id', companyId).eq('ativa', true)
    .order('ordem').order('id')

  const ativas = variacoes ?? []
  if (!ativas.length) { erros.push('Crie pelo menos uma variação ativa.'); return { plano: { total: N, variacoes: [], sem_variacao: N }, erros } }

  const configMap = new Map((configuracoes ?? []).map(c => [Number(c.variacao_id), c]))
  let dist = new Map()

  if (modo === 'unica') {
    const vid = ativas[0].id
    dist.set(vid, N)
    ativas.slice(1).forEach(v => dist.set(v.id, 0))
  } else if (modo === 'equilibrada') {
    const base = Math.floor(N / ativas.length), extras = N % ativas.length
    ativas.forEach((v, i) => dist.set(v.id, base + (i < extras ? 1 : 0)))
  } else if (modo === 'percentual') {
    const { dist: d, errosP } = distribuirPercentualVar(ativas, N, configMap)
    dist = d; erros.push(...errosP)
  } else {
    ativas.forEach(v => dist.set(v.id, 0)) // manual: mostra estado atual
    const { data: atuais } = await supabase.from('disparo_campanha_destinatarios')
      .select('variacao_id').eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')
    for (const d of atuais ?? []) if (d.variacao_id) dist.set(d.variacao_id, (dist.get(d.variacao_id) ?? 0) + 1)
  }

  const atribuidos = [...dist.values()].reduce((s, v) => s + v, 0)
  const variacoesPlano = ativas.map(v => ({
    variacao_id: v.id,
    nome: v.nome,
    tipo_mensagem: v.tipo_mensagem,
    quantidade: dist.get(v.id) ?? 0,
    percentual: N > 0 ? +((dist.get(v.id) ?? 0) / N * 100).toFixed(1) : 0,
  }))

  return { plano: { total: N, atribuidos, sem_variacao: N - atribuidos, variacoes: variacoesPlano, modo }, erros }
}

function distribuirPercentualVar(ativas, total, configMap) {
  const erros = []
  const soma = ativas.reduce((s, v) => s + (Number(configMap.get(v.id)?.percentual) || 0), 0)
  if (Math.abs(soma - 100) > 0.01) erros.push(`A soma dos percentuais (${soma.toFixed(2)}%) deve ser exatamente 100%.`)

  const floors = ativas.map(v => {
    const pct = Number(configMap.get(v.id)?.percentual) || 0
    return { id: v.id, pct, qtd: Math.floor(total * pct / 100) }
  })
  const somaFloor = floors.reduce((s, f) => s + f.qtd, 0)
  const resto = total - somaFloor
  const sorted = [...floors].sort((a, b) => (b.pct * total / 100 - b.qtd) - (a.pct * total / 100 - a.qtd))
  sorted.forEach((f, i) => { f.qtd += (i < resto ? 1 : 0) })

  const dist = new Map(floors.map(f => [f.id, f.qtd]))
  return { dist, errosP: erros }
}

async function aplicarDistribuicaoVariacoes(campanhaId, companyId, modo, plano, configuracoes) {
  if (modo === 'manual') return

  await supabase.from('disparo_campanha_destinatarios')
    .update({ variacao_id: null })
    .eq('campanha_id', campanhaId).eq('company_id', companyId).neq('status', 'excluido')

  const { data: livres } = await supabase.from('disparo_campanha_destinatarios')
    .select('id').eq('campanha_id', campanhaId).eq('company_id', companyId)
    .neq('status', 'excluido').is('variacao_id', null).order('id')

  const ids = (livres ?? []).map(r => r.id)
  let offset = 0

  for (const vp of plano.variacoes ?? []) {
    if (vp.quantidade <= 0) continue
    const chunk = ids.slice(offset, offset + vp.quantidade)
    offset += vp.quantidade
    if (!chunk.length) continue
    for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
      await supabase.from('disparo_campanha_destinatarios')
        .update({ variacao_id: vp.variacao_id })
        .in('id', chunk.slice(i, i + BATCH_SIZE))
        .eq('campanha_id', campanhaId).eq('company_id', companyId)
    }
  }
}

// ─── Hook: revisão ao alterar destinatários ───────────────────────────────────
exports._marcarRevisaoVariacoes = marcarRevisaoVariacoes
exports._substituirVariaveis = substituirVariaveis
exports._extrairVariaveisUsadas = extrairVariaveisUsadas
