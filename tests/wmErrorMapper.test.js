/**
 * Mapeador de erro da WM → envelope local (doc 36, seção 5).
 *
 * Dois invariantes que, se quebrarem, viram incidente:
 *   (a) o 401 da WM NUNCA pode virar 401 local — deslogaria o atendente;
 *   (b) nenhum erro cru da WM atravessa: código desconhecido cai no ramo padrão da faixa de HTTP
 *       (o `shared/http/errors.ts` da WM não foi recebido — pendência 3).
 */
const { mapearErroWm, CODIGOS, ESTADO, OPERACAO, MENSAGENS } = require('../helpers/wmErrorMapper')
const stateMachine = require('../services/wm/wmOrcamentoStateMachine')

const CHAVES_PERMITIDAS = ['ok', 'codigo', 'mensagem', 'estado', 'requestId', 'indice_item']

function res(extra = {}) {
  return {
    ok: false,
    status: 0,
    data: null,
    erroWm: null,
    indiceItem: null,
    transporte: null,
    respostaInvalida: false,
    configuracaoInvalida: null,
    ...extra,
  }
}

/** Códigos nomeados nos documentos da WM — escritos à mão a partir da seção 5 do doc 36. */
const NOMEADOS = [
  { erroWm: 'TOKEN_ASSISTENTE_INVALIDO', status: 401, codigo: CODIGOS.CREDENCIAL_INVALIDA },
  { erroWm: 'CONTATO_NAO_AUTORIZADO', status: 403, codigo: CODIGOS.ACESSO_NAO_AUTORIZADO },
  { erroWm: 'payload_invalido', status: 400, codigo: CODIGOS.PAYLOAD_INVALIDO },
  { erroWm: 'PERIODO_INVALIDO', status: 400, codigo: CODIGOS.PERIODO_INVALIDO },
  { erroWm: 'PAGINA_FORA_DO_INTERVALO', status: 400, codigo: CODIGOS.PAGINA_FORA_DO_INTERVALO },
  { erroWm: 'CLIENTE_INVALIDO', status: 502, codigo: CODIGOS.CLIENTE_INVALIDO },
  { erroWm: 'VENDEDOR_NAO_ENCONTRADO', status: 502, codigo: CODIGOS.VENDEDOR_NAO_ENCONTRADO },
  { erroWm: 'PRODUTO_NAO_ENCONTRADO', status: 502, codigo: CODIGOS.PRODUTO_NAO_ENCONTRADO },
  { erroWm: 'PRODUTO_INATIVO', status: 502, codigo: CODIGOS.PRODUTO_INATIVO },
  { erroWm: 'SINCRONIZADOR_OFFLINE', status: 503, codigo: CODIGOS.SINCRONIZADOR_OFFLINE },
  { erroWm: 'REALTIME_TIMEOUT', status: 504, codigo: CODIGOS.TIMEOUT },
  { erroWm: 'COMANDO_ID_REUTILIZADO', status: 409, codigo: CODIGOS.COMANDO_ID_REUTILIZADO },
  { erroWm: 'COMANDO_NAO_REEXECUTADO', status: 409, codigo: CODIGOS.COMANDO_EM_ANDAMENTO },
  { erroWm: 'RESULTADO_INCERTO', status: 409, codigo: CODIGOS.RESULTADO_INCERTO },
  // 2ª remessa do contrato (§11): dados mudaram entre prévia e criação. O guia NÃO fixa o HTTP
  // deste erro, então ele é mapeado por código — ver o describe dedicado mais abaixo.
  { erroWm: 'ORCAMENTO_DADOS_ALTERADOS', status: 409, codigo: CODIGOS.ORCAMENTO_DADOS_ALTERADOS },
]

describe('wmErrorMapper — envelope', () => {
  it('o envelope tem só as chaves do contrato local, nada mais', () => {
    for (const caso of NOMEADOS) {
      const { envelope } = mapearErroWm({ resultado: res(caso), operacao: OPERACAO.PREPARACAO })
      for (const k of Object.keys(envelope)) expect(CHAVES_PERMITIDAS).toContain(k)
      expect(envelope.ok).toBe(false)
      expect(typeof envelope.codigo).toBe('string')
      expect(typeof envelope.mensagem).toBe('string')
      expect(typeof envelope.requestId).toBe('string')
      expect(envelope.requestId.length).toBeGreaterThan(0)
    }
  })

  it('o código bruto da WM fica no `interno`, nunca no envelope', () => {
    // Código inédito de propósito: se o mapeador repassasse o cru, apareceria no envelope.
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 503, erroWm: 'SEGREDO_INTERNO_DA_WM' }),
      operacao: OPERACAO.LEITURA,
    })
    expect(interno.codigoWm).toBe('SEGREDO_INTERNO_DA_WM')
    expect(JSON.stringify(envelope)).not.toContain('SEGREDO_INTERNO_DA_WM')
    expect(envelope.codigo).toBe(CODIGOS.SINCRONIZADOR_OFFLINE)

    // E o código nomeado também não vaza outro texto da WM: o envelope só tem o código local.
    const nomeado = mapearErroWm({ resultado: res({ status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }) })
    expect(nomeado.envelope.codigo).toBe(CODIGOS.SINCRONIZADOR_OFFLINE)
    expect(nomeado.envelope.codigo.startsWith('WM_')).toBe(true)
  })

  it('usa o requestId recebido e gera um quando não vem', () => {
    const comId = mapearErroWm({ resultado: res({ status: 503 }), requestId: 'req-abc' })
    expect(comId.envelope.requestId).toBe('req-abc')

    const a = mapearErroWm({ resultado: res({ status: 503 }) }).envelope.requestId
    const b = mapearErroWm({ resultado: res({ status: 503 }) }).envelope.requestId
    expect(a).not.toBe(b)
  })

  it('`estado` usa exatamente o vocabulário da máquina de estados', () => {
    expect(ESTADO.FALHA_SEGURA).toBe(stateMachine.ESTADOS.FALHA_SEGURA)
    expect(ESTADO.INCERTO).toBe(stateMachine.ESTADOS.INCERTO)
  })

  it('nenhuma mensagem ao usuário tem jargão técnico, código ou número de HTTP', () => {
    for (const mensagem of Object.values(MENSAGENS)) {
      expect(mensagem).not.toMatch(/WM_/)
      expect(mensagem).not.toMatch(/\b(400|401|403|404|408|409|429|500|502|503|504)\b/)
      expect(mensagem).not.toMatch(/comando_id|payload|indice_item|stack|undefined|null/i)
      expect(mensagem).not.toMatch(/RESULTADO_INCERTO|SINCRONIZADOR_OFFLINE|TOKEN_ASSISTENTE/)
      expect(mensagem.length).toBeGreaterThan(10)
    }
  })
})

describe('wmErrorMapper — códigos nomeados pela WM', () => {
  it.each(NOMEADOS)('mapeia $erroWm ($status) para $codigo', ({ erroWm, status, codigo }) => {
    const { envelope } = mapearErroWm({ resultado: res({ status, erroWm }), operacao: OPERACAO.PREPARACAO })
    expect(envelope.codigo).toBe(codigo)
    expect(envelope.mensagem).toBe(MENSAGENS[codigo])
  })

  it('o 401 da WM NUNCA vira 401 local, em nenhuma operação', () => {
    for (const operacao of Object.values(OPERACAO)) {
      for (const erroWm of ['TOKEN_ASSISTENTE_INVALIDO', null, 'CODIGO_QUE_NAO_CONHECEMOS']) {
        const { envelope, interno } = mapearErroWm({ resultado: res({ status: 401, erroWm }), operacao })
        expect(interno.httpStatusLocal).not.toBe(401)
        expect(interno.httpStatusLocal).toBe(503)
        expect(envelope.codigo).toBe(CODIGOS.CREDENCIAL_INVALIDA)
        expect(interno.alertaOperacional).toBe(true)
      }
    }
  })

  it('o 403 não afirma a causa (contato inativo OU conflito de equivalência)', () => {
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 403, erroWm: 'CONTATO_NAO_AUTORIZADO' }),
      operacao: OPERACAO.LEITURA,
    })
    expect(envelope.codigo).toBe(CODIGOS.ACESSO_NAO_AUTORIZADO)
    expect(interno.httpStatusLocal).not.toBe(401)
    // A WM omite o telefone de propósito; a mensagem não pode insinuar causa nem dado.
    expect(envelope.mensagem).not.toMatch(/telefone|contato inativo|inexistente|duplicad|equival|conflito/i)
    expect(interno.alertaOperacional).toBe(true)
  })

  it('502 de resolução é recuperável (422) e preserva indice_item zero-based', () => {
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 502, erroWm: 'PRODUTO_INATIVO', indiceItem: 0 }),
      operacao: OPERACAO.PREPARACAO,
    })
    expect(interno.httpStatusLocal).toBe(422)
    expect(envelope.indice_item).toBe(0)
    expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)

    const outro = mapearErroWm({ resultado: res({ status: 502, erroWm: 'PRODUTO_NAO_ENCONTRADO', indiceItem: 3 }) })
    expect(outro.envelope.indice_item).toBe(3)
  })

  it('sem indice_item a chave não aparece no envelope', () => {
    const { envelope } = mapearErroWm({ resultado: res({ status: 502, erroWm: 'CLIENTE_INVALIDO' }) })
    expect(envelope).not.toHaveProperty('indice_item')
  })

  it('502 desconhecido é erro técnico de origem, não escolha do usuário', () => {
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 502, erroWm: 'ALGO_NOVO_DA_WM' }),
      operacao: OPERACAO.PREPARACAO,
    })
    expect(envelope.codigo).toBe(CODIGOS.ERRO_ORIGEM)
    expect(interno.httpStatusLocal).toBe(503)
    expect(interno.alertaOperacional).toBe(true)
  })
})

describe('wmErrorMapper — ramo padrão por faixa de HTTP (pendência 3)', () => {
  const faixas = [
    [400, CODIGOS.PAYLOAD_INVALIDO, 400],
    [401, CODIGOS.CREDENCIAL_INVALIDA, 503],
    [403, CODIGOS.ACESSO_NAO_AUTORIZADO, 503],
    [404, CODIGOS.NAO_ENCONTRADO, 404],
    [409, CODIGOS.CONFLITO, 409],
    [418, CODIGOS.RECUSADO, 422],
    [429, CODIGOS.INDISPONIVEL, 503],
    [502, CODIGOS.ERRO_ORIGEM, 503],
    [503, CODIGOS.SINCRONIZADOR_OFFLINE, 503],
    [504, CODIGOS.TIMEOUT, 504],
    [500, CODIGOS.INDISPONIVEL, 503],
    [599, CODIGOS.INDISPONIVEL, 503],
    [302, CODIGOS.RESPOSTA_INVALIDA, 503],
  ]

  it.each(faixas)('status %s sem código conhecido cai em %s (HTTP local %s)', (status, codigo, httpLocal) => {
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status, erroWm: 'CODIGO_INEDITO_XPTO' }),
      operacao: OPERACAO.LEITURA,
    })
    expect(envelope.codigo).toBe(codigo)
    expect(interno.httpStatusLocal).toBe(httpLocal)
    expect(JSON.stringify(envelope)).not.toContain('CODIGO_INEDITO_XPTO')
  })

  it('status 0 sem transporte nem configuração ainda produz envelope válido', () => {
    const { envelope } = mapearErroWm({ resultado: res({ status: 0 }) })
    expect(envelope.codigo).toBe(CODIGOS.ERRO_DESCONHECIDO)
    expect(envelope.ok).toBe(false)
  })

  it('chamado por engano com sucesso não inventa erro de domínio, mas alerta', () => {
    const { envelope, interno } = mapearErroWm({ resultado: res({ ok: true, status: 200 }) })
    expect(envelope.codigo).toBe(CODIGOS.ERRO_DESCONHECIDO)
    expect(interno.alertaOperacional).toBe(true)
  })
})

describe('wmErrorMapper — FALHA_SEGURA × INCERTO', () => {
  it('configuração inválida é FALHA_SEGURA até na criação (nada foi enviado)', () => {
    for (const operacao of Object.values(OPERACAO)) {
      const { envelope, interno } = mapearErroWm({
        resultado: res({ configuracaoInvalida: 'base_url_ausente' }),
        operacao,
      })
      expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
      expect(envelope.codigo).toBe(CODIGOS.INTEGRACAO_NAO_CONFIGURADA)
      expect(interno.alertaOperacional).toBe(true)
    }
  })

  it('erro de conexão é FALHA_SEGURA até na criação (a requisição não chegou)', () => {
    const { envelope } = mapearErroWm({ resultado: res({ transporte: 'conexao' }), operacao: OPERACAO.CRIACAO })
    expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    expect(envelope.codigo).toBe(CODIGOS.INDISPONIVEL)
  })

  it('timeout na CRIAÇÃO é INCERTO e a mensagem manda não criar outro', () => {
    const { envelope, interno } = mapearErroWm({ resultado: res({ transporte: 'timeout' }), operacao: OPERACAO.CRIACAO })
    expect(envelope.estado).toBe(ESTADO.INCERTO)
    expect(envelope.codigo).toBe(CODIGOS.RESULTADO_INCERTO)
    expect(envelope.mensagem).toMatch(/não crie outro/i)
    expect(interno.httpStatusLocal).toBe(504)
  })

  it('timeout em leitura e preparação é FALHA_SEGURA (não escrevem)', () => {
    for (const operacao of [OPERACAO.LEITURA, OPERACAO.PREPARACAO]) {
      const { envelope } = mapearErroWm({ resultado: res({ transporte: 'timeout' }), operacao })
      expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
      expect(envelope.codigo).toBe(CODIGOS.TIMEOUT)
    }
  })

  it('falha de transporte não classificada na criação é INCERTO (cautela)', () => {
    const { envelope } = mapearErroWm({ resultado: res({ transporte: 'desconhecido' }), operacao: OPERACAO.CRIACAO })
    expect(envelope.estado).toBe(ESTADO.INCERTO)
  })

  it('504 REALTIME_TIMEOUT: INCERTO só na criação', () => {
    const criacao = mapearErroWm({ resultado: res({ status: 504, erroWm: 'REALTIME_TIMEOUT' }), operacao: OPERACAO.CRIACAO })
    expect(criacao.envelope.estado).toBe(ESTADO.INCERTO)
    expect(criacao.envelope.codigo).toBe(CODIGOS.RESULTADO_INCERTO)

    const preparo = mapearErroWm({ resultado: res({ status: 504, erroWm: 'REALTIME_TIMEOUT' }), operacao: OPERACAO.PREPARACAO })
    expect(preparo.envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    expect(preparo.envelope.codigo).toBe(CODIGOS.TIMEOUT)
  })

  it('409 COMANDO_NAO_REEXECUTADO e RESULTADO_INCERTO seguem INCERTO (D10)', () => {
    for (const erroWm of ['COMANDO_NAO_REEXECUTADO', 'RESULTADO_INCERTO']) {
      const { envelope, interno } = mapearErroWm({ resultado: res({ status: 409, erroWm }), operacao: OPERACAO.CRIACAO })
      expect(envelope.estado).toBe(ESTADO.INCERTO)
      expect(interno.httpStatusLocal).toBe(409)
      expect(interno.alertaOperacional).toBe(true)
    }
  })

  it('409 COMANDO_ID_REUTILIZADO é falha segura deste payload, com alerta crítico', () => {
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 409, erroWm: 'COMANDO_ID_REUTILIZADO' }),
      operacao: OPERACAO.CRIACAO,
    })
    // Este payload não foi executado pela WM; o alerta existe porque divergir de um comando_id
    // já usado é bug local — nunca reenviar.
    expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    expect(envelope.codigo).toBe(CODIGOS.COMANDO_ID_REUTILIZADO)
    expect(interno.alertaOperacional).toBe(true)
    expect(envelope.mensagem).toMatch(/não pode ser reenviado/i)
  })

  it('ORCAMENTO_DADOS_ALTERADOS é recusa ANTES da escrita: FALHA_SEGURA até na criação', () => {
    // §11 do guia da 2ª remessa: os dados mudaram entre a prévia e a criação, então nada foi
    // gravado. Se este erro virasse INCERTO, o atendente ficaria preso no fluxo de verificação
    // em vez de simplesmente recalcular a prévia.
    const { envelope, interno } = mapearErroWm({
      resultado: res({ status: 409, erroWm: 'ORCAMENTO_DADOS_ALTERADOS' }),
      operacao: OPERACAO.CRIACAO,
    })
    expect(envelope.codigo).toBe(CODIGOS.ORCAMENTO_DADOS_ALTERADOS)
    expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    expect(interno.httpStatusLocal).toBe(409)
    // A orientação é repreparar e confirmar de novo — NUNCA "tentar de novo" o mesmo comando.
    expect(envelope.mensagem).toMatch(/prévia de novo/i)
    expect(envelope.mensagem).not.toMatch(/tente de novo|reenvi/i)
  })

  it('ORCAMENTO_DADOS_ALTERADOS é mapeado por CÓDIGO, não por status', () => {
    // O guia descreve o erro sem fixar o HTTP: a tabela dele põe recusa de ERP em 502 e
    // conflito de comando em 409. Em qualquer um dos dois o resultado local é o mesmo — e sem o
    // mapeamento por código, o 409 cairia no ramo padrão e viraria INCERTO na criação.
    for (const status of [400, 409, 422, 502, 503]) {
      const { envelope } = mapearErroWm({
        resultado: res({ status, erroWm: 'ORCAMENTO_DADOS_ALTERADOS' }),
        operacao: OPERACAO.CRIACAO,
      })
      expect(envelope.codigo).toBe(CODIGOS.ORCAMENTO_DADOS_ALTERADOS)
      expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    }
    // E o ramo padrão do 409 desconhecido continua INCERTO na criação — nada foi afrouxado.
    const desconhecido = mapearErroWm({
      resultado: res({ status: 409, erroWm: 'OUTRO_CONFLITO_QUALQUER' }),
      operacao: OPERACAO.CRIACAO,
    })
    expect(desconhecido.envelope.estado).toBe(ESTADO.INCERTO)
  })

  it('2xx com corpo fora do contrato: INCERTO na criação, FALHA_SEGURA no resto', () => {
    const criacao = mapearErroWm({ resultado: res({ status: 200, respostaInvalida: true }), operacao: OPERACAO.CRIACAO })
    expect(criacao.envelope.estado).toBe(ESTADO.INCERTO)
    expect(criacao.envelope.codigo).toBe(CODIGOS.RESULTADO_INCERTO)

    const leitura = mapearErroWm({ resultado: res({ status: 200, respostaInvalida: true }), operacao: OPERACAO.LEITURA })
    expect(leitura.envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    expect(leitura.envelope.codigo).toBe(CODIGOS.RESPOSTA_INVALIDA)
  })

  it('5xx desconhecido na criação é INCERTO; em leitura é FALHA_SEGURA', () => {
    const criacao = mapearErroWm({ resultado: res({ status: 500 }), operacao: OPERACAO.CRIACAO })
    expect(criacao.envelope.estado).toBe(ESTADO.INCERTO)

    const leitura = mapearErroWm({ resultado: res({ status: 500 }), operacao: OPERACAO.LEITURA })
    expect(leitura.envelope.estado).toBe(ESTADO.FALHA_SEGURA)
  })

  it('502 e 503 nomeados são pré-escrita: FALHA_SEGURA mesmo na criação', () => {
    for (const erroWm of ['CLIENTE_INVALIDO', 'SINCRONIZADOR_OFFLINE']) {
      const status = erroWm === 'SINCRONIZADOR_OFFLINE' ? 503 : 502
      const { envelope } = mapearErroWm({ resultado: res({ status, erroWm }), operacao: OPERACAO.CRIACAO })
      expect(envelope.estado).toBe(ESTADO.FALHA_SEGURA)
    }
  })

  it('usa a operação do próprio resultado quando o chamador não passa', () => {
    const { envelope } = mapearErroWm({ resultado: res({ operacao: 'criacao', transporte: 'timeout' }) })
    expect(envelope.estado).toBe(ESTADO.INCERTO)
  })

  it('todo estado devolvido é terminal-ou-válido na máquina de estados', () => {
    const estados = new Set()
    for (const caso of NOMEADOS) {
      for (const operacao of Object.values(OPERACAO)) {
        estados.add(mapearErroWm({ resultado: res(caso), operacao }).envelope.estado)
      }
    }
    for (const e of estados) expect(stateMachine.TODOS_OS_ESTADOS).toContain(e)
  })
})
