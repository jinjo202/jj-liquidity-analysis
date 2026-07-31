import { describe, it, expect } from 'vitest'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

describe('formatJo', () => {
  it('조원 단위 소수 둘째 자리', () => {
    expect(formatJo(4.7169)).toBe('4.72조원')
    expect(formatJo(-9.84)).toBe('-9.84조원')
  })
})

describe('formatIdx', () => {
  it('지수는 정수 + 천단위 콤마 + p', () => {
    expect(formatIdx(5663.24)).toBe('5,663p')
    expect(formatIdx(9115)).toBe('9,115p')
  })
})

describe('formatPct', () => {
  it('퍼센트는 소수 첫째 자리', () => {
    expect(formatPct(-37.94)).toBe('-37.9%')
    expect(formatPct(15.42)).toBe('15.4%')
  })
})

describe('formatDateKo', () => {
  it('YYYYMMDD를 한국어 날짜로', () => {
    expect(formatDateKo('20260729')).toBe('2026년 7월 29일')
    expect(formatDateKo('20260101')).toBe('2026년 1월 1일')
  })
})
