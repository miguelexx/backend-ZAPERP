/**
 * `nova_mensagem` do inbound tem que alcançar quem está com a conversa ABERTA.
 *
 * Caso real (21/10/2026): o card mostrava a última mensagem do cliente (12:34) e a thread parava
 * na anterior (12:33). O emit escopado ia SÓ para as salas `usuario_*`, montadas a partir de uma
 * lista com cache de 15s (CONVERSA_VISIBILITY_CACHE_TTL_MS). Com a lista vencida — ou montada
 * antes de uma mudança de atribuição/setor — o atendente que estava OLHANDO a conversa não recebia
 * a mensagem dela. O card se curava sozinho (qualquer refetch da lista traz o preview da API); a
 * thread não tem nada equivalente e ficava mentindo.
 *
 * Entrar em `conversa_${id}` já exige `canUserJoinConversationRoom` (socket/conversationRooms.js),
 * então incluir essa sala não alcança ninguém que já não pudesse abrir a conversa.
 */

const { _test } = require('../services/chat/realtime/chatRealtimeGateway')
const { buildRoomsConversaEUsuarios } = _test

describe('salas de um evento escopado à conversa', () => {
  test('inclui a sala da CONVERSA, não só as dos usuários', () => {
    expect(buildRoomsConversaEUsuarios(4242, [7, 9])).toEqual([
      'conversa_4242',
      'usuario_7',
      'usuario_9',
    ])
  })

  test('o caso do print: lista desatualizada sem o atendente que está com a conversa aberta', () => {
    // O usuário 42 não está na lista cacheada, mas está na sala da conversa porque a abriu (e
    // passou pela autorização do join). Antes desta correção ele não recebia nada.
    const rooms = buildRoomsConversaEUsuarios(777, [99])
    expect(rooms).toContain('conversa_777')
  })

  test('lista vazia ainda entrega para quem está com a conversa aberta', () => {
    expect(buildRoomsConversaEUsuarios(10, [])).toEqual(['conversa_10'])
  })

  test('ids inválidos não viram sala de usuário; a sala da conversa permanece', () => {
    expect(buildRoomsConversaEUsuarios(60, [0, -3, NaN, null, undefined, '8'])).toEqual([
      'conversa_60',
      'usuario_8',
    ])
  })

  test('conversa inválida não cria sala de conversa (não inventa room)', () => {
    expect(buildRoomsConversaEUsuarios(null, [5])).toEqual(['usuario_5'])
    expect(buildRoomsConversaEUsuarios(0, [5])).toEqual(['usuario_5'])
    expect(buildRoomsConversaEUsuarios('abc', [5])).toEqual(['usuario_5'])
  })

  test('entrada vazia não quebra', () => {
    expect(buildRoomsConversaEUsuarios(null, null)).toEqual([])
    expect(buildRoomsConversaEUsuarios(undefined, undefined)).toEqual([])
  })

  test('continua sendo UMA lista só — o payload é serializado uma vez no caminho quente', () => {
    const rooms = buildRoomsConversaEUsuarios(10, [1, 2, 3, 4, 5])
    expect(rooms).toHaveLength(6) // 5 usuários + a conversa
    expect(new Set(rooms).size).toBe(6) // sem sala repetida
  })
})
