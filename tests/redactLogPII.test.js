/**
 * Redacao de dados pessoais em log (doc 29 §3 item 15).
 *
 * POR QUE EXISTE: o caminho de inbound logava, em TODA mensagem recebida, o telefone
 * COMPLETO do cliente e os primeiros 50 caracteres do texto da mensagem. Isso e conteudo
 * de conversa de cliente replicado no log, onde fica fora de qualquer controle de acesso
 * do produto e sem retencao definida. O conteudo JA esta na tabela `mensagens`: logar
 * outra vez nao acrescenta diagnostico, so exposicao.
 *
 * Alem das funcoes, este teste trava a POLITICA no caminho quente: um `console.log` que
 * volte a passar `phone`/`texto` crus nas linhas de inbound reprova aqui.
 */

const fs = require('fs')
const path = require('path')
const { telefoneParaLog, textoParaLog, nomeParaLog } = require('../helpers/redactLogPII')

describe('redactLogPII — telefoneParaLog', () => {
  it('mantem apenas os 4 ultimos digitos', () => {
    expect(telefoneParaLog('5511987654321')).toBe('****4321')
  })

  it('normaliza formatacao antes de cortar', () => {
    expect(telefoneParaLog('+55 (11) 98765-4321')).toBe('****4321')
  })

  it('nunca devolve o numero completo', () => {
    const completo = '5511987654321'
    expect(telefoneParaLog(completo)).not.toContain('98765')
    expect(telefoneParaLog(completo).replace(/\D/g, '').length).toBeLessThanOrEqual(4)
  })

  it('aguenta ausente, vazio e nao-digitos', () => {
    expect(telefoneParaLog(null)).toBe('****????')
    expect(telefoneParaLog(undefined)).toBe('****????')
    expect(telefoneParaLog('')).toBe('****????')
    expect(telefoneParaLog('abc')).toBe('****????')
  })

  it('numero mais curto que 4 digitos nao quebra', () => {
    expect(telefoneParaLog('12')).toBe('****12')
  })
})

describe('redactLogPII — textoParaLog', () => {
  it('devolve o tamanho, nunca o conteudo', () => {
    const segredo = 'o pix da empresa e 12345678900'
    const saida = textoParaLog(segredo)
    expect(saida).toBe(`txt:${segredo.length}`)
    expect(saida).not.toContain('pix')
    expect(saida).not.toContain('12345678900')
  })

  it('distingue vazio de ausente (util para diagnostico)', () => {
    expect(textoParaLog('')).toBe('txt:0')
    expect(textoParaLog(null)).toBe('txt:-')
    expect(textoParaLog(undefined)).toBe('txt:-')
  })

  it('nao vaza conteudo de valor nao-string', () => {
    expect(textoParaLog({ segredo: 'abc' })).toMatch(/^txt:\d+$/)
  })
})

describe('redactLogPII — nomeParaLog', () => {
  it('devolve inicial e tamanho, nunca o nome completo', () => {
    expect(nomeParaLog('Claudia DB')).toBe('C.(10)')
    expect(nomeParaLog('Claudia DB')).not.toContain('laudia')
  })

  it('aguenta ausente e vazio', () => {
    expect(nomeParaLog(null)).toBe('-')
    expect(nomeParaLog('')).toBe('-')
  })
})

describe('politica: o log de inbound nao leva telefone nem texto crus', () => {
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'webhookZapiController.js'),
    'utf8'
  )

  it('o helper esta realmente importado (nao so citado em comentario)', () => {
    // Esta assercao existe porque a primeira tentativa inseriu o comentario e NAO o
    // require: o guard "o arquivo ja menciona redactLogPII" casou com o proprio comentario.
    expect(fonte).toMatch(
      /const \{[^}]*telefoneParaLog[^}]*\} = require\('\.\.\/helpers\/redactLogPII'\)/
    )
  })

  it('nao resta recorte do texto da mensagem', () => {
    expect(fonte).not.toContain('texto?.slice(0, 50)')
    expect(fonte).not.toContain('texto.slice(0, 50)')
  })

  it('as duas linhas de "mensagem recebida" passam pelos redatores', () => {
    const marcadores = [
      ['grupo', "'📩 Z-API [GRUPO]'"],
      ['privada', "'📩 ULTRAMSG mensagem recebida:'"],
    ]
    for (const [rotulo, marcador] of marcadores) {
      const i = fonte.indexOf(marcador)
      expect(i).toBeGreaterThan(-1)
      // Janela de argumentos depois do marcador. Nao se tenta equilibrar parenteses (foi o
      // que quebrou a primeira versao deste teste): verifica-se cada ocorrencia de `phone`
      // / `texto` e exige-se que venha imediatamente depois de um redator.
      const janela = fonte.slice(i, i + 400)
      expect(janela).toContain('telefoneParaLog(')
      expect(janela).toContain('textoParaLog(')

      const crus = []
      const re = /\b(phone|texto)\b/g
      let m
      while ((m = re.exec(janela)) !== null) {
        const antes = janela.slice(Math.max(0, m.index - 8), m.index)
        if (!antes.endsWith('ParaLog(')) crus.push(`${rotulo}: ${m[1]} em @${m.index}`)
      }
      expect(crus).toEqual([])
    }
  })
})

describe('politica: conversationSync nao loga telefone cru', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'conversationSync.js'), 'utf8')

  it('o helper esta importado', () => {
    expect(fonte).toMatch(/const \{[^}]*telefoneParaLog[^}]*\} = require\('\.\/redactLogPII'\)/)
  })

  it('nenhum console.* passa identificador de telefone sem redator', () => {
    // Varre TODAS as chamadas de console do arquivo. Pega qualquer log novo que volte a
    // levar telefone cru — e nao so' as 6 linhas que foram corrigidas.
    const RISCO = ['phoneStr', 'telefoneCanonico', 'conv.telefone', 'created.telefone']
    const crus = []
    const chamadas = fonte.match(/console\.(log|warn|error|info)\([\s\S]{0,300}?\)\s*$/gm) || []
    for (const chamada of chamadas) {
      // Remove as formas que NAO revelam o numero, antes de varrer. Sem isto, a contagem
      // de digitos dava falso positivo (foi o que aconteceu na 1a versao deste teste):
      // `String(phoneStr || '').replace(/\D/g, '').length` nao emite o telefone, so' o
      // tamanho — que e justamente o diagnostico util quando a normalizacao falha.
      const seguro = chamada
        .replace(/telefoneParaLog\([^)]*\)/g, '')
        // Qualquer expressao que termine em `.length` entrega TAMANHO, nao o numero.
        // (A 1a versao tentou casar `/\D/g` literalmente e falhou: num literal de regex,
        // `\D` e a classe "nao-digito", nao o texto. E o `\b` que eu tinha posto virou um
        // caractere de backspace no arquivo, quebrando a terceira substituicao em silencio.)
        .replace(/String\([^)]*\)[\s\S]{0,40}?\.length/g, '')
        .replace(/[\w.]+\.length/g, '')
      for (const ident of RISCO) {
        if (seguro.includes(ident)) {
          crus.push(`${ident} em: ${chamada.slice(0, 90).replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(crus).toEqual([])
  })

  it('os dois logs do caminho quente ficam atras de WHATSAPP_DEBUG', () => {
    // Corriam em TODA mensagem no caminho de SUCESSO: um com o canonico e todas as
    // variantes, outro com o telefone da conversa. Sao diagnostico, nao operacao.
    expect(fonte).toMatch(/if \(WHATSAPP_DEBUG\) console\.log\(`\[findOrCreateConversation\][^`]*canonical=/)
    expect(fonte).toMatch(/if \(WHATSAPP_DEBUG\) console\.log\(`\[findOrCreateConversation\][^`]*phone_db=/)
    expect(fonte).toMatch(/const WHATSAPP_DEBUG = String\(process\.env\.WHATSAPP_DEBUG/)
  })

  it('as variantes deixam de ser enumeradas (eram varios telefones por linha)', () => {
    expect(fonte).not.toContain("variants=[${variants.join(',')}]")
    expect(fonte).toContain('variants=${variants.length}')
  })
})
