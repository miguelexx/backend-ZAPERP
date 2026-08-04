const { fetchWithRetry } = require('../helpers/retryWithBackoff')

describe('fetchWithRetry', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test('retenta GET em erro temporario HTTP', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 200 })

    const res = await fetchWithRetry('https://api.example.test/status', { method: 'GET' }, { baseDelayMs: 0 })

    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  test('nao retenta POST por padrao para evitar duplicidade de envio', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500 })

    const res = await fetchWithRetry('https://api.example.test/messages/chat', { method: 'POST' }, { baseDelayMs: 0 })

    expect(res.status).toBe(500)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('nao retenta erro de rede em POST por padrao', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'))

    await expect(
      fetchWithRetry('https://api.example.test/messages/chat', { method: 'POST' }, { baseDelayMs: 0 })
    ).rejects.toThrow('socket hang up')

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('permite retry de POST somente quando chamada declara idempotencia', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 200 })

    const res = await fetchWithRetry(
      'https://api.example.test/idempotent-post',
      { method: 'POST' },
      { baseDelayMs: 0, idempotent: true }
    )

    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  describe('retryConnectionErrors em POST de envio', () => {
    function erroDeConexao(code) {
      const err = new TypeError('fetch failed')
      err.cause = Object.assign(new Error(code), { code })
      return err
    }

    test('retenta quando a conexao nunca foi estabelecida', async () => {
      global.fetch = jest.fn()
        .mockRejectedValueOnce(erroDeConexao('ECONNREFUSED'))
        .mockRejectedValueOnce(erroDeConexao('EAI_AGAIN'))
        .mockResolvedValueOnce({ status: 200 })

      const res = await fetchWithRetry(
        'https://api.ultramsg.test/messages/chat',
        { method: 'POST' },
        { baseDelayMs: 0, maxAttempts: 3, retryConnectionErrors: true }
      )

      expect(res.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(3)
    })

    test('nao retenta timeout: mensagem pode ter sido aceita e duplicaria no cliente', async () => {
      const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      global.fetch = jest.fn().mockRejectedValue(timeout)

      await expect(
        fetchWithRetry(
          'https://api.ultramsg.test/messages/chat',
          { method: 'POST' },
          { baseDelayMs: 0, maxAttempts: 3, retryConnectionErrors: true }
        )
      ).rejects.toThrow('The operation was aborted')

      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    test('nao retenta ECONNRESET: requisicao pode ter sido processada', async () => {
      global.fetch = jest.fn().mockRejectedValue(erroDeConexao('ECONNRESET'))

      await expect(
        fetchWithRetry(
          'https://api.ultramsg.test/messages/chat',
          { method: 'POST' },
          { baseDelayMs: 0, maxAttempts: 3, retryConnectionErrors: true }
        )
      ).rejects.toThrow()

      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    test('nao retenta por status HTTP: resposta recebida significa envio processado', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 502 })

      const res = await fetchWithRetry(
        'https://api.ultramsg.test/messages/chat',
        { method: 'POST' },
        { baseDelayMs: 0, maxAttempts: 3, retryConnectionErrors: true }
      )

      expect(res.status).toBe(502)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })
  })
})
