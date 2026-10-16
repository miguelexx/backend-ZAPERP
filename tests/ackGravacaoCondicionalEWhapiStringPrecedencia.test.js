/**
 * F2 e F3 da auditoria das setas (doc 33).
 *
 * F2 — `mapWhapiAckToStatus`: a STRING do campo `status` manda; `code` é só fallback.
 * F3 — `patchMensagemStatusById`: a gravação do ACK é CONDICIONAL (`status NOT IN (...)`), então
 *      ACK concorrente não rebaixa o tique — e, quando a guarda não casa por motivo que não é
 *      regressão (status NULL/desconhecido), ela cai na gravação sem guarda em vez de perder o ACK.
 */

const {
  gravacaoDeStatusBloqueada,
  statusesQueBloqueiamGravacao,
  STATUS_ALIASES,
  canonStatusForEmit,
} = require('../helpers/messageStatusHelper')

/**
 * Supabase de mentira com UMA tabela em memória que HONRA o `NOT IN` do update — sem isso o
 * teste da guarda não provaria nada (um mock que ignora o predicado sempre "passa").
 */
function fakeSupabase(linhas) {
  const estado = new Map(linhas.map((l) => [l.id, { ...l }]))
  const consultas = []

  function builder(tabela, modo, patch) {
    const filtros = { eq: {}, notIn: null }
    const api = {
      eq(col, val) { filtros.eq[col] = val; return api },
      not(col, op, lista) {
        if (op !== 'in') throw new Error(`operador não suportado no fake: ${op}`)
        filtros.notIn = { col, valores: String(lista).replace(/^\(|\)$/g, '').split(',') }
        return api
      },
      select() { return api },
      is(col, val) { filtros.eq[col] = val; return api },
      order() { return api },
      limit(n) { filtros.limite = n; return api },
      // selectSingleMensagemByWhatsappId faz `await query` (lista), não maybeSingle.
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const rows = [...estado.values()].filter((r) =>
              Object.entries(filtros.eq).every(([c, v]) => (v === null ? r[c] == null : String(r[c]) === String(v)))
            )
            consultas.push({ tabela, modo, filtros: JSON.parse(JSON.stringify(filtros)), lista: true })
            return { data: rows.slice(0, filtros.limite || rows.length), error: null }
          })
          .then(resolve, reject)
      },
      async maybeSingle() {
        const alvo = estado.get(filtros.eq.id)
        const casaEq = alvo && Object.entries(filtros.eq).every(([c, v]) => String(alvo[c]) === String(v))
        let casa = Boolean(casaEq)
        if (casa && filtros.notIn) {
          const atual = alvo[filtros.notIn.col]
          // Semântica SQL: NULL NOT IN (...) não casa.
          casa = atual != null && !filtros.notIn.valores.includes(String(atual))
        }
        consultas.push({ tabela, modo, filtros: JSON.parse(JSON.stringify(filtros)), casou: casa })
        if (!casa) return { data: null, error: null }
        if (modo === 'update') Object.assign(alvo, patch)
        return { data: { ...alvo }, error: null }
      },
    }
    return api
  }

  return {
    estado,
    consultas,
    from(tabela) {
      return {
        update: (patch) => builder(tabela, 'update', patch),
        select: () => builder(tabela, 'select'),
      }
    },
  }
}

const { patchMensagemStatusById, updateSingleMensagemByWhatsappId } =
  require('../controllers/webhookInbound/whatsappIdLookup')

const SELECT = 'id, conversa_id, company_id, autor_usuario_id, whatsapp_id'

function linha(extra = {}) {
  return { id: 9, company_id: 1, conversa_id: 2, autor_usuario_id: 4, whatsapp_id: 'WAMID-1', status: 'sent', status_mensagem: 'sent', ...extra }
}

describe('F3 — lista de bloqueio derivada da regra de não-regressão', () => {
  test('cada apelido da lista continua canonizando (não deixa a lista divergir do normalizador)', () => {
    // O que importa: NENHUM apelido da lista pode cair fora do conjunto canônico. Se alguém
    // tirar um apelido de `normalizeRawAckStatus` e esquecer esta lista, ele passa a canonizar
    // para si mesmo (rank -1) e entraria errado na guarda SQL — este teste quebra antes disso.
    for (const alias of STATUS_ALIASES) {
      expect(['pending', 'sent', 'delivered', 'read', 'played', 'erro']).toContain(canonStatusForEmit(alias))
    }
  })

  test('bloqueia só o que é estritamente mais avançado', () => {
    expect(statusesQueBloqueiamGravacao('delivered')).toEqual(
      expect.arrayContaining(['read', 'lida', 'seen', 'visualizada', 'read_by_me', '3', 'played', '4'])
    )
    expect(statusesQueBloqueiamGravacao('delivered')).not.toEqual(expect.arrayContaining(['sent', 'pending', 'erro']))
    expect(statusesQueBloqueiamGravacao('played')).toEqual([])
  })

  test('erro segue a regra do ACK: barrado por sent+, liberado sobre pending/erro', () => {
    expect(gravacaoDeStatusBloqueada('sent', 'erro')).toBe(true)
    expect(gravacaoDeStatusBloqueada('read', 'erro')).toBe(true)
    expect(gravacaoDeStatusBloqueada('pending', 'erro')).toBe(false)
    expect(gravacaoDeStatusBloqueada('erro', 'erro')).toBe(false)
    expect(gravacaoDeStatusBloqueada('erro', 'sent')).toBe(false)
  })

  test('status atual desconhecido, nulo ou vazio NUNCA bloqueia', () => {
    expect(gravacaoDeStatusBloqueada('queued', 'sent')).toBe(false)
    expect(gravacaoDeStatusBloqueada(null, 'read')).toBe(false)
    expect(gravacaoDeStatusBloqueada('', 'read')).toBe(false)
  })
})

describe('F3 — gravação condicional do ACK', () => {
  test('ACK que avança grava normalmente', async () => {
    const sb = fakeSupabase([linha({ status: 'sent', status_mensagem: 'sent' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT })
    expect(r.bloqueadoPorRegressao).toBe(false)
    expect(r.data.status).toBe('delivered')
    expect(sb.estado.get(9).status_mensagem).toBe('delivered')
  })

  test('ACK atrasado NÃO rebaixa: linha em read recusa delivered e devolve o status vencedor', async () => {
    const sb = fakeSupabase([linha({ status: 'read', status_mensagem: 'read' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT })
    expect(r.bloqueadoPorRegressao).toBe(true)
    expect(r.data.status).toBe('read')
    expect(sb.estado.get(9).status).toBe('read')
  })

  test('a guarda vai mesmo no UPDATE (é atômica, não um if em JS)', async () => {
    const sb = fakeSupabase([linha({ status: 'sent' })])
    await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT })
    const upd = sb.consultas.find((c) => c.modo === 'update')
    expect(upd.filtros.notIn).not.toBeNull()
    expect(upd.filtros.notIn.valores).toEqual(expect.arrayContaining(['read', 'played']))
  })

  test('status NULL cai na gravação SEM guarda (NULL NOT IN não casa) — ACK não se perde', async () => {
    const sb = fakeSupabase([linha({ status: null, status_mensagem: null })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'read', select: SELECT })
    expect(r.bloqueadoPorRegressao).toBe(false)
    expect(sb.estado.get(9).status).toBe('read')
    // 1ª tentativa com guarda (não casou) → releitura → 2ª tentativa sem guarda.
    expect(sb.consultas.filter((c) => c.modo === 'update')).toHaveLength(2)
    expect(sb.consultas.filter((c) => c.modo === 'update')[1].filtros.notIn).toBeNull()
  })

  test('status legado desconhecido também grava (não vira ACK perdido)', async () => {
    const sb = fakeSupabase([linha({ status: 'queued', status_mensagem: 'queued' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT })
    expect(r.bloqueadoPorRegressao).toBe(false)
    expect(sb.estado.get(9).status).toBe('delivered')
  })

  test('mensagem inexistente continua "não encontrada" (não vira bloqueio)', async () => {
    const sb = fakeSupabase([])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'read', select: SELECT })
    expect(r.data).toBeNull()
    expect(r.bloqueadoPorRegressao).toBe(false)
  })

  test('status igual ao gravado passa (no-op) para o chamador ainda achar a linha', async () => {
    const sb = fakeSupabase([linha({ status: 'delivered', status_mensagem: 'delivered' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT })
    expect(r.bloqueadoPorRegressao).toBe(false)
    expect(r.data.id).toBe(9)
  })

  test('played não tem nada acima: grava direto, sem guarda', async () => {
    const sb = fakeSupabase([linha({ status: 'read' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'played', select: SELECT })
    expect(r.data.status).toBe('played')
    expect(sb.consultas.find((c) => c.modo === 'update').filtros.notIn).toBeNull()
  })

  test('guardarRegressao:false preserva a gravação incondicional (caminhos que não são ACK)', async () => {
    const sb = fakeSupabase([linha({ status: 'read' })])
    const r = await patchMensagemStatusById(sb, {
      company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: SELECT, guardarRegressao: false,
    })
    expect(r.data.status).toBe('delivered')
    expect(r.bloqueadoPorRegressao).toBe(false)
  })

  test('o select sempre traz `status`, mesmo quando o chamador não pediu', async () => {
    const sb = fakeSupabase([linha({ status: 'sent' })])
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', select: 'id, conversa_id' })
    expect(r.data.status).toBe('delivered')
  })
})

describe('F3 — updateSingleMensagemByWhatsappId só ganha guarda quando pedida', () => {
  test('com guardarRegressaoDeStatus: ACK atrasado é barrado e devolve bloqueadoPorRegressao', async () => {
    const sb = fakeSupabase([linha({ status: 'read', status_mensagem: 'read' })])
    const r = await updateSingleMensagemByWhatsappId(sb, {
      company_id: 1,
      whatsapp_id: 'WAMID-1',
      whatsapp_instance_id: null,
      updates: { status: 'delivered', status_mensagem: 'delivered' },
      select: SELECT,
      guardarRegressaoDeStatus: true,
    })
    expect(r.bloqueadoPorRegressao).toBe(true)
    expect(r.data.status).toBe('read')
    expect(sb.estado.get(9).status).toBe('read')
  })

  test('com guardarRegressaoDeStatus: ACK que avança grava', async () => {
    const sb = fakeSupabase([linha({ status: 'sent', status_mensagem: 'sent' })])
    const r = await updateSingleMensagemByWhatsappId(sb, {
      company_id: 1,
      whatsapp_id: 'WAMID-1',
      whatsapp_instance_id: null,
      updates: { status: 'read', status_mensagem: 'read' },
      select: SELECT,
      guardarRegressaoDeStatus: true,
    })
    expect(r.bloqueadoPorRegressao).toBe(false)
    expect(sb.estado.get(9).status).toBe('read')
  })

  test('update de EDIÇÃO (sem status) nunca recebe guarda', async () => {
    const sb = fakeSupabase([linha({ status: 'read' })])
    const r = await updateSingleMensagemByWhatsappId(sb, {
      company_id: 1,
      whatsapp_id: 'WAMID-1',
      whatsapp_instance_id: null,
      updates: { texto: 'editado', editada: true },
      select: SELECT,
    })
    expect(r.error).toBeFalsy()
    expect(sb.estado.get(9).texto).toBe('editado')
    expect(sb.estado.get(9).status).toBe('read')
    expect(sb.consultas.filter((c) => c.modo === 'update').every((c) => c.filtros.notIn == null)).toBe(true)
  })
})

describe('F2 — string do status tem precedência sobre o code', () => {
  const { mapWhapiAckToStatus, mapWhapiCodeToStatus, mapWhapiStatusStringToStatus, resetDivergenciasWhapiAck } =
    require('../controllers/webhookWhapiController')._test

  beforeEach(() => {
    // O aviso de divergência é limitado a 1x por combinação a cada 10 min: sem zerar, um teste
    // engole o aviso do outro.
    resetDivergenciasWhapiAck()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { jest.restoreAllMocks() })

  test('string e code concordando → o status oficial', () => {
    expect(mapWhapiAckToStatus('read', 4)).toBe('read')
    expect(mapWhapiAckToStatus('delivered', 3)).toBe('delivered')
    expect(mapWhapiAckToStatus('failed', 0)).toBe('erro')
  })

  test('DIVERGINDO, vale a string (era o contrário: o número descartava o campo documentado)', () => {
    expect(mapWhapiAckToStatus('read', 3)).toBe('read')
    expect(mapWhapiAckToStatus('read', 2)).toBe('read')
    expect(mapWhapiAckToStatus('read', 0)).toBe('read')
    expect(mapWhapiAckToStatus('failed', 4)).toBe('erro')
    expect(mapWhapiAckToStatus('delivered', 4)).toBe('delivered')
  })

  test('divergência vira aviso em log (sinal de contrato mudado)', () => {
    mapWhapiAckToStatus('read', 3)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('DIVERGENTES'),
      expect.objectContaining({ por_string: 'read', por_code: 'delivered' })
    )
  })

  test('string ausente ou desconhecida → usa o code', () => {
    expect(mapWhapiAckToStatus(undefined, 4)).toBe('read')
    expect(mapWhapiAckToStatus('', 2)).toBe('sent')
    expect(mapWhapiAckToStatus('coisa-nova', 5)).toBe('played')
  })

  test('número DENTRO do campo status é lido na escala da Whapi, não na do UltraMSG (F10)', () => {
    expect(mapWhapiAckToStatus('3', undefined)).toBe('delivered')
    expect(mapWhapiAckToStatus('2', undefined)).toBe('sent')
    expect(mapWhapiAckToStatus('4', undefined)).toBe('read')
  })

  test('sem string nem code reconhecíveis: devolve o cru (statusZapi ignora o que não canoniza)', () => {
    expect(mapWhapiAckToStatus('coisa-nova', undefined)).toBe('coisa-nova')
    expect(mapWhapiAckToStatus(undefined, undefined)).toBe('pending')
    expect(mapWhapiAckToStatus('coisa-nova', 99)).toBe('coisa-nova')
  })

  test('escala do code: 0..6 e nada fora dela', () => {
    // code 6 = deleted → sentinela de REVOGAÇÃO, não `erro` (F5 do doc 33).
    expect([0, 1, 2, 3, 4, 5, 6].map(mapWhapiCodeToStatus))
      .toEqual(['erro', 'pending', 'sent', 'delivered', 'read', 'played', 'revogada'])
    expect(mapWhapiCodeToStatus(7)).toBeNull()
    expect(mapWhapiCodeToStatus(null)).toBeNull()
    expect(mapWhapiCodeToStatus('')).toBeNull()
  })

  test('strings oficiais da Whapi, uma a uma', () => {
    // `deleted` é revogação; só `failed` é falha de envio (F5 do doc 33).
    expect(['pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted'].map(mapWhapiStatusStringToStatus))
      .toEqual(['pending', 'sent', 'delivered', 'read', 'played', 'erro', 'revogada'])
    expect(mapWhapiStatusStringToStatus('nao-existe')).toBeNull()
  })
})
