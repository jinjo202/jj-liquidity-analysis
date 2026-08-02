// 지수대별 신용융자 누적과 반대매매 진행률을 사이클 x 시장으로 나눠 분석한다.
//
// 사이클을 나누는 이유: 코스피 레벨이 2021년 3,300p, 2026년 9,100p로 완전히 다르다.
// 전 기간을 같은 절대 지수 버킷으로 묶으면 두 국면이 섞여 아무 의미가 없다.
// 2020-21 사이클은 청산까지 끝난 선례라, 진행 중인 2025-26 사이클의 대조군이 된다.
//
// 시장 구분
//   전체     : 크로스통계 OS0026(유가증권+코스닥 합계) x 코스피 지수 - 원 자료와 같은 구성
//   유가증권 : 분리 계열 x 코스피 지수
//   코스닥   : 분리 계열 x 코스닥 지수
// 유가증권/코스닥은 splitSeries가 있을 때만 계산한다.
import {
  analyzeMarket, accumulate, classify, factorOf, buildShortCoverLadder,
  MAINTENANCE, LOAN_RATIO,
  type DailyRow, type IdxRow, type MarketAnalysis, type TurnoverRow,
} from '@/lib/buckets'
import type { KofiaRow } from '@/lib/fetch-kofia'
import type {
  AnalysisSnapshot, PeriodAnalysis, ReproRow, RatioPoint, StressRow, Bench, Projection,
  CreditSplitRow, LendingRow, LendingAnalysis, LendingDayPoint,
} from '@/lib/types'

// 대차잔고 데이터 자체에는 출처 메타데이터가 없다(Supabase 테이블에 저장하지 않음).
// 방법론 문서(§16)와 같은 고정 설명을 여기서 붙인다.
const LENDING_META = {
  source: 'KOFIA FREESIS 대차거래추이 (수동 반영)',
  unit: '백만원(잔고금액), 주(잔고/체결/상환 주수)',
  note: '시장 전체 기준. 한국은 공매도가 거의 전량 차입 후 매도 구조라 대차잔고를 공매도 잔고의 표준 프록시로 쓴다. '
    + '시장 전체 실제 공매도 잔고는 별도로 공표되지 않는다(종목별 순보유잔고, 대량보유자 신고 기준만 공표). '
    + '대차거래는 공매도 외에 ETF 설정/환매, 차익거래 등 다른 목적으로도 일어나므로 잔고 변화 전부가 공매도 포지션 변화는 아니다.',
}

export const PDF_BARS: Record<number, number> = {
  4000: 0.36, 4500: 2.10, 5000: 4.00, 5500: 3.23, 6000: 2.86, 6500: 0.97,
  7000: 1.07, 7500: 1.28, 8000: 2.87, 8500: 0.92, 9000: 0.72,
}

const MARKETS = ['전체', '유가증권', '코스닥'] as const
const idxKey: Record<string, 'OS0001' | 'OS0002'> = { 전체: 'OS0001', 유가증권: 'OS0001', 코스닥: 'OS0002' }

type MarketInput = { idxRows: IdxRow[]; rows: DailyRow[] }

export function buildAnalysis(
  series: KofiaRow[], splitSeries?: CreditSplitRow[], lendingSeries?: LendingRow[],
): AnalysisSnapshot {
  const lastDate = series.at(-1)!.date

  // 적립 구간과 청산 판정 구간을 명시한다.
  // 2020-21: 코로나 저점부터 쌓인 신용이 2021.9 고점을 찍고 2022~23.1 에 걸쳐 풀렸다.
  // 2025-26: 2025년 초부터 쌓여 2026.6 고점, 청산은 진행 중.
  const PERIODS = [
    {
      key: 'c2021', name: '2020–21 사이클',
      note: '코로나 저점(2020.3) 이후 적립 → 2021.9 신용 고점 → 2022~2023.1 청산. 이미 끝난 국면이라 진행 중인 사이클의 대조군이 된다.',
      accBase: '20191231', accEnd: '20211231', evalEnd: '20230131', closed: true,
    },
    {
      key: 'c2026', name: '2025–26 사이클',
      note: '2025년 초부터 적립 → 2026.6 신용 고점 → 청산 진행 중.',
      accBase: '20241231', accEnd: lastDate, evalEnd: lastDate, closed: false,
    },
  ]

  function buildInput(market: string): MarketInput | null {
    const ik = idxKey[market]
    const idxRows = series
      .filter((r): r is KofiaRow & Record<typeof ik, number> => Number.isFinite(r[ik]))
      .map(r => ({ date: r.date, idx: r[ik]! }))

    if (market === '전체') {
      return {
        idxRows,
        rows: series
          .filter(r => Number.isFinite(r.OS0026) && Number.isFinite(r[ik]))
          .map(r => ({ date: r.date, idx: r[ik]!, credit: r.OS0026! })),
      }
    }
    if (!splitSeries) return null

    const field = market === '유가증권' ? 'kospi' : 'kosdaq'
    const byDate = new Map(splitSeries.map(r => [r.date, r[field]]))
    return {
      idxRows,
      rows: idxRows
        .map(r => ({ ...r, credit: byDate.get(r.date) as number | undefined }))
        .filter((r): r is DailyRow => Number.isFinite(r.credit)),
    }
  }

  const inputs: Record<string, MarketInput> = {}
  for (const m of MARKETS) {
    const v = buildInput(m)
    if (v) inputs[m] = v
  }

  // 거래대금(조원). 억원 -> 조원은 /10000. '전체'는 코스피+코스닥 합계로, 신용융자 '전체'가
  // 유가증권+코스닥 합계인 것과 같은 기준을 맞춘다.
  function buildTurnover(market: string): TurnoverRow[] {
    if (market === '유가증권') {
      return series.filter(r => Number.isFinite(r.OS0011))
        .map(r => ({ date: r.date, valueJo: r.OS0011! / 1e4 }))
    }
    if (market === '코스닥') {
      return series.filter(r => Number.isFinite(r.OS0012))
        .map(r => ({ date: r.date, valueJo: r.OS0012! / 1e4 }))
    }
    return series.filter(r => Number.isFinite(r.OS0011) || Number.isFinite(r.OS0012))
      .map(r => ({ date: r.date, valueJo: ((r.OS0011 ?? 0) + (r.OS0012 ?? 0)) / 1e4 }))
  }
  const turnoverByMarket = Object.fromEntries(MARKETS.map(m => [m, buildTurnover(m)]))

  const periods: PeriodAnalysis[] = PERIODS.map(p => {
    const markets: Record<string, MarketAnalysis> = {}
    for (const [name, input] of Object.entries(inputs)) {
      const res = analyzeMarket({
        ...input, accBase: p.accBase, accEnd: p.accEnd, evalEnd: p.evalEnd,
        turnoverRows: turnoverByMarket[name],
      })
      if (res) markets[name] = res
    }
    return { ...p, markets }
  }).filter(p => Object.keys(p.markets).length > 0)

  /* ---------- 원 자료 재현 검증 ----------
     원 자료는 2026 연초 대비 · 500p 버킷 · 전체(시장 합계) 기준이다.
     사이클 구분과 별개로 방법론이 맞는지 보는 고정 검증이므로 조건을 그대로 둔다. */
  const reproRows = inputs['전체'].rows.filter(r => r.date >= '20251231' && r.date <= '20260727')
  const reproBuckets = classify(accumulate(reproRows, 500),
    series.find(r => r.date === '20260727')!.OS0001!)
  const repro: ReproRow[] = Object.keys(PDF_BARS).map(Number).map(low => {
    const mine = reproBuckets.find(b => b.low === low)?.jo ?? 0
    return { low, high: low + 500, pdf: PDF_BARS[low], mine, diff: mine - PDF_BARS[low] }
  })
  const reproMAE = repro.reduce((s, r) => s + Math.abs(r.diff), 0) / repro.length

  /* ---------- 신용/시가총액 비율 ---------- */
  // 시가총액은 억원, 신용융자는 백만원. 억원 x 100 = 백만원.
  const ratioSeries: RatioPoint[] = series
    .filter(r => Number.isFinite(r.OS0026) && Number.isFinite(r.OS0008))
    .map(r => ({
      date: r.date,
      mcapJo: ((r.OS0008! + (r.OS0009 ?? 0)) * 100) / 1e6,
      creditJo: r.OS0026! / 1e6,
      ratio: (r.OS0026! / ((r.OS0008! + (r.OS0009 ?? 0)) * 100)) * 100,
    }))
  const ratioAt = (d: string) => ratioSeries.find(r => r.date === d) ?? null

  /* ---------- 앞으로 남은 청산 규모 추정 ---------- */
  // 근거가 다른 벤치마크를 여러 개 놓는다. 하나로 수렴하지 않으므로 범위로 본다.
  function projectRemaining(): Projection | null {
    const closed = periods.find(p => p.closed)?.markets['전체']
    const open = periods.find(p => !p.closed)?.markets['전체']
    if (!closed || !open) return null

    const a = closed.headline, b = open.headline
    const doneJo = -b.actualDeclineJo          // 이미 청산된 양(양수)
    const peakJo = b.creditPeakJo

    const benches: Bench[] = []

    // 1) 직전 사이클 청산률을 그대로 적용
    const r1 = peakJo * (-a.unwindPct / 100)
    benches.push({
      key: 'unwindRate', name: '2021 사이클 청산률 대입',
      basis: `청산률 ${a.unwindPct.toFixed(1)}% x 신용 고점 ${peakJo.toFixed(2)}조`,
      totalJo: r1, remainJo: r1 - doneJo,
      caveat: '두 사이클의 레버리지 강도가 같다고 가정한다. 신용/시총 비율은 그렇지 않다고 말한다.',
    })

    // 2) 지수 낙폭 대비 청산 탄성
    const elast = (-a.unwindPct) / (-a.idxDrawdownPct)
    const r2 = peakJo * ((-b.idxDrawdownPct) * elast / 100)
    benches.push({
      key: 'elasticity', name: '지수 낙폭 대비 청산 탄성',
      basis: `탄성 ${elast.toFixed(2)} (2022: 청산 ${a.unwindPct.toFixed(1)}% / 지수 ${a.idxDrawdownPct.toFixed(1)}%) x 현 낙폭 ${b.idxDrawdownPct.toFixed(1)}%`,
      totalJo: r2, remainJo: r2 - doneJo,
      caveat: '탄성이 사이클 간에 일정하다고 가정한다.',
    })

    // 3) 마진콜 모델(보정)
    benches.push({
      key: 'marginModel', name: '마진콜 모델(보정)',
      basis: `현 지수 ${Math.round(b.idxTrough)}p 기준 진입 물량 ${open.scaledExposureJo.toFixed(2)}조`,
      totalJo: open.scaledExposureJo, remainJo: open.scaledExposureJo - doneJo,
      caveat: '강제 청산만 센다. 마진콜을 피하려는 자발적 축소는 포함하지 않는다.',
    })

    // 4) 신용/시총 비율이 직전 사이클 저점 비율로 회귀
    const troughRatio = ratioAt(a.creditTroughDate)
    const now = ratioSeries.at(-1)!
    if (troughRatio && now) {
      const targetCreditJo = (troughRatio.ratio / 100) * now.mcapJo
      const r4 = peakJo - targetCreditJo
      benches.push({
        key: 'ratioNorm', name: '신용/시총 비율 정상화',
        basis: `2023 저점 비율 ${troughRatio.ratio.toFixed(3)}% x 현 시총 ${now.mcapJo.toFixed(0)}조 = 목표 잔고 ${targetCreditJo.toFixed(2)}조`,
        totalJo: r4, remainJo: r4 - doneJo,
        caveat: `현 비율은 이미 ${now.ratio.toFixed(3)}% 로 그 저점보다 낮다. 시총이 신용보다 빠르게 줄어 비율이 오히려 올라간 상태다.`,
      })
    }

    const remains = benches.map(x => x.remainJo)
    return {
      doneJo, peakJo,
      currentRatio: ratioSeries.at(-1) ?? null,
      peakRatio: ratioAt(b.creditPeakDate),
      prevPeakRatio: ratioAt(a.creditPeakDate),
      prevTroughRatio: troughRatio,
      benches,
      lowJo: Math.max(0, Math.min(...remains)), highJo: Math.max(...remains),
      // 추가 하락 시 열리는 물량(보정)
      scenarioRemain: open.scenarios.map(s => ({
        idx: s.idx,
        exposureJo: s.exposureJo * open.churnScale,
        extraJo: (s.exposureJo - open.headline.exposureJo) * open.churnScale,
      })),
    }
  }
  const projection = projectRemaining()

  /* ---------- 실측 스트레스 지표 ---------- */
  // OS0025(반대매매금액)는 위탁매매 미수금에 대한 반대매매다. 신용융자 반대매매는
  // 공표되지 않으므로 추정치의 검증값이 아니라 별도 스트레스 축으로만 쓴다.
  const stress: StressRow[] = series
    .filter(r => r.date >= '20260601' && Number.isFinite(r.OS0025))
    .map(r => ({
      date: r.date, idx: r.OS0001!, kosdaq: r.OS0002 ?? null,
      forced: r.OS0025!, unpaid: r.OS0024!, credit: r.OS0026 ?? null,
    }))

  /* ---------- 대차잔고(공매도 프록시)와 숏커버링 ---------- */
  // 한국은 공매도가 거의 전량 차입 후 매도라, 대차잔고를 시장 전체 공매도 잔고의
  // 표준 프록시로 쓴다. 시장 전체 실제 공매도 잔고는 공표되지 않는다(종목별 순보유잔고,
  // 대량보유자 신고 기준만 공표). lendingSeries가 있을 때만 계산한다.
  function buildLending(): LendingAnalysis | null {
    if (!lendingSeries || !lendingSeries.length) return null

    const idxByDate = new Map(
      series.filter(r => Number.isFinite(r.OS0001)).map(r => [r.date, r.OS0001!]),
    )
    const merged: LendingDayPoint[] = lendingSeries
      .map(r => ({ date: r.date, balJo: r.balanceMil / 1e6, idx: idxByDate.get(r.date) }))
      .filter((r): r is LendingDayPoint => Number.isFinite(r.idx))
      .sort((a, b) => a.date.localeCompare(b.date))
    if (!merged.length) return null

    for (let i = 1; i < merged.length; i++) {
      merged[i].dIdxPct = (merged[i].idx / merged[i - 1].idx - 1) * 100
      merged[i].dBalPct = (merged[i].balJo / merged[i - 1].balJo - 1) * 100
    }

    const allTimePeak = merged.reduce((m, r) => (r.balJo > m.balJo ? r : m))
    const last = merged.at(-1)!

    // 진행 중인 사이클(신용융자 분석과 같은 창) 안에서의 잔고 고점 -> 현재.
    const openP = PERIODS.find(p => !p.closed)!
    const cycleWindow = merged.filter(r => r.date >= openP.accBase && r.date <= openP.evalEnd)
    if (!cycleWindow.length) return null
    const cyclePeak = cycleWindow.reduce((m, r) => (r.balJo > m.balJo ? r : m), cycleWindow[0])
    const afterCyclePeak = cycleWindow.filter(r => r.date >= cyclePeak.date)
    const cycleDeclinePct = (afterCyclePeak.at(-1)!.balJo / cyclePeak.balJo - 1) * 100

    // 잔고 고점 이후 구간에서 하루 단위 지수-잔고 co-movement 를 센다.
    const tail = afterCyclePeak.slice(1)
    const dayClass = {
      coverType: tail.filter(r => (r.dIdxPct ?? 0) > 0 && (r.dBalPct ?? 0) < 0).length, // 지수↑ 잔고↓ = 숏커버형
      jointUnwind: tail.filter(r => (r.dIdxPct ?? 0) < 0 && (r.dBalPct ?? 0) < 0).length, // 지수↓ 잔고↓ = 동반 청산
      newShort: tail.filter(r => (r.dIdxPct ?? 0) < 0 && (r.dBalPct ?? 0) > 0).length, // 지수↓ 잔고↑ = 신규 숏 추정
      riskOn: tail.filter(r => (r.dIdxPct ?? 0) > 0 && (r.dBalPct ?? 0) > 0).length,
    }

    const candidates = tail
      .filter(r => (r.dIdxPct ?? 0) > 0 && (r.dBalPct ?? 0) < 0)
      .map(r => ({ ...r, score: r.dIdxPct! * -r.dBalPct! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)

    // 숏커버 사다리: 마진콜 사다리와 순서만 반대로, 지수가 오를 때 손실권에 드는 물량.
    // 적립 창은 신용융자 쪽과 같은 사이클 창을 쓴다.
    const milByDate = new Map(lendingSeries.map(r => [r.date, r.balanceMil]))
    const recentTurnover = turnoverByMarket['전체'].slice(-20)
    const shortCoverLadder = buildShortCoverLadder({
      rows: cycleWindow.map(r => ({ date: r.date, idx: r.idx, credit: milByDate.get(r.date)! })),
      currentIdx: last.idx, currentDate: last.date,
      netBuildJo: cyclePeak.balJo - cycleWindow[0].balJo,
      avgDailyTurnoverJo: recentTurnover.length
        ? recentTurnover.reduce((s, r) => s + r.valueJo, 0) / recentTurnover.length : null,
    })

    return {
      meta: LENDING_META,
      allTimePeak, last,
      cyclePeak, cycleDeclinePct,
      dayClass, candidates, shortCoverLadder,
      series: merged.filter(r => r.date >= '20200101').map(r => ({ d: r.date, bal: r.balJo, idx: r.idx })),
    }
  }
  const lending = buildLending()

  return {
    meta: {
      maintenance: MAINTENANCE, loanRatio: LOAN_RATIO, marginFactor: factorOf(),
      hasSplit: !!splitSeries, markets: Object.keys(inputs),
      lastDate,
    },
    periods, repro, reproMAE, stress, projection,
    ratio: ratioSeries.filter((r, i) => i % 5 === 0 || i === ratioSeries.length - 1),
    series: series
      .filter(r => Number.isFinite(r.OS0001))
      .map(r => ({ d: r.date, i: r.OS0001!, q: r.OS0002 ?? null, c: r.OS0026 ?? null })),
    lending,
  }
}
