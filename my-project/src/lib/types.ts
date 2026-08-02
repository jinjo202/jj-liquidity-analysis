import type { MarketAnalysis, ShortCoverLadder } from '@/lib/buckets'

export type PeriodAnalysis = {
  key: string; name: string; note: string
  accBase: string; accEnd: string; evalEnd: string; closed: boolean
  markets: Record<string, MarketAnalysis>
}

export type ReproRow = {
  low: number; high: number; pdf: number; mine: number; diff: number
}

export type RatioPoint = {
  date: string; mcapJo: number; creditJo: number; ratio: number
}

export type StressRow = {
  date: string; idx: number; kosdaq: number | null
  forced: number; unpaid: number; credit: number | null
}

export type Bench = {
  key: string; name: string; basis: string
  totalJo: number; remainJo: number; caveat: string
}

export type Projection = {
  doneJo: number; peakJo: number
  currentRatio: RatioPoint | null
  peakRatio: RatioPoint | null
  prevPeakRatio: RatioPoint | null
  prevTroughRatio: RatioPoint | null
  benches: Bench[]
  lowJo: number; highJo: number
  scenarioRemain: { idx: number; exposureJo: number; extraJo: number }[]
}

export type CreditSplitRow = { date: string; total: number; kospi: number; kosdaq: number }

export type LendingRow = {
  date: string; dealShares: number | null; repayShares: number | null
  balanceShares: number; balanceMil: number
}

export type LendingDayPoint = {
  date: string; balJo: number; idx: number
  dIdxPct?: number; dBalPct?: number
}

export type LendingAnalysis = {
  meta: { source: string; unit: string; note: string }
  allTimePeak: LendingDayPoint
  last: LendingDayPoint
  cyclePeak: LendingDayPoint
  cycleDeclinePct: number
  dayClass: { coverType: number; jointUnwind: number; newShort: number; riskOn: number }
  candidates: (LendingDayPoint & { score: number })[]
  // 이 필드가 생기기 전에 저장된 스냅샷을 그대로 읽을 수 있어야 하므로 optional 이다.
  shortCoverLadder?: ShortCoverLadder | null
  series: { d: string; bal: number; idx: number }[]
}

export type AnalysisSnapshot = {
  meta: {
    maintenance: number; loanRatio: number; marginFactor: number
    markets: string[]
    hasSplit: boolean
    lastDate: string
  }
  periods: PeriodAnalysis[]
  repro: ReproRow[]
  reproMAE: number
  stress: StressRow[]
  projection: Projection | null
  ratio: RatioPoint[]
  series: { d: string; i: number; q: number | null; c: number | null }[]
  lending: LendingAnalysis | null
}
