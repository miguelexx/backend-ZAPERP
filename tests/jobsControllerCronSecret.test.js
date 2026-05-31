describe('jobsController.checkCronSecret', () => {
  const ORIGINAL_ENV = process.env

  function createRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
  }

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('bloqueia endpoint manual sem CRON_SECRET configurado', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: '' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: {} }, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejeita X-Cron-Secret incorreto', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'secret-a' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: { 'x-cron-secret': 'secret-b' } }, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('aceita X-Cron-Secret correto', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'secret-a' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: { 'x-cron-secret': 'secret-a' } }, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})
