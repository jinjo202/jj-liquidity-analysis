import { describe, it, expect } from 'vitest'
import { daysSince } from '@/lib/queries'

describe('daysSince', () => {
  it('같은 날이면 0', () => {
    expect(daysSince('20260729', new Date('2026-07-29T15:00:00+09:00'))).toBe(0)
  })

  it('하루 지나면 1', () => {
    expect(daysSince('20260729', new Date('2026-07-30T09:00:00+09:00'))).toBe(1)
  })

  it('여러 날 지난 경우', () => {
    expect(daysSince('20260720', new Date('2026-07-30T09:00:00+09:00'))).toBe(10)
  })
})
