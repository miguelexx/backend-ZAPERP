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
})
