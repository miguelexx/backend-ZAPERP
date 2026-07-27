/**
 * Leitura do payload de GET /instance/status da UltraMsg.
 *
 * A API responde em formatos diferentes conforme a versão/instância. O mais comum e
 * documentado é ANINHADO:
 *   { "status": { "accountStatus": { "status": "authenticated", "substatus": "normal" } } }
 * mas também aparecem as formas planas:
 *   { "status": "authenticated" }   { "state": "connected" }   { "accountStatus": {...} }
 *
 * O código antigo fazia `String(data?.status ?? ...)` direto. Com a resposta aninhada isso
 * vira a string "[object object]", que não bate com nenhum estado conhecido — e o sistema
 * concluía DESCONECTADO com o WhatsApp funcionando normalmente, acendendo o banner
 * "mensagens não serão entregues" para o atendente sem motivo.
 *
 * Aqui a leitura entende todas as formas e, quando não reconhece nada, devolve
 * `indefinido: true` — quem chama trata "não sei" como "não acuse desconexão", em vez de
 * assumir o pior.
 */

/** Estados em que a instância entrega mensagem. */
const ESTADOS_CONECTADOS = ['authenticated', 'connected', 'standby', 'ready', 'online']

/** Estados em que a instância comprovadamente NÃO entrega. */
const ESTADOS_DESCONECTADOS = [
  'got qr code',
  'qr',
  'qrcode',
  'disconnected',
  'unpaired',
  'unpaired_idle',
  'not_authenticated',
  'unlaunched',
  'loading',
  'timeout',
  'blocked',
  'expired',
  'destroyed',
  'conflict',
]

function textoDeEstado(valor) {
  if (valor == null) return ''
  if (typeof valor === 'string') return valor.toLowerCase().trim()
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor).toLowerCase()
  return ''
}

/**
 * Procura o texto de estado nas formas conhecidas, da mais específica para a mais genérica.
 * Nunca faz varredura recursiva cega: campos desconhecidos ficam de fora de propósito,
 * para não capturar algo como um "status" de outra coisa e concluir errado.
 */
function extrairTextoStatus(data, text) {
  if (data && typeof data === 'object') {
    const caminhos = [
      data.status?.accountStatus?.status,
      data.status?.accountStatus?.substatus,
      data.accountStatus?.status,
      data.accountStatus?.substatus,
      data.status?.status,
      data.status,
      data.state,
      data.instance?.status,
      data.instance?.state,
      data.response?.status,
      data.response?.accountStatus?.status,
    ]
    for (const c of caminhos) {
      const t = textoDeEstado(c)
      if (t) return t
    }
  }
  return textoDeEstado(text)
}

/**
 * @param {any} data corpo JSON da resposta
 * @param {string} [text] corpo cru, quando a resposta não é JSON
 * @returns {{ statusText: string, connected: boolean, indefinido: boolean }}
 *   `indefinido` = a resposta não permitiu concluir nada (formato novo/inesperado).
 */
function lerStatusUltramsg(data, text) {
  const statusText = extrairTextoStatus(data, text)

  // Campo booleano explícito manda, quando existe.
  if (data && typeof data === 'object' && typeof data.connected === 'boolean') {
    return { statusText, connected: data.connected, indefinido: false }
  }

  if (statusText && ESTADOS_CONECTADOS.includes(statusText)) {
    return { statusText, connected: true, indefinido: false }
  }
  if (statusText && ESTADOS_DESCONECTADOS.includes(statusText)) {
    return { statusText, connected: false, indefinido: false }
  }

  // Nem conectado nem desconectado reconhecível: não dá para afirmar nada.
  return { statusText, connected: false, indefinido: true }
}

/** Resumo curto do payload para log — ajuda a descobrir formatos novos em produção. */
function resumirPayloadStatus(data, text) {
  try {
    if (data && typeof data === 'object') return JSON.stringify(data).slice(0, 300)
    return String(text || '').slice(0, 300)
  } catch {
    return '(payload não serializável)'
  }
}

module.exports = {
  lerStatusUltramsg,
  resumirPayloadStatus,
  ESTADOS_CONECTADOS,
  ESTADOS_DESCONECTADOS,
}
