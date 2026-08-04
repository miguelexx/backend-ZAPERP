/**
 * Reconciliacao do eco fromMe pelo referenceId crm-{id}.
 *
 * A busca e feita por company_id + id (chave primaria), entao filtrar tambem por
 * whatsapp_instance_id so gerava falso negativo quando um dos lados estava null:
 * o eco nao casava com a linha original e acabava virando mensagem duplicada no banco.
 * Divergencia real de instancia (ambos os lados conhecidos) continua bloqueada.
 */

const { _test } = require('../controllers/webhookZapiController')
const { tryReconcileFromMeByCrmReferenceId } = _test

const WA_ID_REAL = '3EB0C767D0A4F1B2A9C8D5E6'

function fakeSupabase(rowEncontrada) {
  const filtrosSelect = []

  const selectChain = {
    eq(coluna, valor) {
      filtrosSelect.push([coluna, valor])
      return selectChain
    },
    is(coluna, valor) {
      filtrosSelect.push([coluna, valor])
      return selectChain
    },
    maybeSingle: async () => ({ data: rowEncontrada, error: null }),
  }

  const updateChain = {
    updates: null,
    eq: () => updateChain,
    select: () => updateChain,
    maybeSingle: async () => ({
      data: rowEncontrada ? { ...rowEncontrada, ...updateChain.updates } : null,
      error: null,
    }),
  }

  return {
    filtrosSelect,
    updateChain,
    from: () => ({
      select: () => selectChain,
      update: (updates) => {
        updateChain.updates = updates
        return updateChain
      },
    }),
  }
}

const rowBase = {
  id: 777,
  company_id: 10,
  conversa_id: 55,
  direcao: 'out',
  whatsapp_id: '35096', // id de fila UltraMSG, ainda nao o id real
  status: 'pending',
}

test('reconcilia quando a linha tem instancia e o webhook nao resolveu instancia', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: 3 })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: null,
    payload: { referenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado?.id).toBe(777)
  expect(supabase.updateChain.updates.whatsapp_id).toBe(WA_ID_REAL)
  // Nao deve haver filtro por instancia na consulta.
  expect(supabase.filtrosSelect.map(([coluna]) => coluna)).toEqual(['company_id', 'id', 'direcao'])
})

test('reconcilia quando o webhook tem instancia e a linha e legada com instancia null', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: null })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 3,
    payload: { referenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado?.id).toBe(777)
})

test('bloqueia quando ambos conhecem a instancia e elas divergem', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: 3 })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 9,
    payload: { referenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado).toBeNull()
  expect(supabase.updateChain.updates).toBeNull()
})

test('reconcilia normalmente quando as duas instancias coincidem', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: 3 })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 3,
    payload: { ultramsgReferenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado?.id).toBe(777)
})

test('nao reconcilia quando a linha ja tem outro whatsapp_id real', async () => {
  const supabase = fakeSupabase({
    ...rowBase,
    whatsapp_instance_id: 3,
    whatsapp_id: '3EB0AAAAAAAAAAAAAAAAAAAA',
  })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 3,
    payload: { referenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado).toBeNull()
})

test('ignora payload sem referenceId crm', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: 3 })

  const resultado = await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 3,
    payload: { referenceId: 'algo-externo' },
    whatsappIdStr: WA_ID_REAL,
  })

  expect(resultado).toBeNull()
})

test('promove o status quando o ack do webhook e mais avancado que o persistido', async () => {
  const supabase = fakeSupabase({ ...rowBase, whatsapp_instance_id: 3 })

  await tryReconcileFromMeByCrmReferenceId(supabase, {
    company_id: 10,
    conversa_id: 55,
    whatsapp_instance_id: 3,
    payload: { referenceId: 'crm-777' },
    whatsappIdStr: WA_ID_REAL,
    statusPayload: 'delivered',
  })

  expect(supabase.updateChain.updates.status).toBe('delivered')
})
