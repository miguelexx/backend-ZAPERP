'use strict'

const supabase = require('../../config/supabase')
const orcamentoWmFlag = require('../../helpers/orcamentoWmFlag')
const { registrarEventoOrcamento, EVENTOS } = require('./wmOrcamentoAuditoria')

const TABELA = 'wm_orcamento_integracoes'
const VALIDACAO_STATUS = Object.freeze(['nao_validado', 'autorizado', 'negado', 'erro'])

/**
 * Configuração da integração WM por empresa (`wm_orcamento_integracoes`).
 *
 * REGRA DE OURO (D1 do doc 36): `telefone_autorizado` é segredo operacional. Fica em coluna de
 * TEXTO — não há criptografia de aplicação nesta codebase e não é esta frente que a introduz —
 * e a proteção é de acesso: só sai daqui por `obterTelefoneAutorizado`, que é para uso
 * server-side na chamada à WM. Nenhuma rota devolve esse valor e nada aqui o registra em log:
 * o único recorte exibível é `telefone_ultimos4`.
 *
 * Esse telefone é o CONTATO AUTORIZADO que resolve a instalação do lado da WM — não é o
 * telefone da conversa nem o do comprador (seção 4 do doc 36).
 *
 * Isolamento: o cliente Supabase usa SERVICE_ROLE e ignora RLS, então TODA query aqui filtra
 * `company_id` explicitamente, e o insert carrega `company_id` no payload. `company_id` vem
 * sempre do JWT — nunca de body/query.
 */

function normalizarCompanyId(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return null
  return cid
}

/** Só dígitos; os últimos 4 são o recorte exibível. */
function ultimos4(telefone) {
  const digitos = String(telefone ?? '').replace(/\D+/g, '')
  if (digitos.length < 4) return null
  return digitos.slice(-4)
}

/**
 * Recorte seguro para resposta de API: sem `telefone_autorizado`, sem `id` interno.
 * @param {object|null} row
 */
function sanitizarConfig(row) {
  if (!row) {
    return {
      configurado: false,
      ativo: false,
      telefone_ultimos4: null,
      validacao_status: 'nao_validado',
      validado_em: null,
      atualizado_em: null,
    }
  }
  return {
    configurado: true,
    ativo: !!row.ativo,
    telefone_ultimos4: row.telefone_ultimos4 ?? null,
    validacao_status: row.validacao_status ?? 'nao_validado',
    validado_em: row.validado_em ?? null,
    atualizado_em: row.atualizado_em ?? null,
  }
}

/**
 * Linha completa da empresa (uso INTERNO — contém o telefone autorizado).
 * @param {number} companyId
 * @returns {Promise<object|null>}
 */
async function obterConfigInterna(companyId) {
  const cid = normalizarCompanyId(companyId)
  if (!cid) return null
  const { data, error } = await supabase
    .from(TABELA)
    .select('id, company_id, ativo, telefone_autorizado, telefone_ultimos4, validado_em, validacao_status, provisionado_por, criado_em, atualizado_em')
    .eq('company_id', cid)
    .maybeSingle()
  if (error) {
    // Nunca ecoar o erro cru: a mensagem do PostgREST pode conter o valor da coluna.
    console.warn('[wmIntegrationConfigService] leitura indisponível para company_id', cid)
    return null
  }
  return data || null
}

/**
 * Configuração exibível (sem segredo). É o que qualquer rota pode devolver.
 * @param {number} companyId
 */
async function obterConfigPublica(companyId) {
  return sanitizarConfig(await obterConfigInterna(companyId))
}

/**
 * Telefone autorizado para uso server-side na chamada à WM. Nunca devolver ao navegador.
 * @param {number} companyId
 * @returns {Promise<string|null>}
 */
async function obterTelefoneAutorizado(companyId) {
  const row = await obterConfigInterna(companyId)
  const telefone = String(row?.telefone_autorizado ?? '').trim()
  return telefone.length > 0 ? telefone : null
}

/**
 * Cria ou atualiza o vínculo da empresa. Provisionamento é operação confiável, não admin de
 * tenant (seção 4 do doc 36) — esta função não é exposta por rota nesta sessão.
 *
 * Faz select → update/insert em vez de upsert para que a mutação carregue o filtro
 * `company_id` explícito; a UNIQUE em `company_id` continua sendo a garantia real.
 *
 * @param {object} opts
 * @param {number} opts.company_id         sempre do JWT
 * @param {string} [opts.telefone_autorizado] omitido = mantém o atual
 * @param {boolean} [opts.ativo]
 * @param {string} [opts.provisionado_por]
 * @returns {Promise<{ config?: object, error?: string }>}
 */
async function salvarConfig({ company_id, telefone_autorizado, ativo, provisionado_por } = {}) {
  const cid = normalizarCompanyId(company_id)
  if (!cid) return { error: 'company_id obrigatório' }

  const patch = { atualizado_em: new Date().toISOString() }
  if (telefone_autorizado !== undefined) {
    const telefone = String(telefone_autorizado ?? '').trim()
    if (telefone.length === 0) return { error: 'telefone_autorizado não pode ser vazio' }
    const quatro = ultimos4(telefone)
    if (!quatro) return { error: 'telefone_autorizado inválido' }
    patch.telefone_autorizado = telefone
    patch.telefone_ultimos4 = quatro
    // Telefone novo invalida a validação anterior.
    patch.validacao_status = 'nao_validado'
    patch.validado_em = null
  }
  if (ativo !== undefined) patch.ativo = !!ativo
  if (provisionado_por !== undefined) patch.provisionado_por = String(provisionado_por ?? '').trim() || null

  const existente = await obterConfigInterna(cid)

  if (existente) {
    const { data, error } = await supabase
      .from(TABELA)
      .update(patch)
      .eq('company_id', cid)
      .select('id, company_id, ativo, telefone_ultimos4, validado_em, validacao_status, provisionado_por, criado_em, atualizado_em')
      .maybeSingle()
    if (error) return { error: 'Não foi possível salvar a configuração.' }
    orcamentoWmFlag.invalidateOrcamentoWmCache(cid)
    return { config: sanitizarConfig(data) }
  }

  if (patch.telefone_autorizado === undefined) {
    return { error: 'telefone_autorizado obrigatório no primeiro provisionamento' }
  }

  const { data, error } = await supabase
    .from(TABELA)
    .insert({ ...patch, company_id: cid, ativo: patch.ativo === true })
    .select('id, company_id, ativo, telefone_ultimos4, validado_em, validacao_status, provisionado_por, criado_em, atualizado_em')
    .maybeSingle()
  if (error) return { error: 'Não foi possível salvar a configuração.' }
  orcamentoWmFlag.invalidateOrcamentoWmCache(cid)
  return { config: sanitizarConfig(data) }
}

/**
 * Registra o resultado da validação do telefone junto à WM (`acesso/validar`), que só é
 * chamada em provisionamento e diagnóstico — nunca por orçamento (seção 11 do doc 36).
 *
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {'autorizado'|'negado'|'erro'} opts.status
 * @param {number|null} [opts.usuario_id]
 */
async function registrarValidacao({ company_id, status, usuario_id = null } = {}) {
  const cid = normalizarCompanyId(company_id)
  if (!cid) return { error: 'company_id obrigatório' }
  if (!VALIDACAO_STATUS.includes(status) || status === 'nao_validado') {
    return { error: 'status de validação inválido' }
  }

  const { data, error } = await supabase
    .from(TABELA)
    .update({
      validacao_status: status,
      validado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    })
    .eq('company_id', cid)
    .select('id, company_id, ativo, telefone_ultimos4, validado_em, validacao_status, atualizado_em')
    .maybeSingle()
  if (error) return { error: 'Não foi possível registrar a validação.' }

  orcamentoWmFlag.invalidateOrcamentoWmCache(cid)
  await registrarEventoOrcamento({
    company_id: cid,
    usuario_id,
    acao: EVENTOS.CONFIG_VALIDADA,
    detalhes: { validacao_status: status, telefone_ultimos4: data?.telefone_ultimos4 ?? null },
  })
  return { config: sanitizarConfig(data) }
}

module.exports = {
  TABELA,
  VALIDACAO_STATUS,
  ultimos4,
  sanitizarConfig,
  obterConfigInterna,
  obterConfigPublica,
  obterTelefoneAutorizado,
  salvarConfig,
  registrarValidacao,
}
