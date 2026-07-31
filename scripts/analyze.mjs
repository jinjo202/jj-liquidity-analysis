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
// 유가증권/코스닥은 data/credit-split.json 이 있을 때만 계산한다.
import fs from 'node:fs';
import path from 'node:path';
import { analyzeMarket, accumulate, classify, factorOf, MAINTENANCE, LOAN_RATIO } from './lib/buckets.mjs';

const DIR = path.join(import.meta.dirname, '..', 'data');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'kofia-daily.json'), 'utf8'));

const lastDate = raw.series.at(-1).date;

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
];

const idxKey = { 전체: 'OS0001', 유가증권: 'OS0001', 코스닥: 'OS0002' };

const splitPath = path.join(DIR, 'credit-split.json');
const split = fs.existsSync(splitPath)
  ? JSON.parse(fs.readFileSync(splitPath, 'utf8'))
  : null;

function buildInput(market) {
  const ik = idxKey[market];
  const idxRows = raw.series
    .filter(r => Number.isFinite(r[ik]))
    .map(r => ({ date: r.date, idx: r[ik] }));

  if (market === '전체') {
    return {
      idxRows,
      rows: raw.series
        .filter(r => Number.isFinite(r.OS0026) && Number.isFinite(r[ik]))
        .map(r => ({ date: r.date, idx: r[ik], credit: r.OS0026 })),
    };
  }
  if (!split) return null;

  const field = market === '유가증권' ? 'kospi' : 'kosdaq';
  const byDate = new Map(split.series.map(r => [r.date, r[field]]));
  return {
    idxRows,
    rows: idxRows
      .map(r => ({ ...r, credit: byDate.get(r.date) }))
      .filter(r => Number.isFinite(r.credit)),
  };
}

const MARKETS = ['전체', '유가증권', '코스닥'];
const inputs = Object.fromEntries(
  MARKETS.map(m => [m, buildInput(m)]).filter(([, v]) => v));

// 거래대금(조원). 억원 -> 조원은 /10000. '전체'는 코스피+코스닥 합계로, 신용융자 '전체'가
// 유가증권+코스닥 합계인 것과 같은 기준을 맞춘다.
function buildTurnover(market) {
  if (market === '유가증권') {
    return raw.series.filter(r => Number.isFinite(r.OS0011))
      .map(r => ({ date: r.date, valueJo: r.OS0011 / 1e4 }));
  }
  if (market === '코스닥') {
    return raw.series.filter(r => Number.isFinite(r.OS0012))
      .map(r => ({ date: r.date, valueJo: r.OS0012 / 1e4 }));
  }
  return raw.series.filter(r => Number.isFinite(r.OS0011) || Number.isFinite(r.OS0012))
    .map(r => ({ date: r.date, valueJo: ((r.OS0011 ?? 0) + (r.OS0012 ?? 0)) / 1e4 }));
}
const turnoverByMarket = Object.fromEntries(MARKETS.map(m => [m, buildTurnover(m)]));

const periods = PERIODS.map(p => {
  const markets = {};
  for (const [name, input] of Object.entries(inputs)) {
    const res = analyzeMarket({
      ...input, accBase: p.accBase, accEnd: p.accEnd, evalEnd: p.evalEnd,
      turnoverRows: turnoverByMarket[name],
    });
    if (res) markets[name] = res;
  }
  return { ...p, markets };
}).filter(p => Object.keys(p.markets).length);

/* ---------- 원 자료 재현 검증 ----------
   원 자료는 2026 연초 대비 · 500p 버킷 · 전체(시장 합계) 기준이다.
   사이클 구분과 별개로 방법론이 맞는지 보는 고정 검증이므로 조건을 그대로 둔다. */
const PDF_BARS = {
  4000: 0.36, 4500: 2.10, 5000: 4.00, 5500: 3.23, 6000: 2.86, 6500: 0.97,
  7000: 1.07, 7500: 1.28, 8000: 2.87, 8500: 0.92, 9000: 0.72,
};
const reproRows = inputs['전체'].rows.filter(r => r.date >= '20251231' && r.date <= '20260727');
const reproBuckets = classify(accumulate(reproRows, 500),
  raw.series.find(r => r.date === '20260727').OS0001);
const repro = Object.keys(PDF_BARS).map(Number).map(low => {
  const mine = reproBuckets.find(b => b.low === low)?.jo ?? 0;
  return { low, high: low + 500, pdf: PDF_BARS[low], mine, diff: mine - PDF_BARS[low] };
});
const reproMAE = repro.reduce((s, r) => s + Math.abs(r.diff), 0) / repro.length;

/* ---------- 신용/시가총액 비율 ---------- */
// 시가총액은 억원, 신용융자는 백만원. 억원 x 100 = 백만원.
const ratioSeries = raw.series
  .filter(r => Number.isFinite(r.OS0026) && Number.isFinite(r.OS0008))
  .map(r => ({
    date: r.date,
    mcapJo: ((r.OS0008 + (r.OS0009 ?? 0)) * 100) / 1e6,
    creditJo: r.OS0026 / 1e6,
    ratio: (r.OS0026 / ((r.OS0008 + (r.OS0009 ?? 0)) * 100)) * 100,
  }));
const ratioAt = d => ratioSeries.find(r => r.date === d) ?? null;

/* ---------- 앞으로 남은 청산 규모 추정 ---------- */
// 근거가 다른 벤치마크를 여러 개 놓는다. 하나로 수렴하지 않으므로 범위로 본다.
function projectRemaining() {
  const closed = periods.find(p => p.closed)?.markets['전체'];
  const open = periods.find(p => !p.closed)?.markets['전체'];
  if (!closed || !open) return null;

  const a = closed.headline, b = open.headline;
  const doneJo = -b.actualDeclineJo;          // 이미 청산된 양(양수)
  const peakJo = b.creditPeakJo;

  const benches = [];

  // 1) 직전 사이클 청산률을 그대로 적용
  const r1 = peakJo * (-a.unwindPct / 100);
  benches.push({
    key: 'unwindRate', name: '2021 사이클 청산률 대입',
    basis: `청산률 ${a.unwindPct.toFixed(1)}% x 신용 고점 ${peakJo.toFixed(2)}조`,
    totalJo: r1, remainJo: r1 - doneJo,
    caveat: '두 사이클의 레버리지 강도가 같다고 가정한다. 신용/시총 비율은 그렇지 않다고 말한다.',
  });

  // 2) 지수 낙폭 대비 청산 탄성
  const elast = (-a.unwindPct) / (-a.idxDrawdownPct);
  const r2 = peakJo * ((-b.idxDrawdownPct) * elast / 100);
  benches.push({
    key: 'elasticity', name: '지수 낙폭 대비 청산 탄성',
    basis: `탄성 ${elast.toFixed(2)} (2022: 청산 ${a.unwindPct.toFixed(1)}% / 지수 ${a.idxDrawdownPct.toFixed(1)}%) x 현 낙폭 ${b.idxDrawdownPct.toFixed(1)}%`,
    totalJo: r2, remainJo: r2 - doneJo,
    caveat: '탄성이 사이클 간에 일정하다고 가정한다.',
  });

  // 3) 마진콜 모델(보정)
  benches.push({
    key: 'marginModel', name: '마진콜 모델(보정)',
    basis: `현 지수 ${Math.round(b.idxTrough)}p 기준 진입 물량 ${open.scaledExposureJo.toFixed(2)}조`,
    totalJo: open.scaledExposureJo, remainJo: open.scaledExposureJo - doneJo,
    caveat: '강제 청산만 센다. 마진콜을 피하려는 자발적 축소는 포함하지 않는다.',
  });

  // 4) 신용/시총 비율이 직전 사이클 저점 비율로 회귀
  const troughRatio = ratioAt(a.creditTroughDate);
  const now = ratioSeries.at(-1);
  if (troughRatio && now) {
    const targetCreditJo = (troughRatio.ratio / 100) * now.mcapJo;
    const r4 = peakJo - targetCreditJo;
    benches.push({
      key: 'ratioNorm', name: '신용/시총 비율 정상화',
      basis: `2023 저점 비율 ${troughRatio.ratio.toFixed(3)}% x 현 시총 ${now.mcapJo.toFixed(0)}조 = 목표 잔고 ${targetCreditJo.toFixed(2)}조`,
      totalJo: r4, remainJo: r4 - doneJo,
      caveat: `현 비율은 이미 ${now.ratio.toFixed(3)}% 로 그 저점보다 낮다. 시총이 신용보다 빠르게 줄어 비율이 오히려 올라간 상태다.`,
    });
  }

  const remains = benches.map(x => x.remainJo);
  return {
    doneJo, peakJo,
    currentRatio: ratioSeries.at(-1),
    peakRatio: ratioAt(b.creditPeakDate),
    prevPeakRatio: ratioAt(a.creditPeakDate),
    prevTroughRatio: troughRatio,
    benches,
    lowJo: Math.min(...remains), highJo: Math.max(...remains),
    // 추가 하락 시 열리는 물량(보정)
    scenarioRemain: open.scenarios.map(s => ({
      idx: s.idx,
      exposureJo: s.exposureJo * open.churnScale,
      extraJo: (s.exposureJo - open.headline.exposureJo) * open.churnScale,
    })),
  };
}
const projection = projectRemaining();

/* ---------- 연도별 월간 지수·거래대금 ---------- */
// 코스피(2,000~9,000대)와 코스닥(600~1,200대)은 원 지수로 겹쳐 그리면 코스닥이 눌린다.
// 그래서 지수는 그 해 1월을 100으로 지수화해 같은 축에 놓고, 거래대금은 원래 단위(조원)로 둔다.
// 두 사이클의 신용 고점이 속한 해(2021 / 2026)를 그대로 비교 대상으로 쓴다.
function monthlyProfile(year, throughDate) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const from = `${year}${mm}01`;
    const nextY = m < 12 ? year : year + 1;
    const nextM = m < 12 ? m + 1 : 1;
    const to = `${nextY}${String(nextM).padStart(2, '0')}01`;
    if (from > throughDate) break;
    const w = raw.series.filter(r => r.date >= from && r.date < to && r.date <= throughDate);
    if (!w.length) break;
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
    const kIdx = avg(w.map(r => r.OS0001).filter(Number.isFinite));
    const qIdx = avg(w.map(r => r.OS0002).filter(Number.isFinite));
    const kTo = avg(w.map(r => r.OS0011).filter(Number.isFinite));
    const qTo = avg(w.map(r => r.OS0012).filter(Number.isFinite));
    months.push({
      ym: `${year}-${mm}`, days: w.length,
      kIdx, qIdx, kToJo: kTo != null ? kTo / 1e4 : null, qToJo: qTo != null ? qTo / 1e4 : null,
    });
  }
  if (!months.length) return null;
  const kBase = months[0].kIdx, qBase = months.find(m => m.qIdx != null)?.qIdx;
  return {
    year, months,
    kIdxIdx: months.map(m => (kBase ? (m.kIdx / kBase) * 100 : null)),
    qIdxIdx: months.map(m => (qBase && m.qIdx != null ? (m.qIdx / qBase) * 100 : null)),
  };
}
const closedYear = Number(PERIODS[0].accEnd.slice(0, 4));
const openYear = Number(lastDate.slice(0, 4));
const monthly = {
  closed: monthlyProfile(closedYear, `${closedYear}1231`),
  open: monthlyProfile(openYear, lastDate),
};

/* ---------- 대차잔고(공매도 프록시)와 숏커버링 ---------- */
// 한국은 공매도가 거의 전량 차입 후 매도라, 대차잔고를 시장 전체 공매도 잔고의
// 표준 프록시로 쓴다. 시장 전체 실제 공매도 잔고는 공표되지 않는다(종목별 순보유잔고,
// 대량보유자 신고 기준만 공표). data/lending-balance.json 이 있을 때만 계산한다.
const lendingPath = path.join(DIR, 'lending-balance.json');
let lending = null;
if (fs.existsSync(lendingPath)) {
  const lend = JSON.parse(fs.readFileSync(lendingPath, 'utf8'));
  const idxByDate = new Map(raw.series.filter(r => Number.isFinite(r.OS0001)).map(r => [r.date, r.OS0001]));
  const merged = lend.series
    .map(r => ({ date: r.date, balJo: r.balanceMil / 1e6, idx: idxByDate.get(r.date) }))
    .filter(r => Number.isFinite(r.idx))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < merged.length; i++) {
    merged[i].dIdxPct = (merged[i].idx / merged[i - 1].idx - 1) * 100;
    merged[i].dBalPct = (merged[i].balJo / merged[i - 1].balJo - 1) * 100;
  }

  const allTimePeak = merged.reduce((m, r) => (r.balJo > m.balJo ? r : m));
  const last = merged.at(-1);

  // 진행 중인 사이클(신용융자 분석과 같은 창) 안에서의 잔고 고점 -> 현재.
  const openP = PERIODS.find(p => !p.closed);
  const cycleWindow = merged.filter(r => r.date >= openP.accBase && r.date <= openP.evalEnd);
  const cyclePeak = cycleWindow.reduce((m, r) => (r.balJo > m.balJo ? r : m), cycleWindow[0]);
  const afterCyclePeak = cycleWindow.filter(r => r.date >= cyclePeak.date);
  const cycleDeclinePct = (afterCyclePeak.at(-1).balJo / cyclePeak.balJo - 1) * 100;

  // 잔고 고점 이후 구간에서 하루 단위 지수-잔고 co-movement 를 센다.
  const tail = afterCyclePeak.slice(1);
  const dayClass = {
    coverType: tail.filter(r => r.dIdxPct > 0 && r.dBalPct < 0).length,   // 지수↑ 잔고↓ = 숏커버형
    jointUnwind: tail.filter(r => r.dIdxPct < 0 && r.dBalPct < 0).length, // 지수↓ 잔고↓ = 동반 청산
    newShort: tail.filter(r => r.dIdxPct < 0 && r.dBalPct > 0).length,    // 지수↓ 잔고↑ = 신규 숏 추정
    riskOn: tail.filter(r => r.dIdxPct > 0 && r.dBalPct > 0).length,
  };

  const candidates = tail
    .filter(r => r.dIdxPct > 0 && r.dBalPct < 0)
    .map(r => ({ ...r, score: r.dIdxPct * -r.dBalPct }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  /* ----- 숏커버 여력: 잔고가 '정상'으로 돌아가려면 얼마가 더 되갚아져야 하는가 ----- */
  // 대차잔고 감소 = 빌린 주식을 사서 갚는 것 = 매수 압력. 신용융자 쪽 §12 가
  // '얼마나 더 팔려야 하나'를 범위로 봤듯이, 여기서는 '얼마나 더 사야 하나'를 범위로 본다.
  // 벤치마크가 하나로 수렴하지 않는 것도 §12 와 같다.
  const mcapByDate = new Map(raw.series
    .filter(r => Number.isFinite(r.OS0008))
    .map(r => [r.date, ((r.OS0008 + (r.OS0009 ?? 0)) * 100) / 1e6]));      // 조원
  const turnByDate = new Map(raw.series
    .filter(r => Number.isFinite(r.OS0011) || Number.isFinite(r.OS0012))
    .map(r => [r.date, ((r.OS0011 ?? 0) + (r.OS0012 ?? 0)) / 1e4]));       // 조원

  const ratioAtDate = d => {
    const m = mcapByDate.get(d), b = merged.find(r => r.date === d)?.balJo;
    return m && b ? (b / m) * 100 : null;
  };

  // 직전(완결) 사이클의 대차잔고 고점 -> 저점. 되돌림이 어디서 멈췄는지가 기준점이 된다.
  const closedP = PERIODS.find(p => p.closed);
  const prevWindow = merged.filter(r => r.date >= closedP.accBase && r.date <= closedP.evalEnd);
  const prevPeak = prevWindow.length ? prevWindow.reduce((m, r) => (r.balJo > m.balJo ? r : m)) : null;
  const prevTrough = prevPeak
    ? prevWindow.filter(r => r.date >= prevPeak.date).reduce((m, r) => (r.balJo < m.balJo ? r : m))
    : null;

  // 오늘 기준 하루 평균 거래대금(최근 20영업일). '며칠치 매수인가'로 환산하는 데 쓴다.
  const recentTurn = merged.slice(-20).map(r => turnByDate.get(r.date)).filter(Number.isFinite);
  const dailyTurnoverJo = recentTurn.length
    ? recentTurn.reduce((s, v) => s + v, 0) / recentTurn.length : null;

  const coveredJo = cyclePeak.balJo - last.balJo;   // 고점 이후 이미 되갚아진 양
  const benches = [];
  const push = (key, name, targetJo, basis, caveat) => {
    if (!Number.isFinite(targetJo)) return;
    benches.push({
      key, name, targetJo, basis, caveat,
      remainJo: last.balJo - targetJo,             // 양수면 더 커버될 여지
      equivDays: dailyTurnoverJo ? (last.balJo - targetJo) / dailyTurnoverJo : null,
    });
  };

  // 1) 이번 사이클 적립 시작 시점 잔고로 복귀
  const baseRow = merged.find(r => r.date >= openP.accBase);
  if (baseRow) {
    push('cycleBase', '사이클 시작 잔고로 복귀', baseRow.balJo,
      `${baseRow.date} 잔고 ${baseRow.balJo.toFixed(2)}조`,
      '이번 사이클에서 쌓인 대차가 전부 풀린다고 본다. 구조적 증가분(ETF 확대 등)은 안 풀릴 수 있다.');
  }
  // 1b) 같은 복귀를 절대 잔고가 아니라 시총 대비 비율로 본다. 시총이 그 사이 2배가 됐으므로
  //     절대 잔고 복귀는 사실상 '시장이 그때 크기로 돌아간다'는 가정과 같아 과대추정이 된다.
  const baseRatio = baseRow ? ratioAtDate(baseRow.date) : null;
  if (baseRatio && mcapByDate.get(last.date)) {
    push('baseRatio', '사이클 시작 비율로 복귀', (baseRatio / 100) * mcapByDate.get(last.date),
      `${baseRow.date} 잔고/시총 ${baseRatio.toFixed(2)}% × 현 시총 ${mcapByDate.get(last.date).toFixed(0)}조`,
      '시총 성장분을 감안한 복귀 목표다. 위의 절대 잔고 복귀보다 현실적이다.');
  }
  // 2) 직전 사이클의 잔고 감소율을 이번 고점에 적용
  if (prevPeak && prevTrough) {
    const declPct = prevTrough.balJo / prevPeak.balJo - 1;
    push('prevDecline', '직전 사이클 감소율 대입', cyclePeak.balJo * (1 + declPct),
      `${closedP.name} 잔고 ${prevPeak.balJo.toFixed(1)}조(${prevPeak.date}) → ${prevTrough.balJo.toFixed(1)}조(${prevTrough.date}), ${(declPct * 100).toFixed(1)}% × 이번 고점 ${cyclePeak.balJo.toFixed(1)}조`,
      '두 사이클의 대차 수요 구성이 같다고 가정한다.');
  }
  // 3) 대차잔고/시총 비율이 직전 사이클 저점 비율로 회귀
  const prevTroughRatio = prevTrough ? ratioAtDate(prevTrough.date) : null;
  const nowMcap = mcapByDate.get(last.date);
  if (prevTroughRatio && nowMcap) {
    push('ratioNorm', '잔고/시총 비율 정상화', (prevTroughRatio / 100) * nowMcap,
      `직전 사이클 저점 비율 ${prevTroughRatio.toFixed(2)}% × 현 시총 ${nowMcap.toFixed(0)}조`,
      '시총이 지수와 같이 움직이므로, 지수가 더 오르면 목표 잔고도 같이 올라간다.');
  }

  const remains = benches.map(b => b.remainJo);
  const cover = {
    coveredJo,
    coveredPctOfPeak: (coveredJo / cyclePeak.balJo) * 100,
    dailyTurnoverJo,
    coveredEquivDays: dailyTurnoverJo ? coveredJo / dailyTurnoverJo : null,
    nowRatio: ratioAtDate(last.date),
    peakRatio: ratioAtDate(cyclePeak.date),
    prevPeak, prevTrough, prevTroughRatio,
    benches,
    lowJo: remains.length ? Math.min(...remains) : null,
    highJo: remains.length ? Math.max(...remains) : null,
  };

  lending = {
    meta: lend.meta,
    allTimePeak, last,
    cyclePeak, cycleDeclinePct,
    dayClass, candidates, cover,
    series: merged.filter(r => r.date >= '20200101').map(r => ({ d: r.date, bal: r.balJo, idx: r.idx })),
  };
}

/* ---------- 실측 스트레스 지표 ---------- */
// OS0025(반대매매금액)는 위탁매매 미수금에 대한 반대매매다. 신용융자 반대매매는
// 공표되지 않으므로 추정치의 검증값이 아니라 별도 스트레스 축으로만 쓴다.
const stress = raw.series
  .filter(r => r.date >= '20260601' && Number.isFinite(r.OS0025))
  .map(r => ({
    date: r.date, idx: r.OS0001, kosdaq: r.OS0002 ?? null,
    forced: r.OS0025, unpaid: r.OS0024, credit: r.OS0026 ?? null,
  }));

/* ---------- 예탁금과 2차 레버리지 채널 ---------- */
// 지금까지의 분석은 신용융자(OS0026) 한 채널만 봤다. 그런데 개인 레버리지에는
// 예탁증권담보융자(OS0027)라는 두 번째 통로가 있고, 그 반대편에는 대기자금인
// 투자자예탁금(OS0021)이 있다. 셋을 같이 놓아야 '레버리지가 감당 가능한가'를 볼 수 있다.
// 단위는 전부 백만원이므로 /1e6 하면 조원이다.
function leverageChannels() {
  const rows = raw.series
    .filter(r => Number.isFinite(r.OS0021) && Number.isFinite(r.OS0026) && r.OS0026 > 0)
    .map(r => ({
      date: r.date,
      idx: Number.isFinite(r.OS0001) ? r.OS0001 : null,
      depositJo: r.OS0021 / 1e6,
      creditJo: r.OS0026 / 1e6,
      pledgeJo: Number.isFinite(r.OS0027) ? r.OS0027 / 1e6 : null,
      coverage: r.OS0021 / r.OS0026,                  // 예탁금 / 신용융자 (배)
    }))
    .map(r => ({ ...r, totalLevJo: r.creditJo + (r.pledgeJo ?? 0) }));
  if (!rows.length) return null;

  const byDate = new Map(rows.map(r => [r.date, r]));
  const at = d => byDate.get(d) ?? null;

  // 커버리지는 낮을수록 '빚 대비 실탄이 없다'는 뜻이다. 현재가 역사적으로 어디쯤인지
  // 백분위로 준다(0% = 역대 최저, 100% = 역대 최고).
  const last = rows.at(-1);
  const sorted = rows.map(r => r.coverage).sort((a, b) => a - b);
  const pct = sorted.filter(v => v < last.coverage).length / sorted.length * 100;
  const covMin = rows.reduce((m, r) => (r.coverage < m.coverage ? r : m));
  const covMax = rows.reduce((m, r) => (r.coverage > m.coverage ? r : m));
  const levPeak = rows.reduce((m, r) => (r.totalLevJo > m.totalLevJo ? r : m));

  // 사이클 기준점에서의 스냅샷. 신용융자 고점/저점 날짜를 그대로 가져온다.
  const hA = periods.find(p => p.closed)?.markets['전체']?.headline;
  const hB = periods.find(p => !p.closed)?.markets['전체']?.headline;
  const marks = [
    hA && { label: '2021 신용 고점', ...at(hA.creditPeakDate), date: hA.creditPeakDate },
    hA && { label: '2023 신용 저점', ...at(hA.creditTroughDate), date: hA.creditTroughDate },
    hB && { label: '2026 신용 고점', ...at(hB.creditPeakDate), date: hB.creditPeakDate },
    { label: '현재', ...last },
  ].filter(m => m && Number.isFinite(m.coverage));

  return {
    last, pct, covMin, covMax, levPeak, marks,
    pledgeSharePct: last.pledgeJo != null ? (last.pledgeJo / last.totalLevJo) * 100 : null,
    series: rows.filter((r, i) => i % 5 === 0 || i === rows.length - 1)
      .map(r => ({ d: r.date, dep: r.depositJo, cr: r.creditJo, pl: r.pledgeJo, cov: r.coverage })),
  };
}
const channels = leverageChannels();

/* ---------- 미수금 -> 반대매매 전이 ---------- */
// 위탁매매미수금(OS0024)은 결제하지 못한 외상 매수다. 결제일(D+2)까지 채우지 못하면
// 증권사가 반대매매(OS0025)로 처분한다. 즉 미수금은 반대매매의 선행지표여야 하고,
// 시차는 영업일 2일이어야 한다. 실제 데이터에서 그 시차가 나오는지 확인한다.
function unpaidLead() {
  const rows = raw.series
    .filter(r => Number.isFinite(r.OS0024) && Number.isFinite(r.OS0025) && r.OS0024 > 0)
    .map(r => ({ date: r.date, unpaid: r.OS0024 / 1e6, forced: r.OS0025 / 1e6 }));
  if (rows.length < 60) return null;

  const pearson = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  };

  // 미수금[t] 와 반대매매[t+lag] 의 상관. 전 구간과 최근 구간을 따로 본다.
  const lagStats = (from) => {
    const w = rows.filter(r => r.date >= from);
    return [0, 1, 2, 3].map(lag => {
      const xs = [], ys = [];
      for (let i = 0; i + lag < w.length; i++) { xs.push(w[i].unpaid); ys.push(w[i + lag].forced); }
      return { lag, n: xs.length, r: pearson(xs, ys) };
    });
  };
  const full = lagStats(rows[0].date);
  const recent = lagStats('20250101');
  const best = full.reduce((m, s) => ((s.r ?? -2) > (m.r ?? -2) ? s : m));

  // 전이율 = 반대매매[t+best.lag] / 미수금[t]. 평균은 이상치에 끌려가므로 중앙값을 쓴다.
  const ratios = [];
  for (let i = 0; i + best.lag < rows.length; i++) {
    if (rows[i].unpaid > 0) ratios.push(rows[i + best.lag].forced / rows[i].unpaid);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];

  const last = rows.at(-1);
  const recentRows = rows.slice(-60);
  const avg60 = recentRows.reduce((s, r) => s + r.unpaid, 0) / recentRows.length;
  const topUnpaid = [...rows].sort((a, b) => b.unpaid - a.unpaid).slice(0, 5);

  return {
    full, recent, best, medianTransfer: median, last, avg60, topUnpaid,
    // 현재 미수금이 그대로 전이되면 나올 반대매매 규모
    impliedForcedJo: last.unpaid * median,
    tail: rows.slice(-25),
  };
}
const unpaid = unpaidLead();

/* ---------- 교차검증 소스의 최신 지수 ---------- */
// FREESIS 는 EOD 공표라 하루 이상 늦다. 네이버 계열이 더 최신이면 그 값을 같이 싣는다.
// 장중에 돌리면 마지막 행은 '종가'가 아니라 진행 중인 값이므로 그렇게 표시한다.
let spot = null;
let crossCheckRows = null;
let spotSource = null;                 // 네이버 계열의 마지막 행(FREESIS 보다 빠르든 아니든)
const kospiPath = path.join(DIR, 'kospi-daily.json');
if (fs.existsSync(kospiPath)) {
  const kd = JSON.parse(fs.readFileSync(kospiPath, 'utf8'));
  crossCheckRows = kd.length;
  const l = kd.at(-1);
  spotSource = l ? { date: l.date, idx: l.close } : null;
  if (l && l.date > lastDate) {
    const base = raw.series.filter(r => Number.isFinite(r.OS0001)).at(-1);
    spot = {
      date: l.date, idx: l.close,
      baseDate: base.date, baseIdx: base.OS0001,
      changePct: (l.close / base.OS0001 - 1) * 100,
      note: '네이버 금융 일별 시세. 장중이면 종가가 아니라 진행 중인 값이다. 본문의 모든 계산은 FREESIS 최종 공표일 기준이다.',
    };
  }
}

/* ---------- 전일 대비 변화 + 데이터 신선도 ---------- */
// 자동 갱신을 걸어두면 리포트를 매일 열게 된다. 그때 제일 먼저 알고 싶은 것은
// "어제와 뭐가 달라졌나"와 "이 숫자가 며칠 전 것인가"다.
// 계열마다 공표 시차가 달라서(지수 T+1, 신용융자 결제일 기준 T+2, 대차 T+1) 각각 표시한다.
function dailyDelta() {
  const pick = (field, scale = 1) => {
    const rows = raw.series.filter(r => Number.isFinite(r[field]));
    if (rows.length < 2) return null;
    const [prev, last] = [rows.at(-2), rows.at(-1)];
    const v = r => r[field] / scale;
    return {
      date: last.date, prevDate: prev.date,
      value: v(last), prev: v(prev),
      delta: v(last) - v(prev),
      pct: prev[field] ? (v(last) / v(prev) - 1) * 100 : null,
    };
  };

  const items = [
    { key: 'idx', label: '코스피', unit: 'p', ...pick('OS0001') },
    { key: 'kosdaq', label: '코스닥', unit: 'p', ...pick('OS0002') },
    { key: 'credit', label: '신용융자', unit: '조', ...pick('OS0026', 1e6) },
    { key: 'deposit', label: '투자자예탁금', unit: '조', ...pick('OS0021', 1e6) },
    { key: 'unpaid', label: '위탁매매미수금', unit: '조', ...pick('OS0024', 1e6) },
  ].filter(x => x.date);

  if (lending) {
    const s = lending.series;
    if (s.length >= 2) {
      const [p, l] = [s.at(-2), s.at(-1)];
      items.push({
        key: 'lending', label: '대차잔고', unit: '조',
        date: l.d, prevDate: p.d, value: l.bal, prev: p.bal,
        delta: l.bal - p.bal, pct: (l.bal / p.bal - 1) * 100,
      });
    }
  }

  // 계열별 최신 관측일. 가장 늦은 계열이 리포트 전체의 '기준일'이 된다.
  const freshness = [
    { label: '지수·거래대금', date: raw.series.filter(r => Number.isFinite(r.OS0001)).at(-1)?.date },
    { label: '신용융자·예탁금', date: raw.series.filter(r => Number.isFinite(r.OS0026)).at(-1)?.date },
    lending && { label: '대차잔고', date: lending.last.date },
    spotSource && { label: '교차검증 지수(네이버)', date: spotSource.date, live: true },
  ].filter(x => x && x.date);

  return { items, freshness };
}

const daily = dailyDelta();

const out = {
  meta: {
    maintenance: MAINTENANCE, loanRatio: LOAN_RATIO, marginFactor: factorOf(),
    hasSplit: !!split, markets: Object.keys(inputs), crossCheckRows,
    source: raw.meta, splitSource: split?.meta ?? null,
  },
  periods, repro, reproMAE, stress, projection, monthly, lending, channels, unpaid, spot, daily,
  ratio: ratioSeries.filter((r, i) => i % 5 === 0 || i === ratioSeries.length - 1),
  series: raw.series
    .filter(r => Number.isFinite(r.OS0001))
    .map(r => ({ d: r.date, i: r.OS0001, q: r.OS0002 ?? null, c: r.OS0026 ?? null })),
};

fs.writeFileSync(path.join(DIR, 'analysis.json'), JSON.stringify(out));

/* ---------- 콘솔 리포트 ---------- */

const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const k0 = n => Math.round(n).toLocaleString();

for (const p of periods) {
  console.log(`\n${'#'.repeat(66)}\n# ${p.name}   적립 ${p.accBase}~${p.accEnd} / 청산판정 ~${p.evalEnd}`);
  for (const [name, m] of Object.entries(p.markets)) {
    const h = m.headline;
    console.log(`\n  [${name}]  버킷 ${m.width}p`);
    console.log(`  지수  고점 ${k0(h.idxPeak)} (${h.idxPeakDate}) -> 저점 ${k0(h.idxTrough)} (${h.idxTroughDate})  ${f(h.idxDrawdownPct, 1)}%`);
    console.log(`  신용  고점 ${f(h.creditPeakJo)}조 (${h.creditPeakDate}) -> 저점 ${f(h.creditTroughJo)}조 (${h.creditTroughDate})  ${f(h.actualDeclineJo)}조 (${f(h.unwindPct, 1)}%)`);
    console.log(`  적립 gross ${f(h.buildJo)}조 / 순증 ${f(m.netBuildJo)}조 (churn 보정계수 ${f(m.churnScale)})`);
    console.log(`  마진콜 진입  gross ${f(h.exposureJo)}조 -> 보정 ${f(m.scaledExposureJo)}조 (적립의 ${f(h.exposureOfBuildPct, 0)}%) / 미진입 보정 ${f(m.scaledRemainingJo)}조`);
    console.log('    구간             금액   마진콜레벨  상태');
    for (const b of m.buckets.filter(b => b.jo >= 0.005)) {
      const st = b.fullyTriggered ? '청산완료' : b.triggered ? '청산진행' : '';
      console.log(`    ${k0(b.low).padStart(6)}-${k0(b.high).padEnd(7)} ${f(b.jo).padStart(6)}  ${k0(b.marginHigh).padStart(8)}   ${st}`);
    }
    const rc = m.reconciliation;
    console.log(`    모델 gross ${f(rc.modelExposureJo)}조 (차이 ${f(rc.gapJo)}조) / 보정 ${f(rc.scaledExposureJo)}조 (차이 ${f(rc.scaledGapJo)}조)  vs 실측 ${f(rc.actualDeclineJo)}조`);
    console.log('    민감도: ' + m.sensitivity.map(s => `${f(s.maintenance * 100, 0)}%=${f(s.exposureJo)}`).join('  '));

    const u = m.unwind;
    console.log(`\n    [청산 국면 ${u.fromDate}~${u.toDate}]  총유출 ${f(u.totalJo)}조 / 순감소 ${f(u.netJo)}조`);
    console.log(`    가중평균  매수 ${k0(u.weightedBuildIdx)}p -> 청산 ${k0(u.weightedUnwindIdx)}p  (${f(u.spreadPct, 1)}%)`);
    console.log('      구간             청산액');
    for (const b of u.buckets.filter(b => b.jo >= 0.005)) {
      console.log(`      ${k0(b.low).padStart(6)}-${k0(b.high).padEnd(7)} ${f(b.jo).padStart(6)}`);
    }

    if (m.turnover) {
      const t = m.turnover;
      console.log(`\n    [거래대금 대비]  그 시대 정상 평균(청산 직전 20일) 일 ${f(t.baselineAvgDailyJo)}조  /  오늘 기준 최근 평균 일 ${f(t.currentAvgDailyJo)}조`);
      console.log(`    청산국면 거래대금  총 ${f(t.unwindTotalJo)}조 / 일평균 ${f(t.unwindAvgDailyJo)}조 (그 시대 정상 대비 ${f(t.unwindVsBaselinePct, 0)}%)`);
      console.log(`    청산 국면 총유출(gross) ${f(u.totalJo)}조 = 그 기간 거래대금의 ${f(u.pctOfTurnover, 2)}% = 그 시대 정상 하루 거래대금의 ${f(u.equivDays, 2)}배`);
      console.log(`    (참고: 순감소 ${f(-u.netJo)}조는 같은 기간 신규매수와 상쇄되고 남은 잔고 변화다)`);
    }

    if (m.ladder.length) {
      console.log(`\n    [마진콜 사다리]  현재 지수 ${k0(h.idxTrough)}p 기준, 밑으로 마감하면 열리는 물량 (오늘 기준 거래대금 대비)`);
      for (const r of m.ladder) {
        const days = r.incrementalPctOfDay != null
          ? ` (평소 하루 거래대금의 ${f(r.incrementalPctOfDay, 1)}%, 누적 ${f(r.cumulativePctOfDay, 1)}%)` : '';
        console.log(`      ${k0(r.threshold)}p 밑 -> +${f(r.incrementalJo)}조 (누적 ${f(r.cumulativeJo)}조)${days}`);
      }
    }
  }
}

// 두 사이클 대조
if (periods.length === 2 && periods.every(p => p.markets['전체'])) {
  const [ma, mb] = periods.map(p => p.markets['전체']);
  const [a, b] = [ma.headline, mb.headline];
  console.log(`\n${'#'.repeat(66)}\n# 사이클 대조 (전체)`);
  const row = (lb, x, y) => console.log(`  ${lb.padEnd(22)} ${String(x).padStart(20)} ${String(y).padStart(20)}`);
  row('', periods[0].name, periods[1].name);
  row('버킷 폭', ma.width + 'p', mb.width + 'p');
  row('지수 고점', k0(a.idxPeak), k0(b.idxPeak));
  row('지수 낙폭', f(a.idxDrawdownPct, 1) + '%', f(b.idxDrawdownPct, 1) + '%');
  row('신용 고점', f(a.creditPeakJo) + '조', f(b.creditPeakJo) + '조');
  row('신용 청산(실측)', f(a.actualDeclineJo) + '조', f(b.actualDeclineJo) + '조');
  row('청산률', f(a.unwindPct, 1) + '%', f(b.unwindPct, 1) + '%');
  row('마진콜 진입(보정)', f(ma.scaledExposureJo) + '조', f(mb.scaledExposureJo) + '조');

  console.log(`\n  보정 모델은 2021 사이클을 ${f(ma.scaledExposureJo)}조로 추정했고 실측은 ${f(-a.actualDeclineJo)}조였다`
    + ` (오차 ${f(Math.abs(ma.reconciliation.scaledGapJo))}조). 끝난 사이클에서 모델이 검증된다.`);
  console.log(`  2021 사이클: 지수 ${f(a.idxDrawdownPct, 1)}% 하락에 신용 ${f(a.unwindPct, 1)}% 청산.`);
  console.log(`  현 사이클  : 지수 ${f(b.idxDrawdownPct, 1)}% 하락인데 신용은 ${f(b.unwindPct, 1)}% 만 청산.`);

  // 2021 사이클의 청산률(신용고점 대비)을 현 사이클 신용고점에 적용
  const impliedJo = b.creditPeakJo * (a.unwindPct / 100);      // 음수
  const residualJo = impliedJo - b.actualDeclineJo;            // 음수면 아직 남았다는 뜻
  console.log(`  2021 청산률 적용 시 총 ${f(impliedJo)}조 청산 -> 현재까지 ${f(b.actualDeclineJo)}조, 잔여 ${f(residualJo)}조.`);
}

if (projection) {
  const p = projection;
  console.log(`\n${'#'.repeat(66)}\n# 앞으로 남은 청산 규모 (전체)`);
  console.log(`  이미 청산 ${f(p.doneJo)}조 (신용 고점 ${f(p.peakJo)}조 대비 ${f(p.doneJo / p.peakJo * 100, 1)}%)`);
  console.log(`  신용/시총 비율  2021 고점 ${f(p.prevPeakRatio?.ratio, 3)}% -> 2023 저점 ${f(p.prevTroughRatio?.ratio, 3)}%`);
  console.log(`                  2026 고점 ${f(p.peakRatio?.ratio, 3)}% -> 현재 ${f(p.currentRatio?.ratio, 3)}%`);
  for (const b of p.benches) {
    console.log(`\n  [${b.name}]`);
    console.log(`    ${b.basis}`);
    console.log(`    총 청산 ${f(b.totalJo)}조  ->  잔여 ${f(b.remainJo)}조`);
    console.log(`    단서: ${b.caveat}`);
  }
  console.log(`\n  잔여 추정 범위: ${f(p.lowJo)}조 ~ ${f(p.highJo)}조`);
  console.log('  추가 하락 시 열리는 물량(보정): ' + p.scenarioRemain
    .map(s => `${k0(s.idx)}p=+${f(s.extraJo)}`).join('  '));
}

for (const key of ['closed', 'open']) {
  const mo = monthly[key];
  if (!mo) continue;
  console.log(`\n${'#'.repeat(66)}\n# ${mo.year}년 월별 지수(1월=100)·거래대금`);
  mo.months.forEach((m, i) => {
    console.log(`  ${m.ym}  코스피지수 ${f(mo.kIdxIdx[i], 1)} (${k0(m.kIdx)})  코스닥지수 ${f(mo.qIdxIdx[i], 1)} (${k0(m.qIdx)})  코스피거래대금 ${f(m.kToJo)}조  코스닥거래대금 ${f(m.qToJo)}조`);
  });
}

if (lending) {
  console.log(`\n${'#'.repeat(66)}\n# 대차잔고(공매도 프록시)`);
  console.log(`  역대 최고 ${f(lending.allTimePeak.balJo)}조 (${lending.allTimePeak.date})  ->  현재 ${f(lending.last.balJo)}조 (${lending.last.date})`);
  console.log(`  이번 사이클 잔고 고점 ${f(lending.cyclePeak.balJo)}조 (${lending.cyclePeak.date})  ->  ${f(lending.cycleDeclinePct, 1)}%`);
  console.log(`  고점 이후 하루 단위 조합: 숏커버형(지수↑잔고↓)=${lending.dayClass.coverType}  동반청산(지수↓잔고↓)=${lending.dayClass.jointUnwind}  신규숏추정(지수↓잔고↑)=${lending.dayClass.newShort}  동반상승=${lending.dayClass.riskOn}`);
  console.log('  숏커버링 후보일:');
  for (const c of lending.candidates) {
    console.log(`    ${c.date}  지수 ${k0(c.idx)}(${f(c.dIdxPct, 2)}%)  잔고 ${f(c.balJo)}조(${f(c.dBalPct, 2)}%)`);
  }

  const cv = lending.cover;
  console.log(`\n  [숏커버 여력]  이미 되갚음 ${f(cv.coveredJo)}조 (고점의 ${f(cv.coveredPctOfPeak, 1)}%`
    + `${cv.coveredEquivDays ? `, 오늘 하루 거래대금의 ${f(cv.coveredEquivDays, 1)}배` : ''})`);
  console.log(`  잔고/시총 비율  이번 고점 ${f(cv.peakRatio)}% -> 현재 ${f(cv.nowRatio)}%  (직전 사이클 저점 ${f(cv.prevTroughRatio)}%)`);
  for (const b of cv.benches) {
    console.log(`\n  [${b.name}]`);
    console.log(`    ${b.basis}`);
    console.log(`    목표 잔고 ${f(b.targetJo)}조  ->  잔여 커버 ${f(b.remainJo)}조`
      + `${b.equivDays != null ? ` (하루 거래대금의 ${f(b.equivDays, 2)}배)` : ''}`);
    console.log(`    단서: ${b.caveat}`);
  }
  console.log(`\n  잔여 숏커버 범위: ${f(cv.lowJo)}조 ~ ${f(cv.highJo)}조  (하루 평균 거래대금 ${f(cv.dailyTurnoverJo)}조)`);
}

if (channels) {
  const c = channels;
  console.log(`\n${'#'.repeat(66)}\n# 예탁금과 2차 레버리지 채널 (${c.last.date})`);
  console.log(`  투자자예탁금 ${f(c.last.depositJo)}조  /  신용융자 ${f(c.last.creditJo)}조  /  예탁증권담보융자 ${f(c.last.pledgeJo)}조`);
  console.log(`  총 레버리지 ${f(c.last.totalLevJo)}조 (담보융자가 ${f(c.pledgeSharePct, 0)}% — 마진콜 모델이 안 세는 부분)`);
  console.log(`  총 레버리지 역대 최고 ${f(c.levPeak.totalLevJo)}조 (${c.levPeak.date})`);
  console.log(`  예탁금 커버리지 ${f(c.last.coverage)}배 = 역대 ${f(c.pct, 0)}백분위 (최저 ${f(c.covMin.coverage)}배 ${c.covMin.date} / 최고 ${f(c.covMax.coverage)}배 ${c.covMax.date})`);
  console.log('    기준점            예탁금    신용융자   담보융자   커버리지');
  for (const m of c.marks) {
    console.log(`    ${m.label.padEnd(14)} ${f(m.depositJo).padStart(8)}조 ${f(m.creditJo).padStart(8)}조 ${f(m.pledgeJo).padStart(8)}조 ${f(m.coverage).padStart(8)}배`);
  }
}

if (unpaid) {
  const u = unpaid;
  console.log(`\n${'#'.repeat(66)}\n# 미수금 -> 반대매매 전이`);
  console.log('  미수금[t] vs 반대매매[t+lag] 상관계수');
  console.log('    lag        전구간      2025년이후');
  u.full.forEach((s, i) => console.log(`    ${s.lag}일  ${f(s.r, 3).padStart(12)} ${f(u.recent[i]?.r, 3).padStart(12)}   (n=${s.n})`));
  console.log(`  최대 상관 시차 ${u.best.lag}일 (r=${f(u.best.r, 3)}) — 결제일 D+2 규칙과 ${u.best.lag === 2 ? '일치' : '불일치'}`);
  console.log(`  전이율 중앙값 ${f(u.medianTransfer * 100, 1)}% (미수금 1조당 반대매매 ${f(u.medianTransfer, 3)}조)`);
  console.log(`  현재 미수금 ${f(u.last.unpaid)}조 (${u.last.date}, 최근 60일 평균 ${f(u.avg60)}조의 ${f(u.last.unpaid / u.avg60 * 100, 0)}%)`);
  console.log(`  그대로 전이되면 반대매매 ${f(u.impliedForcedJo)}조 / 실제 당일 반대매매 ${f(u.last.forced)}조`);
  console.log('  미수금 역대 상위 5일: ' + u.topUnpaid.map(r => `${r.date}=${f(r.unpaid)}조`).join('  '));
}

if (spot) {
  console.log(`\n${'#'.repeat(66)}\n# 교차검증 소스 최신 지수`);
  console.log(`  FREESIS 최종 ${k0(spot.baseIdx)}p (${spot.baseDate})  ->  네이버 ${k0(spot.idx)}p (${spot.date})  ${f(spot.changePct, 2)}%`);
  console.log(`  ${spot.note}`);
}

if (daily) {
  console.log(`\n${'#'.repeat(66)}\n# 전일 대비 변화`);
  for (const it of daily.items) {
    const sign = it.delta >= 0 ? '+' : '';
    console.log(`  ${it.label.padEnd(14)} ${f(it.value).padStart(10)}${it.unit}`
      + `  ${sign}${f(it.delta)}${it.unit} (${sign}${f(it.pct, 2)}%)  ${it.prevDate}->${it.date}`);
  }
  console.log('\n  데이터 최신일: ' + daily.freshness.map(x => `${x.label} ${x.date}${x.live ? '(장중 가능)' : ''}`).join(' / '));
}

console.log(`\n원 자료 재현 (전체, 2026 연초 대비, 7.27 기준) 평균 절대오차 ${f(reproMAE, 3)}조`);
if (!split) {
  console.log("\n[미완] 유가증권/코스닥 분리 계열 없음. FREESIS '신용공여 잔고 추이' 내려받아 data/ 에 넣고:");
  console.log('  node scripts/ingest-split.mjs && node scripts/analyze.mjs && node scripts/build.mjs');
}
