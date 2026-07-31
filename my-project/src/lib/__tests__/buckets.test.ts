import { describe, it, expect } from 'vitest'
import { factorOf, jo, pickWidth, accumulate, classify, accumulateOutflow, weightedIndex, turnoverStats, buildLadder } from '@/lib/buckets'

describe('factorOf', () => {
  it('마진콜 계수는 담보유지비율 x 융자비율', () => {
    expect(factorOf()).toBeCloseTo(0.84, 10)
    expect(factorOf(1.3, 0.6)).toBeCloseTo(0.78, 10)
  })
})

describe('jo', () => {
  it('백만원을 조원으로 바꾼다', () => {
    expect(jo(1_000_000)).toBe(1)
    expect(jo(38_630_000)).toBeCloseTo(38.63, 10)
  })
})

describe('pickWidth', () => {
  it('버킷 수가 20을 넘지 않는 가장 촘촘한 폭', () => {
    expect(pickWidth(1847)).toBe(100)
    expect(pickWidth(6821)).toBe(500)
  })
})

describe('accumulate', () => {
  it('증가분만 그날 지수의 버킷에 담는다', () => {
    const rows = [
      { date: '20260101', idx: 5100, credit: 1000 },
      { date: '20260102', idx: 5200, credit: 1500 }, // +500 -> 5000 버킷
      { date: '20260103', idx: 5600, credit: 1200 }, // -300 -> grossDown
      { date: '20260104', idx: 5700, credit: 1900 }, // +700 -> 5500 버킷
    ]
    const acc = accumulate(rows, 500)
    expect(acc.buckets.get(5000)).toBe(500)
    expect(acc.buckets.get(5500)).toBe(700)
    expect(acc.grossUp).toBe(1200)
    expect(acc.grossDown).toBe(300)
  })
})

describe('accumulateOutflow', () => {
  it('감소분만 그날 지수의 버킷에 담는다', () => {
    const rows = [
      { date: '20260101', idx: 7100, credit: 2000 },
      { date: '20260102', idx: 7200, credit: 1400 }, // -600 -> 7000 버킷
      { date: '20260103', idx: 6600, credit: 1500 }, // +100 무시
      { date: '20260104', idx: 6700, credit: 1100 }, // -400 -> 6500 버킷
    ]
    const out = accumulateOutflow(rows, 500)
    expect(out.buckets.get(7000)).toBe(600)
    expect(out.buckets.get(6500)).toBe(400)
    expect(out.total).toBe(1000)
  })
})

describe('classify', () => {
  it('구간 상단/하단에 계수를 곱해 마진콜 레벨을 매기고 판정한다', () => {
    const buckets = new Map([[7000, 1_130_000]])
    const [b] = classify({ buckets, width: 500 }, 5663)
    expect(b.low).toBe(7000)
    expect(b.high).toBe(7500)
    expect(b.marginHigh).toBeCloseTo(6300, 6)   // 7500 x 0.84
    expect(b.marginLow).toBeCloseTo(5880, 6)    // 7000 x 0.84
    expect(b.triggered).toBe(true)              // 5663 < 6300
    expect(b.fullyTriggered).toBe(true)         // 5663 < 5880
    expect(b.jo).toBeCloseTo(1.13, 6)
  })

  it('마진콜 레벨보다 지수가 높으면 미진입', () => {
    const buckets = new Map([[5000, 4_160_000]])
    const [b] = classify({ buckets, width: 500 }, 5663)
    expect(b.marginHigh).toBeCloseTo(4620, 6)   // 5500 x 0.84
    expect(b.triggered).toBe(false)
  })
})

describe('weightedIndex', () => {
  it('버킷 중앙값을 금액으로 가중평균한다', () => {
    const buckets = new Map([[5000, 100], [6000, 300]])
    // (5250*100 + 6250*300) / 400 = 6000
    expect(weightedIndex(buckets, 500)).toBeCloseTo(6000, 6)
  })

  it('금액이 없으면 null', () => {
    expect(weightedIndex(new Map(), 500)).toBeNull()
  })
})

describe('turnoverStats', () => {
  it('청산 국면 거래대금을 그 시대 평균 및 오늘 평균과 대조한다', () => {
    const rows = [
      { date: '20260101', valueJo: 10 }, { date: '20260102', valueJo: 10 },
      { date: '20260103', valueJo: 10 }, { date: '20260104', valueJo: 10 },
      { date: '20260105', valueJo: 10 },
      { date: '20260106', valueJo: 20 }, { date: '20260107', valueJo: 30 },
      { date: '20260108', valueJo: 5 }, { date: '20260109', valueJo: 5 },
      { date: '20260110', valueJo: 5 },
    ]
    const s = turnoverStats(rows, '20260106', '20260107', 20)
    expect(s).not.toBeNull()
    expect(s!.baselineAvgDailyJo).toBeCloseTo(10, 6)
    expect(s!.currentAvgDailyJo).toBeCloseTo(11.5, 6)
    expect(s!.unwindTotalJo).toBeCloseTo(50, 6)
    expect(s!.unwindDays).toBe(2)
    expect(s!.unwindAvgDailyJo).toBeCloseTo(25, 6)
    expect(s!.unwindVsBaselinePct).toBeCloseTo(250, 6)
  })

  it('빈 배열이면 null', () => {
    expect(turnoverStats([], '20260101', '20260102')).toBeNull()
  })
})

describe('buildLadder', () => {
  it('안 터진 버킷만, marginHigh 내림차순으로 누적한다', () => {
    const buckets = [
      { low: 5000, high: 5500, jo: 1, marginHigh: 4620, marginLow: 4200, triggered: false, fullyTriggered: false },
      { low: 7000, high: 7500, jo: 2, marginHigh: 6300, marginLow: 5880, triggered: true, fullyTriggered: true },
    ]
    const scaledBuckets = [
      { ...buckets[0], jo: 1.5 },
      { ...buckets[1], jo: 3 },
    ]
    const ladder = buildLadder(buckets, scaledBuckets, 2)
    expect(ladder).toHaveLength(1)
    expect(ladder[0].threshold).toBe(4620)
    expect(ladder[0].incrementalJo).toBeCloseTo(1.5, 6)
    expect(ladder[0].cumulativeJo).toBeCloseTo(1.5, 6)
    expect(ladder[0].incrementalDays).toBeCloseTo(0.75, 6)
    expect(ladder[0].incrementalPctOfDay).toBeCloseTo(75, 6)
  })
})
