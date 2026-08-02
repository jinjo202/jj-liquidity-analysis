// PART 4: 다음 주 수급 전망.
//
// 방향을 맞히는 게 목적이 아니다. 목적은 "이번 주 지수가 어디로 가면 어떤 물량이
// 기계적으로 따라 나오는가" 를 미리 숫자로 적어 두는 것이다. 그래야 다음 주에
// 실제로 나온 움직임을 보고 수급이 원인이었는지 아닌지 판정할 수 있다.
//
// 세 축을 쓴다.
//   1) 레버리지 ETF 리밸런싱 — 지수 시나리오별로 그날 안에 강제로 나가는 매매(PART 3)
//   2) 마진콜 사다리 — 지수가 밑으로 가면 열리는 신용 물량(PART 1)
//   3) 대차잔고 — 지수가 위로 가면 되갚아야 하는 숏(PART 2)
// 여기에 과거 유사 국면의 다음 5거래일 수익률 분포(base rate)를 붙인다.

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
};

/**
 * 조건을 만족한 날들의 '다음 N거래일' 수익률 분포.
 * 표본이 작으면 작다고 말해야 한다 — n 을 같이 돌려준다.
 */
export function forwardReturns(series, cond, horizon = 5) {
  const hits = [];
  for (let i = 0; i < series.length - horizon; i++) {
    if (!cond(series, i)) continue;
    const a = series[i].i, b = series[i + horizon].i;
    if (a > 0 && b > 0) hits.push({ d: series[i].d, ret: (b / a - 1) * 100 });
  }
  const rets = hits.map(h => h.ret);
  return {
    n: rets.length,
    median: quantile(rets, 0.5), mean: mean(rets),
    p25: quantile(rets, 0.25), p75: quantile(rets, 0.75),
    min: rets.length ? Math.min(...rets) : null,
    max: rets.length ? Math.max(...rets) : null,
    upRate: rets.length ? (rets.filter(r => r > 0).length / rets.length) * 100 : null,
    recent: hits.slice(-5),
  };
}

/**
 * @param {object} o
 * @param {{d:string,i:number}[]} o.series   코스피 일별(우리 시계열)
 * @param {object|null} o.etf                PART 3 결과
 * @param {object|null} o.lending            PART 2 결과
 * @param {object|null} o.marginLadder       진행 사이클 '전체' 시장의 사다리
 * @param {number} o.spotIdx                 최신 지수(장중 포함)
 * @param {string} o.spotDate
 * @param {{date:string,label:string,detail:string,impact:string}[]} o.events  다음 주 예정 이벤트
 */
export function buildOutlook(o) {
  const { series, etf, lending, marginLadder, spotIdx, spotDate, events } = o;
  if (!series?.length) return null;

  const last = series.at(-1);
  const idxNow = Number.isFinite(spotIdx) ? spotIdx : last.i;

  /* ---------- 1. 시나리오별 ETF 리밸런싱 ---------- */
  // 단일종목 레버리지·인버스의 현재 AUM 에 계수를 곱한다. 지수와 종목 수익률이 같다는
  // 가정을 쓴다 — 삼성전자·SK하이닉스가 코스피 등락의 60~80% 를 설명하므로(§23.4) 거칠지만 쓸 만하다.
  const SCEN = [-5, -3, -1, 1, 3, 5];
  const scenarios = [];
  if (etf?.stockDaily) {
    // 상품마다 계수가 다르다(2X=2, -2X=6). 종목별로 평균 내면 규모가 작은 인버스가
    // 과대 반영되므로, 상품 하나하나에 자기 AUM 과 자기 계수를 곱해서 더한다.
    const fundsOf = code => (etf.perFund ?? []).filter(f =>
      f.underlying === code && (f.group === 'single_lev' || f.group === 'single_inv'));
    for (const r of SCEN) {
      const rows = Object.values(etf.stockDaily).map(s => {
        const lastRow = s.series.at(-1);
        const funds = fundsOf(s.code);
        const flowJo = funds.reduce((acc, f) => {
          const aumJo = f.snaps.at(-1)?.aumJo ?? 0;
          return acc + f.lev * (f.lev - 1) * aumJo * (r / 100);
        }, 0);
        return {
          code: s.code, name: s.name, flowJo,
          aumJo: funds.reduce((a, f) => a + (f.snaps.at(-1)?.aumJo ?? 0), 0),
          turnoverJo: lastRow?.turnoverJo ?? null,
        };
      });
      const flowJo = rows.reduce((s, x) => s + x.flowJo, 0);
      const turnoverJo = rows.reduce((s, x) => s + (x.turnoverJo ?? 0), 0);
      scenarios.push({
        retPct: r, flowJo,
        pctOfTurnover: turnoverJo > 0 ? (Math.abs(flowJo) / turnoverJo) * 100 : null,
        idxLevel: idxNow * (1 + r / 100),
        rows,
      });
    }
  }

  /* ---------- 2. 아래로 열리는 물량(마진콜) ---------- */
  // 사다리는 FREESIS 확정 지수 기준으로 계산돼 있다. 반등한 지금 지수에서 첫 문턱까지
  // 얼마나 떨어져야 하는지를 거리로 환산한다 — 그게 지금의 '버퍼' 다.
  const ladder = (marginLadder ?? []).map(r => ({
    threshold: r.threshold,
    gapPct: idxNow > 0 ? (r.threshold / idxNow - 1) * 100 : null,
    incrementalJo: r.incrementalJo, cumulativeJo: r.cumulativeJo,
    pctOfDay: r.incrementalPctOfDay,
  }));
  const firstTrigger = ladder[0] ?? null;

  /* ---------- 3. 위로 나오는 물량(숏커버) ---------- */
  const short = !lending ? null : {
    balJo: lending.last.balJo, date: lending.last.date,
    dBalPct: lending.last.dBalPct ?? null,
    cyclePeakJo: lending.cyclePeak.balJo,
    // 직전 5거래일 잔고 변화 — 늘고 있으면 반등 시 커버 압력이 더 크다.
    recent: lending.series.slice(-6).map(r => ({ d: r.d, balJo: r.bal, idx: r.idx })),
    coverLowJo: lending.cover?.lowJo ?? null,
    coverHighJo: lending.cover?.highJo ?? null,
  };

  /* ---------- 4. 과거 유사 국면 ---------- */
  const dd = (s, i, n) => {
    const from = Math.max(0, i - n);
    const peak = Math.max(...s.slice(from, i + 1).map(x => x.i));
    return peak > 0 ? (s[i].i / peak - 1) * 100 : 0;
  };
  const baseRates = [
    {
      key: 'all', label: '전 구간(기준선)',
      cond: () => true,
    },
    {
      key: 'crash20', label: '20거래일 내 고점 대비 -20% 이하',
      cond: (s, i) => dd(s, i, 20) <= -20,
    },
    {
      key: 'crash15', label: '20거래일 내 고점 대비 -15% 이하',
      cond: (s, i) => dd(s, i, 20) <= -15,
    },
    {
      key: 'spike3', label: '하루 +3% 이상 급등 직후',
      cond: (s, i) => i > 0 && s[i - 1].i > 0 && (s[i].i / s[i - 1].i - 1) * 100 >= 3,
    },
    {
      key: 'spike8', label: '하루 +8% 이상 급등 직후',
      cond: (s, i) => i > 0 && s[i - 1].i > 0 && (s[i].i / s[i - 1].i - 1) * 100 >= 8,
    },
    {
      key: 'crashSpike', label: '급락(-15%) 국면 안의 +3% 급등일',
      cond: (s, i) => dd(s, i, 20) <= -15 && i > 0 && (s[i].i / s[i - 1].i - 1) * 100 >= 3,
    },
  ].map(b => ({ key: b.key, label: b.label, ...forwardReturns(series, b.cond, 5) }));

  /* ---------- 5. 현재 상태 태그 ---------- */
  const i = series.length - 1;
  const state = {
    date: last.d, idx: last.i, spotIdx: idxNow, spotDate,
    drawdown20: dd(series, i, 20),
    drawdown60: dd(series, i, 60),
    lastRet: i > 0 ? (series[i].i / series[i - 1].i - 1) * 100 : null,
  };

  return { state, scenarios, ladder, firstTrigger, short, baseRates, events: events ?? [] };
}
