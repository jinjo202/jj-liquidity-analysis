import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildAnalysis } from '@/lib/analyze'
import type { KofiaRow } from '@/lib/fetch-kofia'
import type { CreditSplitRow, LendingRow } from '@/lib/types'

const FIXTURE = path.resolve(__dirname, './fixtures/kofia-daily.json')
const SPLIT_FIXTURE = path.resolve(__dirname, './fixtures/credit-split.json')
const LENDING_FIXTURE = path.resolve(__dirname, './fixtures/lending-balance.json')

const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { series: KofiaRow[] }
const rawSplit = JSON.parse(fs.readFileSync(SPLIT_FIXTURE, 'utf8')) as { series: CreditSplitRow[] }
const rawLending = JSON.parse(fs.readFileSync(LENDING_FIXTURE, 'utf8')) as { series: LendingRow[] }
const snap = buildAnalysis(raw.series, rawSplit.series, rawLending.series)

describe('buildAnalysis — 기존 분석 결과 재현', () => {
  it('두 사이클을 만든다', () => {
    expect(snap.periods.map(p => p.key)).toEqual(['c2021', 'c2026'])
  })

  it('마진콜 계수는 0.84', () => {
    expect(snap.meta.marginFactor).toBeCloseTo(0.84, 10)
  })

  it('2026 사이클 지수 고점 9,115p / 저점 5,594p', () => {
    const h = snap.periods[1].markets['전체'].headline
    expect(h.idxPeak).toBeCloseTo(9115, 0)
    expect(h.idxTrough).toBeCloseTo(5593.56, 2)
    expect(h.idxDrawdownPct).toBeCloseTo(-38.6, 1)
  })

  it('2026 사이클 신용 고점 38.63조, 청산률 -15.4%', () => {
    const h = snap.periods[1].markets['전체'].headline
    expect(h.creditPeakJo).toBeCloseTo(38.63, 2)
    expect(h.unwindPct).toBeCloseTo(-15.4, 1)
  })

  it('2026 사이클 churn 보정 마진콜 진입 4.72조', () => {
    expect(snap.periods[1].markets['전체'].scaledExposureJo).toBeCloseTo(4.72, 1)
  })

  it('2021 사이클 보정 모델 8.85조 vs 실측 9.84조', () => {
    const m = snap.periods[0].markets['전체']
    expect(m.scaledExposureJo).toBeCloseTo(8.85, 1)
    expect(m.headline.actualDeclineJo).toBeCloseTo(-9.84, 1)
  })

  it('원 자료 재현 평균절대오차가 0.1조 이내', () => {
    expect(snap.reproMAE).toBeLessThan(0.1)
  })

  it('잔여 청산 추정 벤치마크 4개, 상단 약 10.50조', () => {
    expect(snap.projection!.benches).toHaveLength(4)
    expect(snap.projection!.highJo).toBeCloseTo(10.50, 1)
  })

  it('잔여 청산 추정 하단(lowJo)은 음수가 나와도 0으로 클램프된다', () => {
    // 벤치마크별 remainJo 중 최솟값이 음수(시장이 벤치마크보다 이미 더 청산된 상태)여도
    // lowJo는 0 미만으로 내려가지 않아야 한다. UI와 AI 프롬프트가 같은 값을 보게 하기 위함.
    expect(snap.projection!.benches.some(b => b.remainJo < 0)).toBe(true)
    expect(snap.projection!.lowJo).toBeGreaterThanOrEqual(0)
  })

  it('splitSeries가 있으면 유가증권/코스닥 시장도 계산한다', () => {
    expect(snap.meta.hasSplit).toBe(true)
    expect(snap.meta.markets).toEqual(['전체', '유가증권', '코스닥'])
    expect(snap.periods[1].markets['유가증권']).toBeDefined()
    expect(snap.periods[1].markets['코스닥']).toBeDefined()
  })

  it('코스닥 사이클은 코스피보다 낙폭이 크고 신용융자 청산률도 더 높다', () => {
    const kospiOnly = snap.periods[1].markets['유가증권'].headline
    const kosdaqOnly = snap.periods[1].markets['코스닥'].headline
    expect(kosdaqOnly.idxDrawdownPct).toBeCloseTo(-47.4, 0)
    expect(kospiOnly.idxDrawdownPct).toBeCloseTo(-38.6, 0)
    expect(kosdaqOnly.unwindPct).toBeCloseTo(-38.3, 0)
    expect(kospiOnly.unwindPct).toBeCloseTo(-13.5, 0)
  })

  it('splitSeries가 없으면 전체만 계산하고 나머지는 건너뛴다', () => {
    const snapNoSplit = buildAnalysis(raw.series)
    expect(snapNoSplit.meta.hasSplit).toBe(false)
    expect(snapNoSplit.meta.markets).toEqual(['전체'])
    expect(snapNoSplit.periods[1].markets['유가증권']).toBeUndefined()
  })

  it('전체 시장에 거래대금 대비 규모(turnover)와 마진콜 사다리(ladder)가 붙는다', () => {
    const m = snap.periods[1].markets['전체']
    expect(m.turnover).not.toBeNull()
    expect(m.turnover!.unwindDays).toBeGreaterThan(0)
    expect(m.ladder.length).toBeGreaterThan(0)
    expect(m.unwind.pctOfTurnover).not.toBeNull()
  })
})

describe('buildAnalysis — 대차잔고(공매도 프록시)와 숏커버링', () => {
  it('lendingSeries가 없으면 lending은 null이다', () => {
    const snapNoLending = buildAnalysis(raw.series, rawSplit.series)
    expect(snapNoLending.lending).toBeNull()
  })

  it('역대 최고 잔고 195.30조(2026-06-15) → 현재 133.41조(2026-07-30)', () => {
    const l = snap.lending!
    expect(l).not.toBeNull()
    expect(l.allTimePeak.date).toBe('20260615')
    expect(l.allTimePeak.balJo).toBeCloseTo(195.30, 1)
    expect(l.last.date).toBe('20260730')
    expect(l.last.balJo).toBeCloseTo(133.41, 1)
  })

  it('이번 사이클 잔고 고점은 역대 최고와 같은 날(2026-06-15)이고, 고점 대비 -31.7% 하락했다', () => {
    const l = snap.lending!
    expect(l.cyclePeak.date).toBe('20260615')
    expect(l.cycleDeclinePct).toBeCloseTo(-31.7, 0)
  })

  it('사이클 고점 이후 하루 단위 조합에서 동반 청산이 가장 많다', () => {
    const l = snap.lending!
    expect(l.dayClass.jointUnwind).toBe(14)
    expect(l.dayClass.coverType).toBe(4)
    expect(l.dayClass.newShort).toBe(2)
    expect(l.dayClass.riskOn).toBe(12)
  })

  it('숏커버링 후보일은 4개이고, 1위는 2026-06-18이다', () => {
    const l = snap.lending!
    expect(l.candidates).toHaveLength(4)
    expect(l.candidates[0].date).toBe('20260618')
    // 점수(score)는 등락폭의 곱이라 내림차순 정렬이어야 한다.
    for (let i = 1; i < l.candidates.length; i++) {
      expect(l.candidates[i - 1].score).toBeGreaterThanOrEqual(l.candidates[i].score)
    }
  })

  it('meta에 대차잔고가 공매도 전용이 아니라는 한계 설명이 포함된다', () => {
    const l = snap.lending!
    expect(l.meta.note).toContain('공매도')
  })
})
