'use strict'

/**
 * Diz, em UM comando, se uma empresa está pronta para emitir orçamento no ERP Icthus — e,
 * quando não está, QUAL é o impedimento. Só lê: não grava nada, em lugar nenhum.
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * O módulo tem duas portas independentes para o ERP, e elas falham SEPARADAMENTE:
 *
 *   · `produtos/consultar`  → servido do acervo já sincronizado DENTRO da WM. Continua
 *                             respondendo 200 mesmo com o sincronizador da loja desligado.
 *   · `clientes/consultar`  → REALTIME: a WM precisa falar com o sincronizador instalado na
 *     `orcamentos/preparar`   máquina da loja. Sincronizador fora do ar ⇒ `503
 *                             SINCRONIZADOR_OFFLINE` (medido em produção em 25/10/2026).
 *
 * O efeito prático dessa assimetria é a razão deste script: com o sincronizador offline a busca
 * de produto FUNCIONA, então o atendente monta a cesta inteira, digita o cliente, aperta
 * Calcular — e só aí descobre que o ERP está inalcançável. Nada no ZapERP distinguia "WM fora
 * do ar" de "sincronizador da loja fora do ar", e o segundo caso se resolve na própria loja
 * (máquina ligada, internet, serviço rodando), não com a WM.
 *
 * Também confere o que já quebrou de verdade: migration aplicada PELA METADE. Em 23/10/2026 a
 * `wm_orcamento_integracoes` existia e a `wm_orcamento_operacoes` não, e o sintoma no
 * frontend era só "Não foi possível registrar o orçamento agora" — sem dizer o que faltava.
 *
 * USO
 * ---
 *   # diagnóstico completo das portas que não exigem dado da loja
 *   node scripts/wm-diagnostico-empresa.js --company-id=20
 *
 *   # inclui a prévia ponta a ponta (precisa de dado real daquela loja)
 *   node scripts/wm-diagnostico-empresa.js --company-id=20 \
 *        --cliente-busca="maria" --vendedor-busca="paula" --produto=0004325
 *
 * OPÇÕES
 *   --company-id=N       OBRIGATÓRIO. Empresa do ZapERP.
 *   --cliente-busca=T    Liga a prova 6 (prévia ponta a ponta). Exige também --vendedor-busca.
 *   --vendedor-busca=T   Vendedor como a loja o conhece.
 *   --produto=CODIGO     Código ERP do produto da prévia. Omitido = o script pega o primeiro
 *                        resultado da prova 4, para não exigir que você saiba um código.
 *   --busca-produto=T    Termo da prova 4. Default: "a" (achar qualquer coisa, não algo certo).
 *   --json               Só o veredito em JSON, para script. Suprime o relatório legível.
 *
 * SAÍDA
 *   exit 0 = pronta para orçar · exit 1 = há impedimento (o veredito nomeia qual)
 *
 * O QUE ELE NÃO FAZ
 *   Não grava, não cria orçamento (a prova 6 é `preparar`, que é prévia — `criar` nunca é
 *   chamado), não aplica migration, não liga flag, não imprime o telefone autorizado (só os 4
 *   últimos dígitos) e não imprime o `ZAPERP_API_TOKEN`.
 */

const FLAGS_CONHECIDAS = [
  'company-id', 'cliente-busca', 'vendedor-busca', 'produto', 'busca-produto', 'json',
  'help', 'h',
]

const USO = [
  'Uso:',
  '  node scripts/wm-diagnostico-empresa.js --company-id=N',
  '  node scripts/wm-diagnostico-empresa.js --company-id=N --cliente-busca=T --vendedor-busca=T',
  '',
  'Opções: --company-id=N (obrig.) · --cliente-busca=T · --vendedor-busca=T · --produto=CODIGO ·',
  '        --busca-produto=T · --json',
  '',
  'Provisionamento: scripts/wm-provisionar-empresa.js · docs/ai-handoff/36-ANEXO-B-PROVISIONAMENTO.md',
].join('\n')

/** Parsing puro: sem banco, sem rede. */
function parseArgs(argv) {
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

  const texto = (chave) => {
    const v = raw[chave]
    if (v == null || v === 'true') return null
    const t = String(v).trim()
    return t.length ? t : null
  }

  const clienteBusca = texto('cliente-busca')
  const vendedorBusca = texto('vendedor-busca')
  // A prévia precisa dos DOIS: a WM exige cliente e vendedor no mesmo payload.
  if (clienteBusca && !vendedorBusca) erros.push('--cliente-busca exige também --vendedor-busca.')
  if (vendedorBusca && !clienteBusca) erros.push('--vendedor-busca exige também --cliente-busca.')

  return {
    erros,
    ajuda,
    opts: {
      companyId: Number.isInteger(companyId) && companyId > 0 ? companyId : null,
      clienteBusca,
      vendedorBusca,
      produto: texto('produto'),
      buscaProduto: texto('busca-produto') || 'a',
      json: raw.json === 'true',
    },
  }
}

/**
 * Traduz o resultado normalizado do `wmApiClient` numa leitura de LIVENESS do sincronizador.
 *
 * O ponto fino: para esta pergunta, `404` é tão bom quanto `200`. "Nenhum cliente encontrado"
 * só pode ter vindo de alguém que de fato consultou a base da loja — logo o sincronizador
 * está vivo. Tratar 404 como falha daria "offline" em loja saudável cujo termo não casou.
 */
function lerLiveness(res) {
  if (!res || typeof res !== 'object') return { estado: 'erro', detalhe: 'resposta ausente' }
  if (res.configuracaoInvalida) return { estado: 'config', detalhe: res.configuracaoInvalida }
  if (res.transporte) return { estado: 'indisponivel', detalhe: res.transporte }
  if (res.ok) return { estado: 'online', detalhe: 'respondeu 200' }
  if (res.status === 404) return { estado: 'online', detalhe: 'respondeu 404 (consultou e não achou)' }
  if (res.status === 503) return { estado: 'offline', detalhe: res.erroWm || 'SINCRONIZADOR_OFFLINE' }
  if (res.status === 504) return { estado: 'lento', detalhe: 'timeout da operação realtime' }
  if (res.status === 401) return { estado: 'credencial', detalhe: 'ZAPERP_API_TOKEN recusado' }
  if (res.status === 403) return { estado: 'nao_autorizado', detalhe: 'telefone não autorizado' }
  return { estado: 'erro', detalhe: `HTTP ${res.status || 0}${res.erroWm ? ` ${res.erroWm}` : ''}` }
}

/** Uma tabela existe e é legível? É assim que migration pela metade aparece. */
async function tabelaLegivel(client, tabela) {
  try {
    const { error } = await client.from(tabela).select('company_id', { head: true, count: 'exact' }).limit(1)
    if (error) return { ok: false, motivo: error.message || 'erro de leitura' }
    return { ok: true }
  } catch (e) {
    return { ok: false, motivo: e?.message || 'exceção na leitura' }
  }
}

/**
 * Núcleo. Dependências por parâmetro para o teste exercitar tudo sem banco e sem rede.
 *
 * @param {object} opts  saída de `parseArgs().opts`
 * @param {object} deps  { supabase, wmApiClient, configService, flagHelper, env, log }
 * @returns {Promise<{ exitCode: number, veredito: object }>}
 */
async function diagnosticar(opts, deps) {
  const log = typeof deps?.log === 'function' ? deps.log : console.log
  const quieto = opts.json === true
  const say = (texto = '') => { if (!quieto) log(texto) }

  const { supabase, wmApiClient, configService, flagHelper } = deps
  const env = deps?.env || process.env

  const provas = []
  const impedimentos = []
  /** Uma prova fechada. `bloqueia` entra no veredito como impedimento. */
  const prova = (nome, estado, detalhe, bloqueia = false) => {
    provas.push({ nome, estado, detalhe })
    const marca = estado === 'ok' ? 'OK  ' : estado === 'aviso' ? 'AVISO' : 'FALHA'
    say(`  [${marca}] ${nome}${detalhe ? ` — ${detalhe}` : ''}`)
    if (bloqueia) impedimentos.push({ nome, detalhe })
  }

  say(`Diagnóstico do Orçamento WM — company_id=${opts.companyId}`)
  say('')

  // ---- 1. ambiente -------------------------------------------------------------------------
  say('1. Ambiente deste processo')
  const envLigada = String(env.WM_ORCAMENTOS_ENABLED ?? '').trim().toLowerCase()
  const envOk = envLigada === 'true' || envLigada === '1'
  // "deste processo" é literal: rodando na sua máquina isto lê o `.env` local, que normalmente
  // está desligado, e NÃO diz nada sobre o servidor. Para valer em produção, rode no servidor.
  prova('WM_ORCAMENTOS_ENABLED', envOk ? 'ok' : 'falha',
    envOk ? 'ligada' : 'DESLIGADA neste processo — se rodou na sua máquina, isto é o .env local, '
      + 'não o do servidor', !envOk)

  const base = wmApiClient.resolveBaseUrl()
  prova('WM_API_BASE_URL', base.ok ? 'ok' : 'falha', base.ok ? base.base : base.motivo, !base.ok)

  const temToken = String(env.ZAPERP_API_TOKEN ?? '').trim().length > 0
  prova('ZAPERP_API_TOKEN', temToken ? 'ok' : 'falha',
    temToken ? 'presente (valor nunca impresso)' : 'AUSENTE — nenhuma chamada à WM vai autenticar',
    !temToken)

  // ---- 2. migration ------------------------------------------------------------------------
  say('')
  say('2. Migration (as DUAS tabelas, não só a primeira)')
  for (const tabela of ['wm_orcamento_integracoes', 'wm_orcamento_operacoes']) {
    const r = await tabelaLegivel(supabase, tabela)
    prova(tabela, r.ok ? 'ok' : 'falha',
      r.ok ? 'legível' : `ILEGÍVEL (${r.motivo}) — migration 20261020120000_wm_orcamentos.sql`, !r.ok)
  }

  // ---- 3. vínculo da empresa ---------------------------------------------------------------
  say('')
  say('3. Vínculo desta empresa')
  const { data: empresa } = await supabase
    .from('empresas').select('id, nome, ativo').eq('id', opts.companyId).maybeSingle()
  if (!empresa) {
    prova('empresa existe no ZapERP', 'falha', `company_id=${opts.companyId} não existe`, true)
  } else {
    prova('empresa existe no ZapERP', 'ok', `${empresa.nome ?? '(sem nome)'}`)
  }

  const cfg = await configService.obterConfigPublica(opts.companyId)
  if (!cfg.configurado) {
    prova('vínculo provisionado', 'falha',
      'não existe — rode scripts/wm-provisionar-empresa.js', true)
  } else {
    prova('vínculo provisionado', 'ok', `telefone ****${cfg.telefone_ultimos4 ?? '????'}`)
    prova('ativo na empresa', cfg.ativo ? 'ok' : 'falha',
      cfg.ativo ? 'sim' : 'NÃO — provisionado mas desligado (--ativar)', !cfg.ativo)
    // Valores possíveis: nao_validado | autorizado | negado | erro (VALIDACAO_STATUS do
    // wmIntegrationConfigService). `nao_validado` não impede funcionar — impede CONFIAR que o
    // telefone é desta empresa. `negado` é diferente: a WM recusou, e aí nada vai funcionar.
    const v = cfg.validacao_status
    prova('validação na WM', v === 'autorizado' ? 'ok' : v === 'negado' ? 'falha' : 'aviso',
      `validacao_status=${v}` + (
        v === 'autorizado' ? ''
          : v === 'negado' ? ' — a WM RECUSOU este telefone'
            : ' — vínculo nunca conferido contra a WM'
      ), v === 'negado')
  }

  if (flagHelper) {
    const efetiva = await flagHelper.orcamentoWmHabilitado(opts.companyId)
    prova('flag efetiva (env E empresa)', efetiva ? 'ok' : 'falha',
      efetiva ? 'o módulo aparece para esta empresa' : 'o módulo NÃO aparece para esta empresa', !efetiva)
  }

  // Sem telefone não há como provar porta nenhuma. Pare aqui, com veredito honesto.
  const telefone = cfg.configurado ? await configService.obterTelefoneAutorizado(opts.companyId) : null
  if (!telefone || impedimentos.some((i) => i.nome === 'ZAPERP_API_TOKEN' || i.nome === 'WM_API_BASE_URL')) {
    say('')
    say('As portas do ERP não foram testadas: falta telefone autorizado, base ou token.')
    const veredito = { pronta: false, impedimentos, provas, portas_testadas: false }
    if (quieto) log(JSON.stringify(veredito, null, 2))
    return { exitCode: 1, veredito }
  }

  // ---- 4. porta de autorização -------------------------------------------------------------
  say('')
  say('4. Porta de autorização (não depende do sincronizador)')
  const acesso = lerLiveness(await wmApiClient.validarAcesso({ telefone }))
  const acessoOk = acesso.estado === 'online'
  prova('acesso/validar', acessoOk ? 'ok' : 'falha', acesso.detalhe, !acessoOk)

  // ---- 5. porta do acervo sincronizado -----------------------------------------------------
  say('')
  say('5. Porta do acervo sincronizado (produtos — responde mesmo com a loja offline)')
  const prod = await wmApiClient.consultarProdutos({ telefone, busca: opts.buscaProduto })
  const prodLive = lerLiveness(prod)
  const prodOk = prodLive.estado === 'online'
  let primeiroCodigo = null
  if (prodOk && prod.ok) {
    const d = prod.data?.dados || {}
    const itens = d.produtos || (d.codigo_produto_erp ? [d] : [])
    primeiroCodigo = itens[0]?.codigo_produto_erp || null
    const total = d.paginacao?.total ?? itens.length
    prova('produtos/consultar', 'ok', `${total} resultado(s) para "${opts.buscaProduto}"`)
  } else {
    prova('produtos/consultar', 'falha', prodLive.detalhe, true)
  }

  // ---- 6. porta realtime -------------------------------------------------------------------
  say('')
  say('6. Porta REALTIME (exige o sincronizador ligado na máquina da loja)')
  const cli = lerLiveness(
    await wmApiClient.consultarClientes({ telefone, busca: opts.clienteBusca || 'a' }),
  )
  if (cli.estado === 'online') {
    prova('sincronizador da loja', 'ok', `vivo (${cli.detalhe})`)
  } else if (cli.estado === 'offline') {
    prova('sincronizador da loja', 'falha',
      'OFFLINE — a loja não está alcançável. Confira a máquina do sincronizador: ligada, ' +
      'com internet e com o serviço rodando. Produto continua buscando (acervo), mas ' +
      'NENHUM orçamento pode ser calculado.', true)
  } else {
    prova('sincronizador da loja', 'falha', cli.detalhe, true)
  }

  // ---- 7. prévia ponta a ponta -------------------------------------------------------------
  say('')
  say('7. Prévia ponta a ponta (orcamentos/preparar — prévia, nunca cria)')
  const codigo = opts.produto || primeiroCodigo
  if (!opts.clienteBusca) {
    prova('preparar', 'aviso', 'não testada — passe --cliente-busca e --vendedor-busca')
  } else if (!codigo) {
    prova('preparar', 'aviso', 'não testada — nenhum código de produto (use --produto=CODIGO)')
  } else {
    const prep = await wmApiClient.prepararOrcamento({
      telefone,
      cliente_busca: opts.clienteBusca,
      vendedor_busca: opts.vendedorBusca,
      bloquear_apos_criar: false,
      itens: [{ codigo_produto_erp: codigo, quantidade: '1' }],
    })
    const pl = lerLiveness(prep)
    if (pl.estado === 'online') {
      const status = prep.data?.dados?.status || '(sem status)'
      // Ambiguidade NÃO é defeito: é a WM se recusando a escolher no lugar do atendente.
      prova('preparar', 'ok', `respondeu "${status}" com o produto ${codigo}`)
    } else {
      prova('preparar', 'falha', pl.detalhe, true)
    }
  }

  // ---- veredito ----------------------------------------------------------------------------
  const pronta = impedimentos.length === 0
  const veredito = { pronta, impedimentos, provas, portas_testadas: true }

  if (quieto) {
    log(JSON.stringify(veredito, null, 2))
  } else {
    say('')
    if (pronta) {
      say('VEREDITO: PRONTA PARA ORÇAR.')
    } else {
      say(`VEREDITO: ${impedimentos.length} impedimento(s).`)
      for (const i of impedimentos) say(`  · ${i.nome}: ${i.detalhe}`)
    }
  }

  return { exitCode: pronta ? 0 : 1, veredito }
}

async function main(argv) {
  const { erros, ajuda, opts } = parseArgs(argv)
  if (ajuda) {
    console.log(USO)
    return 0
  }
  if (erros.length) {
    for (const e of erros) console.error(`ERRO: ${e}`)
    console.error('')
    console.error(USO)
    return 1
  }

  require('../config/env').loadEnv()
  const { exitCode } = await diagnosticar(opts, {
    supabase: require('../config/supabase'),
    wmApiClient: require('../services/wm/wmApiClient'),
    configService: require('../services/wm/wmIntegrationConfigService'),
    flagHelper: require('../helpers/orcamentoWmFlag'),
  })
  return exitCode
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`ERRO inesperado: ${e?.message || e}`)
      process.exit(1)
    })
}

module.exports = { parseArgs, lerLiveness, tabelaLegivel, diagnosticar, main, USO }
