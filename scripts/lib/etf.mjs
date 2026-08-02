// PART 3 계산: 레버리지 ETF 수급(좌수·AUM 분해)과 일별 리밸런싱 요구액.
//
// PART 1·2 는 '잔고'를 본다 — 얼마가 쌓여 있고 얼마가 풀릴 수 있는가.
// PART 3 은 '매일 강제로 나가는 매매'를 본다. 레버리지 ETF 는 잔고가 그대로여도
// 기초자산이 움직이면 목표 배수를 맞추려고 그날 안에 사거나 판다. 성격이 다른 축이다.

/** AUM 은 좌수 x 가격이다. 여기서는 NAV 대신 종가를 쓴다(§23 한계 — 일별 NAV 소스가 없다). */
export const aumWon = r => r.close * r.units;
export const toJo = won => won / 1e12;

const ln = (a, b) => (a > 0 && b > 0 ? Math.log(b / a) : null);

/**
 * 한 구간의 AUM 변화를 유출입(좌수)과 가격으로 가른다.
 * Δln AUM = Δln 좌수 + Δln 가격 이라 로그로 보면 정확히 갈린다.
 * 좌수가 줄었으면 실제 환매(디레버리징), 그대로면 값만 빠진 것이다.
 */
export function decompose(from, to) {
  if (!from || !to) return null;
  const dUnits = ln(from.units, to.units);
  const dPrice = ln(from.close, to.close);
  const dAum = ln(aumWon(from), aumWon(to));
  return {
    fromDate: from.d, toDate: to.d,
    aumFromJo: toJo(aumWon(from)), aumToJo: toJo(aumWon(to)),
    unitsFrom: from.units, unitsTo: to.units,
    closeFrom: from.close, closeTo: to.close,
    dAum, dUnits, dPrice,
    aumPct: dAum == null ? null : (Math.exp(dAum) - 1) * 100,
    unitsPct: dUnits == null ? null : (Math.exp(dUnits) - 1) * 100,
    pricePct: dPrice == null ? null : (Math.exp(dPrice) - 1) * 100,
    // 유출입이 AUM 변화의 몇 %를 설명하는가. 부호가 갈리면 서로 상쇄된 것이다.
    flowShare: dAum && dUnits != null ? dUnits / dAum : null,
  };
}

/**
 * 레버리지 배수 L 상품의 일별 리밸런싱 요구액.
 *
 *   필요 매매액 = L x (L - 1) x AUM(t-1) x r(t)
 *
 * 2X 는 계수 2(오르면 사고 내리면 판다), -2X 는 계수 6 이다. 인버스가 3배 크다 —
 * 규모가 작다고 빼면 안 되는 이유다. 둘 다 부호가 r 과 같아서 추세를 증폭한다.
 */
export const rebalanceCoef = lev => lev * (lev - 1);

export function rebalanceWon(lev, prevAumWon, r) {
  if (!Number.isFinite(prevAumWon) || !Number.isFinite(r)) return null;
  return rebalanceCoef(lev) * prevAumWon * r;
}

const pct = (a, b) => (a > 0 ? b / a - 1 : null);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

/**
 * @param {object} o
 * @param {object} o.etf        data/etf-daily.json
 * @param {object|null} o.csop  data/csop-snapshot.json (홍콩 최신 스냅샷)
 * @param {object|null} [o.csopDaily]  data/csop-daily.json (홍콩 일별 좌수 히스토리)
 * @param {{date:string,idx:number,mcapJo:number}[]} o.market  코스피 지수·시총(FREESIS)
 * @param {string[]} o.checkpointDates  비교 시점(오름차순). 마지막은 최신일.
 */
export function analyzeEtf(o) {
  const { etf, csop, market, checkpointDates } = o;
  if (!etf?.universe?.length) return null;

  const byCode = new Map(etf.universe.map(u => [u.code, u]));
  const rowsOf = code => etf.series[code] ?? [];
  const at = (code, d) => rowsOf(code).find(r => r.d === d) ?? null;
  const lastRow = code => rowsOf(code).at(-1) ?? null;

  const UNDERLYING = { '005930': '삼성전자', '000660': 'SK하이닉스' };
  const isUnderlying = u => u.group === 'underlying';
  const funds = etf.universe.filter(u => !isUnderlying(u));

  // 어느 종목에 걸린 상품인지. 이름으로 가른다(단일종목형만 해당).
  const underlyingOf = name =>
    (/삼성전자/.test(name) ? '005930' : /SK하이닉스/.test(name) ? '000660' : null);

  /* ---------- 1. 시점별 스냅샷과 분해 ---------- */
  const checkpoints = checkpointDates.map(d => ({ date: d }));

  const perFund = funds.map(u => {
    const snaps = checkpointDates.map(d => {
      const r = at(u.code, d);
      return r ? { d, close: r.close, units: r.units, aumJo: toJo(aumWon(r)) } : { d, close: null, units: null, aumJo: null };
    });
    const first = snaps.find(s => s.units != null);
    const last = snaps.filter(s => s.units != null).at(-1);
    const rows = rowsOf(u.code);
    return {
      code: u.code, name: u.name, group: u.group, lev: u.lev,
      underlying: underlyingOf(u.name),
      listedFrom: rows[0]?.d ?? null,
      snaps,
      full: decompose(
        rows.find(r => r.d === first?.d) ?? null,
        rows.find(r => r.d === last?.d) ?? null,
      ),
      // 구간별 분해: 시점 사이사이
      legs: checkpointDates.slice(0, -1).map((d, i) => decompose(at(u.code, d), at(u.code, checkpointDates[i + 1]))),
    };
  });

  const groups = etf.groups.map(g => {
    const members = perFund.filter(f => f.group === g.key);
    const sums = checkpointDates.map((d, i) => ({
      d,
      aumJo: members.reduce((s, m) => s + (m.snaps[i].aumJo ?? 0), 0),
      units: members.reduce((s, m) => s + (m.snaps[i].units ?? 0), 0),
      n: members.filter(m => m.snaps[i].aumJo != null).length,
    }));
    return { ...g, count: members.length, sums };
  });

  /* ---------- 2. 종목별 일별 리밸런싱 요구액 ---------- */
  // 단일종목 상품만 센다. 기초자산 수익률을 그 종목 실제 종가로 잡을 수 있기 때문이다.
  const stockDaily = {};
  for (const [code, name] of Object.entries(UNDERLYING)) {
    const rows = rowsOf(code);
    if (!rows.length) continue;

    const linked = perFund.filter(f => f.underlying === code
      && (f.group === 'single_lev' || f.group === 'single_inv'));

    const mkt = new Map(market.map(m => [m.date, m]));
    const series = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      const r = pct(prev.close, cur.close);
      if (r == null) continue;

      let flowWon = 0, prevAumWon = 0, contributors = 0;
      for (const f of linked) {
        const p = at(f.code, prev.d);
        if (!p) continue;
        const a = aumWon(p);
        prevAumWon += a;
        flowWon += rebalanceWon(f.lev, a, r) ?? 0;
        contributors++;
      }
      if (!contributors) continue;

      const turnoverWon = cur.valueMil * 1e6;
      const mcapWon = cur.close * cur.units;
      const m = mkt.get(cur.d);
      series.push({
        d: cur.d,
        close: cur.close, ret: r * 100,
        amplitude: (cur.high - cur.low) / cur.close * 100,   // 일중 진폭
        gap: (cur.close - cur.open) / cur.open * 100,        // 시가->종가
        turnoverJo: toJo(turnoverWon),
        prevAumJo: toJo(prevAumWon),
        flowJo: toJo(flowWon),
        flowPctTurnover: turnoverWon > 0 ? (Math.abs(flowWon) / turnoverWon) * 100 : null,
        weightPct: m?.mcapJo ? (toJo(mcapWon) / m.mcapJo) * 100 : null,
        // 지수 기여: 비중 x 수익률. 추정이 아니라 산술 분해다.
        idxContribPct: m?.mcapJo ? (toJo(mcapWon) / m.mcapJo) * r * 100 : null,
      });
    }

    // 리밸 수요가 큰 날에 실제로 더 출렁였는가.
    const withFlow = series.filter(s => s.flowPctTurnover != null);
    const sorted = [...withFlow].sort((a, b) => b.flowPctTurnover - a.flowPctTurnover);
    const topN = Math.max(3, Math.round(withFlow.length * 0.2));
    const top = sorted.slice(0, topN), rest = sorted.slice(topN);

    // 반증: 단일종목 ETF 가 없던 시절과 비교한다. 지금의 진폭이 원래 이 종목의 성질이면
    // ETF 탓이라고 말할 수 없다. 상장일(첫 연결 ETF 의 첫 거래일)로 시대를 가른다.
    const listedFrom = linked.map(f => rowsOf(f.code)[0]?.d).filter(Boolean).sort()[0] ?? null;
    const amp = rs => mean(rs.map(r => ((r.high - r.low) / r.close) * 100));
    const era = (from, to) => {
      const rs = rows.filter(r => (!from || r.d >= from) && (!to || r.d < to));
      return { from: rs[0]?.d ?? null, to: rs.at(-1)?.d ?? null, days: rs.length, meanAmplitude: amp(rs) };
    };
    const eras = listedFrom ? {
      listedFrom,
      before2025: era(null, '20260101'),
      before2026: era('20260101', listedFrom),
      after: era(listedFrom, null),
    } : null;

    stockDaily[code] = {
      name, code, eras,
      series,
      funds: linked.map(f => ({ code: f.code, name: f.name, lev: f.lev })),
      test: {
        topN,
        topMeanAmplitude: mean(top.map(s => s.amplitude)),
        restMeanAmplitude: mean(rest.map(s => s.amplitude)),
        topMeanFlowPct: mean(top.map(s => s.flowPctTurnover)),
        restMeanFlowPct: mean(rest.map(s => s.flowPctTurnover)),
        corrFlowAmplitude: pearson(withFlow.map(s => s.flowPctTurnover), withFlow.map(s => s.amplitude)),
        corrFlowTurnover: pearson(withFlow.map(s => Math.abs(s.flowJo)), withFlow.map(s => s.turnoverJo)),
      },
    };
  }

  /* ---------- 2.5 좌수 추이 — 꺾였는가 ---------- */
  // 이 프로젝트에서 매일 확인할 지표는 이것 하나다. AUM 은 가격이 섞여 있어
  // 수급이 정리됐는지를 못 알려준다. 좌수가 꺾이는 날이 진짜 디레버리징의 시작이다.
  function unitsTrendOf(filter) {
    const dates = [...new Set(funds.filter(filter).flatMap(f => rowsOf(f.code).map(r => r.d)))].sort();
    const series = dates.map(d => {
      let units = 0, aumJo = 0, n = 0;
      for (const f of funds.filter(filter)) {
        const r = at(f.code, d);
        if (!r) continue;
        units += r.units; aumJo += toJo(aumWon(r)); n++;
      }
      return { d, unitsM: units / 1e6, aumJo, n };
    }).filter(x => x.n > 0);
    if (series.length < 3) return null;

    const last = series.at(-1);
    const peak = series.reduce((m, r) => (r.unitsM > m.unitsM ? r : m));
    const daysSincePeak = series.length - 1 - series.findIndex(r => r.d === peak.d);
    const back = k => series[Math.max(0, series.length - 1 - k)];
    const chg = k => (back(k).unitsM > 0 ? (last.unitsM / back(k).unitsM - 1) * 100 : null);

    // 연속 감소일. 하루 반짝 감소는 꺾인 게 아니다.
    let downStreak = 0;
    for (let i = series.length - 1; i > 0; i--) {
      if (series[i].unitsM < series[i - 1].unitsM) downStreak++;
      else break;
    }

    const d5 = chg(5);
    const verdict = d5 == null ? 'unknown'
      : d5 > 1 ? 'building'      // 아직 쌓이는 중
      : d5 < -1 ? 'rolling'      // 꺾였다
      : 'flat';                  // 정체 — 꺾이는 길목일 수 있다
    return {
      series, last, peak, daysSincePeak, downStreak,
      d1: chg(1), d5, d10: chg(10),
      fromPeakPct: peak.unitsM > 0 ? (last.unitsM / peak.unitsM - 1) * 100 : null,
      verdict,
    };
  }

  const unitsTrend = {
    single: unitsTrendOf(f => f.group === 'single_lev'),
    samsung: unitsTrendOf(f => f.group === 'single_lev' && underlyingOf(f.name) === '005930'),
    hynix: unitsTrendOf(f => f.group === 'single_lev' && underlyingOf(f.name) === '000660'),
    sector: unitsTrendOf(f => f.group === 'sector_lev'),
  };

  /* ---------- 2.6 전체 레버리지 ETF 합계 추이 ---------- */
  // 그룹별 일별 AUM 을 쌓아 시장 전체 레버리지 규모를 한 장으로 본다.
  // 여기서는 좌수가 아니라 AUM 을 쓴다 — 상품마다 1좌 가격이 달라 좌수는 더할 수 없다.
  const aumDates = [...new Set(funds.flatMap(f => rowsOf(f.code).map(r => r.d)))].sort();
  const groupKeys = etf.groups.map(g => g.key);
  const aumDaily = aumDates.map(d => {
    const row = { d, total: 0 };
    for (const key of groupKeys) {
      const v = funds.filter(f => f.group === key)
        .reduce((s, f) => { const r = at(f.code, d); return s + (r ? toJo(aumWon(r)) : 0); }, 0);
      row[key] = v; row.total += v;
    }
    return row;
  });
  const aumTotal = (() => {
    if (!aumDaily.length) return null;
    const last = aumDaily.at(-1);
    const peak = aumDaily.reduce((m, r) => (r.total > m.total ? r : m));
    const back = k => aumDaily[Math.max(0, aumDaily.length - 1 - k)];
    const chg = k => (back(k).total > 0 ? (last.total / back(k).total - 1) * 100 : null);
    return {
      last, peak,
      fromPeakPct: peak.total > 0 ? (last.total / peak.total - 1) * 100 : null,
      d1: chg(1), d5: chg(5), d20: chg(20),
      daysSincePeak: aumDaily.length - 1 - aumDaily.findIndex(r => r.d === peak.d),
    };
  })();

  /* ---------- 3. 지수 기여 분해 ---------- */
  // 코스피 등락 중 삼성전자·SK하이닉스가 산술적으로 설명하는 몫.
  const mkt = new Map(market.map(m => [m.date, m]));
  const dates = [...new Set(Object.values(stockDaily).flatMap(s => s.series.map(x => x.d)))].sort();
  const indexContrib = dates.map(d => {
    const parts = Object.values(stockDaily)
      .map(s => s.series.find(x => x.d === d))
      .filter(x => x && x.idxContribPct != null);
    if (!parts.length) return null;
    const m = mkt.get(d), prevIdx = market[market.findIndex(x => x.date === d) - 1]?.idx;
    const idxRet = m && prevIdx ? (m.idx / prevIdx - 1) * 100 : null;
    const contrib = parts.reduce((s, x) => s + x.idxContribPct, 0);
    return {
      d, idxRet, contribPct: contrib,
      sharePct: idxRet ? (contrib / idxRet) * 100 : null,
      flowJo: Object.values(stockDaily).reduce((s, x) => s + (x.series.find(y => y.d === d)?.flowJo ?? 0), 0),
    };
  }).filter(Boolean);

  /* ---------- 4. 홍콩(CSOP) ---------- */
  // 스냅샷(csop-snapshot)에 일별 히스토리(csop-daily)를 붙인다. 히스토리는
  // 상장~직전일은 HKEX SDW 발행좌수(src:hkex-sdw), 이후는 CSOP 신고좌수다(§23.6).
  const { csopDaily } = o;
  const hk = csop ? {
    asOf: csop.asOf,
    products: csop.products.map(p => {
      const series = (csopDaily?.products?.find(x => x.ticker === p.ticker)?.series ?? [])
        .map(r => ({ d: r.d, unitsM: r.units / 1e6, src: r.src ?? 'csop' }));
      let trend = null;
      if (series.length >= 6) {
        const last = series.at(-1);
        const peak = series.reduce((m, r) => (r.unitsM > m.unitsM ? r : m));
        const back = k => series[Math.max(0, series.length - 1 - k)];
        trend = {
          days: series.length,
          d5: back(5).unitsM > 0 ? (last.unitsM / back(5).unitsM - 1) * 100 : null,
          fromPeakPct: peak.unitsM > 0 ? (last.unitsM / peak.unitsM - 1) * 100 : null,
          peakDate: peak.d,
        };
      }
      return { ...p, navJo: null, series, trend };
    }),
    note: csop._note,
  } : null;

  return {
    asOf: etf.series[etf.universe[0]?.code]?.at(-1)?.d ?? null,
    checkpoints, groups, perFund, stockDaily, indexContrib, hk, unitsTrend, aumDaily, aumTotal,
    coef: { lev2: rebalanceCoef(2), inv2: rebalanceCoef(-2) },
  };
}
