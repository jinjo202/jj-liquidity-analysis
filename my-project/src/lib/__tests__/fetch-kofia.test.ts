import { describe, it, expect } from 'vitest'
import { parseKofiaRows, INDICATORS } from '@/lib/fetch-kofia'

describe('INDICATORS', () => {
  it('신용융자는 OS0026, 백만원 단위', () => {
    expect(INDICATORS.OS0026.name).toBe('신용융자')
    expect(INDICATORS.OS0026.unit).toBe('백만원')
    expect(INDICATORS.OS0026.sqlKey).toBe('STATCRS0600000010VM021')
  })

  it('11개 지표를 다룬다', () => {
    expect(Object.keys(INDICATORS)).toHaveLength(11)
  })

  it('KOSPI/KOSDAQ 거래대금은 OS0011/OS0012, 억원 단위', () => {
    expect(INDICATORS.OS0011.name).toBe('KOSPI거래대금')
    expect(INDICATORS.OS0011.unit).toBe('억원')
    expect(INDICATORS.OS0012.name).toBe('KOSDAQ거래대금')
  })
})

describe('parseKofiaRows', () => {
  it('TMPV1을 date로, 지표 코드를 숫자로 정규화한다', () => {
    const rows = parseKofiaRows([
      { TMPV1: '20260728', OS0001: '6023.66', OS0026: '33194040' },
    ])
    expect(rows).toEqual([{ date: '20260728', OS0001: 6023.66, OS0026: 33194040 }])
  })

  it('"null" 문자열과 빈 값은 버린다', () => {
    const rows = parseKofiaRows([
      { TMPV1: '20260729', OS0001: '5663.24', OS0026: 'null', OS0025: '' },
    ])
    expect(rows).toEqual([{ date: '20260729', OS0001: 5663.24 }])
  })

  it('날짜가 없는 행은 버린다', () => {
    expect(parseKofiaRows([{ OS0001: '100' }])).toEqual([])
  })
})
