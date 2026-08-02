import { describe, it, expect } from 'vitest'
import { parseSiseJson, toLive, ymdKST } from '@/lib/naver-index'

// 네이버 siseJson 응답 형식(작은따옴표 JS 리터럴). 실제 응답을 줄인 것이다.
const SAMPLE = `[['날짜','시가','고가','저가','종가','거래량','외국인소진율'],
["20260729", 5700.11, 5720.00, 5600.00, 5663.24, 812345678, 30.11],
["20260730", 5650.00, 5660.00, 5560.00, 5593.56, 799999999, 30.05],
["20260731", 5600.00, 6600.00, 5590.00, 6595.45, 999999999, 30.20]]`

describe('parseSiseJson', () => {
  it('작은따옴표 리터럴을 날짜·종가로 파싱하고 날짜 오름차순으로 정렬한다', () => {
    const rows = parseSiseJson(SAMPLE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ date: '20260729', close: 5663.24 })
    expect(rows.at(-1)).toEqual({ date: '20260731', close: 6595.45 })
  })

  it('헤더가 바뀌면 조용히 빈 값을 내지 않고 던진다', () => {
    expect(() => parseSiseJson(`[['date','close'],["20260731", 1]]`)).toThrow(/헤더/)
  })
})

describe('toLive', () => {
  it('마지막 두 점으로 현재가와 전일 대비를 만든다', () => {
    const live = toLive(parseSiseJson(SAMPLE))
    expect(live.date).toBe('20260731')
    expect(live.close).toBe(6595.45)
    expect(live.prevDate).toBe('20260730')
    expect(live.changePct).toBeCloseTo(17.91, 2)
  })

  it('점이 하나뿐이면 전일 대비는 null 이다', () => {
    const live = toLive([{ date: '20260731', close: 6595.45 }])
    expect(live.prevClose).toBeNull()
    expect(live.changePct).toBeNull()
  })
})

describe('ymdKST', () => {
  it('UTC 밤이면 한국은 이미 다음 날이다', () => {
    // 2026-07-31 16:00 UTC = 2026-08-01 01:00 KST
    expect(ymdKST(new Date('2026-07-31T16:00:00Z'))).toBe('20260801')
    expect(ymdKST(new Date('2026-07-31T16:00:00Z'), -10)).toBe('20260722')
  })
})
