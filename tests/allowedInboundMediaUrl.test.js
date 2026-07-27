const { isAllowedInboundMediaUrl } = require('../helpers/allowedInboundMediaUrl')

describe('isAllowedInboundMediaUrl', () => {
  const u = (href) => new URL(href)

  test('permite bucket/path UltraMsg legítimos em S3', () => {
    expect(isAllowedInboundMediaUrl(u('https://ultramsgmedia.s3.amazonaws.com/file.ogg'))).toBe(true)
    expect(
      isAllowedInboundMediaUrl(u('https://s3.amazonaws.com/ultramsgmedia/abc/file.jpg'))
    ).toBe(true)
    expect(
      isAllowedInboundMediaUrl(u('https://ultramsg-foo.s3.us-east-1.amazonaws.com/x.bin'))
    ).toBe(true)
  })

  test('bloqueia host S3 com substring ultramsg no meio (SSRF)', () => {
    expect(
      isAllowedInboundMediaUrl(u('https://evil-ultramsg.s3.amazonaws.com/payload.bin'))
    ).toBe(false)
    expect(
      isAllowedInboundMediaUrl(u('https://attackerultramsg.s3.amazonaws.com/x'))
    ).toBe(false)
  })

  test('CloudFront exige path /ultramsgmedia/', () => {
    expect(
      isAllowedInboundMediaUrl(u('https://d111.cloudfront.net/ultramsgmedia/a.ogg'))
    ).toBe(true)
    expect(
      isAllowedInboundMediaUrl(u('https://d111.cloudfront.net/other/ultramsg-trick.ogg'))
    ).toBe(false)
  })

  test('bloqueia http, localhost e IPs privados', () => {
    expect(isAllowedInboundMediaUrl(u('http://files.ultramsg.com/a.ogg'))).toBe(false)
    expect(isAllowedInboundMediaUrl(u('https://127.0.0.1/a.ogg'))).toBe(false)
    expect(isAllowedInboundMediaUrl(u('https://10.0.0.5/a.ogg'))).toBe(false)
  })
})
