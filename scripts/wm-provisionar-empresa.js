'use strict'

/**
 * Provisiona o vínculo `company_id` → telefone autorizado da WM (ERP Icthus).
 *
 * POR QUE ISTO É UM SCRIPT, E NÃO UMA ROTA
 * ----------------------------------------
 * Decisão D7 do doc 36 (`docs/ai-handoff/36-ORCAMENTO-WM-INTEGRACAO.md`): `orcamentos.configurar`
 * NÃO existe no catálogo de permissões e nunca vai existir. O `ZAPERP_API_TOKEN` alcança
 * QUALQUER empresa cadastrada na WM e o telefone enviado é o ÚNICO seletor de tenant
 * (pendência 13 da seção 10 — a WM declara que não fornece prova de vínculo). Um admin de
 * tenant que pudesse digitar esse telefone leria o ERP de outra empresa. Logo: provisionamento é
 * operação confiável, à mão, por quem tem o `.env` — nunca superfície HTTP.
 *
 * O caminho alternativo, para quem trabalha no Supabase Editor, é o bloco SQL documentado em
 * `docs/ai-handoff/36-ANEXO-B-PROVISIONAMENTO.md`. A diferença é só esta: pelo SQL **não há
 * validação contra a WM** — use o SQL quando a validação já foi feita.
 *
 * USO
 * ---
 *   # 1) primeiro provisionamento: valida na WM e grava DESATIVADO
 *   node scripts/wm-provisionar-empresa.js --company-id=1 --telefone=5534991847800 \
 *        --por="miguel/suporte" --confirmar
 *
 *   # ensaio sem gravar (valida empresa, formato e WM)
 *   node scripts/wm-provisionar-empresa.js --company-id=1 --telefone=5534991847800 \
 *        --por="miguel/suporte" --dry-run
 *
 *   # 2) ativar — segundo passo consciente; revalida o telefone já gravado
 *   node scripts/wm-provisionar-empresa.js --company-id=1 --por="miguel/suporte" \
 *        --ativar --confirmar
 *
 *   # desligar a empresa sem perder histórico
 *   node scripts/wm-provisionar-empresa.js --company-id=1 --por="miguel/suporte" \
 *        --desativar --sem-validar --confirmar
 *
 * OPÇÕES
 *   --company-id=N   OBRIGATÓRIO. Empresa do ZapERP. Conferida antes de qualquer outra coisa.
 *   --por=TEXTO      OBRIGATÓRIO. Quem está provisionando (vai para `provisionado_por`).
 *                    Argumento de linha de comando de propósito: nada de env nova para isto.
 *   --telefone=T     Contato autorizado da WM, 8 a 30 caracteres, como a WM o aceita. NÃO é o
 *                    telefone da conversa nem o do comprador. Omitido = mantém o já gravado.
 *   --ativar         Liga a empresa (`ativo=true`). Sem ela o vínculo nasce DESATIVADO.
 *   --desativar      Desliga a empresa (`ativo=false`). Não apaga nada.
 *   --confirmar      Sem ela NADA é gravado. Não há confirmação interativa: este script roda em
 *                    terminal não interativo (PM2, SSH, CI).
 *   --dry-run        Valida tudo e não grava, mesmo com `--confirmar`.
 *   --sem-validar    Pula a chamada `acesso/validar` e grava com `validacao_status` =
 *                    'nao_validado'. Só para quando a WM está indisponível ou a validação foi
 *                    feita por outro meio. Avisa em letras maiúsculas.
 *
 * O QUE ELE FAZ, NESTA ORDEM
 *   1. valida os argumentos (company_id e formato do telefone) — sem tocar em rede nem banco;
 *   2. confere que a empresa existe no ZapERP;
 *   3. chama `POST /api/v1/assistente/acesso/validar` pelo `services/wm/wmApiClient.js`;
 *   4. grava com `wmIntegrationConfigService.salvarConfig` (que deriva `telefone_ultimos4` e
 *      zera a validação quando o telefone muda) e registra a validação com `registrarValidacao`;
 *   5. imprime o resumo com os ÚLTIMOS 4 DÍGITOS e nada mais.
 *
 * O QUE O `acesso/validar` PROVA — E O QUE NÃO PROVA
 *   Ele devolve só `{ "autorizado": true }`. Isso prova que existe um contato ativo e inequívoco
 *   com esse telefone do lado da WM. **NÃO prova que esse contato pertence à mesma empresa do
 *   `company_id` do ZapERP.** Essa conferência é HUMANA e tem de ser feita com a WM. O script
 *   repete esse aviso na saída, toda vez.
 *
 * SEGREDOS
 *   O telefone autorizado nunca é impresso, nem em sucesso, nem em erro, nem com `--dry-run`:
 *   só `telefone_ultimos4`. O `ZAPERP_API_TOKEN` nunca sai do header da requisição.
 *
 * NÃO FAZ
 *   Não aplica migration (aplique `supabase/migrations/20261020120000_wm_orcamentos.sql` antes),
 *   não apaga linha nenhuma, não cria permissão, não liga `WM_ORCAMENTOS_ENABLED` (a flag
 *   efetiva é a env global **E** o `ativo` da empresa) e não normaliza o telefone — a
 *   normalização brasileira é da WM (`docs/wm/14-normalizacao-telefones.md`).
 */

const FLAGS_CONHECIDAS = [
  'company-id', 'por', 'telefone', 'ativar', 'desativar', 'confirmar', 'dry-run', 'sem-validar',
  'help', 'h',
]

const USO = [
  'Uso:',
  '  node scripts/wm-provisionar-empresa.js --company-id=N --telefone=T --por=QUEM --confirmar',
  '  node scripts/wm-provisionar-empresa.js --company-id=N --por=QUEM --ativar --confirmar',
  '',
  'Opções: --company-id=N (obrig.) · --por=TEXTO (obrig.) · --telefone=T · --ativar ·',
  '        --desativar · --confirmar · --dry-run · --sem-validar',
  '',
  'Caminho por SQL (Supabase Editor): docs/ai-handoff/36-ANEXO-B-PROVISIONAMENTO.md',
].join('\n')

/**
 * Parsing puro: nenhuma leitura de banco, nenhuma chamada de rede. É aqui que `company_id`
 * inválido e telefone fora de 8–30 caracteres morrem — antes de qualquer chamada.
 */
function parseArgs(argv) {
  const { validarTelefoneAutorizado } = require('../validators/wmOrcamentosValidators')

  const raw = {}
  const erros = []
  for (const arg of argv || []) {
    const texto = String(arg)
    if (!texto.startsWith('--')) {
      erros.push(`Argumento solto não aceito: "${texto}". Use o formato --chave=valor.`)
      continue
    }
    const [chave, ...resto] = texto.slice(2).split('=')
    if (!FLAGS_CONHECIDAS.includes(chave)) {
      erros.push(`Opção desconhecida: --${chave}`)
      continue
    }
    raw[chave] = resto.length ? resto.join('=') : 'true'
  }

  const ajuda = raw.help === 'true' || raw.h === 'true'

  const companyIdBruto = raw['company-id']
  const companyId = Number(companyIdBruto)
  if (companyIdBruto == null) {
    erros.push('--company-id=N é obrigatório.')
  } else if (!Number.isInteger(companyId) || companyId <= 0) {
    erros.push(`--company-id precisa ser inteiro positivo (recebi "${companyIdBruto}").`)
  }

  const por = String(raw.por ?? '').trim()
  if (raw.por == null || raw.por === 'true' || por.length === 0) {
    erros.push('--por="quem está provisionando" é obrigatório (vai para provisionado_por).')
  } else if (por.length > 120) {
    erros.push('--por precisa ter no máximo 120 caracteres.')
  }

  // Telefone: validado pelo MESMO validador que o payload da WM usa (8–30 caracteres), para não
  // existirem duas noções de "telefone aceitável" nesta codebase. Nunca ecoar o valor no erro.
  let telefone = null
  if (raw.telefone != null && raw.telefone !== 'true') {
    const v = validarTelefoneAutorizado(String(raw.telefone))
    if (!v.ok) {
      erros.push('--telefone fora do formato aceito pela WM: são de 8 a 30 caracteres, como a WM o cadastrou. (valor não ecoado de propósito)')
    } else {
      telefone = v.value
    }
  } else if (raw.telefone === 'true') {
    erros.push('--telefone precisa de valor: --telefone=5534991847800')
  }

  const ativar = raw.ativar === 'true'
  const desativar = raw.desativar === 'true'
  if (ativar && desativar) erros.push('--ativar e --desativar são mutuamente exclusivos.')
  // `raw.telefone != null` e não `telefone`: telefone informado mas inválido já tem erro próprio,
  // não é também "nada a fazer".
  if (raw.telefone == null && !ativar && !desativar) {
    erros.push('Nada a fazer: informe --telefone, --ativar ou --desativar.')
  }

  return {
    erros,
    ajuda,
    opts: {
      companyId: Number.isInteger(companyId) && companyId > 0 ? companyId : null,
      por,
      telefone,
      ativar,
      desativar,
      confirmar: raw.confirmar === 'true',
      dryRun: raw['dry-run'] === 'true',
      semValidar: raw['sem-validar'] === 'true',
    },
  }
}

/**
 * Traduz o resultado normalizado do `wmApiClient` para uma decisão de provisionamento.
 * Nunca devolve corpo de resposta: só o código sanitizado que o cliente já extraiu.
 */
function classificarValidacao(res) {
  if (!res || typeof res !== 'object') {
    return { status: 'erro', mensagem: 'Resposta da WM ausente.' }
  }
  if (res.configuracaoInvalida) {
    return {
      status: 'config',
      mensagem: `Integração WM não configurada neste ambiente (${res.configuracaoInvalida}).`,
    }
  }
  if (res.transporte) {
    return {
      status: 'indisponivel',
      mensagem: `A API WM não respondeu (${res.transporte}). Nada foi gravado.`,
    }
  }
  if (res.ok) {
    if (res.data && res.data.autorizado === true) {
      return { status: 'autorizado', mensagem: 'A WM aceita este telefone (autorizado: true).' }
    }
    return {
      status: 'resposta_invalida',
      mensagem: 'A WM respondeu 200 sem "autorizado: true" — fora do contrato. Nada foi gravado.',
    }
  }
  if (res.status === 403) {
    return {
      status: 'negado',
      mensagem: 'A WM NEGOU este telefone (403): contato inexistente, inativo, ambíguo, ou fora de 8–15 dígitos após a normalização dela.',
    }
  }
  if (res.status === 401) {
    return {
      status: 'credencial',
      mensagem: 'A WM recusou a credencial (401): confira o ZAPERP_API_TOKEN deste ambiente.',
    }
  }
  if (res.status === 400) {
    return {
      status: 'payload',
      mensagem: 'A WM recusou o payload (400). O telefone provavelmente não está no formato que ela aceita.',
    }
  }
  return {
    status: 'erro',
    mensagem: `A WM devolveu HTTP ${res.status || 0}${res.erroWm ? ` (${res.erroWm})` : ''}. Nada foi gravado.`,
  }
}

/** Empresa existe no ZapERP? Pré-condição de tudo: sem empresa não há vínculo que faça sentido. */
async function carregarEmpresa(client, companyId) {
  const { data, error } = await client
    .from('empresas')
    .select('id, nome, ativo')
    .eq('id', companyId)
    .maybeSingle()
  if (error) return { erro: 'Não foi possível consultar a tabela empresas.' }
  if (!data) return { erro: `Empresa ${companyId} não existe no ZapERP.` }
  return { empresa: data }
}

const AVISO_VINCULO = [
  'ATENÇÃO — o que a validação da WM prova, e o que não prova:',
  '  · prova: existe um contato ATIVO e inequívoco com este telefone do lado da WM;',
  '  · NÃO prova: que esse contato pertence à MESMA empresa deste company_id do ZapERP.',
  '  A WM declara que não fornece essa prova (pendência 13, doc 36 §10). O ZAPERP_API_TOKEN',
  '  alcança qualquer empresa da WM e o telefone é o único seletor de tenant.',
  '  >> A conferência do vínculo é HUMANA e tem de ser feita com a WM antes de ativar. <<',
]

/**
 * Núcleo do script. Recebe as dependências por parâmetro para que o teste exercite o fluxo
 * inteiro sem banco e sem rede.
 *
 * @param {object} opts  saída de `parseArgs().opts`
 * @param {object} deps  { supabase, wmApiClient, configService, log }
 * @returns {Promise<{ exitCode: number, linhas: string[], resumo: object|null }>}
 */
async function provisionar(opts, deps) {
  const linhas = []
  const log = typeof deps?.log === 'function' ? deps.log : console.log
  const say = (texto = '') => { linhas.push(texto); log(texto) }
  const falhar = (texto) => {
    say('')
    say(`ERRO: ${texto}`)
    say('Nada foi gravado.')
    return { exitCode: 1, linhas, resumo: null }
  }

  const { supabase, wmApiClient, configService } = deps

  say(`Empresa ZapERP: company_id=${opts.companyId}`)

  // 1. empresa existe?
  const { empresa, erro: erroEmpresa } = await carregarEmpresa(supabase, opts.companyId)
  if (erroEmpresa) return falhar(erroEmpresa)
  say(`  nome: ${empresa.nome ?? '(sem nome)'} · ativa no ZapERP: ${empresa.ativo === false ? 'não' : 'sim'}`)

  // 2. estado atual do vínculo (sem segredo: obterConfigPublica já é o recorte exibível)
  const antes = await configService.obterConfigPublica(opts.companyId)
  if (antes.configurado) {
    say(`Vínculo atual: existe · ativo=${antes.ativo} · telefone ****${antes.telefone_ultimos4 ?? '????'}` +
      ` · validacao=${antes.validacao_status}`)
  } else {
    say('Vínculo atual: não existe')
    say('  (a leitura falhando — migration 20261020120000_wm_orcamentos.sql não aplicada — aparece igual a esta;')
    say('   nesse caso a gravação adiante vai falhar e o script avisa.)')
  }

  // 3. qual telefone vai ser validado
  // O telefone já gravado só é lido do banco quando há validação a fazer — `--desativar
  // --sem-validar` não precisa dele, e segredo que não é lido não tem como escapar.
  const telefoneNovo = Boolean(opts.telefone)
  let telefone = opts.telefone
  if (!telefone) {
    if (!antes.configurado) {
      return falhar('--telefone=... é obrigatório no primeiro provisionamento desta empresa.')
    }
    if (!opts.semValidar) {
      telefone = await configService.obterTelefoneAutorizado(opts.companyId)
      if (!telefone) {
        return falhar('A empresa tem linha de vínculo mas nenhum telefone gravado. Rode com --telefone=... (ou --sem-validar, se só quer mexer em ativo).')
      }
    }
  }
  if (telefone) {
    say(`Telefone a usar: ****${String(telefone).replace(/\D+/g, '').slice(-4) || '????'}` +
      ` (${telefoneNovo ? 'novo, vindo do comando' : 'o já gravado'})`)
  } else {
    say('Telefone: mantido como está, e não lido — este comando só mexe em `ativo`.')
  }

  // 4. validação na WM
  let statusValidacao = null
  if (opts.semValidar) {
    say('')
    say('*** --SEM-VALIDAR: A VALIDAÇÃO CONTRA A WM FOI PULADA. ***')
    say('*** O VÍNCULO FICA COM validacao_status = nao_validado E PRECISA SER VALIDADO ANTES DE ATIVAR. ***')
  } else {
    say('')
    say('Validando o telefone na WM (POST /api/v1/assistente/acesso/validar)...')
    const res = await wmApiClient.validarAcesso({ telefone })
    const veredito = classificarValidacao(res)
    say(`  ${veredito.mensagem}`)
    if (veredito.status !== 'autorizado') {
      if (veredito.status === 'config') {
        say('')
        say('Configure WM_API_BASE_URL e ZAPERP_API_TOKEN no .env deste ambiente, ou rode com')
        say('--sem-validar se a validação já foi feita por outro meio (grava como nao_validado).')
      }
      return falhar(veredito.mensagem)
    }
    statusValidacao = 'autorizado'
  }

  // 5. o aviso do vínculo de tenant — sempre, inclusive em dry-run
  say('')
  for (const linha of AVISO_VINCULO) say(linha)

  // 6. o que seria gravado
  // `ativo` nasce false. Telefone novo também força false: trocar o telefone é exatamente o
  // momento em que um erro mandaria dados de outra empresa — ativar é passo separado.
  let ativoAlvo
  if (opts.ativar) ativoAlvo = true
  else if (opts.desativar) ativoAlvo = false
  else if (telefoneNovo) ativoAlvo = false
  else ativoAlvo = undefined

  say('')
  say('Gravação pretendida:')
  if (telefoneNovo) say(`  telefone_autorizado: substituído (termina em ${String(telefone).replace(/\D+/g, '').slice(-4)})`)
  else say('  telefone_autorizado: mantido')
  say(`  ativo: ${ativoAlvo === undefined ? '(mantido)' : ativoAlvo}`)
  say(`  validacao_status: ${statusValidacao ?? 'nao_validado'}`)
  say(`  provisionado_por: ${opts.por}`)

  if (opts.dryRun) {
    say('')
    say('DRY-RUN: nada foi gravado.')
    return { exitCode: 0, linhas, resumo: null }
  }
  if (!opts.confirmar) {
    say('')
    say('Nada foi gravado: falta --confirmar. Repita o mesmo comando acrescentando --confirmar.')
    return { exitCode: 0, linhas, resumo: null }
  }

  // 7. gravação
  const salvo = await configService.salvarConfig({
    company_id: opts.companyId,
    ...(telefoneNovo ? { telefone_autorizado: telefone } : {}),
    ...(ativoAlvo === undefined ? {} : { ativo: ativoAlvo }),
    provisionado_por: opts.por,
  })
  if (salvo?.error) {
    say('')
    say('Se a tabela wm_orcamento_integracoes ainda não existe, aplique primeiro a migration')
    say('supabase/migrations/20261020120000_wm_orcamentos.sql no Supabase Editor (doc 36 §6).')
    return falhar(salvo.error)
  }

  // `salvarConfig` zera a validação quando o telefone muda — então o registro da validação vem
  // DEPOIS, nunca antes.
  let config = salvo.config
  if (statusValidacao) {
    const marcado = await configService.registrarValidacao({
      company_id: opts.companyId,
      status: statusValidacao,
      usuario_id: null,
    })
    if (marcado?.error) {
      say('')
      say(`AVISO: o vínculo foi gravado, mas não foi possível registrar a validação (${marcado.error}).`)
      say('Rode o comando de novo para registrar, ou use o bloco SQL do anexo B.')
    } else if (marcado?.config) {
      config = marcado.config
    }
  }

  const resumo = {
    company_id: opts.companyId,
    empresa: empresa.nome ?? null,
    telefone_ultimos4: config?.telefone_ultimos4 ?? null,
    ativo: config?.ativo === true,
    validacao_status: config?.validacao_status ?? 'nao_validado',
    validado_em: config?.validado_em ?? null,
    provisionado_por: opts.por,
  }

  say('')
  say('GRAVADO.')
  say(`  company_id:         ${resumo.company_id}`)
  say(`  empresa:            ${resumo.empresa ?? '(sem nome)'}`)
  say(`  telefone:           ****${resumo.telefone_ultimos4 ?? '????'}  (só os últimos 4 — o valor completo nunca é impresso)`)
  say(`  ativo:              ${resumo.ativo}`)
  say(`  validacao_status:   ${resumo.validacao_status}`)
  say(`  validado_em:        ${resumo.validado_em ?? '—'}`)
  say(`  provisionado_por:   ${resumo.provisionado_por}`)
  say('')
  if (!resumo.ativo) {
    say('A empresa está DESATIVADA. Depois de conferir o vínculo com a WM, ative com:')
    say(`  node scripts/wm-provisionar-empresa.js --company-id=${opts.companyId} --por="${opts.por}" --ativar --confirmar`)
  } else {
    say('A empresa está ATIVA. A flag efetiva ainda exige WM_ORCAMENTOS_ENABLED=true na API.')
    say('Para desligar sem perder histórico:')
    say(`  node scripts/wm-provisionar-empresa.js --company-id=${opts.companyId} --por="${opts.por}" --desativar --sem-validar --confirmar`)
  }

  return { exitCode: 0, linhas, resumo }
}

/** Dependências reais. Falha de configuração do Supabase vira mensagem, não stack trace. */
function construirDeps() {
  try { require('../config/env').loadEnv?.() } catch (_) { /* .env opcional */ }
  try { require('dotenv').config() } catch (_) { /* dotenv opcional */ }

  let supabase = null
  try {
    supabase = require('../config/supabase')
  } catch (e) {
    return { erro: 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env deste ambiente.' }
  }
  return {
    deps: {
      supabase,
      wmApiClient: require('../services/wm/wmApiClient'),
      configService: require('../services/wm/wmIntegrationConfigService'),
      log: console.log,
    },
  }
}

async function main(argv = process.argv.slice(2)) {
  const { erros, ajuda, opts } = parseArgs(argv)
  if (ajuda) {
    console.log(USO)
    return 0
  }
  if (erros.length > 0) {
    for (const e of erros) console.error(`ERRO: ${e}`)
    console.error('')
    console.error(USO)
    return 1
  }

  const { deps, erro } = construirDeps()
  if (erro) {
    console.error(`ERRO: ${erro}`)
    return 1
  }

  const { exitCode } = await provisionar(opts, deps)
  return exitCode
}

/**
 * `process.exitCode` em vez de `process.exit()`: no Windows, derrubar o processo enquanto o pool
 * de conexões do cliente Supabase ainda está fechando dispara uma asserção do libuv
 * (`!(handle->flags & UV_HANDLE_CLOSING)`) e o código de saída vira 127 — a mensagem fica certa e
 * o status mentindo. Aqui o loop termina sozinho; o `unref` de segurança abaixo só existe para o
 * caso de o pool segurar o processo, e nunca o mantém vivo por si.
 */
function encerrar(code) {
  process.exitCode = code
  const fuga = setTimeout(() => process.exit(code), 5000)
  if (typeof fuga.unref === 'function') fuga.unref()
}

if (require.main === module) {
  main()
    .then(encerrar)
    .catch((e) => {
      // Nunca imprimir o objeto de erro inteiro: ele pode carregar corpo de requisição.
      console.error(`ERRO inesperado: ${e?.message || 'falha desconhecida'}`)
      encerrar(1)
    })
}

module.exports = {
  FLAGS_CONHECIDAS,
  USO,
  AVISO_VINCULO,
  parseArgs,
  classificarValidacao,
  carregarEmpresa,
  provisionar,
  main,
}
