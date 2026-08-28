/**
 * Proteção persistente do nome do contato.
 *
 * A pontuação de nomeSource NÃO é a defesa: o nome importado/manual fica
 * marcado no banco (nome_protegido + nome_origem) e só muda com edição
 * autorizada ou nova importação confirmada.
 */

const { chooseBestName, normalizeName } = require('./contactEnrichment')

const ORIGEM_IMPORT_PLANILHA = 'import_planilha'
const ORIGEM_MANUAL = 'manual'
const ORIGENS_AUTORIZADAS = new Set([ORIGEM_IMPORT_PLANILHA, ORIGEM_MANUAL])

function clienteTemNomeProtegido(row) {
  if (!row) return false
  return row.nome_protegido === true || row.nome_protegido === 'true' || row.nome_protegido === 1
}

function origemAutorizada(origem) {
  return ORIGENS_AUTORIZADAS.has(String(origem || ''))
}

function origemDaFonte(nomeSource) {
  const s = String(nomeSource || '')
  if (s === ORIGEM_IMPORT_PLANILHA || s === 'import') return ORIGEM_IMPORT_PLANILHA
  if (s === ORIGEM_MANUAL) return ORIGEM_MANUAL
  return s || 'unknown'
}

/**
 * Gate explícito: nome protegido só muda por manual ou import_planilha.
 * Edição manual nunca é sobrescrita por importação sem confirmação explícita.
 */
function podeEscreverNome(existente, origemCandidata, opts = {}) {
  const origem = origemDaFonte(origemCandidata)
  if (!clienteTemNomeProtegido(existente)) {
    return { allowed: true, reason: 'nao_protegido' }
  }
  if (origem === ORIGEM_MANUAL) {
    return { allowed: true, reason: 'edicao_manual' }
  }
  if (origem === ORIGEM_IMPORT_PLANILHA) {
    const atual = String(existente?.nome_origem || '')
    if (atual === ORIGEM_MANUAL && opts.confirmarNomeManual !== true) {
      return { allowed: false, reason: 'manual_preservado' }
    }
    return { allowed: true, reason: 'import_confirmada' }
  }
  return { allowed: false, reason: 'protegido' }
}

function patchNomeAutorizado(nome, origem) {
  return {
    nome,
    nome_origem: origemDaFonte(origem),
    nome_protegido: true,
    nome_override: true,
  }
}

function patchNomeInsert(nome, origem) {
  const src = origemDaFonte(origem)
  if (!origemAutorizada(src) || !nome) {
    return nome ? { nome } : {}
  }
  return {
    nome,
    nome_origem: src,
    nome_protegido: true,
  }
}

/**
 * Decide o patch de nome (sem I/O). Foto/tags/pushname ficam fora.
 */
function decidirPatchNomeCliente(existente, candidato, nomeSource, opts = {}) {
  const origem = origemDaFonte(nomeSource)
  const cand = normalizeName(candidato)
  const gate = podeEscreverNome(existente, origem, opts)

  if (!gate.allowed) {
    return {
      patch: null,
      decision: 'kept',
      reason: gate.reason,
      nome: existente?.nome || null,
    }
  }

  const { name, decision } = chooseBestName(existente?.nome, cand, origem, {
    fromMe: opts.fromMe,
    company_id: opts.company_id,
    telefoneTail: opts.telefoneTail,
    nomeProtegido: clienteTemNomeProtegido(existente),
    nomeOrigem: existente?.nome_origem,
    confirmarNomeManual: opts.confirmarNomeManual,
  })

  const atual = existente?.nome != null ? String(existente.nome) : ''
  if (decision !== 'updated' || !name || name === atual) {
    if (origemAutorizada(origem) && existente && !clienteTemNomeProtegido(existente) && (existente.nome || name)) {
      const nomeFinal = name || existente.nome
      return {
        patch: {
          nome_origem: origem,
          nome_protegido: true,
          nome_override: true,
        },
        decision: 'protected',
        reason: 'marcar_protecao',
        nome: nomeFinal,
      }
    }
    return {
      patch: null,
      decision: decision || 'kept',
      reason: 'sem_mudanca',
      nome: existente?.nome || name || null,
    }
  }

  if (origemAutorizada(origem)) {
    return {
      patch: patchNomeAutorizado(name, origem),
      decision: 'updated',
      reason: gate.reason,
      nome: name,
    }
  }

  return {
    patch: { nome: name },
    decision: 'updated',
    reason: gate.reason,
    nome: name,
  }
}

function deveAtualizarNomeContatoCache(cliente, origemCandidata) {
  if (!clienteTemNomeProtegido(cliente)) return true
  return origemAutorizada(origemDaFonte(origemCandidata))
}

module.exports = {
  ORIGEM_IMPORT_PLANILHA,
  ORIGEM_MANUAL,
  ORIGENS_AUTORIZADAS,
  clienteTemNomeProtegido,
  origemAutorizada,
  origemDaFonte,
  podeEscreverNome,
  patchNomeAutorizado,
  patchNomeInsert,
  decidirPatchNomeCliente,
  deveAtualizarNomeContatoCache,
}
