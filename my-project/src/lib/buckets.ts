// 지수대별 신용융자 배분과 마진콜 판정.
// 시장(코스피/코스닥)과 사이클(2020-21 / 2025-26)에 상관없이 같은 규칙을 쓴다.
//
// 배분 규칙은 삼성자산운용 House View(2026-07-29) 자료를 역설계한 것이다.
// 근거와 재현 검증은 docs/methodology.md 참조.

export type DailyRow = { date: string; idx: number; credit: number }
export type IdxRow = { date: string; idx: number }

export type Bucket = {
  low: number; high: number; jo: number
  marginHigh: number; marginLow: number
  triggered: boolean; fullyTriggered: boolean
}

export type BucketRow = { low: number; high: number; jo: number }

export type AccResult = {
  buckets: Map<number, number>
  grossUp: number; grossDown: number; width: number
}

export type OutflowResult = {
  buckets: Map<number, number>; total: number; width: number
}

export type TurnoverRow = { date: string; valueJo: number }

export type TurnoverStats = {
  baselineAvgDailyJo: number | null
  currentAvgDailyJo: number | null
  unwindTotalJo: number
  unwindDays: number
  unwindAvgDailyJo: number | null
  unwindVsBaselinePct: number | null
}

export type LadderRow = {
  threshold: number; low: number; high: number
  incrementalJo: number; cumulativeJo: number
  incrementalDays: number | null; cumulativeDays: number | null
  incrementalPctOfDay: number | null; cumulativePctOfDay: number | null
}

export type ShortCoverLadder = {
  width: number
  currentIdx: number; currentDate: string
  grossJo: number; netBuildJo: number; churnScale: number
  underwaterJo: number   // 현재 지수 아래 구간에서 열린 숏 = 이미 손실권
  aboveJo: number        // 위쪽에 남은 물량 = 사다리 합계
  avgDailyTurnoverJo: number | null
  buckets: BucketRow[]   // 지수대별 숏 적립 분포(보정 후)
  rows: LadderRow[]
}

export type MarketAnalysis = {
  churnScale: number
  netBuildJo: number
  scaledBuckets: Bucket[]
  scaledExposureJo: number
  scaledRemainingJo: number
  unwind: {
    fromDate: string; toDate: string
    buckets: BucketRow[]
    totalJo: number; netJo: number
    weightedBuildIdx: number | null
    weightedUnwindIdx: number | null
    spreadPct: number | null
    pctOfTurnover: number | null
    equivDays: number | null
  }
  turnover: TurnoverStats | null
  ladder: LadderRow[]
  width: number; accBase: string; accEnd: string; evalEnd: string
  headline: {
    idxPeakDate: string; idxPeak: number
    idxTroughDate: string; idxTrough: number
    idxDrawdownPct: number
    idxLast: number; idxLastDate: string
    creditStartJo: number
    creditPeakDate: string; creditPeakJo: number
    creditTroughDate: string; creditTroughJo: number
    creditLastJo: number; creditLastDate: string
    actualDeclineJo: number; unwindPct: number
    buildJo: number; exposureJo: number; remainingJo: number
    exposureOfBuildPct: number
  }
  buckets: Bucket[]
  walk: { date: string; idx: number; minIdx: number; exposureJo: number }[]
  scenarios: { idx: number; exposureJo: number }[]
  sensitivity: { maintenance: number; factor: number; exposureJo: number }[]
  reconciliation: {
    modelExposureJo: number; scaledExposureJo: number
    actualDeclineJo: number; gapJo: number; scaledGapJo: number
    grossUpJo: number; grossDownJo: number
  }
}

export const MAINTENANCE = 1.40;  // 담보유지비율
export const LOAN_RATIO = 0.60;   // 융자비율(증거금률 40%)

/**
 * 마진콜 계수. 자기자금 40 + 융자 60 으로 100 을 사면 평가액 P 에 대해
 * P / 60 >= 담보유지비율 을 만족해야 하므로 하한은 100 x (담보유지비율 x 융자비율).
 */
export const factorOf = (maint = MAINTENANCE, loan = LOAN_RATIO) => maint * loan;

export const jo = (mil: number) => mil / 1e6; // 백만원 -> 조원
export const sumJo = (bs: { jo: number }[]) => bs.reduce((s, b) => s + b.jo, 0);

/**
 * 일별 감소분을 그날 지수의 버킷에 누적한다. 적립(accumulate)의 반대편이다.
 * "어느 지수대에서 실제로 청산이 일어났는가" 를 본다. 적립과 같은 폭을 쓰므로
 * 같은 축에 나란히 놓고 비교할 수 있다.
 */
export function accumulateOutflow(rows: DailyRow[], width: number): OutflowResult {
  const buckets = new Map<number, number>();
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].credit - rows[i - 1].credit;
    if (delta >= 0) continue;
    const low = Math.floor(rows[i].idx / width) * width;
    buckets.set(low, (buckets.get(low) ?? 0) + -delta);
    total += -delta;
  }
  return { buckets, total, width };
}

/** 금액 가중 평균 지수. 버킷 중앙값을 대표값으로 쓴다. */
export function weightedIndex(buckets: Map<number, number>, width: number): number | null {
  let num = 0, den = 0;
  for (const [low, mil] of buckets) { num += (low + width / 2) * mil; den += mil; }
  return den > 0 ? num / den : null;
}

const toRows = (m: Map<number, number>, width: number): BucketRow[] => [...m.entries()]
  .map(([low, mil]) => ({ low, high: low + width, jo: jo(mil) }))
  .sort((a, b) => a.low - b.low);

/**
 * 지수 구간 폭을 자동으로 고른다.
 * 사이클마다 지수 레벨이 완전히 다르므로(2021년 3,300 vs 2026년 9,100)
 * 절대 폭을 고정하면 한쪽은 칸이 하나뿐이거나 수십 개가 된다.
 * 버킷 수가 20개를 넘지 않는 가장 촘촘한 값을 쓴다.
 */
export function pickWidth(span: number, maxBuckets = 20): number {
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  return nice.find(w => span / w <= maxBuckets) ?? nice.at(-1)!;
}

/**
 * 거래대금 대비 규모를 잰다. 청산 금액 자체는 조원 단위로만 보면 크기 감이 안 온다.
 * "그 시장이 평소 하루에 사고파는 돈의 며칠치인가" 로 바꿔야 시장이 그 물량을
 * 얼마나 부담스러워할지 가늠할 수 있다.
 *
 * 기준선(baseline)을 두 개 쓴다:
 *   - baselineAvgDailyJo: 그 사이클의 청산이 시작되기 '직전' 정상 시기 평균.
 *     2021년 사건을 2026년 거래대금 규모로 재단하면 시장 성장분까지 섞여
 *     "그때 그 사건이 그때 기준으로 얼마나 컸는가"를 왜곡한다. 사이클마다
 *     자기 시대의 정상치와 비교해야 한다.
 *   - currentAvgDailyJo: 데이터 마지막 날 기준 최근 평균. 앞으로 남은 사다리는
 *     '오늘' 시장이 그 물량을 받아낼 수 있는지를 봐야 하므로 이건 항상 최신값이다.
 *
 * @param {{date:string, valueJo:number}[]} turnoverRows 일별 거래대금(조원), 날짜 오름차순
 * @param {string} fromDate 청산 국면 시작일
 * @param {string} toDate   청산 국면 종료일
 * @param {number} recentWindow 평균을 잴 거래일 수
 */
export function turnoverStats(turnoverRows: TurnoverRow[] | undefined, fromDate: string, toDate: string, recentWindow = 20): TurnoverStats | null {
  if (!turnoverRows || !turnoverRows.length) return null;

  const avg = (rows: TurnoverRow[]) => rows.length ? rows.reduce((s, r) => s + r.valueJo, 0) / rows.length : null;

  const before = turnoverRows.filter(r => r.date < fromDate).slice(-recentWindow);
  const baselineAvgDailyJo = avg(before);
  const currentAvgDailyJo = avg(turnoverRows.slice(-recentWindow));

  const win = turnoverRows.filter(r => r.date >= fromDate && r.date <= toDate);
  const unwindTotalJo = win.reduce((s, r) => s + r.valueJo, 0);
  const unwindDays = win.length;
  const unwindAvgDailyJo = unwindDays > 0 ? unwindTotalJo / unwindDays : null;

  return {
    baselineAvgDailyJo, currentAvgDailyJo, unwindTotalJo, unwindDays, unwindAvgDailyJo,
    // 청산 국면의 거래대금이 그 시대 정상치보다 늘었는지(패닉성 거래 증가) 줄었는지(유동성 고갈)
    unwindVsBaselinePct: unwindAvgDailyJo != null && baselineAvgDailyJo
      ? (unwindAvgDailyJo / baselineAvgDailyJo) * 100 : null,
  };
}

/**
 * 남은 마진콜 사다리. 현재 지수 기준으로 아직 안 터진 버킷을, 그 버킷이 터지는
 * 지수(marginHigh) 내림차순으로 늘어놓는다 — 지수가 그 밑으로 마감하면 그 물량이 열린다.
 * 정의상 안 터진 버킷은 marginHigh <= 현재지수 이므로, 지수가 더 떨어질수록
 * marginHigh 가 큰 버킷부터(=현재지수에 가장 가까운 것부터) 순서대로 열린다.
 */
export function buildLadder(buckets: Bucket[], scaledBuckets: Bucket[], avgDailyTurnoverJo: number | null): LadderRow[] {
  const remaining = buckets
    .map((b, i) => ({ ...b, scaledJo: scaledBuckets[i].jo }))
    .filter(b => !b.triggered)
    .sort((a, b) => b.marginHigh - a.marginHigh);

  let cum = 0;
  return remaining.map(b => {
    cum += b.scaledJo;
    return {
      threshold: b.marginHigh, low: b.low, high: b.high,
      incrementalJo: b.scaledJo, cumulativeJo: cum,
      incrementalDays: avgDailyTurnoverJo ? b.scaledJo / avgDailyTurnoverJo : null,
      cumulativeDays: avgDailyTurnoverJo ? cum / avgDailyTurnoverJo : null,
      // 거래대금이 커서 '일치'로는 소수점 이하로 뭉개지는 시장(예: 코스닥)이 있다.
      // 그런 경우 하루 거래대금 대비 %로 보는 게 더 읽힌다.
      incrementalPctOfDay: avgDailyTurnoverJo ? (b.scaledJo / avgDailyTurnoverJo) * 100 : null,
      cumulativePctOfDay: avgDailyTurnoverJo ? (cum / avgDailyTurnoverJo) * 100 : null,
    };
  });
}

/**
 * 숏커버 사다리. 마진콜 사다리와 순서만 반대다.
 *
 * 대차잔고 증가분을 그날 지수의 버킷에 쌓으면 '어느 지수대에서 숏이 열렸는가' 가 나온다
 * (accumulate 를 그대로 쓴다 — 신용융자 적립과 계산이 같고 부호 방향만 반대로 읽는다).
 * 지수가 그 구간 위로 올라가면 그 물량은 손실권이다.
 *
 * 대표 진입 지수로 구간 '하단' 을 쓴다. 마진콜 쪽이 구간 상단을 대표 매수가로 쓰는 것과
 * 같은 기준이다 — 지수가 움직이는 방향에서 가장 먼저 걸리는 쪽을 대표값으로 잡는다.
 * 그래서 현재 지수가 걸쳐 있는 구간(low < 현재지수 < high)은 일부만 손실권이어도
 * 전체를 '이미 손실권' 으로 센다. 마진콜 쪽 triggered 판정과 같은 보수적 규칙이다.
 *
 * 신용융자와 결정적으로 다른 점: 담보유지비율에 해당하는 강제 청산 규칙이 공표되지 않는다.
 * 그래서 계수를 곱하지 않고 손실권 진입만 센다. 이 사다리가 말하는 건 '얼마가 청산된다'
 * 가 아니라 '얼마가 손실권에 든다' 이고, 손실권 물량이 곧 커버 압력의 상한이다.
 */
export function buildShortCoverLadder(o: {
  rows: DailyRow[]                       // credit 자리에 대차잔고(백만원)를 넣는다
  currentIdx: number
  currentDate: string
  netBuildJo: number                     // 사이클 시작 -> 잔고 고점의 순증. churn 보정 기준
  width?: number
  avgDailyTurnoverJo?: number | null
}): ShortCoverLadder | null {
  const { rows, currentIdx, currentDate, netBuildJo, avgDailyTurnoverJo = null } = o
  if (rows.length < 20) return null

  const idxs = rows.map(r => r.idx)
  const w = o.width ?? pickWidth(Math.max(...idxs) - Math.min(...idxs))
  const acc = accumulate(rows, w)
  const grossJo = jo(acc.grossUp)
  if (grossJo <= 0) return null

  // 같은 물량이 들어왔다 나갔다 하면 gross 는 두 번 센다. 신용융자 쪽과 같은 보정을 쓴다:
  // 분포는 그대로 두고 합계만 실측 순증에 맞춘다.
  const churnScale = Math.max(0, netBuildJo / grossJo)
  const buckets: BucketRow[] = [...acc.buckets.entries()]
    .map(([low, mil]) => ({ low, high: low + w, jo: jo(mil) * churnScale }))
    .sort((a, b) => a.low - b.low)

  const underwaterJo = buckets.filter(b => b.low < currentIdx).reduce((s, b) => s + b.jo, 0)

  let cum = 0
  const ladderRows: LadderRow[] = buckets.filter(b => b.low >= currentIdx).map(b => {
    cum += b.jo
    return {
      threshold: b.low, low: b.low, high: b.high,
      incrementalJo: b.jo, cumulativeJo: cum,
      incrementalDays: avgDailyTurnoverJo ? b.jo / avgDailyTurnoverJo : null,
      cumulativeDays: avgDailyTurnoverJo ? cum / avgDailyTurnoverJo : null,
      incrementalPctOfDay: avgDailyTurnoverJo ? (b.jo / avgDailyTurnoverJo) * 100 : null,
      cumulativePctOfDay: avgDailyTurnoverJo ? (cum / avgDailyTurnoverJo) * 100 : null,
    }
  })

  return {
    width: w, currentIdx, currentDate,
    grossJo, netBuildJo, churnScale,
    underwaterJo, aboveJo: cum,
    avgDailyTurnoverJo, buckets, rows: ladderRows,
  }
}

/**
 * 일별 신용융자 증가분을 그날 지수의 버킷에 누적한다(gross).
 * 감소일은 버킷에서 빼지 않고 따로 합산해 실제 청산 규모와 대조할 때만 쓴다.
 */
export function accumulate(rows: DailyRow[], width: number): AccResult {
  const buckets = new Map<number, number>();
  let grossUp = 0, grossDown = 0;

  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].credit - rows[i - 1].credit;
    if (delta > 0) {
      const low = Math.floor(rows[i].idx / width) * width;
      buckets.set(low, (buckets.get(low) ?? 0) + delta);
      grossUp += delta;
    } else {
      grossDown += -delta;
    }
  }
  return { buckets, grossUp, grossDown, width };
}

/**
 * 버킷마다 마진콜 레벨을 붙이고 판정 지수로 진입 여부를 가른다.
 * 대표 매수 지수는 구간 상단을 쓴다(원 자료의 '상단기준'과 동일).
 */
export function classify({ buckets, width }: { buckets: Map<number, number>; width: number }, evalIdx: number, factor = factorOf()): Bucket[] {
  return [...buckets.entries()]
    .map(([low, mil]) => {
      const high = low + width;
      return {
        low, high, jo: jo(mil),
        marginHigh: high * factor, // 이 지수를 깨면 구간 상단 물량부터 마진콜
        marginLow: low * factor,   // 이 지수를 깨면 구간 전체가 마진콜
        triggered: evalIdx < high * factor,
        fullyTriggered: evalIdx < low * factor,
      };
    })
    .sort((a, b) => a.low - b.low);
}

/**
 * 한 시장 x 한 사이클을 분석한다.
 *
 * 적립 구간과 청산 구간을 분리해서 받는다. 2020-21 사이클처럼 이미 끝난 국면은
 * 적립을 2021년까지만 잡고 청산은 2022~23년 지수로 판정해야 실제와 맞는다.
 *
 * @param {object} o
 * @param {{date:string, idx:number, credit:number}[]} o.rows  신용융자와 지수가 모두 있는 날
 * @param {{date:string, idx:number}[]} o.idxRows              지수만 있는 날까지 포함
 * @param {string} o.accBase  적립 기준선(이 날 잔고 다음부터 델타를 잡는다)
 * @param {string} o.accEnd   적립 종료일
 * @param {string} o.evalEnd  청산 판정 종료일(적립 종료 이후의 하락 국면을 덮는다)
 * @param {number} [o.width]  버킷 폭. 생략하면 지수 범위에서 자동 결정
 * @param {{date:string, valueJo:number}[]} [o.turnoverRows] 일별 거래대금(조원). 있으면
 *   거래대금 대비 규모와 마진콜 사다리를 같이 계산한다.
 */
export function analyzeMarket(o: {
  rows: DailyRow[]
  idxRows: IdxRow[]
  accBase: string
  accEnd: string
  evalEnd: string
  width?: number
  turnoverRows?: TurnoverRow[]
}): MarketAnalysis | null {
  const { rows, idxRows, accBase, accEnd, evalEnd, width, turnoverRows } = o;
  const accRows = rows.filter(r => r.date >= accBase && r.date <= accEnd);
  if (accRows.length < 20) return null;

  const accIdx = accRows.map(r => r.idx);
  const w = width ?? pickWidth(Math.max(...accIdx) - Math.min(...accIdx));
  const acc = accumulate(accRows, w);

  // 청산 판정 구간: 적립 구간에서 지수가 가장 높았던 날부터 evalEnd 까지.
  // 반대매매는 되돌아오지 않으므로 그날까지의 '최저 지수'로 판정한다.
  const evalWindow = idxRows.filter(r => r.date >= accBase && r.date <= evalEnd);
  const idxPeak = evalWindow.reduce((m, r) => (r.idx > m.idx ? r : m));
  const tail = evalWindow.filter(r => r.date >= idxPeak.date);

  let runMin = Infinity;
  const walk = tail.map(r => {
    runMin = Math.min(runMin, r.idx);
    return {
      date: r.date, idx: r.idx, minIdx: runMin,
      exposureJo: sumJo(classify(acc, runMin).filter(b => b.triggered)),
    };
  });

  const troughIdx = runMin;
  const buckets = classify(acc, troughIdx);
  const triggered = buckets.filter(b => b.triggered);
  const remaining = buckets.filter(b => !b.triggered);

  // 실제 잔고: 사이클 안의 신용융자 고점과 그 이후 저점
  const creditWindow = rows.filter(r => r.date >= accBase && r.date <= evalEnd);
  const creditPeak = creditWindow.reduce((m, r) => (r.credit > m.credit ? r : m));
  const afterPeak = creditWindow.filter(r => r.date >= creditPeak.date);
  const creditTrough = afterPeak.reduce((m, r) => (r.credit < m.credit ? r : m));

  const scenarios = [0.95, 0.90, 0.80, 0.70, 0.60]
    .map(r => Math.round((troughIdx * r) / w) * w)
    .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
    .map(idx => ({ idx, exposureJo: sumJo(classify(acc, idx).filter(b => b.triggered)) }));

  const sensitivity = [1.30, 1.40, 1.50, 1.70].map(m => {
    const f = factorOf(m, LOAN_RATIO);
    return {
      maintenance: m, factor: f,
      exposureJo: sumJo(classify(acc, troughIdx, f).filter(b => b.triggered)),
    };
  });

  const actualDeclineJo = jo(creditTrough.credit - creditPeak.credit);
  const buildJo = sumJo(buckets);
  const exposureJo = sumJo(triggered);

  // gross 누적은 같은 자금이 들어왔다 나갔다 하면 두 번 세어진다. 창이 길수록 심하다.
  // (2020-21 사이클은 적립 합계가 신용 고점보다 10조 가까이 크게 나온다.)
  // 버킷이 알려주는 건 '지수대별 분포'이므로, 합계만 실제 순증(고점 - 기초잔고)에
  // 맞춰 균등 스케일한다. 분포는 그대로 두고 수준만 실측에 맞추는 보정이다.
  const netBuildJo = jo(creditPeak.credit - accRows[0].credit);
  const churnScale = buildJo > 0 ? netBuildJo / buildJo : 0;
  const scaledBuckets = buckets.map(b => ({ ...b, jo: b.jo * churnScale }));

  // 청산 국면: 신용융자 고점 ~ 저점(진행 중이면 최신). 감소분을 그날 지수대에 배분한다.
  // 적립과 달리 보정하지 않는다. 감소분 합계는 실측 잔고 변화와 직접 대응하기 때문이다.
  const unwindRows = rows.filter(r => r.date >= creditPeak.date && r.date <= creditTrough.date);
  const outflow = accumulateOutflow(unwindRows, w);
  const wBuild = weightedIndex(acc.buckets, w);
  const wUnwind = weightedIndex(outflow.buckets, w);

  // 거래대금 대비 규모. 실측 청산은 그 시대 기준(baseline)과 대조하고,
  // 앞으로 남은 사다리는 오늘 기준(current) 거래대금과 대조한다.
  const turnover = turnoverStats(turnoverRows, creditPeak.date, creditTrough.date);
  const ladder = buildLadder(buckets, scaledBuckets, turnover?.currentAvgDailyJo ?? null);
  const unwindPctOfTurnover = turnover ? (jo(outflow.total) / turnover.unwindTotalJo) * 100 : null;
  const unwindEquivDays = turnover?.baselineAvgDailyJo
    ? jo(outflow.total) / turnover.baselineAvgDailyJo : null;

  return {
    churnScale, netBuildJo,
    scaledBuckets,
    scaledExposureJo: exposureJo * churnScale,
    scaledRemainingJo: sumJo(remaining) * churnScale,
    unwind: {
      fromDate: creditPeak.date, toDate: creditTrough.date,
      buckets: toRows(outflow.buckets, w),
      totalJo: jo(outflow.total),
      // 실측 순감소보다 총유출이 크다. 청산 국면에도 신규 매수가 섞이기 때문이다.
      netJo: -actualDeclineJo,
      weightedBuildIdx: wBuild,
      weightedUnwindIdx: wUnwind,
      // 평균적으로 어느 지수대에서 사서 어느 지수대에서 털렸는지의 간격
      spreadPct: wBuild && wUnwind ? (wUnwind / wBuild - 1) * 100 : null,
      pctOfTurnover: unwindPctOfTurnover, equivDays: unwindEquivDays,
    },
    turnover, ladder,
    width: w, accBase, accEnd, evalEnd,
    headline: {
      idxPeakDate: idxPeak.date, idxPeak: idxPeak.idx,
      idxTroughDate: walk.find(x => x.minIdx === troughIdx)?.date ?? evalEnd,
      idxTrough: troughIdx,
      idxDrawdownPct: (troughIdx / idxPeak.idx - 1) * 100,
      idxLast: evalWindow.at(-1)!.idx, idxLastDate: evalWindow.at(-1)!.date,

      creditStartJo: jo(accRows[0].credit),
      creditPeakDate: creditPeak.date, creditPeakJo: jo(creditPeak.credit),
      creditTroughDate: creditTrough.date, creditTroughJo: jo(creditTrough.credit),
      creditLastJo: jo(creditWindow.at(-1)!.credit), creditLastDate: creditWindow.at(-1)!.date,
      actualDeclineJo,
      unwindPct: (actualDeclineJo / jo(creditPeak.credit)) * 100,

      buildJo, exposureJo,
      remainingJo: sumJo(remaining),
      exposureOfBuildPct: buildJo > 0 ? (exposureJo / buildJo) * 100 : 0,
    },
    buckets, walk, scenarios, sensitivity,
    reconciliation: {
      modelExposureJo: exposureJo,
      scaledExposureJo: exposureJo * churnScale,
      actualDeclineJo,
      gapJo: exposureJo + actualDeclineJo,                       // 실제 감소는 음수
      scaledGapJo: exposureJo * churnScale + actualDeclineJo,
      grossUpJo: jo(acc.grossUp),
      grossDownJo: jo(acc.grossDown),
    },
  };
}
