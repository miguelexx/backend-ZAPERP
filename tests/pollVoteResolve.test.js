/**
 * Resolução de IDs de voto de enquete Whapi (SHA-256 base64 → texto).
 */
const {
  pollOptionHash,
  looksLikePollOptionHash,
  resolvePollVoteLabels,
  buildPollOptionIdMap,
} = require('../helpers/pollVoteResolve')

describe('pollVoteResolve', () => {
  test('pollOptionHash é estável (SHA-256 base64)', () => {
    expect(pollOptionHash('1')).toBe('a4ayc/80/OGda4BO/1o/V0etpOqiLx1JwB5S3beHW0s=')
    expect(pollOptionHash('Suporte')).toBe(pollOptionHash('Suporte'))
  })

  test('resolvePollVoteLabels mapeia hash → opção', () => {
    const options = ['Suporte', 'Financeiro']
    const votes = [pollOptionHash('Financeiro')]
    expect(resolvePollVoteLabels(votes, options)).toEqual(['Financeiro'])
  })

  test('resolvePollVoteLabels usa results[].id/name do Whapi', () => {
    const results = [
      { name: 'Option 1', id: 'abc=' },
      { name: 'Option 2', id: 'def=' },
    ]
    expect(resolvePollVoteLabels(['def='], results)).toEqual(['Option 2'])
  })

  test('texto legível passa direto; hash sem match some', () => {
    expect(resolvePollVoteLabels(['Financeiro'], ['A', 'B'])).toEqual(['Financeiro'])
    expect(resolvePollVoteLabels([pollOptionHash('Zzz')], ['A'])).toEqual([])
  })

  test('looksLikePollOptionHash e buildPollOptionIdMap', () => {
    expect(looksLikePollOptionHash(pollOptionHash('1'))).toBe(true)
    expect(looksLikePollOptionHash('oi')).toBe(false)
    expect(buildPollOptionIdMap(['A', 'B'])).toEqual([
      { name: 'A', id: pollOptionHash('A') },
      { name: 'B', id: pollOptionHash('B') },
    ])
  })
})
