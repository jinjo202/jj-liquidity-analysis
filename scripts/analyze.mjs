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
import { analyzeEtf } from './lib/etf.mjs';
import { buildOutlook } from './lib/outlook.mjs';

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

/* ---------- 마진콜 스트레스 시계열 ---------- */
// 반대매매 ÷ 위탁매매미수금 = 미수 잔액 중 강제로 처분된 비율. 절대액은 시장 규모에 끌려
// 다니지만 이 비율은 "미수를 낸 사람들이 실제로 얼마나 털렸나" 를 바로 말한다.
// 하루치는 튀므로 5일 이동평균으로 본다(§18).
function marginStress() {
  const rows = raw.series
    .filter(r => Number.isFinite(r.OS0024) && Number.isFinite(r.OS0025) && r.OS0024 > 0)
    .map(r => ({ d: r.date, recvJo: r.OS0024 / 1e6, callJo: r.OS0025 / 1e6 }))
    .map(r => ({ ...r, ratio: (r.callJo / r.recvJo) * 100 }));
  if (rows.length < 30) return null;
  for (let i = 0; i < rows.length; i++) {
    const w = rows.slice(Math.max(0, i - 4), i + 1);
    rows[i].ma5 = w.reduce((s2, x) => s2 + x.ratio, 0) / w.length;
  }
  const recent = rows.filter(r => r.d >= '20240101');
  const hist = rows.map(r => r.ma5);
  const sorted = [...hist].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const last = rows.at(-1);
  const peak = recent.reduce((m, r) => (r.ma5 > m.ma5 ? r : m));
  return {
    last, med, peak,
    pct: (sorted.filter(v => v <= last.ma5).length / sorted.length) * 100,
    // 평시 수준으로 돌아왔나 — 중앙값 대비 배수로 본다.
    vsMedian: med > 0 ? last.ma5 / med : null,
    series: rows.filter(r => r.d >= '20240101').map(r => ({ d: r.d, ma5: r.ma5, recvJo: r.recvJo })),
  };
}
const marginStressData = marginStress();

/* ---------- 레버리지 ETF AUM 분해 — 자금이냐 가격이냐 ---------- */
// AUM 변화는 두 갈래다: 좌수가 늘어 들어온 돈(유출입)과, 들고 있던 물량의 값이 변한 것(가격).
// 일별로 flow_t = Δ좌수 × 그날 종가 로 잡고 누적한다. 나머지가 가격 기여분이다.
function aumBreakdown(etfData, groups, market) {
  const codes = (etfData.universe ?? []).filter(u => groups.includes(u.group)).map(u => u.code);
  if (!codes.length) return null;
  const dates = [...new Set(codes.flatMap(c => (etfData.series[c] ?? []).map(r => r.d)))].sort();
  const prev = new Map();
  let cumFlow = 0, base = null;
  const out = [];
  for (const d of dates) {
    let aum = 0, flow = 0, seen = 0;
    for (const c of codes) {
      const r = (etfData.series[c] ?? []).find(x => x.d === d);
      if (!r || !Number.isFinite(r.units) || !Number.isFinite(r.close)) continue;
      seen++;
      aum += (r.units * r.close) / 1e12;
      const p = prev.get(c);
      if (p) flow += ((r.units - p.units) * r.close) / 1e12;
      prev.set(c, r);
    }
    if (!seen) continue;
    if (base == null) base = aum;
    cumFlow += flow;
    out.push({
      d, aum,
      flowCum: base + cumFlow,          // 시작 규모 + 누적 유출입
      priceCum: aum - (base + cumFlow), // 나머지 = 가격 기여
    });
  }
  if (out.length < 20) return null;

  // 레버리지 익스포저 = Σ(AUM × |배수|). ETF 가 실제로 기초자산에 걸고 있는 명목 규모다.
  // 시가총액으로 나누면 "이 상품군이 시장의 몇 %를 흔들 수 있나" 가 된다.
  const levOf = new Map((etfData.universe ?? []).map(u => [u.code, Math.abs(u.lev ?? 1)]));
  const mcapAt = new Map(market.map(m => [m.date, m.mcapJo]));
  for (const row of out) {
    let expo = 0;
    for (const c of codes) {
      const r = (etfData.series[c] ?? []).find(x => x.d === row.d);
      if (!r || !Number.isFinite(r.units) || !Number.isFinite(r.close)) continue;
      expo += ((r.units * r.close) / 1e12) * (levOf.get(c) ?? 1);
    }
    row.exposure = expo;
    const mc = mcapAt.get(row.d);
    row.exposurePctMcap = mc ? (expo / mc) * 100 : null;
  }

  const last = out.at(-1), peak = out.reduce((m, r) => (r.aum > m.aum ? r : m));
  const expoPeak = out.reduce((m, r) => ((r.exposure ?? 0) > (m.exposure ?? 0) ? r : m));
  return {
    base, from: out[0].d, series: out, last, peak, expoPeak,
    // 고점 이후 감소분 중 가격이 설명하는 몫. 100% 면 자금은 안 빠졌다는 뜻이다.
    dropFromPeak: peak.aum - last.aum,
    priceShareOfDrop: peak.aum !== last.aum
      ? ((peak.priceCum - last.priceCum) / (peak.aum - last.aum)) * 100 : null,
    flowShareOfDrop: peak.aum !== last.aum
      ? ((peak.flowCum - last.flowCum) / (peak.aum - last.aum)) * 100 : null,
  };
}

/* ---------- 투자자별 순매수 — 좌수를 떠받친 건 누구인가 ---------- */
// 좌수가 늘었다는 사실만으로는 누가 샀는지 모른다. 개인이 팔았는데 기관이 받아 좌수가
// 그대로일 수도 있다. 항복(자발적 투항) 판정은 이 조각이 있어야 선다(§27).
// 수량(주) 기준이라 종목 간 절대량 비교는 하지 않는다 — 방향과 자기 기준 강도만 본다.
const flowPath = path.join(DIR, 'investor-flows.json');
const flowRaw = fs.existsSync(flowPath) ? JSON.parse(fs.readFileSync(flowPath, 'utf8')) : null;

function analyzeInvestorFlows() {
  if (!flowRaw?.items?.length) return null;
  const items = flowRaw.items.map(it => {
    const s = (it.series ?? []).filter(r => Number.isFinite(r.individual));
    if (s.length < 5) return null;
    const sum = k => s.reduce((a, r) => a + (r[k] ?? 0), 0);
    const tail = n => s.slice(-n);
    const sumOf = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const px0 = s.find(r => r.close)?.close ?? null, px1 = [...s].reverse().find(r => r.close)?.close ?? null;
    return {
      code: it.code, name: it.name, kind: it.kind, group: it.group ?? null,
      days: s.length, from: s[0].d, to: s.at(-1).d,
      individual: sum('individual'), foreign: sum('foreign'), institution: sum('institution'),
      ind5: sumOf(tail(5), 'individual'),
      buyDays: s.filter(r => r.individual > 0).length,
      sellDays: s.filter(r => r.individual < 0).length,
      retPct: px0 && px1 ? (px1 / px0 - 1) * 100 : null,
      series: s.map(r => ({ d: r.d, i: r.individual, f: r.foreign, o: r.institution })),
    };
  }).filter(Boolean);
  if (!items.length) return null;

  // 급락 구간에서 개인이 순매수면 항복이 아니다 — 오히려 물타기다.
  const lev = items.filter(x => x.kind === 'etf' && x.group === 'single_lev');
  const netBuyers = items.filter(x => x.individual > 0).length;

  // ★ 수량(주)만 보면 안 된다. 1좌 가격이 제각각이라 14종을 더할 수 없고, 무엇보다
  // "얼마나 팔았나" 는 금액이라야 답이 된다. 실제로 수량으로는 20일 내내 순매수인데
  // 금액으로 보면 하루에 1조 넘게 던진 날이 나온다. 순매수액 = 순매수 수량 × 종가 (근사).
  const wonByDate = new Map();
  for (const it of lev) {
    for (const r of it.series) {
      const px = it.series.find(x => x.d === r.d) && (flowRaw.items.find(x => x.code === it.code)?.series ?? [])
        .find(x => x.d === r.d)?.close;
      if (!px) continue;
      wonByDate.set(r.d, (wonByDate.get(r.d) ?? 0) + (r.i * px) / 1e8);   // 억원
    }
  }
  const dates = [...wonByDate.keys()].sort();
  let run = 0;
  const levWon = dates.map(d => { run += wonByDate.get(d); return { d, eok: wonByDate.get(d), cumEok: run }; });
  const sellDays = levWon.filter(r => r.eok < 0);
  const tail = n => levWon.slice(-n).reduce((s, r) => s + r.eok, 0);
  const worst = levWon.length ? levWon.reduce((m, r) => (r.eok < m.eok ? r : m)) : null;
  const cumPeak = levWon.length ? levWon.reduce((m, r) => (r.cumEok > m.cumEok ? r : m)) : null;
  const cumLast = levWon.at(-1) ?? null;

  const levFlow = !levWon.length ? null : {
    series: levWon,
    cumEok: cumLast.cumEok,
    cumPeak,
    // 누적 고점 대비 얼마나 반납했나. 100% 면 그 기간에 쌓은 걸 전부 되판 것이다.
    givenBackPct: cumPeak.cumEok > 0 ? (1 - cumLast.cumEok / cumPeak.cumEok) * 100 : null,
    sellDays: sellDays.length, totalDays: levWon.length,
    worst,
    last5Eok: tail(5), prevEok: levWon.slice(0, -5).reduce((s, r) => s + r.eok, 0),
  };

  return {
    asOf: items[0].to, from: items[0].from, days: items[0].days,
    source: flowRaw.meta,
    items: items.sort((a, b) => b.individual - a.individual),
    levFlow,
    summary: {
      total: items.length, netBuyers,
      levTotalIndividual: lev.reduce((a, x) => a + x.individual, 0),
      levNetBuyers: lev.filter(x => x.individual > 0).length,
      levCount: lev.length,
      // 판정: 수량 기준으로는 순매수여도 최근 금액이 크게 순매도면 그쪽이 최신 신호다.
      verdict: netBuyers > items.length / 2 ? 'averaging-down' : 'capitulating',
      recentTurn: levFlow && levFlow.last5Eok < 0 && levFlow.prevEok > 0,
    },
  };
}
const investorFlow = analyzeInvestorFlows();

/* ---------- 종목별 대차잔고·외국인 지분율 (PART 2 보조) ---------- */
// 시장 전체 대차잔고는 "얼마나 더 오를 수 있나" 를 묻는다. 여기서는 그 잔고가 어느 종목에
// 붙어 있는지를 묻는다 — 코스피 등락의 상당 부분을 두 종목이 설명하기 때문이다(PART 3).
//
// 주수로 본다. 금액은 가격이 섞여 두 종목을 비교할 수 없다 — 실제로 삼성 94.7백만주와
// 하이닉스 13.6백만주가 금액으로는 24.9조 vs 23.4조로 거의 같아 보인다(주가가 6.5배 차이).
// 종목 간 비교는 상장주식수 대비 비중으로 한다.
const stockFlowPath = path.join(DIR, 'stock-flows.json');
const stockFlows = fs.existsSync(stockFlowPath)
  ? JSON.parse(fs.readFileSync(stockFlowPath, 'utf8'))
  : null;

function analyzeStockFlows() {
  if (!stockFlows?.stocks?.length) return null;
  // 상장주식수(units)와 종가는 etf-daily.json 이 두 종목까지 같이 받아 둔다(§23).
  const etfFile = path.join(DIR, 'etf-daily.json');
  const px = fs.existsSync(etfFile)
    ? JSON.parse(fs.readFileSync(etfFile, 'utf8')).series ?? null
    : null;

  const items = stockFlows.stocks.map(st => {
    const listed = px?.[st.code]?.at(-1)?.units ?? null;
    const rows = st.series
      .filter(r => Number.isFinite(r.balanceShares))
      .map(r => ({
        d: r.d,
        shares: r.balanceShares,
        pctListed: listed ? (r.balanceShares / listed) * 100 : null,
        valueJo: r.close ? (r.balanceShares * r.close) / 1e12 : null,
        foreignPct: r.foreignPct ?? null,
        close: r.close ?? null,
      }));
    if (rows.length < 20) return null;

    const first = rows[0], last = rows.at(-1);
    const peak = rows.reduce((a, r) => (r.shares > a.shares ? r : a));
    const trough = rows.reduce((a, r) => (r.shares < a.shares ? r : a));
    const fRows = rows.filter(r => r.foreignPct != null);
    const fFirst = fRows[0] ?? null, fLast = fRows.at(-1) ?? null;
    const fHigh = fRows.length ? fRows.reduce((a, r) => (r.foreignPct > a.foreignPct ? r : a)) : null;
    const fLow = fRows.length ? fRows.reduce((a, r) => (r.foreignPct < a.foreignPct ? r : a)) : null;
    const back = n => rows[Math.max(0, rows.length - 1 - n)];

    return {
      code: st.code, name: st.name, listedShares: listed,
      first, last, peak, trough,
      fromPeakPct: peak.shares > 0 ? (last.shares / peak.shares - 1) * 100 : null,
      d20Pct: (last.shares / back(20).shares - 1) * 100,
      d60Pct: (last.shares / back(60).shares - 1) * 100,
      foreign: fLast && {
        first: fFirst, last: fLast, high: fHigh, low: fLow,
        // 저점에서 얼마나 되돌아왔나. 외국인이 다시 들어오는지가 숏커버와 함께 상방을 만든다.
        fromLowPp: fLast.foreignPct - fLow.foreignPct,
        d20Pp: fLast.foreignPct - (back(20).foreignPct ?? fLast.foreignPct),
      },
      // 외국인 지분율의 평균·표준편차 밴드. "지금이 역사적으로 어디쯤인가" 를 z점수로 말한다.
      // 표본이 확보된 구간(수집 시작 이후)만 쓰므로 '장기 평균' 이 아니라 '이 구간 평균' 이다.
      foreignBand: (() => {
        const vs = fRows.map(r => r.foreignPct);
        if (vs.length < 30) return null;
        const mean = vs.reduce((s2, v) => s2 + v, 0) / vs.length;
        const sd = Math.sqrt(vs.reduce((s2, v) => s2 + (v - mean) ** 2, 0) / vs.length);
        const now = vs[vs.length - 1];
        return { mean, sd, z: sd > 0 ? (now - mean) / sd : null, n: vs.length,
          lo1: mean - sd, hi1: mean + sd, lo2: mean - 2 * sd, hi2: mean + 2 * sd };
      })(),
      // 누적 순유입 대용 — 외국인 보유주식수의 변화를 누적한다. 실제 매매 금액이 아니라
      // 보유량 변화라, 증자·분할이 있으면 어긋난다(두 종목은 해당 없음).
      foreignCum: (() => {
        let cum = 0; const out = [];
        for (let i = 0; i < rows.length; i++) {
          if (i > 0 && rows[i].foreignShares != null && rows[i - 1].foreignShares != null) {
            cum += (rows[i].foreignShares - rows[i - 1].foreignShares) / 1e6;   // 백만주
          }
          out.push({ d: rows[i].d, cumM: cum });
        }
        return out;
      })(),
      // 차트용. 385일을 다 실으면 index.html 이 커진다 — 3일에 하나씩 + 마지막 날.
      series: rows.filter((r, i) => i % 3 === 0 || i === rows.length - 1),
    };
  }).filter(Boolean);

  if (!items.length) return null;
  return { asOf: items[0].last.d, source: stockFlows.meta, items };
}
const stockFlow = analyzeStockFlows();

/* ---------- 시장별 되돌림 진척 ---------- */
// 합계만 보면 "아직 17%밖에 안 풀렸다"로 읽히는데, 쪼개면 두 시장이 정반대다.
// 코스닥은 이번 사이클에 쌓은 것을 거의 다 토해냈고 코스피는 거의 그대로 들고 있다.
// 결론이 합계 뒤에 가려져 있어서 따로 뽑는다. 날짜·잔고는 이미 계산된 headline 을 그대로 쓰고,
// 여기서 새로 세는 것은 시장별 신용/시총 비율뿐이다(전체 비율은 두 시장이 섞여 이 질문에 답하지 못한다).
function marketDivergence() {
  const open = periods.find(p => !p.closed), closed = periods.find(p => p.closed);
  if (!split || !open || !closed) return null;

  const MCAP = { 유가증권: r => r.OS0008, 코스닥: r => r.OS0009 };
  const CREDIT = { 유가증권: 'kospi', 코스닥: 'kosdaq' };
  const creditByDate = new Map(split.series.map(r => [r.date, r]));

  const items = Object.keys(MCAP).map(name => {
    const h = open.markets[name]?.headline, hPrev = closed.markets[name]?.headline;
    if (!h || !hPrev) return null;

    // 시총은 억원, 신용융자는 백만원. 억원 x 100 = 백만원.
    const ratioAtDate = d => {
      const c = creditByDate.get(d), m = raw.series.find(r => r.date === d);
      const mcap = m ? MCAP[name](m) : null;
      if (!c || !Number.isFinite(mcap) || !mcap) return null;
      return { date: d, creditJo: c[CREDIT[name]] / 1e6, mcapJo: (mcap * 100) / 1e6,
        ratio: (c[CREDIT[name]] / (mcap * 100)) * 100 };
    };

    const builtJo = h.creditPeakJo - h.creditStartJo;
    const retracedJo = h.creditPeakJo - h.creditLastJo;
    return {
      market: name,
      startJo: h.creditStartJo, startDate: h.creditStartDate,
      peakJo: h.creditPeakJo, peakDate: h.creditPeakDate,
      lastJo: h.creditLastJo, lastDate: h.creditLastDate,
      builtJo, retracedJo,
      // 이번 사이클에 쌓은 것 중 몇 %를 되돌렸나. 고점 대비 청산률(unwindPct)과 달리
      // 사이클 시작 수준을 기준선으로 잡는다 — "원래대로 돌아왔나"가 여기서 답이 나온다.
      retracedPctOfBuild: builtJo > 0 ? (retracedJo / builtJo) * 100 : null,
      multipleOfStart: h.creditStartJo > 0 ? h.creditLastJo / h.creditStartJo : null,
      unwindPct: h.unwindPct, idxDrawdownPct: h.idxDrawdownPct,
      prevUnwindPct: hPrev.unwindPct,
      now: ratioAtDate(h.creditLastDate),
      prevPeak: ratioAtDate(hPrev.creditPeakDate),
      prevTrough: ratioAtDate(hPrev.creditTroughDate),
    };
  }).filter(Boolean);

  if (items.length < 2) return null;
  for (const it of items) {
    it.ratioVsPrevTrough = it.now && it.prevTrough ? it.now.ratio / it.prevTrough.ratio : null;
    // 직전 사이클 저점 비율까지 내려가려면 얼마가 더 풀려야 하나. 이미 밑이면 0.
    it.toPrevTroughJo = it.now && it.prevTrough
      ? Math.max(0, it.now.creditJo - (it.prevTrough.ratio / 100) * it.now.mcapJo) : null;
  }
  const done = items.filter(x => x.ratioVsPrevTrough != null && x.ratioVsPrevTrough <= 1).map(x => x.market);
  return { asOf: items[0].lastDate, items, doneMarkets: done };
}
const divergence = marketDivergence();

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
    .map(r => ({
      date: r.date, balJo: r.balanceMil / 1e6, idx: idxByDate.get(r.date),
      balShares: Number.isFinite(r.balanceShares) ? r.balanceShares : null,
    }))
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

  const coveredJo = cyclePeak.balJo - last.balJo;   // 고점 이후 이미 되갚아진 '금액'

  // ★ 금액만 보면 안 된다. 잔고금액 = 주수 × 주가라, 지수가 빠지면 한 주도 안 갚아도 금액이 준다.
  // PART 3 에서 ETF 를 AUM 이 아니라 좌수로 본 것과 같은 함정이다(§16.4).
  // 실제로 이번 사이클은 금액 고점 이후 금액이 -20% 인데 주수는 오히려 늘었다.
  const shareRows = cycleWindow.filter(r => Number.isFinite(r.balShares));
  const shares = shareRows.length < 20 ? null : (() => {
    const pk = shareRows.reduce((m, r) => (r.balShares > m.balShares ? r : m));
    const after = shareRows.filter(r => r.date >= pk.date);
    const trough = after.reduce((m, r) => (r.balShares < m.balShares ? r : m));
    const now = shareRows.at(-1);
    const back = n => shareRows[Math.max(0, shareRows.length - 1 - n)];
    // 금액 변화를 로그로 쪼갠다: Δln금액 = Δln주수 + Δln단가.
    const atMoneyPeak = shareRows.find(r => r.date === cyclePeak.date) ?? pk;
    const dMoney = Math.log(now.balJo / atMoneyPeak.balJo);
    const dShares = Math.log(now.balShares / atMoneyPeak.balShares);
    return {
      peakDate: pk.date, peakShares: pk.balShares,
      troughDate: trough.date, troughShares: trough.balShares,
      nowDate: now.date, nowShares: now.balShares,
      fromPeakPct: (now.balShares / pk.balShares - 1) * 100,
      troughFromPeakPct: (trough.balShares / pk.balShares - 1) * 100,
      fromTroughPct: (now.balShares / trough.balShares - 1) * 100,
      d5Pct: (now.balShares / back(5).balShares - 1) * 100,
      d20Pct: (now.balShares / back(20).balShares - 1) * 100,
      // 금액 고점 이후 금액 변화 중 가격이 설명하는 몫(%). 100% 면 전부 가격이다.
      moneyPeakDate: atMoneyPeak.date,
      moneyDeclinePct: (Math.exp(dMoney) - 1) * 100,
      sharesSinceMoneyPeakPct: (Math.exp(dShares) - 1) * 100,
      priceShareOfMoveePct: dMoney !== 0 ? ((dMoney - dShares) / dMoney) * 100 : null,
      // 3일에 하나씩 솎되 고점·최저는 반드시 남긴다 — 안 그러면 차트의 고/저 라벨이
      // 카드 숫자와 어긋난다(실제로 31.91억주가 31.83으로 찍혔다).
      series: shareRows
        .filter((r, i) => i % 3 === 0 || i === shareRows.length - 1
          || r.date === pk.date || r.date === trough.date)
        .map(r => ({ d: r.date, v: r.balShares / 1e8 })),   // 억주
    };
  })();
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
    shares,
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

/* ---------- 레버리지 ETF 수급(PART 3) ---------- */
// data/etf-daily.json 이 있을 때만 계산한다. 대차잔고와 같은 방식으로 완만하게 저하시킨다.
const etfPath = path.join(DIR, 'etf-daily.json');
let etf = null;
if (fs.existsSync(etfPath)) {
  const etfData = JSON.parse(fs.readFileSync(etfPath, 'utf8'));
  const csopPath = path.join(DIR, 'csop-snapshot.json');
  const csop = fs.existsSync(csopPath) ? JSON.parse(fs.readFileSync(csopPath, 'utf8')) : null;
  const csopDailyPath = path.join(DIR, 'csop-daily.json');
  const csopDaily = fs.existsSync(csopDailyPath) ? JSON.parse(fs.readFileSync(csopDailyPath, 'utf8')) : null;

  // 비중 계산용 코스피 지수·시총(억원 -> 조원).
  const market = raw.series
    .filter(r => Number.isFinite(r.OS0001) && Number.isFinite(r.OS0008))
    .map(r => ({ date: r.date, idx: r.OS0001, mcapJo: (r.OS0008 * 100) / 1e6 }));

  // 비교 시점: 5월말 / 지수 고점 / 6월말 / 최신. 고점은 박아두지 않고 사이클에서 찾는다.
  const openP = PERIODS.find(p => !p.closed);
  const cycleIdx = market.filter(m => m.date >= openP.accBase && m.date <= openP.evalEnd);
  const idxPeak = cycleIdx.reduce((m, r) => (r.idx > m.idx ? r : m), cycleIdx[0]);
  const etfLast = Object.values(etfData.series).map(s => s.at(-1)?.d).filter(Boolean).sort().at(-1);
  const onOrBefore = d => {
    const all = etfData.series['005930'] ?? Object.values(etfData.series)[0] ?? [];
    return all.filter(r => r.d <= d).at(-1)?.d ?? d;
  };
  const named = [
    [onOrBefore('20260531'), '5월말'],
    [idxPeak.date, '지수 고점'],
    [onOrBefore('20260630'), '6월말'],
    [etfLast, '최근'],
  ];
  const checkpointDates = [...new Set(named.map(([d]) => d))].sort();

  etf = analyzeEtf({ etf: etfData, csop, csopDaily, market, checkpointDates });
  // 같은 날짜에 이름이 겹치면(예: 6월말이 곧 고점) 먼저 붙은 이름을 남긴다.
  if (etf) etf.checkpointLabels = Object.fromEntries([...named].reverse());

  // 단일종목 레버리지 ETF 의 거래대금. AUM·좌수가 "얼마나 쌓였나" 라면 이건 "얼마나 돌리나" 다.
  //   회전율 = 거래대금 / AUM. 1을 넘으면 그날 하루에 펀드 전체가 한 번 이상 손바뀜한 것이다.
  //   시장 대비 = 이 상품군 거래대금 / 코스피+코스닥 거래대금. 시장 거래를 얼마나 먹는지.
  // 거래일이 아닌 날(장 시작 전 조회분)은 거래대금 0 으로 와서 회전율을 왜곡한다 — 버린다.
  if (etf) {
    const turnoverOf = groupKey => {
      const codes = (etfData.universe ?? []).filter(u => u.group === groupKey).map(u => u.code);
      if (!codes.length) return null;
      const mktJo = new Map(raw.series
        .filter(r => Number.isFinite(r.OS0011) || Number.isFinite(r.OS0012))
        .map(r => [r.date, ((r.OS0011 ?? 0) + (r.OS0012 ?? 0)) / 1e4]));
      const dates = [...new Set(codes.flatMap(c => (etfData.series[c] ?? []).map(r => r.d)))].sort();
      const rows = dates.map(d => {
        let valJo = 0, aumJo = 0, n = 0;
        for (const c of codes) {
          const r = (etfData.series[c] ?? []).find(x => x.d === d);
          if (!r) continue;
          valJo += (r.valueMil ?? 0) / 1e6;
          aumJo += (r.units * r.close) / 1e12;
          n++;
        }
        const mkt = mktJo.get(d) ?? null;
        return {
          d, valJo, aumJo, n,
          turnover: aumJo > 0 ? valJo / aumJo : null,
          marketPct: mkt ? (valJo / mkt) * 100 : null,
        };
      }).filter(r => r.valJo > 0);
      if (rows.length < 5) return null;
      const last = rows.at(-1);
      const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
      const withMkt = rows.filter(r => r.marketPct != null);
      return {
        from: rows[0].d, to: last.d, days: rows.length,
        last,
        valPeak: rows.reduce((m, r) => (r.valJo > m.valJo ? r : m)),
        sharePeak: withMkt.length ? withMkt.reduce((m, r) => (r.marketPct > m.marketPct ? r : m)) : null,
        turnoverPeak: rows.reduce((m, r) => ((r.turnover ?? 0) > (m.turnover ?? 0) ? r : m)),
        avgTurnover: avg(rows.map(r => r.turnover).filter(Number.isFinite)),
        avgTurnover20: avg(rows.slice(-20).map(r => r.turnover).filter(Number.isFinite)),
        avgSharePct: avg(withMkt.map(r => r.marketPct)),
        series: rows,
      };
    };
    etf.turnover = { single_lev: turnoverOf('single_lev'), sector_lev: turnoverOf('sector_lev') };
    etf.breakdown = aumBreakdown(etfData, ['single_lev', 'sector_lev', 'index_lev', 'single_inv', 'index_inv'], market);

    // 국내 + 홍콩 합산 AUM. 홍콩분은 USD 라 환율로 조원에 맞춘다.
    // 홍콩 NAV 는 2026-08-02 수집 시작이라 그 이전은 없다 — 없는 날은 null 로 두고
    // 차트가 거기서부터 그리게 한다(0 으로 채우면 없던 자금이 빠진 것처럼 보인다).
    if (csopDaily?.products?.length) {
      const fx = new Map((csopDaily.fx ?? []).map(r => [r.d, r.krw]));
      const fxAt = d => {
        if (fx.has(d)) return fx.get(d);
        const before = [...fx.keys()].filter(k => k <= d).sort();
        return before.length ? fx.get(before[before.length - 1]) : null;
      };
      const hkByDate = new Map();
      for (const prod of csopDaily.products) {
        for (const r of prod.series ?? []) {
          if (!Number.isFinite(r.totalNavUsd)) continue;
          hkByDate.set(r.d, (hkByDate.get(r.d) ?? 0) + r.totalNavUsd);
        }
      }
      etf.aumCombined = (etf.aumDaily ?? []).map(r => {
        const usd = hkByDate.get(r.d) ?? null;
        const rate = usd != null ? fxAt(r.d) : null;
        const hkJo = usd != null && rate ? (usd * rate) / 1e12 : null;
        return { d: r.d, domestic: r.total, hk: hkJo, total: hkJo == null ? null : r.total + hkJo };
      });
      const withHk = etf.aumCombined.filter(r => r.hk != null);
      etf.aumCombinedMeta = {
        hkFrom: withHk[0]?.d ?? null, hkDays: withHk.length,
        last: withHk.at(-1) ?? null,
        fxLast: (csopDaily.fx ?? []).at(-1) ?? null,
      };
    }
  }
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

  // 커버리지의 역수 = 예탁금 대비 신용융자(%). 같은 정보인데 이쪽이 "빚이 대기자금의 몇 %인가"로
  // 바로 읽힌다. 커버리지에는 없던 것을 하나 더 붙인다 — **정상 수준 기준선**.
  // 고점 대비로만 보면 "고점보다 낮으니 안전"이 되는데, 그 고점이 비정상이었으면 무의미하다.
  // 그래서 중앙값을 여러 창으로 내서 지금이 그 위인지 아래인지로 판정한다.
  const medOf = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const ratioRows = rows.map(r => ({ ...r, ratio: (r.creditJo / r.depositJo) * 100 }));
  const totRows = ratioRows.filter(r => r.pledgeJo != null)
    .map(r => ({ ...r, totRatio: (r.totalLevJo / r.depositJo) * 100 }));
  const win = (rs, a, b) => rs.filter(r => r.date >= a && r.date <= b);
  const pctile = (rs, key, v) => {
    const s = rs.map(r => r[key]).sort((a, b) => a - b);
    return (s.filter(x => x <= v).length / s.length) * 100;
  };
  const openBase = periods.find(p => !p.closed)?.accBase ?? '20241231';
  const rLast = ratioRows.at(-1), tLast = totRows.at(-1);
  const junePeak = (rs, key) => {
    // 이번 사이클에서 신용융자 절대액이 고점을 찍은 달. "그때 과열이었나" 를 묻는 기준점이다.
    const pk = hB?.creditPeakDate;
    if (!pk) return null;
    const w = win(rs, `${pk.slice(0, 6)}01`, `${pk.slice(0, 6)}31`);
    return w.length ? w.reduce((m, r) => (r[key] > m[key] ? r : m)) : null;
  };

  const creditToDeposit = {
    last: { date: rLast.date, ratio: rLast.ratio, creditJo: rLast.creditJo, depositJo: rLast.depositJo },
    high: ratioRows.reduce((m, r) => (r.ratio > m.ratio ? r : m)),
    low: ratioRows.reduce((m, r) => (r.ratio < m.ratio ? r : m)),
    cycleHigh: (() => { const w = win(ratioRows, openBase, '29991231'); return w.length ? w.reduce((m, r) => (r.ratio > m.ratio ? r : m)) : null; })(),
    peakMonthHigh: junePeak(ratioRows, 'ratio'),
    atCreditPeak: hB ? ratioRows.find(r => r.date === hB.creditPeakDate) ?? null : null,
    pct: pctile(ratioRows, 'ratio', rLast.ratio),
    normal: {
      all: medOf(ratioRows.map(r => r.ratio)),
      y3: medOf(win(ratioRows, '20230801', '29991231').map(r => r.ratio)),
      y2024: medOf(win(ratioRows, '20240101', '20241231').map(r => r.ratio)),
      preCycle: medOf(win(ratioRows, '20241201', '20241231').map(r => r.ratio)),
    },
    // 담보융자까지 더한 총 레버리지. 신용 단독과 방향이 갈릴 수 있어 반드시 같이 본다.
    total: !tLast ? null : {
      last: { date: tLast.date, ratio: tLast.totRatio },
      high: totRows.reduce((m, r) => (r.totRatio > m.totRatio ? r : m)),
      peakMonthHigh: junePeak(totRows, 'totRatio'),
      pct: pctile(totRows, 'totRatio', tLast.totRatio),
      normal: {
        all: medOf(totRows.map(r => r.totRatio)),
        y3: medOf(win(totRows, '20230801', '29991231').map(r => r.totRatio)),
      },
    },
  };
  // 신용 단독은 고점 아래인데 총 레버리지는 그렇지 않은 경우가 있다 — 그때 서사가 갈린다.
  creditToDeposit.divergesFromTotal = !!(creditToDeposit.total?.peakMonthHigh
    && creditToDeposit.last.ratio < creditToDeposit.peakMonthHigh?.ratio
    && creditToDeposit.total.last.ratio > creditToDeposit.total.peakMonthHigh.totRatio);

  return {
    last, pct, covMin, covMax, levPeak, marks, creditToDeposit,
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
// 네이버 계열의 마지막 행. FREESIS 보다 빠르든 아니든 담아 두고, 더 최신일 때만 쓴다.
const spotSources = {};
for (const [key, file] of [['kospi', 'kospi-daily.json'], ['kosdaq', 'kosdaq-daily.json']]) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) continue;
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
  const l = rows.at(-1);
  if (l) spotSources[key] = { date: l.date, idx: l.close, rows: rows.length };
}
const spotSource = spotSources.kospi ?? null;   // §19 배너는 코스피 기준이다

const kospiPath = path.join(DIR, 'kospi-daily.json');
if (fs.existsSync(kospiPath)) {
  const kd = JSON.parse(fs.readFileSync(kospiPath, 'utf8'));
  crossCheckRows = kd.length;
  const l = kd.at(-1);
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
  // 1년치 시계열을 같이 싣는다. 리포트에서 지표를 펼치면 추세를 바로 볼 수 있어야
  // "어제 대비"라는 한 점짜리 정보가 오해를 부르지 않는다.
  const yearAgo = (() => {
    const d = String(lastDate);
    return `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  })();

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
      series: rows.filter(r => r.date >= yearAgo).map(r => ({ d: r.date, v: v(r) })),
    };
  };

  const items = [
    { key: 'idx', label: '코스피', unit: 'p', ...pick('OS0001') },
    { key: 'kosdaq', label: '코스닥', unit: 'p', ...pick('OS0002') },
    { key: 'credit', label: '신용융자', unit: '조', ...pick('OS0026', 1e6) },
    { key: 'deposit', label: '투자자예탁금', unit: '조', ...pick('OS0021', 1e6) },
    { key: 'unpaid', label: '위탁매매미수금', unit: '조', ...pick('OS0024', 1e6) },
  ].filter(x => x.date);

  // 지수 둘은 FREESIS(EOD, T+1)보다 네이버가 하루 빠르다. 최신 값을 보여주되
  // 어디서 온 값인지, 장중일 수 있는지를 같이 표시한다(§19).
  for (const [key, src] of [['idx', spotSources.kospi], ['kosdaq', spotSources.kosdaq]]) {
    const item = items.find(x => x.key === key);
    if (!item || !src || !(src.date > item.date)) continue;
    const base = item.value;
    item.prevDate = item.date;
    item.prev = base;
    item.date = src.date;
    item.value = src.idx;
    item.delta = src.idx - base;
    item.pct = (src.idx / base - 1) * 100;
    item.live = true;
    item.source = '네이버 금융';
    item.series = [...item.series, { d: src.date, v: src.idx }];
  }

  if (lending) {
    const s = lending.series;
    if (s.length >= 2) {
      const [p, l] = [s.at(-2), s.at(-1)];
      items.push({
        key: 'lending', label: '대차잔고', unit: '조',
        date: l.d, prevDate: p.d, value: l.bal, prev: p.bal,
        delta: l.bal - p.bal, pct: (l.bal / p.bal - 1) * 100,
        series: s.filter(r => r.d >= yearAgo).map(r => ({ d: r.d, v: r.bal })),
      });
    }
  }

  // 계열별 최신 관측일. 가장 늦은 계열이 리포트 전체의 '기준일'이 된다.
  const freshness = [
    { label: '지수·거래대금', date: raw.series.filter(r => Number.isFinite(r.OS0001)).at(-1)?.date },
    { label: '신용융자·예탁금', date: raw.series.filter(r => Number.isFinite(r.OS0026)).at(-1)?.date },
    lending && { label: '대차잔고', date: lending.last.date },
    Object.keys(spotSources).length && {
      label: '지수 장중(네이버)',
      date: Object.values(spotSources).map(s => s.date).sort().at(-1),
      live: true,
    },
  ].filter(x => x && x.date);

  return { items, freshness };
}

const daily = dailyDelta();

/* ---------- 다음 주 수급 전망(PART 4) ---------- */
// 방향을 맞히려는 게 아니라, 지수가 어디로 가면 어떤 물량이 기계적으로 따라 나오는지를
// 미리 적어 두는 것이다. 다음 주에 실제 움직임과 대조하면 수급이 원인이었는지 판정할 수 있다.
const kospiSeries = raw.series.filter(r => Number.isFinite(r.OS0001)).map(r => ({ d: r.date, i: r.OS0001 }));
const openMarket = periods.find(p => !p.closed)?.markets['전체'] ?? null;

// 규제 일정은 계산으로 나오지 않는다. 외사 리포트에서 옮겨 적고 출처를 단다(data/street-anchors.json).
const anchorsPath = path.join(DIR, 'street-anchors.json');
const anchors = fs.existsSync(anchorsPath) ? JSON.parse(fs.readFileSync(anchorsPath, 'utf8')) : null;
const EVENTS = [
  { date: '20260803', label: 'CSOP 유연 레버리지 전환', detail: '홍콩 단일종목 L&I 가 고정 2배에서 최대 2배·최소 1.1배로 바뀐다', impact: 'down-flow' },
  { date: '20260805', label: '레버리지 ETF 최소 예탁금 상향', detail: '1,000만원 → 3,000만원', impact: 'down-flow' },
  { date: '20260819', label: '증거금 현금만 인정', detail: '대용증권으로 증거금을 채울 수 없게 된다', impact: 'down-flow' },
];

const outlook = buildOutlook({
  series: kospiSeries,
  etf, lending,
  marginLadder: openMarket?.ladder ?? [],
  spotIdx: spot?.idx ?? kospiSeries.at(-1)?.i,
  spotDate: spot?.date ?? kospiSeries.at(-1)?.d,
  events: EVENTS,
});
if (outlook && anchors) outlook.anchors = anchors;

const out = {
  meta: {
    maintenance: MAINTENANCE, loanRatio: LOAN_RATIO, marginFactor: factorOf(),
    hasSplit: !!split, markets: Object.keys(inputs), crossCheckRows,
    source: raw.meta, splitSource: split?.meta ?? null,
  },
  periods, repro, reproMAE, stress, projection, monthly, lending, etf, outlook, channels, unpaid, spot, daily,
  ratio: ratioSeries.filter((r, i) => i % 5 === 0 || i === ratioSeries.length - 1),
  divergence,
  marginStress: marginStressData,
  stockFlow,
  investorFlow,
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

if (etf) {
  const cps = etf.checkpoints.map(c => c.date);
  const lab = d => etf.checkpointLabels?.[d] ?? d.slice(4, 6) + '/' + d.slice(6, 8);
  console.log(`\n${'#'.repeat(66)}\n# 레버리지 ETF 수급 (PART 3)`);
  console.log(`  시점: ${cps.map(d => `${lab(d)}(${d})`).join('  ')}`);

  const VERDICT = { building: '아직 쌓이는 중', flat: '정체 — 꺾이는 길목', rolling: '꺾였다', unknown: '판정 불가' };
  if (etf.unitsTrend?.single) {
    const u = etf.unitsTrend.single;
    console.log(`\n  [★ 매일 볼 것 — 단일종목 레버리지 좌수] ${VERDICT[u.verdict]}`);
    console.log(`    ${u.last.d}  ${f(u.last.unitsM, 0)}백만좌  (전일 ${f(u.d1, 1)}% / 5일 ${f(u.d5, 1)}% / 10일 ${f(u.d10, 1)}%)`);
    console.log(`    최대 ${f(u.peak.unitsM, 0)}백만좌 (${u.peak.d}, ${u.daysSincePeak}거래일 전) 대비 ${f(u.fromPeakPct, 1)}%`
      + `   연속 감소 ${u.downStreak}일`);
    for (const [k, label] of [['samsung', '삼성전자'], ['hynix', 'SK하이닉스'], ['sector', '반도체 섹터']]) {
      const t = etf.unitsTrend[k];
      if (t) console.log(`      ${label.padEnd(10)} ${f(t.last.unitsM, 0).padStart(6)}백만좌  5일 ${f(t.d5, 1).padStart(6)}%  고점대비 ${f(t.fromPeakPct, 1).padStart(6)}%  ${VERDICT[t.verdict]}`);
    }
  }

  console.log(`\n  [그룹별 AUM(조원) = 상장좌수 x 종가]`);
  console.log(`    ${'그룹'.padEnd(24)}${cps.map(d => lab(d).padStart(12)).join('')}`);
  for (const g of etf.groups) {
    if (!g.count) continue;
    console.log(`    ${(g.label + ` (${g.count})`).padEnd(24)}${g.sums.map(s => f(s.aumJo).padStart(12)).join('')}`);
  }

  console.log(`\n  [단일종목 상위 6종 — 좌수(백만좌)와 AUM 분해]`);
  const top = etf.perFund
    .filter(x => x.group === 'single_lev' || x.group === 'single_inv')
    .sort((a, b) => (b.snaps.at(-1).aumJo ?? 0) - (a.snaps.at(-1).aumJo ?? 0)).slice(0, 6);
  for (const x of top) {
    const s0 = x.snaps[0], s1 = x.snaps.at(-1);
    console.log(`    ${x.name}`);
    console.log(`      좌수 ${f(s0.units / 1e6, 1)}M -> ${f(s1.units / 1e6, 1)}M`
      + `   AUM ${f(s0.aumJo)}조 -> ${f(s1.aumJo)}조`);
    if (x.full) {
      console.log(`      분해: AUM ${f(x.full.aumPct, 1)}% = 유출입 ${f(x.full.unitsPct, 1)}% + 가격 ${f(x.full.pricePct, 1)}%`);
    }
  }

  for (const s of Object.values(etf.stockDaily)) {
    const t = s.test;
    const recent = s.series.slice(-5);
    console.log(`\n  [${s.name}] 단일종목 ETF ${s.funds.length}종 리밸런싱`);
    console.log(`    최근 5거래일  (리밸=필요 매매액, 계수 2X=${etf.coef.lev2} / -2X=${etf.coef.inv2})`);
    for (const r of recent) {
      console.log(`      ${r.d}  수익률 ${f(r.ret, 1).padStart(6)}%  리밸 ${f(r.flowJo).padStart(6)}조`
        + `  = 거래대금의 ${f(r.flowPctTurnover, 1).padStart(5)}%   일중진폭 ${f(r.amplitude, 1)}%`
        + `   지수기여 ${f(r.idxContribPct, 2)}%p`);
    }
    console.log(`    리밸 수요 상위 ${t.topN}일 평균 일중진폭 ${f(t.topMeanAmplitude, 1)}% vs 나머지 ${f(t.restMeanAmplitude, 1)}%`
      + `   (상관 r=${f(t.corrFlowAmplitude, 2)})`);
    if (s.eras) {
      const e = s.eras;
      console.log(`    [반증] 평균 일중진폭  2025년 ${f(e.before2025.meanAmplitude, 1)}% (${e.before2025.days}일)`
        + `  /  2026년 상장 전 ${f(e.before2026.meanAmplitude, 1)}% (${e.before2026.days}일)`
        + `  /  상장 후 ${f(e.after.meanAmplitude, 1)}% (${e.after.days}일)`);
    }
  }

  const big = [...etf.indexContrib].sort((a, b) => Math.abs(b.contribPct) - Math.abs(a.contribPct)).slice(0, 5);
  console.log(`\n  [코스피 등락 중 삼성전자+SK하이닉스 산술 기여 상위 5일]`);
  for (const r of big) {
    console.log(`    ${r.d}  코스피 ${f(r.idxRet, 2).padStart(7)}%  기여 ${f(r.contribPct, 2).padStart(6)}%p`
      + `  (${f(r.sharePct, 0)}%)   두 종목 리밸 합계 ${f(r.flowJo)}조`);
  }

  if (etf.hk) {
    console.log(`\n  [홍콩 CSOP 단일종목 L&I — ${etf.hk.asOf} 기준, 좌수 히스토리는 20260802 부터 누적]`);
    for (const p of etf.hk.products) {
      console.log(`    ${p.ticker} ${p.name}`);
      console.log(`      NAV US$${(p.totalNavUsd / 1e9).toFixed(2)}bn  좌수 ${(p.outstandingUnits / 1e6).toFixed(1)}M`
        + `  명목익스포저 US$${(p.notionalUsd / 1e9).toFixed(2)}bn`);
    }
  }
}

if (outlook) {
  const O = outlook;
  console.log(`\n${'#'.repeat(66)}\n# 다음 주 수급 전망 (PART 4)`);
  console.log(`  현재 ${k0(O.state.spotIdx)}p (${O.state.spotDate})  직전일 ${f(O.state.lastRet, 1)}%`
    + `  20일 낙폭 ${f(O.state.drawdown20, 1)}%  60일 낙폭 ${f(O.state.drawdown60, 1)}%`);

  console.log(`\n  [지수 시나리오별 레버리지 ETF 강제 매매]`);
  for (const s of O.scenarios) {
    console.log(`    ${s.retPct > 0 ? '+' : ''}${s.retPct}%  (${k0(s.idxLevel)}p)  ->  `
      + `${s.flowJo >= 0 ? '순매수' : '순매도'} ${f(Math.abs(s.flowJo))}조`
      + `  = 두 종목 하루 거래대금의 ${f(s.pctOfTurnover, 1)}%`);
  }

  if (O.firstTrigger) {
    console.log(`\n  [아래로 열리는 물량 — 마진콜 사다리]`);
    console.log(`    첫 문턱 ${k0(O.firstTrigger.threshold)}p — 지금보다 ${f(O.firstTrigger.gapPct, 1)}% 아래`
      + ` (열리는 물량 ${f(O.firstTrigger.incrementalJo)}조)`);
    for (const r of O.ladder.slice(1, 4)) {
      console.log(`    ${k0(r.threshold)}p (${f(r.gapPct, 1)}%)  +${f(r.incrementalJo)}조  누적 ${f(r.cumulativeJo)}조`);
    }
  }

  if (O.short) {
    console.log(`\n  [위로 나오는 물량 — 숏커버]`);
    console.log(`    대차잔고 ${f(O.short.balJo)}조 (${O.short.date})  전일 대비 ${f(O.short.dBalPct, 1)}%`
      + `  사이클 고점 ${f(O.short.cyclePeakJo)}조`);
    console.log(`    잔여 커버 여력 ${f(O.short.coverLowJo)}~${f(O.short.coverHighJo)}조`);
  }

  console.log(`\n  [과거 유사 국면의 다음 5거래일 코스피 수익률]`);
  for (const b of O.baseRates) {
    console.log(`    ${b.label.padEnd(28)} n=${String(b.n).padStart(4)}  중앙값 ${f(b.median, 1).padStart(6)}%`
      + `  상승확률 ${f(b.upRate, 0).padStart(4)}%  [${f(b.p25, 1)} ~ ${f(b.p75, 1)}]`);
  }

  if (O.events.length) {
    console.log(`\n  [예정된 제도 변경]`);
    for (const e of O.events) console.log(`    ${e.date}  ${e.label} — ${e.detail}`);
  }
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
