const fs = require('fs')
const path = require('path')
const request = require('supertest')
const app = require('../app')
const { ensureUploadsRootExists } = require('../config/uploadsRoot')

describe('entrega publica de video para a UltraMSG', () => {
  test('MP4 sai inline com Content-Type video/mp4 e aceita Range', async () => {
    const uploadsRoot = ensureUploadsRootExists()
    const fileName = `video-header-${Date.now()}.mp4`
    const filePath = path.join(uploadsRoot, fileName)
    fs.writeFileSync(filePath, Buffer.from('fake-mp4-content'))

    try {
      const response = await request(app)
        .get(`/uploads/${fileName}`)
        .set('Range', 'bytes=0-3')

      expect(response.status).toBe(206)
      expect(response.headers['content-type']).toMatch(/^video\/mp4/i)
      expect(response.headers['content-disposition']).toBeUndefined()
      expect(response.headers['accept-ranges']).toBe('bytes')
      expect(response.headers['content-range']).toMatch(/^bytes 0-3\//)
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
  })
})
