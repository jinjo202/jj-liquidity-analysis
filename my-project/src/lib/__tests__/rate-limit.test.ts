import { describe, it, expect } from 'vitest'
import { checkRateLimit, resetRateLimit, checkGlobalDailyLimit, resetGlobalDailyLimit } from '@/lib/rate-limit'

describe('checkRateLimit', () => {
  it('한도 안에서는 통과', () => {
    resetRateLimit()
    expect(checkRateLimit('a', 1000, 3, 60_000)).toBe(true)
    expect(checkRateLimit('a', 1100, 3, 60_000)).toBe(true)
    expect(checkRateLimit('a', 1200, 3, 60_000)).toBe(true)
  })

  it('한도를 넘으면 막는다', () => {
    resetRateLimit()
    checkRateLimit('b', 1000, 2, 60_000)
    checkRateLimit('b', 1100, 2, 60_000)
    expect(checkRateLimit('b', 1200, 2, 60_000)).toBe(false)
  })

  it('윈도우가 지나면 다시 통과', () => {
    resetRateLimit()
    checkRateLimit('c', 1000, 1, 60_000)
    expect(checkRateLimit('c', 2000, 1, 60_000)).toBe(false)
    expect(checkRateLimit('c', 62_000, 1, 60_000)).toBe(true)
  })

  it('키가 다르면 서로 영향 없음', () => {
    resetRateLimit()
    checkRateLimit('d', 1000, 1, 60_000)
    expect(checkRateLimit('e', 1000, 1, 60_000)).toBe(true)
  })
})

describe('checkGlobalDailyLimit', () => {
  const day1 = Date.UTC(2026, 6, 30) // 2026-07-30T00:00:00Z
  const day1Later = day1 + 3600_000 // 같은 날 UTC 한 시간 뒤
  const day2 = Date.UTC(2026, 6, 31) // 다음 날

  it('한도 안에서는 통과', () => {
    resetGlobalDailyLimit()
    expect(checkGlobalDailyLimit(day1, 3)).toBe(true)
    expect(checkGlobalDailyLimit(day1, 3)).toBe(true)
    expect(checkGlobalDailyLimit(day1, 3)).toBe(true)
  })

  it('한도를 넘으면 막는다', () => {
    resetGlobalDailyLimit()
    checkGlobalDailyLimit(day1, 2)
    checkGlobalDailyLimit(day1, 2)
    expect(checkGlobalDailyLimit(day1, 2)).toBe(false)
  })

  it('날짜(UTC)가 바뀌면 카운터가 초기화된다', () => {
    resetGlobalDailyLimit()
    checkGlobalDailyLimit(day1, 1)
    expect(checkGlobalDailyLimit(day1Later, 1)).toBe(false) // 같은 날이므로 여전히 막힘
    expect(checkGlobalDailyLimit(day2, 1)).toBe(true) // 날짜가 바뀌어 다시 통과
  })
})
