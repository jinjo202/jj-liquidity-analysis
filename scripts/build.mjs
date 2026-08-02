// data/analysis.json 을 읽어 index.html 한 장으로 굽는다.
// 차트는 빌드 시점에 SVG 문자열로 만들어 넣는다. 런타임 의존성이 없어야
// file:// 로 열어도 그대로 보이고, fetch 로 데이터를 읽지 않으므로 CORS 문제도 없다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'analysis.json'), 'utf8'));

const f = (n, d = 2) => (n == null || !Number.isFinite(n) ? '-' : n.toFixed(d));
const dtFull = s => `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const k0 = n => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '-');

/* ---------- SVG 유틸 ---------- */

const scale = (v, [d0, d1], [r0, r1]) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
function ticks(min, max, count = 5) {
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0 || 1));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) ?? mag * 10;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(t);
  return out;
}

/** 신용융자 잔고 + 지수 이중축 시계열. 사이클 적립 구간을 음영으로 표시한다. */
function timeSeriesChart(series, periods) {
  const W = 660, H = 330, M = { t: 24, r: 64, b: 46, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const cDom = [0, Math.max(...series.filter(p => p.c != null).map(p => p.c / 1e6)) * 1.08];
  const iDom = [0, Math.max(...series.map(p => p.i)) * 1.08];
  const qDom = [0, Math.max(...series.map(p => p.q ?? 0)) * 1.08];

  const xAt = i => scale(i, [0, series.length - 1], [M.l, M.l + iw]);
  const cAt = v => scale(v, cDom, [M.t + ih, M.t]);
  const iAt = v => scale(v, iDom, [M.t + ih, M.t]);
  const qAt = v => scale(v, qDom, [M.t + ih, M.t]);

  const line = (get, yFn) => series
    .map((p, i) => (get(p) == null ? null : `${xAt(i).toFixed(1)},${yFn(get(p)).toFixed(1)}`))
    .filter(Boolean).map((s, i) => `${i ? 'L' : 'M'}${s}`).join('');

  const idxOfDate = d => {
    const i = series.findIndex(p => p.d >= d);
    return i < 0 ? series.length - 1 : i;
  };

  const bands = periods.map((p, n) => {
    const x0 = xAt(idxOfDate(p.accBase)), x1 = xAt(idxOfDate(p.accEnd));
    return `<rect class="cyc c${n}" x="${x0.toFixed(1)}" y="${M.t}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}"/>
      <text class="cyclab" x="${((x0 + x1) / 2).toFixed(1)}" y="${M.t + ih + 32}" text-anchor="middle">${esc(p.name)} 적립</text>`;
  }).join('');

  const yearTicks = [];
  let lastY = null;
  series.forEach((p, i) => {
    const y = p.d.slice(0, 4);
    if (y !== lastY) { yearTicks.push({ i, label: `'${y.slice(2)}` }); lastY = y; }
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="신용융자 잔고와 지수 추이">
  ${bands}
  ${ticks(0, cDom[1]).map(v => `<line class="grid" x1="${M.l}" y1="${cAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${cAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(cAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  ${ticks(0, iDom[1]).map(v => `<text class="ax" x="${M.l + iw + 8}" y="${(iAt(v) + 3.5).toFixed(1)}">${k0(v)}</text>`).join('')}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  <path class="ln-idx" d="${line(p => p.i, iAt)}"/>
  <path class="ln-kq" d="${line(p => p.q, qAt)}"/>
  <path class="ln-cr" d="${line(p => (p.c == null ? null : p.c / 1e6), cAt)}"/>
  <text class="unit" x="${M.l}" y="14">조원</text>
  <text class="unit" x="${M.l + iw}" y="14" text-anchor="end">지수(p)</text>
</svg>`;
}

/** 지수대별 누적 신용매수(churn 보정) 막대 + 마진콜 레벨 선(우축) */
function bucketChart(m) {
  const buckets = m.scaledBuckets.filter(b => b.jo >= 0.005);
  if (!buckets.length) return '<div class="empty">표시할 버킷이 없다.</div>';

  const W = 660, H = 330, M = { t: 26, r: 62, b: 52, l: 46 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vDom = [0, Math.max(...buckets.map(b => b.jo)) * 1.2];
  const mDom = [0, Math.max(...buckets.map(b => b.marginHigh)) * 1.12];
  const bw = iw / buckets.length;

  const yAt = v => scale(v, vDom, [M.t + ih, M.t]);
  const mAt = v => scale(v, mDom, [M.t + ih, M.t]);
  const cx = i => M.l + bw * (i + 0.5);
  const rot = buckets.length > 12;

  const bars = buckets.map((b, i) => {
    const y = yAt(b.jo), h = M.t + ih - y;
    const cls = b.fullyTriggered ? 'bar hit' : b.triggered ? 'bar part' : 'bar';
    return `<rect class="${cls}" x="${(cx(i) - bw * 0.34).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"/>
      <text class="val" x="${cx(i).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">${f(b.jo)}</text>`;
  }).join('');

  const hit = buckets.map((b, i) => ({ b, i })).filter(x => x.b.triggered);
  let band = '';
  if (hit.length) {
    const x0 = cx(hit[0].i) - bw * 0.5, x1 = cx(hit.at(-1).i) + bw * 0.5;
    band = `<rect class="band" x="${x0.toFixed(1)}" y="${M.t}" width="${(x1 - x0).toFixed(1)}" height="${ih}"/>
      <text class="note" x="${((x0 + x1) / 2).toFixed(1)}" y="${M.t + 12}" text-anchor="middle">지수 ${k0(m.headline.idxTrough)} 기준 마진콜 진입</text>`;
  }

  const xLab = buckets.map((b, i) => rot
    ? `<text class="ax sm" transform="translate(${cx(i).toFixed(1)},${M.t + ih + 14}) rotate(-52)" text-anchor="end">${k0(b.low)}</text>`
    : `<text class="ax sm" x="${cx(i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${k0(b.low)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="지수대별 신용융자 누적 매수액과 마진콜 레벨">
  ${band}
  ${ticks(0, vDom[1]).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 1)}</text>`).join('')}
  ${ticks(0, mDom[1]).map(v => `<text class="ax" x="${M.l + iw + 8}" y="${(mAt(v) + 3.5).toFixed(1)}">${k0(v)}</text>`).join('')}
  ${bars}
  <path class="ln-margin" d="${buckets.map((b, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${mAt(b.marginHigh).toFixed(1)}`).join('')}"/>
  ${buckets.map((b, i) => `<circle class="dot" cx="${cx(i).toFixed(1)}" cy="${mAt(b.marginHigh).toFixed(1)}" r="2.4"/>`).join('')}
  ${xLab}
  <text class="unit" x="${M.l}" y="14">조원(보정)</text>
  <text class="unit" x="${M.l + iw}" y="14" text-anchor="end">마진콜 지수(p)</text>
</svg>`;
}

/** 적립(보정) vs 실제 청산을 같은 지수대 축에 나란히 놓는다. */
function flowChart(m) {
  const width = m.width;
  const acc = new Map(m.scaledBuckets.map(b => [b.low, b.jo]));
  const out = new Map(m.unwind.buckets.map(b => [b.low, b.jo]));
  const lows = [...new Set([...acc.keys(), ...out.keys()])]
    .filter(l => (acc.get(l) ?? 0) >= 0.005 || (out.get(l) ?? 0) >= 0.005)
    .sort((a, b) => a - b);
  if (!lows.length) return '<div class="empty">표시할 구간이 없다.</div>';

  const W = 660, H = 300, M = { t: 26, r: 16, b: 50, l: 46 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vMax = Math.max(...lows.map(l => Math.max(acc.get(l) ?? 0, out.get(l) ?? 0))) * 1.2;
  const bw = iw / lows.length;
  const yAt = v => scale(v, [0, vMax], [M.t + ih, M.t]);
  const cx = i => M.l + bw * (i + 0.5);
  const rot = lows.length > 12;

  const pair = lows.map((l, i) => {
    const a = acc.get(l) ?? 0, o = out.get(l) ?? 0;
    const w2 = bw * 0.32;
    const ra = a > 0 ? `<rect class="bar fin" x="${(cx(i) - w2 - 1).toFixed(1)}" y="${yAt(a).toFixed(1)}" width="${w2.toFixed(1)}" height="${(M.t + ih - yAt(a)).toFixed(1)}"/>` : '';
    const ro = o > 0 ? `<rect class="bar fout" x="${(cx(i) + 1).toFixed(1)}" y="${yAt(o).toFixed(1)}" width="${w2.toFixed(1)}" height="${(M.t + ih - yAt(o)).toFixed(1)}"/>` : '';
    return ra + ro;
  }).join('');

  const xLab = lows.map((l, i) => rot
    ? `<text class="ax sm" transform="translate(${cx(i).toFixed(1)},${M.t + ih + 14}) rotate(-52)" text-anchor="end">${k0(l)}</text>`
    : `<text class="ax sm" x="${cx(i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${k0(l)}</text>`).join('');

  const wb = m.unwind.weightedBuildIdx, wu = m.unwind.weightedUnwindIdx;
  const mark = (v, cls, lb) => {
    if (v == null) return '';
    const i = (v - lows[0]) / width;
    const x = M.l + bw * (i + 0.5);
    if (x < M.l || x > M.l + iw) return '';
    return `<line class="wmark ${cls}" x1="${x.toFixed(1)}" y1="${M.t}" x2="${x.toFixed(1)}" y2="${(M.t + ih).toFixed(1)}"/>
      <text class="wlab ${cls}" x="${x.toFixed(1)}" y="${(M.t - 4).toFixed(1)}" text-anchor="middle">${lb} ${k0(v)}</text>`;
  };

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="지수대별 적립과 청산 비교">
  ${ticks(0, vMax).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 1)}</text>`).join('')}
  ${pair}${mark(wb, 'mb', '평균매수')}${mark(wu, 'mu', '평균청산')}${xLab}
  <text class="unit" x="${M.l}" y="14">조원</text>
</svg>`;
}

/**
 * 월별 지수 추이(그 해 1월=100 지수화). 코스피(2천~9천대)와 코스닥(6백~1천2백대)을
 * 원 지수로 겹치면 코스닥이 눌리므로, 축을 하나로 맞추려고 각자 1월 대비 지수화한다.
 * 두 축을 쓰는 대신(왜곡의 원인) 지수화로 한 축에 놓는 표준적인 해법이다.
 */
function monthlyIndexChart(mo) {
  const n = mo.months.length;
  const W = 320, H = 210, M = { t: 18, r: 14, b: 28, l: 34 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vals = [...mo.kIdxIdx, ...mo.qIdxIdx, 100].filter(Number.isFinite);
  const vDom = [Math.min(...vals) - 3, Math.max(...vals) + 3];
  const xAt = i => scale(i, [0, n - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, vDom, [M.t + ih, M.t]);

  const line = arr => arr
    .map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
    .filter(Boolean).map((s, i) => `${i ? 'L' : 'M'}${s}`).join('');

  const xLab = mo.months.map((m, i) => `<text class="ax sm" x="${xAt(i).toFixed(1)}" y="${M.t + ih + 14}" text-anchor="middle">${m.ym.slice(5)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${mo.year}년 월별 코스피·코스닥 지수, 1월을 100으로 지수화">
  ${ticks(vDom[0], vDom[1], 4).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax sm" x="${M.l - 6}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  <path class="ln-base" d="M${M.l},${yAt(100).toFixed(1)} L${(M.l + iw).toFixed(1)},${yAt(100).toFixed(1)}"/>
  <path class="ln-idx" d="${line(mo.kIdxIdx)}"/>
  <path class="ln-kq" d="${line(mo.qIdxIdx)}"/>
  ${xLab}
</svg>`;
}

/** 월별 평균 거래대금(조원). 코스피/코스닥 그룹 막대, 한 축. */
function monthlyTurnoverChart(mo) {
  const n = mo.months.length;
  const W = 320, H = 210, M = { t: 18, r: 14, b: 28, l: 34 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vMax = Math.max(...mo.months.flatMap(m => [m.kToJo ?? 0, m.qToJo ?? 0])) * 1.15;
  const bw = iw / n;
  const yAt = v => scale(v, [0, vMax], [M.t + ih, M.t]);
  const cx = i => M.l + bw * (i + 0.5);
  const w2 = bw * 0.32;

  const bars = mo.months.map((m, i) => {
    const k = m.kToJo ?? 0, q = m.qToJo ?? 0;
    const bk = `<rect class="bar mk" x="${(cx(i) - w2 - 1).toFixed(1)}" y="${yAt(k).toFixed(1)}" width="${w2.toFixed(1)}" height="${(M.t + ih - yAt(k)).toFixed(1)}"/>`;
    const bq = `<rect class="bar mq" x="${(cx(i) + 1).toFixed(1)}" y="${yAt(q).toFixed(1)}" width="${w2.toFixed(1)}" height="${(M.t + ih - yAt(q)).toFixed(1)}"/>`;
    return bk + bq;
  }).join('');
  const xLab = mo.months.map((m, i) => `<text class="ax sm" x="${cx(i).toFixed(1)}" y="${M.t + ih + 14}" text-anchor="middle">${m.ym.slice(5)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${mo.year}년 월별 코스피·코스닥 평균 거래대금, 조원">
  ${ticks(0, vMax, 4).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax sm" x="${M.l - 6}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  ${bars}${xLab}
</svg>`;
}

/* ---------- 시장 블록 ---------- */

const MARKET_NOTE = {
  전체: '신용융자 합계(유가증권+코스닥)를 코스피 지수로 배분. 원 자료와 같은 구성이라 재현 검증의 기준이 된다.',
  유가증권: '유가증권시장 신용거래융자만 코스피 지수로 배분. 코스닥분이 섞이지 않은 순수한 지수대별 물량이다.',
  코스닥: '코스닥 신용거래융자를 코스닥 지수로 배분.',
};

function marketBlock(name, m, closed) {
  const h = m.headline;
  const rc = m.reconciliation;
  const nextLevel = m.buckets.filter(b => !b.triggered).at(-1)?.marginHigh;

  const bucketRows = m.buckets.map((b, i) => ({ b, s: m.scaledBuckets[i] }))
    .filter(x => x.s.jo >= 0.005)
    .map(({ b, s }) => `<tr class="${b.fullyTriggered ? 'r-hit' : b.triggered ? 'r-part' : ''}">
      <td>${k0(b.low)}–${k0(b.high)}</td><td class="n">${f(s.jo)}</td><td class="n dim">${f(b.jo)}</td>
      <td class="n">${k0(b.marginHigh)}</td>
      <td>${b.fullyTriggered ? '청산 완료' : b.triggered ? '청산 진행' : '–'}</td></tr>`).join('');

  const walkShown = m.walk.filter((w, i, a) => i === 0 || w.exposureJo - a[i - 1].exposureJo > 0.005);
  const walkRows = walkShown.map(w => `<tr><td>${dtFull(w.date)}</td>
    <td class="n">${f(w.idx)}</td><td class="n">${f(w.minIdx)}</td>
    <td class="n">${f(w.exposureJo * m.churnScale)}</td></tr>`).join('');

  const scenRows = m.scenarios.map(s => `<tr><td class="n">${k0(s.idx)}</td>
    <td class="n">${f((s.idx / h.idxTrough - 1) * 100, 1)}%</td>
    <td class="n">${f(s.exposureJo * m.churnScale)}</td>
    <td class="n">${f((s.exposureJo - h.exposureJo) * m.churnScale)}</td></tr>`).join('');

  const sensRows = m.sensitivity.map(s => `<tr class="${s.maintenance === A.meta.maintenance ? 'r-base' : ''}">
    <td class="n">${f(s.maintenance * 100, 0)}%</td><td class="n">${f(s.factor)}</td>
    <td class="n">${f(s.exposureJo * m.churnScale)}</td></tr>`).join('');

  const ladderRows = m.ladder.map(r => `<tr>
    <td class="n">${k0(r.threshold)}</td><td>${k0(r.low)}–${k0(r.high)}</td>
    <td class="n">+${f(r.incrementalJo)}</td><td class="n">${f(r.cumulativeJo)}</td>
    <td class="n">${r.cumulativePctOfDay != null ? f(r.cumulativePctOfDay, 1) + '%' : '–'}</td></tr>`).join('');

  const t = m.turnover;
  const turnoverBox = t ? `<div class="box">
    <b>거래대금 대비 규모</b> — 청산 국면(${dtFull(m.unwind.fromDate)}~${dtFull(m.unwind.toDate)}) 총유출
    <b>${f(m.unwind.totalJo)}조</b>는 그 기간 거래대금(${f(t.unwindTotalJo)}조)의 ${f(m.unwind.pctOfTurnover, 2)}%,
    그 시대 정상 하루 거래대금(${f(t.baselineAvgDailyJo)}조)의 ${f(m.unwind.equivDays, 2)}배에 해당한다.
    같은 국면 거래대금은 정상 대비 ${f(t.unwindVsBaselinePct, 0)}% 수준이었다
    (100% 미만이면 청산이 유동성이 마른 상태에서 진행됐다는 뜻).
    남은 사다리 ${f(m.scaledRemainingJo)}조는 <b>오늘 기준</b> 하루 평균 거래대금(${f(t.currentAvgDailyJo)}조)의
    ${f(m.scaledRemainingJo / t.currentAvgDailyJo, 2)}배다.
  </div>` : '';

  return `<div class="mkt">
<h3 class="mh">${esc(name)} <span class="tag">버킷 ${m.width}p</span></h3>
<p class="lead">${MARKET_NOTE[name]}</p>

<div class="cards">
  <div class="card"><div class="lb">지수 고점 → 저점</div><div class="vl">${f(h.idxDrawdownPct, 1)}<span class="u">%</span></div><div class="nt">${k0(h.idxPeak)} → ${k0(h.idxTrough)}</div></div>
  <div class="card"><div class="lb">신용융자 고점</div><div class="vl">${f(h.creditPeakJo)}<span class="u">조</span></div><div class="nt">${dtFull(h.creditPeakDate)}</div></div>
  <div class="card"><div class="lb">실측 청산</div><div class="vl neg">${f(h.actualDeclineJo)}<span class="u">조</span></div><div class="nt">청산률 ${f(h.unwindPct, 1)}%</div></div>
  <div class="card"><div class="lb">사이클 순증</div><div class="vl">${f(m.netBuildJo)}<span class="u">조</span></div><div class="nt">gross ${f(h.buildJo)}조 × ${f(m.churnScale)}</div></div>
  <div class="card"><div class="lb">마진콜 진입(보정)</div><div class="vl neg">${f(m.scaledExposureJo)}<span class="u">조</span></div><div class="nt">순증의 ${f(h.exposureOfBuildPct, 0)}%</div></div>
  <div class="card"><div class="lb">아직 미진입(보정)</div><div class="vl">${f(m.scaledRemainingJo)}<span class="u">조</span></div><div class="nt">${nextLevel ? `${k0(nextLevel)}p 이탈 시 개시` : '해당 없음'}</div></div>
</div>

<figure>
  ${bucketChart(m)}
  <div class="lg"><span><i class="sw hit"></i>마진콜 전량 진입</span><span><i class="sw part"></i>일부 진입</span><span><i class="sw bar"></i>미진입</span><span><i class="sw acc"></i>마진콜 레벨(우축, 상단기준)</span></div>
  <figcaption>${dtFull(m.accBase)} 잔고를 기준선으로 ${dtFull(m.accEnd)}까지의 일별 증가분을 그날 종가의 ${m.width}p 구간에 배분한 뒤,
  합계를 사이클 순증 ${f(m.netBuildJo)}조에 맞춰 ${f(m.churnScale)}배로 보정했다.</figcaption>
</figure>

<figure>
  <h4>어디서 쌓이고 어디서 털렸는가</h4>
  ${flowChart(m)}
  <div class="lg"><span><i class="sw fin"></i>적립(보정)</span><span><i class="sw fout"></i>실제 청산</span><span><i class="sw mb"></i>금액가중 평균 매수 지수</span><span><i class="sw mu"></i>금액가중 평균 청산 지수</span></div>
  <figcaption>가중평균 매수 ${k0(m.unwind.weightedBuildIdx)}p, 청산 ${k0(m.unwind.weightedUnwindIdx)}p.
  ${m.unwind.toDate === m.headline.creditLastDate && !m.unwind.buckets.length ? '' : ''}
  진행 중인 사이클은 청산 국면이 짧아 최근 고지수 물량만 반영된다. 손실률로 읽을 수 있는 값이 아니다.</figcaption>
</figure>

<div class="box ${Math.abs(rc.scaledGapJo) < Math.abs(rc.gapJo) ? '' : 'warn'}">
  <b>모델 vs 실측</b> — 보정 모델 <b>${f(rc.scaledExposureJo)}조</b> vs 실측 청산 ${f(rc.actualDeclineJo)}조,
  오차 <b>${f(Math.abs(rc.scaledGapJo))}조</b>. (보정 전 gross 기준은 ${f(rc.modelExposureJo)}조로 오차 ${f(Math.abs(rc.gapJo))}조.)
  ${closed
      ? '이 사이클은 청산이 끝났으므로 이 대조가 모델의 실질적인 검증이다.'
      : '진행 중인 사이클이다. 신용융자는 결제일 기준이라 급락 당일 청산이 즉시 반영되지 않고, 추가 담보 납입분도 섞여 있다.'}
</div>
${turnoverBox}

<div class="tables">
  ${m.ladder.length ? `<div><h4>마진콜 사다리 — 지수가 이 아래로 마감하면 열리는 물량</h4>
    <div class="tw"><table>
      <thead><tr><th class="n">지수(p) 밑</th><th>매수구간(p)</th><th class="n">증가(조)</th><th class="n">누적(조)</th><th class="n">누적/하루거래대금</th></tr></thead>
      <tbody>${ladderRows}</tbody>
      <tfoot><tr><th colspan="3">총 잔여</th><th class="n">${f(m.scaledRemainingJo)}</th><th></th></tr></tfoot>
    </table></div>
    <figcaption>현재 지수 ${k0(h.idxTrough)}p 기준. 안 터진 버킷을 마진콜 지수 내림차순으로 나열했다 —
    지수가 더 떨어질수록 이 순서대로 열린다. 오른쪽 열은 오늘 기준 하루 평균 거래대금 대비 누적 비중이다.</figcaption></div>` : ''}
  <div><h4>구간별 누적 신용매수와 마진콜 레벨</h4>
    <div class="tw"><table>
      <thead><tr><th>지수 구간(p)</th><th class="n">보정(조)</th><th class="n">gross(조)</th><th class="n">마진콜 레벨(p)</th><th>상태</th></tr></thead>
      <tbody>${bucketRows}</tbody>
      <tfoot><tr><th>합계</th><th class="n">${f(m.netBuildJo)}</th><th class="n dim">${f(h.buildJo)}</th><th></th><th></th></tr></tfoot>
    </table></div></div>
  <div><h4>지수대별 실제 청산액 (${dtFull(m.unwind.fromDate)}~${dtFull(m.unwind.toDate)})</h4>
    <div class="tw"><table>
      <thead><tr><th>지수 구간(p)</th><th class="n">청산액(조)</th><th class="n">비중</th></tr></thead>
      <tbody>${m.unwind.buckets.filter(b => b.jo >= 0.005).map(b => `<tr>
        <td>${k0(b.low)}–${k0(b.high)}</td><td class="n">${f(b.jo)}</td>
        <td class="n">${f(b.jo / m.unwind.totalJo * 100, 0)}%</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>총유출</th><th class="n">${f(m.unwind.totalJo)}</th><th class="n">순감소 ${f(m.unwind.netJo)}</th></tr></tfoot>
    </table></div>
    <figcaption>일별 <b>감소분</b>을 그날 종가 구간에 배분. 청산 국면에도 신규 매수가 섞이므로 총유출이 순감소보다 크다.</figcaption></div>
  <div><h4>하락 구간 누적 마진콜 노출(보정)</h4>
    <div class="tw"><table>
      <thead><tr><th>일자</th><th class="n">종가</th><th class="n">기간 최저</th><th class="n">누적 노출(조)</th></tr></thead>
      <tbody>${walkRows}</tbody>
    </table></div>
    <figcaption>반대매매는 되돌릴 수 없으므로 그날까지의 <b>최저 종가</b>로 판정한다.</figcaption></div>
  <div><h4>추가 하락 시나리오</h4>
    <div class="tw"><table>
      <thead><tr><th class="n">지수(p)</th><th class="n">저점 대비</th><th class="n">누적 노출(조)</th><th class="n">증가(조)</th></tr></thead>
      <tbody>${scenRows}</tbody>
    </table></div></div>
  <div><h4>담보유지비율 민감도 (지수 ${k0(h.idxTrough)})</h4>
    <div class="tw"><table>
      <thead><tr><th class="n">담보유지비율</th><th class="n">계수</th><th class="n">노출(조)</th></tr></thead>
      <tbody>${sensRows}</tbody>
    </table></div>
    <figcaption>계수 = 담보유지비율 × 융자비율(${f(A.meta.loanRatio * 100, 0)}%). 매수 지수 × 계수 = 마진콜 발생 지수.</figcaption></div>
</div>
</div>`;
}

/* ---------- 사이클 대조 ---------- */

const P = A.periods;
const closedP = P.find(p => p.closed), openP = P.find(p => !p.closed);
const ca = closedP?.markets['전체'], co = openP?.markets['전체'];

let compare = '';
if (ca && co) {
  const a = ca.headline, b = co.headline;
  const impliedJo = b.creditPeakJo * (a.unwindPct / 100);
  const residualJo = impliedJo - b.actualDeclineJo;
  const rows = [
    ['버킷 폭', `${ca.width}p`, `${co.width}p`],
    ['지수 고점', k0(a.idxPeak), k0(b.idxPeak)],
    ['지수 저점', k0(a.idxTrough), k0(b.idxTrough)],
    ['지수 낙폭', `${f(a.idxDrawdownPct, 1)}%`, `${f(b.idxDrawdownPct, 1)}%`],
    ['신용융자 고점', `${f(a.creditPeakJo)}조`, `${f(b.creditPeakJo)}조`],
    ['실측 청산', `${f(a.actualDeclineJo)}조`, `${f(b.actualDeclineJo)}조`],
    ['청산률', `${f(a.unwindPct, 1)}%`, `${f(b.unwindPct, 1)}%`],
    ['마진콜 진입(보정)', `${f(ca.scaledExposureJo)}조`, `${f(co.scaledExposureJo)}조`],
  ].map(([lb, x, y]) => `<tr><td>${lb}</td><td class="n">${x}</td><td class="n">${y}</td></tr>`).join('');

  compare = `<section>
<h2>사이클 대조</h2>
<p class="lead">코스피 레벨이 2021년 3,305p, 2026년 9,115p로 완전히 다르다. 전 기간을 같은 절대 지수 버킷으로 묶으면
두 국면이 섞여 아무 의미가 없으므로 사이클을 나눠 계산했다. 2020–21 사이블은 청산까지 끝난 국면이라 모델의 검증 사례가 된다.</p>
<div class="tables">
  <div><div class="tw"><table>
    <thead><tr><th></th><th class="n">${esc(closedP.name)}</th><th class="n">${esc(openP.name)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>
  <div>
    <div class="box">
      <b>모델 검증</b> — 끝난 2020–21 사이클에서 보정 모델은 청산 규모를 <b>${f(ca.scaledExposureJo)}조</b>로 추정했고
      실측은 ${f(-a.actualDeclineJo)}조였다. 오차 ${f(Math.abs(ca.reconciliation.scaledGapJo))}조
      (실측의 ${f(Math.abs(ca.reconciliation.scaledGapJo / a.actualDeclineJo) * 100, 0)}%).
      마진콜 기반 추정이 실제 청산의 대부분을 설명한다.
    </div>
    <div class="box warn">
      <b>현 사이클은 청산이 덜 진행됐다</b> — 지수는 이미 ${f(b.idxDrawdownPct, 1)}%로
      2022년(${f(a.idxDrawdownPct, 1)}%)보다 깊게 빠졌는데, 신용 청산률은 ${f(b.unwindPct, 1)}%로
      2021 사이클(${f(a.unwindPct, 1)}%)의 ${f(b.unwindPct / a.unwindPct * 100, 0)}% 수준이다.
      2021 청산률을 그대로 적용하면 총 ${f(impliedJo)}조가 풀려야 하고, 현재까지 ${f(b.actualDeclineJo)}조이므로
      <b>잔여 ${f(residualJo)}조</b>가 남는다.
    </div>
    <div class="box">
      <b>두 지표가 다른 방향을 가리킨다</b> — 마진콜 모델은 현 시점 노출을 ${f(co.scaledExposureJo)}조로 보는데
      실측 청산은 이미 ${f(-b.actualDeclineJo)}조다. 강제 청산으로 설명되는 몫보다 실제 감소가 크다는 뜻이고,
      마진콜을 피하려는 자발적 축소가 섞여 있다고 읽는 게 자연스럽다.
      반면 2021 청산률 기준으로는 아직 갈 길이 남았다. 둘 다 근거가 다르므로 한쪽만 취하지 않고 병기한다.
    </div>
  </div>
</div>
</section>`;
}

/* ---------- 월별 지수·거래대금 비교 ---------- */

function monthlyYearBlock(mo) {
  const rows = mo.months.map((m, i) => `<tr>
    <td>${m.ym}</td>
    <td class="n">${k0(m.kIdx)}</td><td class="n dim">${f(mo.kIdxIdx[i], 1)}</td>
    <td class="n">${m.qIdx != null ? k0(m.qIdx) : '-'}</td><td class="n dim">${mo.qIdxIdx[i] != null ? f(mo.qIdxIdx[i], 1) : '-'}</td>
    <td class="n">${f(m.kToJo)}</td><td class="n">${f(m.qToJo)}</td></tr>`).join('');

  return `<div>
  <h4>${mo.year}년</h4>
  <div class="tables" style="margin-top:0">
    <div><figure style="margin-top:0"><h4 style="margin-bottom:2px">지수 (1월=100)</h4>${monthlyIndexChart(mo)}</figure></div>
    <div><figure style="margin-top:0"><h4 style="margin-bottom:2px">월평균 거래대금(조원)</h4>${monthlyTurnoverChart(mo)}</figure></div>
  </div>
  <div class="tw"><table>
    <thead><tr><th>월</th><th class="n">코스피</th><th class="n dim">지수화</th><th class="n">코스닥</th><th class="n dim">지수화</th><th class="n">코스피거래대금</th><th class="n">코스닥거래대금</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

let monthlySection = '';
if (A.monthly?.closed && A.monthly?.open) {
  monthlySection = `<section>
<h2>월별 지수·거래대금 비교 — ${A.monthly.closed.year}년 vs ${A.monthly.open.year}년</h2>
<p class="lead">코스피(2천~9천대)와 코스닥(6백~1천2백대)은 원 지수 그대로 겹치면 코스닥이 눌려 안 보인다.
그래서 지수는 그 해 1월을 100으로 지수화해 한 축에 놓고, 거래대금은 원 단위(조원)로 따로 그렸다 —
지수와 거래대금처럼 스케일이 다른 두 지표를 억지로 한 축(이중축)에 넣지 않고 차트를 나눈 것과 같은 이유다.</p>
<div class="tables">
  ${monthlyYearBlock(A.monthly.closed)}
  ${monthlyYearBlock(A.monthly.open)}
</div>
<div class="lg"><span><i class="sw acc"></i>코스피</span><span><i class="sw kq"></i>코스닥</span><span><i class="sw" style="background:none;border-top:2px dashed var(--mut);height:0;display:inline-block;width:20px;vertical-align:middle;margin-right:5px"></i>기준(1월=100)</span></div>
<div class="box">
  <b>${A.monthly.closed.year}년</b>은 지수 등락폭이 작고(±8%p 이내), 거래대금은 1월부터 꾸준히 우하향했다 —
  지수와 거래대금이 따로 움직인 유형이다.
  <b>${A.monthly.open.year}년</b>은 신용 고점이 낀 달(6월)에 지수와 거래대금이 나란히 정점을 찍고
  그 다음 달(7월) 함께 무너졌다 — §14.2의 "청산 국면 거래대금이 정상보다 오히려 줄어 있었다"는
  계산이 월별로 보이는 그림이다. 코스닥은 코스피보다 한 달 먼저(5월) 꺾여, §8.1에서 확인한
  "코스닥이 유가증권보다 먼저·많이 청산됐다"는 사실과 시점이 맞아떨어진다.
</div>
</section>`;
}

/* ---------- 신용/시총 비율 차트 ---------- */

function ratioChart(rows, marks, unit = '신용융자 / 시가총액 (%)', suf = '%', dg = 3) {
  const W = 660, H = 240, M = { t: 22, r: 16, b: 34, l: 46 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vMax = Math.max(...rows.map(r => r.ratio)) * 1.12;
  const xAt = i => scale(i, [0, rows.length - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, [0, vMax], [M.t + ih, M.t]);

  const yearTicks = [];
  let lastY = null;
  rows.forEach((r, i) => {
    const y = r.date.slice(0, 4);
    if (y !== lastY) { yearTicks.push({ i, label: `'${y.slice(2)}` }); lastY = y; }
  });

  const mk = marks.filter(Boolean).map(mm => {
    const i = rows.findIndex(r => r.date >= mm.date);
    if (i < 0) return '';
    return `<circle class="rdot" cx="${xAt(i).toFixed(1)}" cy="${yAt(mm.ratio).toFixed(1)}" r="3.2"/>
      <text class="ax sm" x="${xAt(i).toFixed(1)}" y="${(yAt(mm.ratio) - 8).toFixed(1)}" text-anchor="middle">${mm.label} ${f(mm.ratio, dg)}${suf}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="신용융자 대 시가총액 비율">
  ${ticks(0, vMax).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 2)}</text>`).join('')}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  <path class="ln-ratio" d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(r.ratio).toFixed(1)}`).join('')}"/>
  ${mk}
  <text class="unit" x="${M.l}" y="13">${esc(unit)}</text>
</svg>`;
}

/** 지표 하나의 1년 추세. 핵심 요약에서 지표를 펼치면 나온다. */
function trendChart(points, unit, dg, spanLabel = '최근 1년') {
  const W = 640, H = 190, M = { t: 18, r: 52, b: 26, l: 12 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vs = points.map(p => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
  const dom = [lo - pad, hi + pad];
  const xAt = i => scale(i, [0, points.length - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, dom, [M.t + ih, M.t]);

  // 분기 시작만 눈금으로 찍는다. 1년치에 월 12개를 다 찍으면 글자가 겹친다.
  const ticksX = [];
  let lastQ = null;
  points.forEach((p, i) => {
    const q = `${p.d.slice(0, 4)}Q${Math.floor((Number(p.d.slice(4, 6)) - 1) / 3)}`;
    if (q !== lastQ) { ticksX.push({ i, label: `${p.d.slice(2, 4)}.${p.d.slice(4, 6)}` }); lastQ = q; }
  });

  const iMax = vs.indexOf(hi), iMin = vs.indexOf(lo);
  const mark = (i, v, label, cls) => `<circle class="tdot ${cls}" cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.8"/>
    <text class="ax sm" x="${xAt(i).toFixed(1)}" y="${(yAt(v) + (cls === 'hi' ? -7 : 13)).toFixed(1)}" text-anchor="middle">${label} ${f(v, dg)}</text>`;

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join('');
  const area = `${d}L${xAt(points.length - 1).toFixed(1)},${(M.t + ih).toFixed(1)}L${xAt(0).toFixed(1)},${(M.t + ih).toFixed(1)}Z`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 1년 추세">
  ${ticks(dom[0], dom[1], 3).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l + iw + 6}" y="${(yAt(v) + 3.5).toFixed(1)}">${f(v, dg)}</text>`).join('')}
  ${ticksX.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 15}" text-anchor="middle">${t.label}</text>`).join('')}
  <path class="tarea" d="${area}"/>
  <path class="tline" d="${d}"/>
  ${mark(iMax, hi, '고', 'hi')}
  ${mark(iMin, lo, '저', 'lo')}
  <circle class="tdot now" cx="${xAt(points.length - 1).toFixed(1)}" cy="${yAt(vs.at(-1)).toFixed(1)}" r="3.4"/>
  <text class="unit" x="${M.l}" y="12">${esc(unit)} · ${esc(spanLabel)} (${points.length}영업일)</text>
</svg>`;
}

/**
 * 그룹별 AUM 을 쌓아 올린 면적 차트. 레버리지 ETF 시장 전체가 어떻게 부풀었다 꺼졌는지를
 * 한 장으로 본다. 선 여러 개를 겹치면 합계가 눈에 안 들어와서 누적 면적을 쓴다.
 */
function stackChart(rows, keys, unit, marks = []) {
  const W = 980, H = 300, M = { t: 20, r: 58, b: 34, l: 12 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  if (rows.length < 2) return '';
  const hi = Math.max(...rows.map(r => keys.reduce((s, k) => s + (r[k.key] ?? 0), 0)));
  const dom = [0, hi * 1.08];
  const xAt = i => scale(i, [0, rows.length - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, dom, [M.t + ih, M.t]);

  // 아래에서부터 쌓는다. 각 층의 윗선 = 자기 값 + 아래 층 누적.
  let below = rows.map(() => 0);
  const layers = keys.map(k => {
    const top = rows.map((r, i) => below[i] + (r[k.key] ?? 0));
    const path = `M${top.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join('L')}`
      + `L${[...below].reverse().map((v, j) => {
        const i = rows.length - 1 - j;
        return `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      }).join('L')}Z`;
    below = top;
    return { ...k, path };
  });

  // x 눈금은 분기 시작만. 하루씩 다 찍으면 글자가 겹친다.
  const ticksX = [];
  let lastQ = null;
  rows.forEach((r, i) => {
    const q = `${r.d.slice(0, 4)}Q${Math.floor((Number(r.d.slice(4, 6)) - 1) / 3)}`;
    if (q !== lastQ) { ticksX.push({ i, label: `${r.d.slice(2, 4)}.${r.d.slice(4, 6)}` }); lastQ = q; }
  });

  const totals = rows.map(r => keys.reduce((s, k) => s + (r[k.key] ?? 0), 0));
  const iPeak = totals.indexOf(Math.max(...totals));

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">
  ${ticks(dom[0], dom[1], 4).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l + iw + 6}" y="${(yAt(v) + 3.5).toFixed(1)}">${f(v, 0)}</text>`).join('')}
  ${ticksX.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 15}" text-anchor="middle">${t.label}</text>`).join('')}
  ${layers.map(l => `<path d="${l.path}" fill="${l.color}" fill-opacity="${l.op ?? 0.85}" stroke="none"/>`).join('')}
  ${marks.map(m => {
    const i = rows.findIndex(r => r.d >= m.d);
    if (i < 0) return '';
    return `<line class="mk" x1="${xAt(i).toFixed(1)}" y1="${M.t}" x2="${xAt(i).toFixed(1)}" y2="${M.t + ih}"/>
      <text class="ax sm" x="${xAt(i).toFixed(1)}" y="${M.t - 5}" text-anchor="middle">${esc(m.label)}</text>`;
  }).join('')}
  <circle class="tdot hi" cx="${xAt(iPeak).toFixed(1)}" cy="${yAt(totals[iPeak]).toFixed(1)}" r="3"/>
  <text class="ax sm" x="${xAt(iPeak).toFixed(1)}" y="${(yAt(totals[iPeak]) - 7).toFixed(1)}" text-anchor="middle">고점 ${f(totals[iPeak], 1)}조</text>
  <circle class="tdot now" cx="${xAt(rows.length - 1).toFixed(1)}" cy="${yAt(totals.at(-1)).toFixed(1)}" r="3.4"/>
  <text class="unit" x="${M.l}" y="12">${esc(unit)}</text>
</svg>`;
}

/** 같은 단위(조원) 계열 여러 개를 한 축에 겹쳐 그린다. */
function levelChart(rows, lines, unit) {
  const W = 660, H = 260, M = { t: 22, r: 16, b: 34, l: 50 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vMax = Math.max(...lines.flatMap(L => rows.map(r => r[L.key] ?? 0))) * 1.1;
  const xAt = i => scale(i, [0, rows.length - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, [0, vMax], [M.t + ih, M.t]);

  const yearTicks = [];
  let lastY = null;
  rows.forEach((r, i) => {
    const y = r.d.slice(0, 4);
    if (y !== lastY) { yearTicks.push({ i, label: `'${y.slice(2)}` }); lastY = y; }
  });

  const paths = lines.map(L => {
    const pts = rows.map((r, i) => (Number.isFinite(r[L.key]) ? `${xAt(i).toFixed(1)},${yAt(r[L.key]).toFixed(1)}` : null))
      .filter(Boolean);
    return `<path class="${L.cls}" d="M${pts.join(' L')}"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">
  ${ticks(0, vMax).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  ${paths}
  <text class="unit" x="${M.l}" y="13">${esc(unit)}</text>
</svg>`;
}

/* ---------- 대차잔고(공매도 프록시) 차트 ---------- */

function lendingChart(series, cyclePeakDate) {
  const W = 660, H = 330, M = { t: 24, r: 64, b: 34, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const bDom = [0, Math.max(...series.map(p => p.bal)) * 1.08];
  const iDom = [0, Math.max(...series.map(p => p.idx)) * 1.08];
  const xAt = i => scale(i, [0, series.length - 1], [M.l, M.l + iw]);
  const bAt = v => scale(v, bDom, [M.t + ih, M.t]);
  const iAt = v => scale(v, iDom, [M.t + ih, M.t]);

  const yearTicks = [];
  let lastY = null;
  series.forEach((p, i) => {
    const y = p.d.slice(0, 4);
    if (y !== lastY) { yearTicks.push({ i, label: `'${y.slice(2)}` }); lastY = y; }
  });

  const peakI = series.findIndex(p => p.d === cyclePeakDate);
  const peakMark = peakI >= 0
    ? `<line class="wmark mu" x1="${xAt(peakI).toFixed(1)}" y1="${M.t}" x2="${xAt(peakI).toFixed(1)}" y2="${(M.t + ih).toFixed(1)}"/>
       <text class="wlab mu" x="${xAt(peakI).toFixed(1)}" y="${(M.t - 4).toFixed(1)}" text-anchor="middle">잔고 고점</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="대차잔고와 코스피 지수 추이">
  ${ticks(0, bDom[1]).map(v => `<line class="grid" x1="${M.l}" y1="${bAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${bAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(bAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  ${ticks(0, iDom[1]).map(v => `<text class="ax" x="${M.l + iw + 8}" y="${(iAt(v) + 3.5).toFixed(1)}">${k0(v)}</text>`).join('')}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  ${peakMark}
  <path class="ln-idx" d="M${series.map((p, i) => `${xAt(i).toFixed(1)},${iAt(p.idx).toFixed(1)}`).join(' L')}"/>
  <path class="ln-cr" d="M${series.map((p, i) => `${xAt(i).toFixed(1)},${bAt(p.bal).toFixed(1)}`).join(' L')}"/>
  <text class="unit" x="${M.l}" y="14">대차잔고(조원)</text>
  <text class="unit" x="${M.l + iw}" y="14" text-anchor="end">코스피(p)</text>
</svg>`;
}

/* ---------- 마진콜 사다리 — 시장별 비교 ---------- */

const OPEN = A.periods.find(p => !p.closed);
let ladderCompareSection = '';
if (OPEN) {
  const marketCol = (name, m) => {
    if (!m.ladder.length) {
      return `<div><h4>${esc(name)}</h4><p class="lead">지수 ${k0(m.headline.idxTrough)}p 기준, 안 터진 버킷 없음(전량 마진콜 구간).</p></div>`;
    }
    const rows = m.ladder.map(r => `<tr>
      <td class="n">${k0(r.threshold)}</td><td>${k0(r.low)}–${k0(r.high)}</td>
      <td class="n">+${f(r.incrementalJo)}</td><td class="n">${f(r.cumulativeJo)}</td>
      <td class="n">${r.cumulativePctOfDay != null ? f(r.cumulativePctOfDay, 1) + '%' : '–'}</td></tr>`).join('');
    return `<div><h4>${esc(name)} <span style="font-weight:400;color:var(--mut)">— 지수 ${k0(m.headline.idxTrough)}p 기준</span></h4>
      <div class="tw"><table>
        <thead><tr><th class="n">지수(p) 밑</th><th>매수구간(p)</th><th class="n">증가(조)</th><th class="n">누적(조)</th><th class="n">누적/일거래대금</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th colspan="3">총 잔여</th><th class="n">${f(m.scaledRemainingJo)}</th><th></th></tr></tfoot>
      </table></div></div>`;
  };

  ladderCompareSection = `<section>
<h2>마진콜 사다리 — 시장별 비교 (${esc(OPEN.name)})</h2>
<p class="lead">"지수가 얼마로 가면 얼마가 풀리는가"를 시장별로 나란히 놓는다. 계산 근거는 §13(전체 기준 예시)과 동일하며,
여기서는 유가증권과 코스닥을 바로 대조할 수 있게 모았다. 오른쪽 열은 오늘 기준 하루 평균 거래대금 대비 누적 비중이다.</p>
<div class="tables">
  ${Object.entries(OPEN.markets).map(([name, m]) => marketCol(name, m)).join('')}
</div>
</section>`;
}

/* ---------- 거래대금 대비 규모 — 시장별 비교 ---------- */

let turnoverCompareSection = '';
if (OPEN) {
  const marketTurnoverCol = (name, m) => {
    if (!m.turnover) return '';
    const t = m.turnover, u = m.unwind;
    const rows = [
      ['그 시대 정상 하루 거래대금', `${f(t.baselineAvgDailyJo)}조`],
      ['오늘 기준 하루 거래대금', `${f(t.currentAvgDailyJo)}조`],
      [`청산국면(${dtFull(u.fromDate)}~${dtFull(u.toDate)}) 총거래대금`, `${f(t.unwindTotalJo)}조`],
      ['그 국면 일평균 거래대금', `${f(t.unwindAvgDailyJo)}조 (정상 대비 ${f(t.unwindVsBaselinePct, 0)}%)`],
      ['총유출(gross)', `${f(u.totalJo)}조`],
      ['&nbsp;&nbsp;= 그 국면 거래대금의', `${f(u.pctOfTurnover, 2)}%`],
      ['&nbsp;&nbsp;= 그 시대 정상 하루의', `${f(u.equivDays, 2)}배`],
      ['남은 사다리(보정)', `${f(m.scaledRemainingJo)}조 = 오늘 하루의 ${f(m.scaledRemainingJo / t.currentAvgDailyJo, 2)}배`],
    ];
    return `<div><h4>${esc(name)}</h4>
      <div class="tw"><table>
        <tbody>${rows.map(([lb, v]) => `<tr><td>${lb}</td><td class="n">${v}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  };

  turnoverCompareSection = `<section>
<h2>거래대금 대비 규모 — 시장별 비교 (${esc(OPEN.name)})</h2>
<p class="lead">계산 근거는 §14와 동일. 과거 청산은 그 시대 정상(청산 직전 20일 평균)과, 남은 사다리는 오늘 기준과 대조한다.</p>
<div class="tables">
  ${Object.entries(OPEN.markets).map(([name, m]) => marketTurnoverCol(name, m)).join('')}
</div>
${(() => {
    const kq = OPEN.markets['코스닥']?.unwind, kospi = OPEN.markets['유가증권']?.unwind;
    const kqT = OPEN.markets['코스닥']?.turnover, kospiT = OPEN.markets['유가증권']?.turnover;
    if (!kq || !kospi) return '';
    return `<div class="box">
  <b>코스닥이 유가증권보다 거래대금 대비 청산 강도가 훨씬 세다</b> — 총유출이 그 시대 정상 하루 거래대금의
  몇 배였는지로 보면 코스닥 <b>${f(kq.equivDays, 2)}배</b>, 유가증권 <b>${f(kospi.equivDays, 2)}배</b>로 4배 가까이 차이난다.
  그런데 청산 국면 거래대금 자체는 코스닥이 정상 대비 ${f(kqT.unwindVsBaselinePct, 0)}%로 유가증권(${f(kospiT.unwindVsBaselinePct, 0)}%)보다
  덜 말랐다 — 코스닥은 유동성이 상대적으로 유지된 채로 강한 청산이 진행됐고, 유가증권은 유동성이 더 마른 채로
  약한 청산이 진행됐다. 남은 사다리도 코스닥은 오늘 하루 거래대금의 ${f(OPEN.markets['코스닥'].scaledRemainingJo / OPEN.markets['코스닥'].turnover.currentAvgDailyJo, 2)}배뿐이라
  더 풀릴 여지도 유가증권보다 작다.
</div>`;
  })()}
</section>`;
}

/* ---------- 대차잔고(공매도 프록시)와 숏커버링 ---------- */

let lendingSection = '';
if (A.lending) {
  const L = A.lending;
  const dc = L.dayClass;
  const creditUnwindPct = A.periods.find(p => !p.closed)?.markets['전체']?.headline?.unwindPct;
  const candRows = L.candidates.map(c => `<tr>
    <td>${dtFull(c.date)}</td>
    <td class="n">${k0(c.idx)}</td><td class="n">+${f(c.dIdxPct, 2)}%</td>
    <td class="n">${f(c.balJo)}</td><td class="n">${f(c.dBalPct, 2)}%</td></tr>`).join('');

  const total = dc.coverType + dc.jointUnwind + dc.newShort + dc.riskOn;

  lendingSection = `<section>
<h2>공매도(대차잔고) 추이와 숏커버링</h2>
<p class="lead">한국은 공매도가 거의 전량 차입 후 매도라 <b>대차잔고</b>를 시장 전체 공매도 잔고의 표준 프록시로 쓴다.
시장 전체 실제 공매도 잔고는 공표되지 않는다(종목별 순보유잔고, 대량보유자 신고 기준만 공표).
FREESIS 대차거래추이(일별, 시장 전체)에서 받았다.</p>

<div class="cards">
  <div class="card"><div class="lb">역대 최고</div><div class="vl">${f(L.allTimePeak.balJo)}<span class="u">조</span></div><div class="nt">${dtFull(L.allTimePeak.date)}</div></div>
  <div class="card"><div class="lb">현재</div><div class="vl">${f(L.last.balJo)}<span class="u">조</span></div><div class="nt">${dtFull(L.last.date)}</div></div>
  <div class="card"><div class="lb">이번 사이클 고점</div><div class="vl">${f(L.cyclePeak.balJo)}<span class="u">조</span></div><div class="nt">${dtFull(L.cyclePeak.date)}</div></div>
  <div class="card"><div class="lb">고점 대비</div><div class="vl neg">${f(L.cycleDeclinePct, 1)}<span class="u">%</span></div><div class="nt">신용융자는 같은 기간 ${f(creditUnwindPct, 1)}%</div></div>
</div>

<figure>
  ${lendingChart(L.series, L.cyclePeak.date)}
  <div class="lg"><span><i class="sw cr"></i>대차잔고(좌, 조원)</span><span><i class="sw acc"></i>코스피(우, p)</span></div>
  <figcaption>2020년 이후. 잔고 고점은 이번 사이클 신용융자 고점(6/24)보다 9일 앞선 6/15이었다 —
  지수 고점(6/22)보다도 먼저 꺾였다.</figcaption>
</figure>

<div class="box">
  <b>대차잔고가 신용융자보다 훨씬 빠르게 풀렸다</b> — 잔고 고점(${dtFull(L.cyclePeak.date)}) 대비
  ${f(L.cycleDeclinePct, 1)}% 감소했는데, 같은 창에서 신용융자(전체)는 ${f(creditUnwindPct, 1)}%였다.
  대차거래는 공매도 외에 ETF 설정/환매, 차익거래, 배당락 대비 등 다른 용도로도 쓰이므로
  이 차이 전부가 숏커버링은 아니다 — 다만 방향은 일관되게 신용보다 훨씬 빠른 디레버리징을 가리킨다.
</div>

<div class="tables">
  <div><h4>잔고 고점 이후 하루 단위 지수·잔고 조합 (${total}일)</h4>
    <div class="tw"><table>
      <thead><tr><th>유형</th><th class="n">일수</th><th class="n">비중</th></tr></thead>
      <tbody>
        <tr><td>지수↑ 잔고↓ (숏커버형)</td><td class="n">${dc.coverType}</td><td class="n">${f(dc.coverType / total * 100, 0)}%</td></tr>
        <tr><td>지수↓ 잔고↓ (동반 청산)</td><td class="n">${dc.jointUnwind}</td><td class="n">${f(dc.jointUnwind / total * 100, 0)}%</td></tr>
        <tr><td>지수↓ 잔고↑ (신규 숏 추정)</td><td class="n">${dc.newShort}</td><td class="n">${f(dc.newShort / total * 100, 0)}%</td></tr>
        <tr><td>지수↑ 잔고↑</td><td class="n">${dc.riskOn}</td><td class="n">${f(dc.riskOn / total * 100, 0)}%</td></tr>
      </tbody>
    </table></div>
    <figcaption>대부분이 '동반 청산'이다 — 지수와 잔고가 같이 빠졌다. 숏이 밀리면서 지수를 떠받친
    전형적인 '숏커버링 랠리'는 아직 이 구간에서 뚜렷하게 나타나지 않았다.</figcaption></div>
  <div><h4>숏커버링 후보일 상위 ${L.candidates.length}일</h4>
    <div class="tw"><table>
      <thead><tr><th>일자</th><th class="n">지수</th><th class="n">등락</th><th class="n">잔고(조)</th><th class="n">잔고 증감</th></tr></thead>
      <tbody>${candRows}</tbody>
    </table></div>
    <figcaption>전부 6월 중(신용·지수 고점 이전)이다. 급락이 시작된 6/22 이후로는 지수 반등일에
    잔고가 같이 줄어든 날이 아직 뚜렷이 나타나지 않았다.</figcaption></div>
</div>

<div class="box warn">
  <b>"오늘 급등"은 이 데이터에 아직 없다</b> — FREESIS 공표 최신일(${dtFull(L.last.date)}) 기준 지수는
  여전히 하락 중이었다. 장중 급등은 EOD 공표 전이라 여기 반영되지 않는다.
  다음에 데이터가 갱신되면 이 표(하루 단위 조합·숏커버링 후보일)가 그 날을 자동으로 잡아낸다 —
  스크립트를 다시 돌리기만 하면 된다.
</div>
</section>`;
}

/* ---------- 숏커버 여력 (상승 압력) ---------- */

let coverSection = '';
if (A.lending?.cover) {
  const CV = A.lending.cover, L = A.lending;
  const rows = CV.benches.map(b => `<tr>
    <td>${esc(b.name)}</td><td class="n">${f(b.targetJo)}</td>
    <td class="n ${b.remainJo > 0 ? 'ok' : 'warn'}">${b.remainJo > 0 ? f(b.remainJo) : '소진'}</td>
    <td class="n">${b.equivDays != null ? f(b.equivDays, 2) + '배' : '–'}</td></tr>`).join('');

  const detail = CV.benches.map(b => `<div class="bench">
    <div class="bn">${esc(b.name)} <span class="bv ${b.remainJo > 0 ? '' : 'neg'}">잔여 커버 ${b.remainJo > 0 ? f(b.remainJo) + '조' : '이미 소진 (' + f(-b.remainJo) + '조 초과)'}</span></div>
    <div class="bb">${esc(b.basis)} → 목표 잔고 ${f(b.targetJo)}조</div>
    <div class="bc">단서 — ${esc(b.caveat)}</div>
  </div>`).join('');

  const positive = CV.benches.filter(b => b.remainJo > 0);

  coverSection = `<section>
<h2>숏커버 여력 — 앞으로 얼마나 더 되갚아져야 하는가</h2>
<p class="lead">대차잔고가 줄어든다는 것은 빌린 주식을 <b>사서 갚는다</b>는 뜻이다. 곧 매수 압력이다.
신용잔고 쪽에서 "얼마나 더 팔려야 하나"를 벤치마크 범위로 본 것과 같은 방식으로,
여기서는 "얼마나 더 사야 하나"를 본다. 벤치마크는 하나로 수렴하지 않으므로 점 추정이 아니라 범위다.</p>

<div class="cards">
  <div class="card"><div class="lb">고점 이후 이미 되갚음</div><div class="vl">${f(CV.coveredJo)}<span class="u">조</span></div><div class="nt">고점의 ${f(CV.coveredPctOfPeak, 1)}%</div></div>
  <div class="card"><div class="lb">= 하루 거래대금의</div><div class="vl">${f(CV.coveredEquivDays, 1)}<span class="u">배</span></div><div class="nt">최근 20일 평균 ${f(CV.dailyTurnoverJo)}조/일</div></div>
  <div class="card"><div class="lb">현재 잔고/시총</div><div class="vl">${f(CV.nowRatio)}<span class="u">%</span></div><div class="nt">이번 고점 ${f(CV.peakRatio)}%</div></div>
  <div class="card"><div class="lb">직전 사이클 저점 비율</div><div class="vl">${f(CV.prevTroughRatio)}<span class="u">%</span></div><div class="nt">${dtFull(CV.prevTrough.date)}</div></div>
</div>

<div class="range">
  <div class="rl">잔여 숏커버 추정 범위</div>
  <div class="rv">${CV.lowJo > 0 ? f(CV.lowJo) : '0'}조 ~ ${f(CV.highJo)}조</div>
  <div class="rn">음수 벤치마크(이미 소진)를 0으로 본 하한 ~ 최대 벤치마크 ·
    하루 평균 거래대금 ${f(CV.dailyTurnoverJo)}조 기준 ${CV.highJo > 0 ? f(CV.highJo / CV.dailyTurnoverJo, 1) : '0'}일치까지</div>
</div>

<div class="tables">
  <div><div class="tw"><table>
    <thead><tr><th>벤치마크</th><th class="n">목표 잔고(조)</th><th class="n">잔여 커버(조)</th><th class="n">일거래대금 대비</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>
  <div>${detail}</div>
</div>

<div class="box warn">
  <b>비율로 보면 되돌림은 이미 끝났다</b> — 대차잔고/시총은 현재 ${f(CV.nowRatio)}%로
  직전 사이클 저점 ${f(CV.prevTroughRatio)}%보다 <b>이미 낮다</b>.
  비율 기준 벤치마크 두 개가 모두 '소진'으로 나오는 이유다.
  ${positive.length ? `양(+)으로 남는 것은 ${positive.map(b => `<b>${esc(b.name)}</b>`).join(', ')}뿐이고,
  그중 절대 잔고 복귀는 시가총액이 그 사이 배로 커진 것을 무시하는 계산이라 상단 과대추정으로 봐야 한다.` : ''}
  §12 의 신용잔고 결론("2022년처럼 풀려야 한다는 전제가 이 사이클에는 그대로 적용되지 않는다")과
  <b>같은 구조의 결론</b>이다 — 양쪽 모두 직전 사이클 대비 정상화가 이미 상당히 진행됐다.
</div>

<div class="box">
  <b>이 숫자를 지수 상승폭으로 환산하지 않는다</b> — 매수 물량 몇 조가 지수 몇 %로 이어지는지는
  이 데이터로 알 수 없다. 거래대금 대비 배수(위 표 오른쪽 열)까지만 제시한다.
  §16.1 대로 대차잔고 감소 전부가 숏커버도 아니다 — ETF 환매·차익거래 청산도 같은 방향으로 잡힌다.
  고점 이후 하루 단위 조합에서 숏커버형(지수↑ 잔고↓)이 ${L.dayClass.coverType}일에 그친 것도 같은 이야기다.
</div>
</section>`;
}

/* ---------- 예탁금과 2차 레버리지 채널 ---------- */

let channelsSection = '';
if (A.channels) {
  const C = A.channels;
  const markRows = C.marks.map(m => `<tr>
    <td>${esc(m.label)}</td><td>${dtFull(m.date)}</td>
    <td class="n">${f(m.depositJo)}</td><td class="n">${f(m.creditJo)}</td>
    <td class="n">${f(m.pledgeJo)}</td><td class="n">${f(m.totalLevJo)}</td>
    <td class="n">${f(m.coverage)}</td></tr>`).join('');

  const peak26 = C.marks.find(m => m.label === '2026 신용 고점');
  const pledgeDeclinePct = peak26 && peak26.pledgeJo
    ? (C.last.pledgeJo / peak26.pledgeJo - 1) * 100 : null;
  const creditDeclinePct = peak26
    ? (C.last.creditJo / peak26.creditJo - 1) * 100 : null;
  const levDeclinePct = peak26
    ? (C.last.totalLevJo / peak26.totalLevJo - 1) * 100 : null;

  channelsSection = `<section>
<h2>예탁금과 2차 레버리지 채널</h2>
<p class="lead">여기까지의 분석은 <b>신용융자</b> 한 채널만 봤다. 그런데 개인 레버리지에는
<b>예탁증권담보융자</b>라는 두 번째 통로가 있고, 그 반대편에는 대기자금인 <b>투자자예탁금</b>이 있다.
셋을 같이 놓아야 "레버리지가 감당 가능한 수준인가"를 볼 수 있다. 셋 다 금투협이 일별로 공표한다.</p>

<div class="cards">
  <div class="card"><div class="lb">투자자예탁금</div><div class="vl">${f(C.last.depositJo)}<span class="u">조</span></div><div class="nt">${dtFull(C.last.date)}</div></div>
  <div class="card"><div class="lb">신용융자</div><div class="vl">${f(C.last.creditJo)}<span class="u">조</span></div><div class="nt">1차 레버리지</div></div>
  <div class="card"><div class="lb">예탁증권담보융자</div><div class="vl">${f(C.last.pledgeJo)}<span class="u">조</span></div><div class="nt">총 레버리지의 ${f(C.pledgeSharePct, 0)}%</div></div>
  <div class="card"><div class="lb">예탁금 커버리지</div><div class="vl">${f(C.last.coverage)}<span class="u">배</span></div><div class="nt">역대 ${f(C.pct, 0)}백분위</div></div>
</div>

<figure>
  <h4>세 계열의 추이 (조원)</h4>
  ${levelChart(C.series, [
    { key: 'dep', cls: 'ln-idx' }, { key: 'cr', cls: 'ln-cr' }, { key: 'pl', cls: 'ln-kq' },
  ], '조원')}
  <div class="lg"><span><i class="sw acc"></i>투자자예탁금</span><span><i class="sw cr"></i>신용융자</span><span><i class="sw kq"></i>예탁증권담보융자</span></div>
  <figcaption>예탁금은 신용융자의 3배 규모로 움직인다. 담보융자는 두 사이클 내내 거의 평평하다 —
  지수와 함께 늘었다 줄었다 하는 신용융자와 성격이 다르다.</figcaption>
</figure>

<div class="box warn">
  <b>디레버리징은 신용융자 채널에서만 일어났다</b> — 6/24 신용 고점 이후
  신용융자는 ${f(creditDeclinePct, 1)}% 줄었는데 예탁증권담보융자는 ${f(pledgeDeclinePct, 1)}%에 그쳤다.
  둘을 합친 총 레버리지로 보면 ${f(peak26?.totalLevJo)}조 → ${f(C.last.totalLevJo)}조, <b>${f(levDeclinePct, 1)}%</b>다.
  신용융자만 보면 청산이 상당히 진행된 것처럼 보이지만, 개인 레버리지 전체로는 그 절반 수준밖에 풀리지 않았다.
  담보융자는 담보유지비율 기준이 신용융자와 달라 같은 지수 하락에도 강제 청산이 늦게 걸린다 —
  §13의 마진콜 사다리는 이 ${f(C.last.pledgeJo)}조를 <b>세지 않는다</b>.
</div>

<figure>
  <h4>예탁금 커버리지 — 대기자금 ÷ 신용융자 (배)</h4>
  ${ratioChart(
    C.series.map(r => ({ date: r.d, ratio: r.cov })),
    C.marks.map(m => ({ date: m.date, ratio: m.coverage, label: m.label.replace(' 신용', '') })),
    '투자자예탁금 / 신용융자 (배)', '배', 2)}
  <figcaption>낮을수록 "빚 대비 실탄이 없다"는 뜻이다. 역대 최저는 ${f(C.covMin.coverage)}배(${dtFull(C.covMin.date)}),
  최고는 ${f(C.covMax.coverage)}배(${dtFull(C.covMax.date)}, 코로나 폭락 직후 현금이 몰린 시점)였다.</figcaption>
</figure>

<div class="tw"><table>
  <thead><tr><th>기준점</th><th>일자</th><th class="n">예탁금(조)</th><th class="n">신용융자(조)</th>
    <th class="n">담보융자(조)</th><th class="n">총 레버리지(조)</th><th class="n">커버리지(배)</th></tr></thead>
  <tbody>${markRows}</tbody>
</table></div>

<div class="box">
  <b>이 사이클은 2021년보다 실탄이 두껍다</b> — 커버리지는 2021년 신용 고점에서 ${f(C.marks.find(m => m.label === '2021 신용 고점')?.coverage)}배였는데
  이번 고점에서는 ${f(peak26?.coverage)}배였고 지금도 ${f(C.last.coverage)}배(역대 ${f(C.pct, 0)}백분위)다.
  §12의 "이번 사이클은 2021년만큼 과열된 적이 없다"는 신용/시총 비율 결론과 방향이 같다.
  다만 커버리지가 높다는 것이 <b>그 예탁금이 실제로 매수에 쓰인다</b>는 뜻은 아니다 — 대기자금은 관망 자금이기도 하다.
</div>
</section>`;
}

/* ---------- 미수금 -> 반대매매 전이 ---------- */

let unpaidSection = '';
if (A.unpaid) {
  const U = A.unpaid;
  const lagRows = U.full.map((s, i) => `<tr>
    <td class="n">${s.lag}일</td><td class="n">${f(s.r, 3)}</td>
    <td class="n">${f(U.recent[i]?.r, 3)}</td></tr>`).join('');
  const tailRows = U.tail.slice(-12).map(r => `<tr>
    <td>${dtFull(r.date)}</td><td class="n">${f(r.unpaid)}</td><td class="n">${f(r.forced, 3)}</td>
    <td class="n">${f(r.forced / r.unpaid * 100, 1)}%</td></tr>`).join('');

  unpaidSection = `<section>
<h2>미수금 → 반대매매 전이</h2>
<p class="lead"><b>위탁매매미수금</b>은 결제하지 못한 외상 매수다. 결제일(D+2)까지 채우지 못하면
증권사가 <b>반대매매</b>로 처분한다. 기계적으로는 미수금이 반대매매의 선행지표여야 하고 시차는 영업일 2일이어야 한다.
실제 데이터에서 그 시차가 나오는지 확인했다.</p>

<div class="tables">
  <div><h4>미수금[t] vs 반대매매[t+시차] 상관계수</h4>
    <div class="tw"><table>
      <thead><tr><th class="n">시차</th><th class="n">전 구간(2010~)</th><th class="n">2025년 이후</th></tr></thead>
      <tbody>${lagRows}</tbody>
    </table></div>
    <figcaption>상관은 <b>시차 0일</b>에서 가장 높다. D+2 규칙과 어긋나 보이지만,
    금투협이 두 계열을 같은 <b>공표일</b> 기준으로 싣기 때문으로 읽는 것이 자연스럽다 —
    미수금 잔고와 그에 대한 반대매매가 같은 날짜 라벨에 붙는다. 즉 이 데이터로는
    "미수금을 보고 이틀 뒤 반대매매를 예측"할 수 없고, 둘은 같은 날의 동시 지표다.
    전 구간 상관이 ${f(U.full[0].r, 2)}로 낮은 것은 국면마다 규모가 달라서이고,
    최근 구간(2025~)만 보면 ${f(U.recent[0].r, 2)}로 뚜렷하다.</figcaption></div>
  <div><h4>최근 12영업일</h4>
    <div class="tw"><table>
      <thead><tr><th>일자</th><th class="n">미수금(조)</th><th class="n">반대매매(조)</th><th class="n">전이율</th></tr></thead>
      <tbody>${tailRows}</tbody>
    </table></div>
    <figcaption>전이율 중앙값은 <b>${f(U.medianTransfer * 100, 1)}%</b>다 — 미수금 대부분은 반대매매까지 가지 않고 결제된다.</figcaption></div>
</div>

<div class="box">
  <b>지금 미수금은 경보 수준이 아니다</b> — ${dtFull(U.last.date)} 기준 ${f(U.last.unpaid)}조로,
  최근 60일 평균 ${f(U.avg60)}조의 ${f(U.last.unpaid / U.avg60 * 100, 0)}%다.
  역대 최대는 ${f(U.topUnpaid[0].unpaid)}조(${dtFull(U.topUnpaid[0].date)})였다.
  중앙값 전이율을 그대로 적용하면 여기서 나올 반대매매는 ${f(U.impliedForcedJo, 3)}조 수준으로,
  실제 당일 값 ${f(U.last.forced, 3)}조와 같은 자릿수다.
  <br>다만 이것은 <b>미수거래</b>에 대한 반대매매다. 신용융자 반대매매는 공표되지 않는다(§7.4) —
  이 절의 숫자는 앞의 추정치를 검증하지 않는다.
</div>
</section>`;
}

/* ---------- 전망 섹션 ---------- */

const PJ = A.projection;
let projSection = '';
if (PJ) {
  const rows = PJ.benches.map(b => `<tr>
    <td>${esc(b.name)}</td>
    <td class="n">${f(b.totalJo)}</td>
    <td class="n ${b.remainJo > 0 ? 'neg' : 'ok'}">${b.remainJo > 0 ? f(b.remainJo) : '충족'}</td></tr>`).join('');

  const detail = PJ.benches.map(b => `<div class="bench">
    <div class="bn">${esc(b.name)} <span class="bv ${b.remainJo > 0 ? 'neg' : ''}">잔여 ${b.remainJo > 0 ? f(b.remainJo) + '조' : '이미 충족 (' + f(-b.remainJo) + '조 초과)'}</span></div>
    <div class="bb">${esc(b.basis)}</div>
    <div class="bc">단서 — ${esc(b.caveat)}</div>
  </div>`).join('');

  const scenRows = PJ.scenarioRemain.map(s => `<tr>
    <td class="n">${k0(s.idx)}</td><td class="n">${f(s.exposureJo)}</td>
    <td class="n">${s.extraJo > 0.005 ? '+' + f(s.extraJo) : '–'}</td></tr>`).join('');

  projSection = `<section>
<h2>앞으로 얼마나 더 청산되어야 하는가</h2>
<p class="lead">근거가 서로 다른 벤치마크 네 개를 놓는다. 하나로 수렴하지 않으므로 점 추정이 아니라 범위로 본다.
이미 청산된 양은 ${f(PJ.doneJo)}조(신용 고점 ${f(PJ.peakJo)}조의 ${f(PJ.doneJo / PJ.peakJo * 100, 1)}%)다.</p>

<div class="range">
  <div class="rl">잔여 청산 추정 범위</div>
  <div class="rv">${PJ.lowJo > 0 ? f(PJ.lowJo) : '0'}조 ~ ${f(PJ.highJo)}조</div>
  <div class="rn">음수 벤치마크(이미 충족)를 0으로 본 하한 ~ 최대 벤치마크</div>
</div>

<div class="tables">
  <div><div class="tw"><table>
    <thead><tr><th>벤치마크</th><th class="n">총 청산(조)</th><th class="n">잔여(조)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <h4 style="margin-top:16px">추가 하락 시 새로 열리는 물량(보정)</h4>
  <div class="tw"><table>
    <thead><tr><th class="n">코스피(p)</th><th class="n">누적 노출(조)</th><th class="n">현재 대비 증가</th></tr></thead>
    <tbody>${scenRows}</tbody>
  </table></div></div>
  <div>${detail}</div>
</div>

<figure>
  <h4>신용융자 / 시가총액 — 레버리지 강도</h4>
  ${ratioChart(A.ratio, [
    PJ.prevPeakRatio && { ...PJ.prevPeakRatio, label: '21 고점' },
    PJ.prevTroughRatio && { ...PJ.prevTroughRatio, label: '23 저점' },
    PJ.peakRatio && { ...PJ.peakRatio, label: '26 고점' },
    PJ.currentRatio && { ...PJ.currentRatio, label: '현재' },
  ])}
  <figcaption>시가총액은 코스피+코스닥 합계. 현 사이클의 레버리지 강도는 신용 고점에서도
  ${f(PJ.peakRatio?.ratio, 3)}%로 2021년 고점 ${f(PJ.prevPeakRatio?.ratio, 3)}%의 절반 수준이었다.
  지금 ${f(PJ.currentRatio?.ratio, 3)}%로 올라온 것은 신용이 늘어서가 아니라 시가총액이 더 빨리 줄었기 때문이다.</figcaption>
</figure>

<div class="box">
  <b>범위가 넓은 이유</b> — 위쪽 두 벤치마크는 직전 사이클과 <b>레버리지 강도가 같다</b>고 가정한다.
  아래쪽 두 개는 그 가정을 쓰지 않는다. 신용/시총 비율로 보면 현 사이클은 2021년만큼 과열된 적이 없고,
  현재 비율 ${f(PJ.currentRatio?.ratio, 3)}%는 이미 2023년 저점 ${f(PJ.prevTroughRatio?.ratio, 3)}%보다 낮다.
  즉 "2022년처럼 풀려야 한다"는 전제 자체가 이 사이클에는 그대로 적용되지 않는다.
</div>
<div class="box warn">
  <b>남은 위험은 지수 경로에 달려 있다</b> — 마진콜 모델 기준으로 현재 지수에서는 추가 노출이 열리지 않는다.
  코스피가 5,000p까지 더 내려가면 ${f(PJ.scenarioRemain.find(s => s.idx <= 5000)?.extraJo ?? 0)}조,
  4,500p에서는 ${f(PJ.scenarioRemain.find(s => s.idx <= 4500)?.extraJo ?? 0)}조가 새로 마진콜 구간에 들어온다.
  잔여 청산의 대부분은 시간이 아니라 <b>추가 하락 여부</b>가 결정한다.
</div>
</section>`;
}

/* ---------- 핵심 요약 (implications) ---------- */
// 리포트 맨 위. 차트를 하나도 안 보고도 결론을 가져갈 수 있어야 한다.
// 숫자는 전부 analysis.json 에서 끌어온다 — 본문과 어긋날 여지를 두지 않는다.

let summarySection = '';
if (co && PJ) {
  const b = co.headline;
  const CH = A.channels, CV = A.lending?.cover;
  const peak26 = CH?.marks.find(m => m.label === '2026 신용 고점');
  const p21 = CH?.marks.find(m => m.label === '2021 신용 고점');
  const levDeclinePct = peak26 ? (CH.last.totalLevJo / peak26.totalLevJo - 1) * 100 : null;
  const creditDeclinePct = peak26 ? (CH.last.creditJo / peak26.creditJo - 1) * 100 : null;
  const at5000 = PJ.scenarioRemain.find(s => s.idx <= 5000)?.extraJo ?? 0;
  const baseRatioBench = CV?.benches.find(x => x.key === 'baseRatio');

  const li = (head, body) => `<li><b>${head}</b> — ${body}</li>`;

  const downList = [
    li(`지수는 ${f(b.idxDrawdownPct, 1)}% 빠졌는데 신용은 ${f(b.unwindPct, 1)}%만 청산됐다`,
      `겉보기로는 잔여가 크다. 2021 사이클 청산률(${f(ca.headline.unwindPct, 1)}%)을 그대로 대입하면 ${f(PJ.benches.find(x => x.key === 'unwindRate')?.remainJo)}조가 더 남는다.`),
    li('그런데 레버리지 강도가 그때와 다르다',
      `신용/시총은 현재 <b>${f(PJ.currentRatio?.ratio, 3)}%</b>로 <b>2023년 저점 ${f(PJ.prevTroughRatio?.ratio, 3)}%보다 이미 낮다</b>.
       "2022년처럼 풀려야 한다"는 전제 자체가 이 사이클에는 그대로 적용되지 않는다.`),
    li('남은 위험은 시간이 아니라 지수 경로다',
      `마진콜 모델 기준 현재 지수에서 새로 열리는 물량은 없다. 코스피가 5,000p 밑으로 마감해야 +${f(at5000)}조가 새로 마진콜 구간에 들어온다.`),
    CH ? li(`사각지대 — 사다리가 안 세는 레버리지 ${f(CH.last.pledgeJo)}조`,
      `예탁증권담보융자는 청산 트리거가 공표되지 않아 마진콜 모델에서 빠져 있다.
       신용융자만 ${f(creditDeclinePct, 1)}% 풀렸고, 둘을 합친 총 레버리지는 <b>${f(levDeclinePct, 1)}%</b>만 줄었다.`) : '',
    CH ? li('대신 실탄은 2021년보다 두껍다',
      `예탁금 커버리지 ${f(CH.last.coverage)}배(역대 ${f(CH.pct, 0)}백분위). 2021년 신용 고점 당시 ${f(p21?.coverage)}배였다.`) : '',
  ].filter(Boolean).join('');

  const upList = CV ? [
    li(`이미 ${f(CV.coveredJo)}조가 되갚아졌다`,
      `대차잔고 고점의 ${f(CV.coveredPctOfPeak, 1)}%. 오늘 하루 거래대금의 ${f(CV.coveredEquivDays, 1)}배에 해당하는 매수가 이미 지나갔다.`),
    li('비율로 보면 되돌림은 이미 끝났다',
      `대차잔고/시총 <b>${f(CV.nowRatio)}%</b>는 직전 사이클 저점 <b>${f(CV.prevTroughRatio)}%</b>보다 낮다.
       비율 기준 벤치마크 두 개가 모두 '소진'으로 나온다.`),
    baseRatioBench ? li(`현실적 상단은 ${f(baseRatioBench.remainJo)}조`,
      `시총 성장을 감안한 복귀 목표 기준. 하루 거래대금의 ${f(baseRatioBench.equivDays, 2)}배 규모다.
       절대 잔고 복귀(${f(CV.benches.find(x => x.key === 'cycleBase')?.remainJo)}조)는 시총이 그 사이 배로 커진 것을 무시하는 계산이라 과대추정이다.`) : '',
    li('아직 숏커버 랠리는 아니다',
      `잔고 고점 이후 숏커버형(지수↑ 잔고↓) 날은 ${A.lending.dayClass.coverType}일뿐이고 전부 급락 시작 전이다. 나머지는 지수·잔고 동반 청산이었다.`),
    li('지수 상승폭으로 환산하지 않는다',
      '매수 물량 몇 조가 지수 몇 %가 되는지는 이 데이터로 알 수 없다. 대차잔고 감소 전부가 숏커버도 아니다(ETF 환매·차익거래 포함).'),
  ].filter(Boolean).join('') : '';

  // 전일 대비 변화 스트립 + 계열별 최신 관측일. 매일 열어보는 리포트라면 여기가 첫 화면이다.
  const D = A.daily;
  // 각 지표는 <details> 다. 눌러야 1년 추세가 펼쳐진다 — 브라우저 기본 기능이라
  // 스크립트가 없고, 인쇄하면 접힌 것도 함께 나온다.
  const deltaStrip = D ? `<div class="deltas">
  ${D.items.map(it => {
    const up = it.delta >= 0;
    const dg = 2;
    const s = it.series ?? [];
    const yr = s.length > 1 ? (it.value / s[0].v - 1) * 100 : null;
    const head = `<div class="dl">${esc(it.label)}${it.live ? '<i class="live">장중</i>' : ''}</div>
      <div class="dv">${f(it.value, dg)}<span class="u">${esc(it.unit)}</span></div>
      <div class="dd ${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} ${f(Math.abs(it.delta), dg)} (${up ? '+' : '-'}${f(Math.abs(it.pct), 2)}%)</div>
      <div class="dt">${dtFull(it.date)}${it.source ? ` · ${esc(it.source)}` : ''}</div>`;
    if (s.length < 2) return `<div class="dcell">${head}</div>`;
    return `<details class="dcell">
      <summary>${head}<span class="more">1년 추세 ${yr >= 0 ? '+' : ''}${f(yr, 1)}% ▾</span></summary>
      <div class="trend">${trendChart(s, `${esc(it.label)} (${esc(it.unit)})`, dg)}</div>
    </details>`;
  }).join('')}
</div>
<div class="fresh">데이터 최신일 —
  ${D.freshness.map(x => `<span><b>${esc(x.label)}</b> ${dtFull(x.date)}${x.live ? ' <i>(장중 갱신)</i>' : ''}</span>`).join('')}
  <span class="fn">계열마다 공표 시차가 다르다: 지수 T+1, 신용융자는 결제일 기준이라 하루 더 늦다.</span>
</div>` : '';

  // 매일 확인할 지표 하나. AUM 은 가격이 섞여 수급이 정리됐는지를 못 알려준다 —
  // 좌수가 꺾이는 날이 진짜 디레버리징의 시작이라, 첫 화면에 고정으로 올린다(§23.2).
  const U = A.etf?.unitsTrend?.single ?? null;
  const VERD = {
    building: { label: '아직 쌓이는 중', cls: 'w-build', line: '좌수가 계속 늘고 있다. 디레버리징은 시작되지 않았다.' },
    flat: { label: '정체 — 꺾이는 길목', cls: 'w-flat', line: '증가가 멈췄다. 감소로 넘어가는지 며칠 더 봐야 한다.' },
    rolling: { label: '꺾였다', cls: 'w-roll', line: '좌수가 실제로 줄기 시작했다. 여기서부터가 진짜 환매다.' },
    unknown: { label: '판정 불가', cls: 'w-flat', line: '표본이 모자란다.' },
  };
  const watchBox = !U ? '' : (() => {
    const v = VERD[U.verdict];
    const sub = [['samsung', '삼성전자'], ['hynix', 'SK하이닉스'], ['sector', '반도체 섹터']]
      .map(([k, name]) => {
        const t = A.etf.unitsTrend[k];
        if (!t) return '';
        return `<div class="wsub"><b>${esc(name)}</b> ${f(t.last.unitsM, 0)}백만좌
          <span class="${t.d5 >= 0 ? 'up' : 'dn'}">5일 ${t.d5 >= 0 ? '+' : ''}${f(t.d5, 1)}%</span>
          <span class="mut">고점대비 ${f(t.fromPeakPct, 1)}%</span></div>`;
      }).join('');
    return `<div class="watch ${v.cls}">
  <div class="wl">매일 볼 것 · 단일종목 레버리지 ETF 상장좌수</div>
  <div class="wmain">
    <div class="wv">${f(U.last.unitsM, 0)}<span class="u">백만좌</span></div>
    <div class="wtag">${esc(v.label)}</div>
  </div>
  <div class="wnums">
    <span>전일 <b class="${U.d1 >= 0 ? 'up' : 'dn'}">${U.d1 >= 0 ? '+' : ''}${f(U.d1, 1)}%</b></span>
    <span>5일 <b class="${U.d5 >= 0 ? 'up' : 'dn'}">${U.d5 >= 0 ? '+' : ''}${f(U.d5, 1)}%</b></span>
    <span>10일 <b class="${U.d10 >= 0 ? 'up' : 'dn'}">${U.d10 >= 0 ? '+' : ''}${f(U.d10, 1)}%</b></span>
    <span>최대 대비 <b>${f(U.fromPeakPct, 1)}%</b> <span class="mut">(${dtFull(U.peak.d)}, ${U.daysSincePeak}거래일 전)</span></span>
    <span>연속 감소 <b>${U.downStreak}일</b></span>
  </div>
  <div class="wline">${esc(v.line)} AUM 은 가격이 섞여 있어 이 판정에 쓸 수 없다 — 좌수로만 본다.</div>
  <div class="wtrend">${trendChart(U.series.map(r => ({ d: r.d, v: r.unitsM })),
    '단일종목 레버리지 ETF 상장좌수 (백만좌)', 0, `상장(${dtFull(U.series[0].d)}) 이후`)}</div>
  ${sub}
</div>`;
  })();

  summarySection = `<section class="summary">
<h2>핵심 요약</h2>
<p class="lead">차트를 하나도 보지 않고도 가져갈 수 있는 결론만 모았다. 숫자는 본문과 같은 계산에서 나온다.</p>

${watchBox}

${deltaStrip}

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">양방향 모두 <b>직전 사이클 기준으로는 정상화가 이미 상당히 진행</b>됐다.
    신용/시총도, 대차잔고/시총도 직전 사이클 저점보다 낮다.
    남은 하락 위험과 남은 상승 여력 둘 다 "시간이 지나면 나올 물량"이 아니라 <b>지수가 어디로 가느냐</b>에 달려 있다.</div>
</div>

<div class="tables">
  <div class="sumcol c-down">
    <h4><span class="pill pd">PART 1</span> 얼마나 더 하락할 수 있나 — 신용잔고</h4>
    <ul class="find">${downList}</ul>
  </div>
  ${upList ? `<div class="sumcol c-up">
    <h4><span class="pill pu">PART 2</span> 얼마나 더 상승할 수 있나 — 공매도·숏커버링</h4>
    <ul class="find">${upList}</ul>
  </div>` : ''}
</div>

${A.spot ? `<div class="box warn">
  <b>반등은 이미 터진 물량을 되돌리지 않는다</b> — FREESIS 최종 공표일 ${dtFull(A.spot.baseDate)} ${k0(A.spot.baseIdx)}p 대비
  ${dtFull(A.spot.date)} ${k0(A.spot.idx)}p(${A.spot.changePct >= 0 ? '+' : ''}${f(A.spot.changePct, 2)}%).
  마진콜 판정은 그날까지의 <b>최저 지수</b> 기준이라, 지수가 되돌아와도 이미 청산된 신용은 돌아오지 않는다.
  반등이 막는 것은 <b>추가</b> 청산뿐이다.
</div>` : ''}

<p class="lead" style="margin-top:14px">아래 탭에서 각 결론의 계산 근거를 볼 수 있다.
전제·한계는 <code>docs/methodology.md</code> §1~20에 전부 적어 두었다.</p>
</section>`;
}

/* ---------- PART 3 레버리지 ETF 수급 ---------- */
// PART 1·2 는 잔고를 본다. PART 3 은 매일 강제로 나가는 매매를 본다 —
// 레버리지 ETF 는 잔고가 그대로여도 기초자산이 움직이면 그날 안에 사거나 판다(§23).
const etfSection = !A.etf ? '' : (() => {
  const E = A.etf;
  const cps = E.checkpoints.map(c => c.date);
  const lab = d => E.checkpointLabels?.[d] ?? dtFull(d);
  const sgn = (n, d = 1) => (n == null || !Number.isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}`);
  const single = E.groups.find(g => g.key === 'single_lev');
  const sectorG = E.groups.find(g => g.key === 'sector_lev');

  // 한 줄 판정은 좌수로 낸다 — AUM 이 줄어도 좌수가 늘었으면 물량은 남아 있는 것이다.
  const unitsFirst = single?.sums[0]?.units ?? 0;
  const unitsLast = single?.sums.at(-1)?.units ?? 0;
  const unitsMult = unitsFirst > 0 ? unitsLast / unitsFirst : null;
  const sectorFirst = sectorG?.sums[0]?.units ?? 0;
  const sectorLast = sectorG?.sums.at(-1)?.units ?? 0;

  const groupRows = E.groups.filter(g => g.count).map(g => `<tr>
    <td>${esc(g.label)} <span class="mut">(${g.count}종)</span></td>
    ${g.sums.map(s => `<td class="n">${f(s.aumJo)}</td>`).join('')}
    <td class="n">${sgn(g.sums[0].units > 0 ? (g.sums.at(-1).units / g.sums[0].units - 1) * 100 : null, 0)}%</td>
  </tr>`).join('');

  const fundRows = E.perFund
    .filter(x => x.group === 'single_lev' || x.group === 'single_inv')
    .sort((a, b) => (b.snaps.at(-1).aumJo ?? 0) - (a.snaps.at(-1).aumJo ?? 0))
    .map(x => `<tr>
      <td>${esc(x.name)}</td>
      <td class="n">${x.lev > 0 ? '2X' : '-2X'}</td>
      ${x.snaps.map(s => `<td class="n">${s.units == null ? '-' : f(s.units / 1e6, 1)}</td>`).join('')}
      <td class="n">${f(x.snaps.at(-1).aumJo)}</td>
      <td class="n">${x.full ? sgn(x.full.unitsPct, 0) + '%' : '-'}</td>
      <td class="n">${x.full ? sgn(x.full.pricePct, 0) + '%' : '-'}</td>
      <td class="n">${x.full ? sgn(x.full.aumPct, 0) + '%' : '-'}</td>
    </tr>`).join('');

  const stockBlocks = Object.values(E.stockDaily).map(s => {
    const rows = s.series.slice(-12).reverse().map(r => `<tr>
      <td>${dtFull(r.d)}</td>
      <td class="n">${sgn(r.ret, 1)}%</td>
      <td class="n">${sgn(r.flowJo, 2)}조</td>
      <td class="n">${f(r.flowPctTurnover, 1)}%</td>
      <td class="n">${f(r.amplitude, 1)}%</td>
      <td class="n">${sgn(r.idxContribPct, 2)}%p</td>
    </tr>`).join('');
    const t = s.test;
    return `<h3>${esc(s.name)} — 단일종목 ETF ${s.funds.length}종</h3>
<p class="lead">필요 매매액 = 계수 × 직전 AUM × 그날 수익률. 2X 는 계수 2, −2X 는 6이다.
  아래는 최근 12거래일이다.</p>
<div class="tw"><table>
  <thead><tr><th>일자</th><th class="n">종목 등락</th><th class="n">리밸런싱 필요액</th>
    <th class="n">그날 거래대금 대비</th><th class="n">일중 진폭</th><th class="n">코스피 기여</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<div class="box">리밸런싱 수요 상위 ${t.topN}일의 평균 일중 진폭 <b>${f(t.topMeanAmplitude, 1)}%</b>,
  나머지 ${f(t.restMeanAmplitude, 1)}%. 상관계수 r=${f(t.corrFlowAmplitude, 2)}.
  ${Math.abs(t.corrFlowAmplitude ?? 0) < 0.35
    ? '방향은 맞지만 상관은 약하다 — 리밸런싱이 유일한 원인이라고 말할 수 있는 수준이 아니다.'
    : '리밸런싱이 큰 날 실제로 더 출렁였다.'}</div>
${!s.eras ? '' : `<div class="box"><b>반증 — ETF가 없던 시절과 비교</b>:
  평균 일중 진폭이 2025년 <b>${f(s.eras.before2025.meanAmplitude, 1)}%</b>(${s.eras.before2025.days}일) →
  2026년 상장 전 <b>${f(s.eras.before2026.meanAmplitude, 1)}%</b>(${s.eras.before2026.days}일) →
  상장 후 <b>${f(s.eras.after.meanAmplitude, 1)}%</b>(${s.eras.after.days}일).
  변동성 상승은 <b>단일종목 ETF 상장 전에 이미 시작됐다.</b> 상장 후 다시
  ${f((s.eras.after.meanAmplitude / s.eras.before2026.meanAmplitude - 1) * 100, 0)}% 더 커진 건 사실이지만,
  ETF가 유일한 원인이라고는 이 데이터로 말할 수 없다.</div>`}`;
  }).join('\n');

  const contribRows = [...E.indexContrib]
    .sort((a, b) => Math.abs(b.contribPct) - Math.abs(a.contribPct)).slice(0, 10)
    .map(r => `<tr>
      <td>${dtFull(r.d)}</td>
      <td class="n">${sgn(r.idxRet, 2)}%</td>
      <td class="n">${sgn(r.contribPct, 2)}%p</td>
      <td class="n">${f(r.sharePct, 0)}%</td>
      <td class="n">${sgn(r.flowJo, 2)}조</td>
    </tr>`).join('');

  const hkRows = !E.hk ? '' : E.hk.products.map(p => `<tr>
    <td>${esc(p.ticker)}</td>
    <td>${esc(p.name)}</td>
    <td class="n">${p.lev > 0 ? '2X' : '-2X'}</td>
    <td class="n">${f(p.totalNavUsd / 1e9)}</td>
    <td class="n">${f(p.outstandingUnits / 1e6, 1)}</td>
    <td class="n">${f(p.notionalUsd / 1e9)}</td>
  </tr>`).join('');

  // 전체 레버리지 ETF 시장이 어떻게 부풀었다 꺼졌는지 한 장으로. 그룹을 쌓아 합계를 보여준다.
  const T = E.aumTotal;
  const stackKeys = [
    { key: 'single_lev', label: '단일종목 레버리지 2X', color: 'var(--lv)', op: 0.9 },
    { key: 'sector_lev', label: '반도체·IT 섹터 레버리지', color: 'var(--cr)', op: 0.75 },
    { key: 'index_lev', label: '지수 레버리지', color: 'var(--acc)', op: 0.6 },
    { key: 'single_inv', label: '단일종목 인버스 2X', color: 'var(--part)', op: 0.9 },
    { key: 'index_inv', label: '지수 인버스 2X', color: 'var(--bar)', op: 0.7 },
  ].filter(k => E.groups.some(g => g.key === k.key && g.count));
  const firstSingle = E.perFund.find(x => x.group === 'single_lev')?.listedFrom ?? null;
  const totalBlock = !T ? '' : `
<figure class="wide">
  <h4>레버리지 ETF 합계 AUM — 전체 추이</h4>
  ${stackChart(E.aumDaily, stackKeys, '국내 상장 레버리지·인버스 ETF 합계 순자산 (조원, 상장좌수 × 종가)',
    [firstSingle ? { d: firstSingle, label: '단일종목 상장' } : null].filter(Boolean))}
  <div class="lg">${stackKeys.map(k => `<span><i class="sw" style="background:${k.color}"></i>${esc(k.label)}</span>`).join('')}</div>
  <figcaption>
    합계 <b>${f(T.last.total)}조</b> (${dtFull(T.last.d)}) · 고점 ${f(T.peak.total)}조(${dtFull(T.peak.d)}) 대비 <b>${f(T.fromPeakPct, 1)}%</b> ·
    전일 ${T.d1 >= 0 ? '+' : ''}${f(T.d1, 1)}% / 5일 ${T.d5 >= 0 ? '+' : ''}${f(T.d5, 1)}% / 20일 ${T.d20 >= 0 ? '+' : ''}${f(T.d20, 1)}%.
    좌수가 아니라 AUM 으로 쌓았다 — 상품마다 1좌 가격이 달라 좌수는 더할 수 없다.
    <b>이 그림에서 줄어든 높이의 대부분은 환매가 아니라 가격이다</b>(아래 분해 참조).
  </figcaption>
</figure>`;

  return `<section>
<h2>지수대별이 아니라 매일 — 레버리지 ETF 수급</h2>
<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">삼성전자·SK하이닉스 <b>단일종목 레버리지 ETF는 정리되지 않았다</b>.
    ${lab(cps[0])}(${dtFull(cps[0])}) 대비 ${lab(cps.at(-1))} 상장좌수가
    <b>${f(unitsMult, 1)}배</b>로 늘었다. AUM이 줄어든 구간이 있어도 그건 환매가 아니라 가격이 빠진 것이다.
    반대로 <b>반도체 섹터 레버리지는 좌수가 ${sgn(sectorFirst > 0 ? (sectorLast / sectorFirst - 1) * 100 : null, 0)}%</b>로
    실제 환매가 일어났다 — 같은 '레버리지'라도 두 계열이 정반대로 움직였다.</div>
</div>

${totalBlock}

<h3>그룹별 AUM (조원, 상장좌수 × 종가)</h3>
<div class="tw"><table>
  <thead><tr><th>그룹</th>${cps.map(d => `<th class="n">${lab(d)}<br><span class="mut">${dtFull(d)}</span></th>`).join('')}<th class="n">좌수 변화</th></tr></thead>
  <tbody>${groupRows}</tbody>
</table></div>
<div class="box">단일종목 레버리지 ETF는 <b>${dtFull(E.perFund.find(x => x.group === 'single_lev')?.listedFrom ?? cps[0])} 상장</b>으로
  카테고리 자체가 두 달밖에 안 됐다. 그 사이에 ${f(single?.sums[0].aumJo)}조 → ${f(single?.sums.at(-1).aumJo)}조가 됐고,
  중간 고점은 ${f(Math.max(...(single?.sums.map(s => s.aumJo) ?? [0])))}조였다.</div>

<h3>단일종목 ETF 상세 — 좌수(백만좌)와 AUM 분해</h3>
<div class="tw"><table>
  <thead><tr><th>종목</th><th class="n">배수</th>${cps.map(d => `<th class="n">${lab(d)}</th>`).join('')}
    <th class="n">현재 AUM(조)</th><th class="n">유출입</th><th class="n">가격</th><th class="n">AUM</th></tr></thead>
  <tbody>${fundRows}</tbody>
</table></div>
<div class="box">AUM = 좌수 × 가격이라 로그로 보면 정확히 갈린다: <b>Δln AUM = Δln 좌수 + Δln 가격</b>.
  유출입(좌수)이 플러스인데 AUM이 덜 늘었다면 가격이 그만큼 깎아먹은 것이다.</div>

${stockBlocks}

<h3>코스피 등락 중 두 종목이 설명하는 몫</h3>
<p class="lead">비중 × 수익률의 산술 분해다. 가격충격 계수를 추정한 값이 아니다 —
  PART 2에서 숏커버를 지수 상승폭으로 환산하지 않은 것과 같은 이유다.</p>
<div class="tw"><table>
  <thead><tr><th>일자</th><th class="n">코스피</th><th class="n">두 종목 기여</th><th class="n">설명 비중</th><th class="n">두 종목 리밸 합계</th></tr></thead>
  <tbody>${contribRows}</tbody>
</table></div>

${E.hk ? `<h3>홍콩 CSOP 단일종목 L&amp;I (${dtFull(E.hk.asOf)} 기준)</h3>
<div class="tw"><table>
  <thead><tr><th>코드</th><th>상품</th><th class="n">배수</th><th class="n">순자산(US$bn)</th>
    <th class="n">좌수(백만)</th><th class="n">명목 익스포저(US$bn)</th></tr></thead>
  <tbody>${hkRows}</tbody>
</table></div>
<div class="box warn">홍콩분은 이제 <b>매일 자동 수집</b>된다(운용사 내부 API, §23.6). 다만 과거를 주는
  API 가 없어 좌수 히스토리는 <b>수집을 시작한 2026-08-02 이후부터만</b> 쌓인다(<code>data/csop-daily.json</code>).
  추이를 말할 만큼 쌓이기 전까지는 시점 비교와 일별 리밸런싱 계산에서 <b>제외</b>한다 —
  위 표는 규모 비교용이고, 국내 리밸런싱 수치는 그만큼 <b>과소</b>다.</div>` : ''}

<div class="box warn"><b>한계</b> — 대차거래·신용융자와 달리 이 계산에는 공표된 강제 청산 규칙이 없다.
  리밸런싱 필요액은 상품 설계상 <b>반드시 나가야 하는 매매</b>지만, 실제 체결 시각·분할 여부·스왑 상대방의
  헤지 방식은 공개되지 않는다. 또 AUM은 NAV가 아니라 <b>종가 × 좌수</b>로 계산했다(일별 NAV 소스 없음).
  괴리율만큼 오차가 있다.</div>
</section>`;
})();

/* ---------- PART 4 다음 주 수급 전망 ---------- */
// 방향을 맞히려는 게 아니다. 지수가 어디로 가면 어떤 물량이 기계적으로 따라 나오는지를
// 미리 적어 두고, 다음 주에 실제 움직임과 대조해 수급이 원인이었는지 판정하려는 것이다.
const outlookSection = !A.outlook ? '' : (() => {
  const O = A.outlook;
  const sgn = (n, d = 1) => (n == null || !Number.isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}`);

  const scenRows = O.scenarios.map(s => `<tr${Math.abs(s.retPct) === 1 ? ' class="dim"' : ''}>
    <td class="n">${sgn(s.retPct, 0)}%</td>
    <td class="n">${k0(s.idxLevel)}p</td>
    <td class="n ${s.flowJo >= 0 ? 'up' : 'dn'}">${s.flowJo >= 0 ? '순매수' : '순매도'} ${f(Math.abs(s.flowJo))}조</td>
    <td class="n">${f(s.pctOfTurnover, 1)}%</td>
  </tr>`).join('');

  const ladderRows = O.ladder.slice(0, 6).map(r => `<tr>
    <td class="n">${k0(r.threshold)}p</td>
    <td class="n">${f(r.gapPct, 1)}%</td>
    <td class="n">+${f(r.incrementalJo)}조</td>
    <td class="n">${f(r.cumulativeJo)}조</td>
  </tr>`).join('');

  const baseRows = O.baseRates.map(b => `<tr${b.n < 10 ? ' class="dim"' : ''}>
    <td>${esc(b.label)}</td>
    <td class="n">${b.n}</td>
    <td class="n">${sgn(b.median, 1)}%</td>
    <td class="n">${f(b.upRate, 0)}%</td>
    <td class="n">${sgn(b.p25, 1)} ~ ${sgn(b.p75, 1)}%</td>
  </tr>`).join('');

  const eventRows = O.events.map(e => `<tr>
    <td class="n">${dtFull(e.date)}</td>
    <td>${esc(e.label)}</td>
    <td>${esc(e.detail)}</td>
  </tr>`).join('');

  const anchorRows = !O.anchors ? '' : O.anchors.items.map(it => {
    const src = O.anchors.sources.find(s => s.key === it.src);
    return `<tr>
      <td>${esc(src ? src.house : it.src)}<br><span class="mut">${src ? dtFull(src.date) : ''}</span></td>
      <td>${esc(it.metric)}</td>
      <td>${esc(it.value)}</td>
      <td class="mut">${esc(it.note ?? '')}</td>
    </tr>`;
  }).join('');

  const short = O.short;
  const ft = O.firstTrigger;

  return `<section>
<h2>다음 주 수급 전망 — 지수가 어디로 가면 무엇이 따라 나오나</h2>
<div class="box warn"><b>이 절은 방향을 맞히려는 게 아니다.</b> 수급으로 미리 알 수 있는 것은
  "지수가 X% 움직이면 기계적으로 얼마가 따라 나오는가"이지 "지수가 어디로 갈 것인가"가 아니다.
  아래 숫자를 먼저 적어 두는 이유는, 다음 주에 실제로 나온 움직임과 대조해야
  <b>수급이 원인이었는지 아닌지</b>를 판정할 수 있기 때문이다. 투자 판단의 근거로 쓰라고 만든 표가 아니다.</div>

<div class="verdict">
  <div class="vl">수급 구도 요약</div>
  <div class="vt">현재 ${k0(O.state.spotIdx)}p(${dtFull(O.state.spotDate)}), 직전일 ${sgn(O.state.lastRet, 1)}%,
    20거래일 낙폭 ${f(O.state.drawdown20, 1)}%.
    ${ft ? `<b>아래쪽</b>은 마진콜 첫 문턱이 ${k0(ft.threshold)}p로 지금보다 <b>${f(ft.gapPct, 1)}%</b> 아래라 버퍼가 생겼다.` : ''}
    ${short ? `<b>위쪽</b>은 대차잔고가 ${f(short.balJo)}조로 직전일 ${sgn(short.dBalPct, 1)}% 늘어,
    반등이 이어지면 되갚아야 할 물량이 오히려 쌓인 상태다.` : ''}
    그리고 다음 주에는 레버리지 수요를 줄이는 제도 변경이 겹친다.</div>
</div>

<h3>지수 시나리오별 레버리지 ETF 강제 매매</h3>
<p class="lead">삼성전자·SK하이닉스 단일종목 레버리지·인버스 ${(A.etf?.perFund ?? []).filter(x => x.group === 'single_lev' || x.group === 'single_inv').length}종의
  현재 AUM에 각 상품의 계수(2X=2, −2X=6)를 곱한 값이다. 두 종목이 코스피 등락의 60~80%를 설명하므로
  지수 등락률을 종목 등락률의 대용치로 썼다 — 거친 근사다.</p>
<div class="tw"><table>
  <thead><tr><th class="n">지수 시나리오</th><th class="n">지수 레벨</th><th class="n">그날 강제 매매</th><th class="n">두 종목 하루 거래대금 대비</th></tr></thead>
  <tbody>${scenRows}</tbody>
</table></div>
<div class="box">대칭이다 — 오르면 사고 내리면 파는 크기가 같다. 중요한 건 <b>좌수가 사상 최대</b>라는 점이다.
  증폭기는 꺼진 게 아니라 장전된 채로 남아 있다(PART 3).</div>

${ft ? `<h3>아래로 열리는 물량 — 마진콜 사다리까지의 거리</h3>
<div class="tw"><table>
  <thead><tr><th class="n">문턱</th><th class="n">지금 대비</th><th class="n">열리는 물량</th><th class="n">누적</th></tr></thead>
  <tbody>${ladderRows}</tbody>
</table></div>
<div class="box">사다리는 FREESIS 확정 지수로 계산돼 있고, 반등한 현재 지수에서 첫 문턱까지는
  <b>${f(ft.gapPct, 1)}%</b>다. 이 거리가 곧 <b>다음 주 신용발 강제 매도가 나오려면 필요한 하락폭</b>이다.</div>` : ''}

${short ? `<h3>위로 나오는 물량 — 숏커버 연료</h3>
<div class="box">대차잔고 <b>${f(short.balJo)}조</b>(${dtFull(short.date)}), 직전일 <b>${sgn(short.dBalPct, 1)}%</b>.
  사이클 고점은 ${f(short.cyclePeakJo)}조였다. 지수가 크게 오른 날 잔고가 같이 늘었다면
  <b>반등에 맞서 새로 짠 숏</b>이라는 뜻이고, 그 물량은 지수가 더 오르면 되갚아야 한다.
  PART 2 기준 잔여 커버 여력은 ${f(short.coverLowJo)}~${f(short.coverHighJo)}조다.</div>` : ''}

<h3>과거 유사 국면의 다음 5거래일</h3>
<p class="lead">2010년 이후 코스피 일별로, 조건을 만족한 날의 <b>다음 5거래일 수익률 분포</b>다.
  표본이 10개 미만인 줄은 흐리게 뒀다 — 그건 근거가 아니라 일화다.</p>
<div class="tw"><table>
  <thead><tr><th>조건</th><th class="n">표본</th><th class="n">중앙값</th><th class="n">상승 확률</th><th class="n">25~75분위</th></tr></thead>
  <tbody>${baseRows}</tbody>
</table></div>
<div class="box"><b>기준선(전 구간)과 크게 다르지 않다.</b> 급락 뒤 반등이라는 조건만으로는
  다음 주 방향이 갈리지 않는다는 뜻이다. 방향을 이 표에서 읽으려 하면 안 된다.</div>

${eventRows ? `<h3>다음 주 이후 예정된 제도 변경</h3>
<div class="tw"><table>
  <thead><tr><th class="n">일자</th><th>내용</th><th>세부</th></tr></thead>
  <tbody>${eventRows}</tbody>
</table></div>
<div class="box">셋 다 <b>레버리지 재축적을 어렵게 만드는</b> 방향이다. 하방 증폭기를 약화시키는 동시에,
  레버리지가 밀어 올리던 상승 탄력도 같이 줄인다. 방향보다 <b>진폭</b>에 먼저 영향을 준다.</div>` : ''}

${anchorRows ? `<h3>외사 리서치 수치와 대조</h3>
<p class="lead">원문 PDF는 제3자 저작물이라 저장소에 넣지 않았다. 대조에 필요한 수치만 옮겨 적었다.</p>
<div class="tw"><table>
  <thead><tr><th>출처</th><th>지표</th><th>값</th><th>비고</th></tr></thead>
  <tbody>${anchorRows}</tbody>
</table></div>
<div class="box"><b>여기서 우리 계산과 갈리는 지점이 있다.</b> 세 하우스 모두 레버리지 ETF AUM이
  반토막 났다는 점을 디레버리징의 진척으로 읽는다. 그런데 우리 분해(PART 3)로는 그 감소가
  <b>거의 전부 가격효과</b>이고 좌수는 오히려 늘었다. J.P. Morgan도 같은 관찰을 적어 두었다 —
  자금 유입은 계속 플러스라는 것이다.
  <b>AUM으로 보면 정리가 끝나가는 것처럼 보이고, 좌수로 보면 아직 시작도 안 했다.</b>
  둘 중 어느 쪽을 보느냐가 다음 국면의 판단을 가른다.</div>` : ''}
</section>`;
})();

/* ---------- 사이클별 상세 — 탭 ---------- */
// 두 사이클을 세로로 이어 붙이면 어느 쪽 숫자를 보고 있는지 헷갈린다.
// 바깥 탭(§9)과 같은 방식으로 라디오 + 형제 선택자만 쓴다. 스크립트 없음.
// 진행 중인 사이클을 먼저, 기본 선택으로 둔다 — 그쪽을 보러 오기 때문이다.
const orderedPeriods = [...A.periods].sort((a, b) => (a.closed ? 1 : 0) - (b.closed ? 1 : 0));

const cycleTabs = orderedPeriods.length < 2
  ? orderedPeriods.map(p => `<section>
<h2>${esc(p.name)}</h2>
<p class="lead">${esc(p.note)}</p>
${Object.entries(p.markets).map(([nm, m]) => marketBlock(nm, m, p.closed)).join('\n')}
</section>`).join('\n')
  : `${orderedPeriods.map((p, i) => `<input type="radio" name="cyc" id="cyc-${p.key}" class="cycin"${i ? '' : ' checked'}>`).join('\n')}
<nav class="tabs sub">
  ${orderedPeriods.map(p => `<label for="cyc-${p.key}">
    <i>${p.closed ? '완결 · 대조군' : '진행 중'}</i><b>${esc(p.name)}</b>
    <span>지수 ${k0(p.markets['전체'].headline.idxPeak)} → ${k0(p.markets['전체'].headline.idxTrough)}p ·
      신용 ${f(p.markets['전체'].headline.creditPeakJo)} → ${f(p.markets['전체'].headline.creditTroughJo)}조</span>
  </label>`).join('\n')}
</nav>
${orderedPeriods.map(p => `<div class="cycpane cp-${p.key}">
<section>
<h2>${esc(p.name)}</h2>
<p class="lead">${esc(p.note)} 적립 ${dtFull(p.accBase)}~${dtFull(p.accEnd)} · 청산 판정 ~${dtFull(p.evalEnd)}</p>
${Object.entries(p.markets).map(([nm, m]) => marketBlock(nm, m, p.closed)).join('\n')}
</section>
</div>`).join('\n')}`;

// 키가 데이터에서 오므로 선택자도 같이 만든다.
const cycleCss = orderedPeriods.length < 2 ? '' : `
  .cycin { position:absolute; opacity:0; pointer-events:none; }
  .tabs.sub { margin-top:26px; }
  .tabs.sub label { padding:9px 14px; border-left-width:1.5px; }
  .tabs.sub label b { font-size:14px; }
  .cycpane { display:none; }
  ${orderedPeriods.map(p => `.tabs.sub label[for="cyc-${p.key}"] { border-left:5px solid var(--${p.closed ? 'bar' : 'acc'}); }`).join('\n  ')}
  ${orderedPeriods.map(p => `#cyc-${p.key}:checked ~ .cp-${p.key} { display:block; }`).join('\n  ')}
  ${orderedPeriods.map(p => `#cyc-${p.key}:checked ~ .tabs.sub label[for="cyc-${p.key}"] {
    background:var(--${p.closed ? 'bar' : 'acc'}); border-color:var(--${p.closed ? 'bar' : 'acc'}); color:#fff; }`).join('\n  ')}
  ${orderedPeriods.map(p => `#cyc-${p.key}:checked ~ .tabs.sub label[for="cyc-${p.key}"] b { color:#fff; }`).join('\n  ')}
  ${orderedPeriods.map(p => `#cyc-${p.key}:focus-visible ~ .tabs.sub label[for="cyc-${p.key}"] { outline:2px solid var(--acc); outline-offset:2px; }`).join('\n  ')}
  .cycpane > section:first-child { border-top:none; margin-top:0; }
  @media print { .tabs.sub { display:none; } .cycpane { display:block !important; } }`;

/* ---------- 문서 조립 ---------- */

const stressRows = A.stress.slice(-14).map(s => `<tr><td>${dtFull(s.date)}</td>
  <td class="n">${f(s.idx)}</td><td class="n">${f(s.kosdaq)}</td>
  <td class="n">${k0(s.forced / 100)}</td><td class="n">${k0(s.unpaid / 100)}</td>
  <td class="n">${s.credit == null ? '미공표' : f(s.credit / 1e6)}</td></tr>`).join('');

const reproRows = A.repro.map(r => `<tr><td>${k0(r.low)}–${k0(r.high)}</td>
  <td class="n">${f(r.pdf)}</td><td class="n">${f(r.mine)}</td>
  <td class="n ${Math.abs(r.diff) > 0.1 ? 'warn' : 'ok'}">${r.diff >= 0 ? '+' : ''}${f(r.diff)}</td></tr>`).join('');

const splitBox = A.meta.hasSplit ? '' : `
<div class="box warn">
  <b>유가증권/코스닥 분리 미적용</b> — 금투협은 신용거래융자를 전체·유가증권·코스닥으로 나눠 공표하지만,
  프로그램으로 접근 가능한 크로스통계 API에는 '전체'만 노출된다. 현재 신용융자는 <b>유가증권+코스닥 합계</b>이며
  코스피 지수로만 버킷을 나눈 상태다. FREESIS &gt; 주식 &gt; 신용공여현황 &gt; 신용공여 잔고 추이 에서 내려받아
  <code>data/</code> 에 넣고 <code>node scripts/ingest-split.mjs</code> 를 실행하면 시장별 분석이 자동으로 붙는다.
</div>`;

const html = `<title>사이클별 지수대별 신용잔고와 반대매매 추정 — ${dtFull(co.headline.idxLastDate)}</title>
<style>
  :root {
    --bg:#fff; --fg:#12181f; --mut:#5a6672; --line:#e2e6ea; --acc:#1a56a8; --kq:#2e8b6f;
    --cr:#c0392b; --hit:#c0392b; --part:#e8883a; --bar:#7f95ad; --band:#fdf1ec; --surf:#f3f5f8;
    --cyc0:rgba(26,86,168,.07); --cyc1:rgba(192,57,43,.07); --lv:#7b4fb5; --nx:#b8792a;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#10151b; --fg:#e6ebf0; --mut:#93a1b0; --line:#26303a; --acc:#5c9ce6; --kq:#5fc4a2;
      --cr:#e8705f; --hit:#e8705f; --part:#f0a868; --bar:#5f7994; --band:#2a1c19; --surf:#1b2431;
      --cyc0:rgba(92,156,230,.10); --cyc1:rgba(232,112,95,.10); --lv:#a78bda; --nx:#d9a05b; }
  }
  :root[data-theme="light"] { --bg:#fff; --fg:#12181f; --mut:#5a6672; --line:#e2e6ea; --acc:#1a56a8;
    --kq:#2e8b6f; --cr:#c0392b; --hit:#c0392b; --part:#e8883a; --bar:#7f95ad; --band:#fdf1ec; --surf:#f3f5f8;
    --cyc0:rgba(26,86,168,.07); --cyc1:rgba(192,57,43,.07); --lv:#7b4fb5; --nx:#b8792a; }
  :root[data-theme="dark"] { --bg:#10151b; --fg:#e6ebf0; --mut:#93a1b0; --line:#26303a; --acc:#5c9ce6;
    --kq:#5fc4a2; --cr:#e8705f; --hit:#e8705f; --part:#f0a868; --bar:#5f7994; --band:#2a1c19; --surf:#1b2431;
    --cyc0:rgba(92,156,230,.10); --cyc1:rgba(232,112,95,.10); --lv:#a78bda; --nx:#d9a05b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:14px; line-height:1.62;
    font-family:"Malgun Gothic","Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:1400px; margin:0 auto; padding:30px 26px 60px; }
  header { border-bottom:2px solid var(--fg); padding-bottom:12px; margin-bottom:18px; }
  .kicker { font-size:11px; letter-spacing:2.5px; text-transform:uppercase; color:var(--mut); }
  h1 { font-size:24px; margin:6px 0 4px; letter-spacing:-.4px; }
  .sub { color:var(--mut); font-size:13px; }
  /* 핵심 요약 */
  .summary { margin-top:20px; border-top:none; }
  .deltas { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:8px; margin:12px 0 8px; }
  .dcell { border:1px solid var(--line); border-radius:7px; padding:8px 11px; }
  details.dcell { padding:0; }
  details.dcell > summary { padding:8px 11px; cursor:pointer; list-style:none; border-radius:7px; }
  details.dcell > summary::-webkit-details-marker { display:none; }
  details.dcell > summary:hover { background:var(--band); }
  details.dcell[open] { grid-column:1/-1; }
  details.dcell[open] > summary { border-bottom:1px solid var(--line); border-radius:7px 7px 0 0; }
  .dcell .more { display:block; font-size:10.5px; color:var(--acc); margin-top:2px; }
  details.dcell[open] .more { color:var(--mut); }
  .trend { padding:10px 12px 6px; }
  .tline { fill:none; stroke:var(--acc); stroke-width:1.5; }
  .tarea { fill:var(--acc); opacity:.07; stroke:none; }
  .tdot { fill:var(--mut); } .tdot.now { fill:var(--acc); } .tdot.hi { fill:var(--cr); } .tdot.lo { fill:var(--kq); }
  .dcell .dl .live { font-style:normal; font-size:9px; background:var(--part); color:#fff;
    border-radius:3px; padding:1px 4px; margin-left:4px; vertical-align:1px; }
  .dcell .dl { font-size:11px; color:var(--mut); }
  .dcell .dv { font-size:17px; font-variant-numeric:tabular-nums; letter-spacing:-.4px; }
  .dcell .dv .u { font-size:11px; color:var(--mut); margin-left:1px; }
  .dcell .dd { font-size:11.5px; font-variant-numeric:tabular-nums; }
  .dcell .dd.up { color:var(--cr); } .dcell .dd.dn { color:var(--acc); }
  .dcell .dt { font-size:10px; color:var(--mut); }
  .fresh { font-size:11px; color:var(--mut); margin-bottom:6px; }
  .fresh span { margin-right:12px; white-space:nowrap; }
  .fresh span.fn { display:block; margin-top:3px; white-space:normal; }
  .fresh i { font-style:normal; color:var(--part); }
  .verdict { border:1px solid var(--line); border-left:3px solid var(--acc); border-radius:0 8px 8px 0;
    padding:12px 15px; margin:12px 0 4px; background:var(--band); }
  .verdict .vl { font-size:11px; letter-spacing:1.5px; color:var(--mut); text-transform:uppercase; }
  .verdict .vt { font-size:14px; margin-top:3px; }
  .sumcol { border:1px solid var(--line); border-radius:8px; padding:13px 15px 6px; }
  .sumcol h4 { font-size:13px; color:var(--fg); margin-bottom:4px; }
  .sumcol ul.find { padding-left:17px; }
  .sumcol ul.find li { font-size:12.5px; margin:9px 0; color:var(--mut); }
  .sumcol ul.find li b { color:var(--fg); }
  .c-down { border-top:3px solid var(--cr); }
  .c-up { border-top:3px solid var(--kq); }
  .pill { display:inline-block; font-size:9.5px; letter-spacing:1.5px; padding:2px 6px; border-radius:4px;
    color:#fff; vertical-align:2px; margin-right:5px; font-weight:600; }
  .pill.pd { background:var(--cr); } .pill.pu { background:var(--kq); }

  /* 탭: 라디오 + 형제 선택자만 쓴다. JS 없이 file:// 에서도 그대로 동작한다. */
  /* 선택된 탭은 색으로 꽉 채운다. 테두리만으로 구분하면 흰 배경에서 거의 안 보였다. */
  .tabin { position:absolute; opacity:0; pointer-events:none; }
  .tabs { display:flex; gap:10px; margin:20px 0 0; flex-wrap:wrap; align-items:stretch; }
  .tabs label { flex:1 1 260px; cursor:pointer; padding:11px 16px; line-height:1.35;
    border:1.5px solid var(--line); border-radius:10px; background:var(--surf);
    color:var(--mut); position:relative; }
  .tabs label i { display:block; font-size:9.5px; letter-spacing:2.5px; font-style:normal; opacity:.75; }
  .tabs label b { display:block; font-size:15.5px; letter-spacing:-.2px; color:var(--fg); }
  .tabs label span { display:block; font-size:11.5px; }
  .tabs label:hover { border-color:var(--mut); }
  .tabs label.t-all { flex:0 1 190px; }
  /* 선택 상태 — 배경을 파트 색으로 채우고 글자를 흰색으로 뒤집는다. */
  #tab-down:checked ~ .tabs label[for="tab-down"],
  #tab-up:checked ~ .tabs label[for="tab-up"],
  #tab-etf:checked ~ .tabs label[for="tab-etf"],
  #tab-next:checked ~ .tabs label[for="tab-next"],
  #tab-all:checked ~ .tabs label[for="tab-all"] { color:#fff; }
  #tab-down:checked ~ .tabs label[for="tab-down"] b,
  #tab-up:checked ~ .tabs label[for="tab-up"] b,
  #tab-etf:checked ~ .tabs label[for="tab-etf"] b,
  #tab-next:checked ~ .tabs label[for="tab-next"] b,
  #tab-all:checked ~ .tabs label[for="tab-all"] b { color:#fff; }
  #tab-down:checked ~ .tabs label[for="tab-down"] { background:var(--cr); border-color:var(--cr); }
  #tab-up:checked ~ .tabs label[for="tab-up"] { background:var(--kq); border-color:var(--kq); }
  #tab-etf:checked ~ .tabs label[for="tab-etf"] { background:var(--lv); border-color:var(--lv); }
  #tab-next:checked ~ .tabs label[for="tab-next"] { background:var(--nx); border-color:var(--nx); }
  #tab-all:checked ~ .tabs label[for="tab-all"] { background:var(--acc); border-color:var(--acc); }
  /* 선택 안 된 탭에도 파트 색을 왼쪽 띠로 조금 남겨 어느 축인지 알 수 있게 한다. */
  .tabs label[for="tab-down"] { border-left:5px solid var(--cr); }
  .tabs label[for="tab-up"] { border-left:5px solid var(--kq); }
  .tabs label[for="tab-etf"] { border-left:5px solid var(--lv); }
  .tabs label[for="tab-next"] { border-left:5px solid var(--nx); }
  .tabs label[for="tab-all"] { border-left:5px solid var(--acc); }
  .pane { display:none; }
  #tab-down:checked ~ .p-down, #tab-up:checked ~ .p-up, #tab-etf:checked ~ .p-etf,
  #tab-next:checked ~ .p-next, #tab-all:checked ~ .pane { display:block; }
  tr.dim td { opacity:.55; }
  td.up { color:var(--kq); } td.dn { color:var(--cr); }
  /* 매일 볼 것 — 첫 화면 고정 박스. 판정에 따라 색이 바뀐다. */
  .watch { margin:18px 0 4px; padding:14px 16px 12px; border-radius:10px;
    border:1.5px solid var(--line); border-left:6px solid var(--mut); background:var(--surf); }
  .watch.w-build { border-left-color:var(--cr); }
  .watch.w-flat { border-left-color:var(--part); }
  .watch.w-roll { border-left-color:var(--kq); }
  .wl { font-size:10px; letter-spacing:2px; color:var(--mut); }
  .wmain { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-top:2px; }
  .wv { font-size:30px; font-weight:700; letter-spacing:-.5px; }
  .wv .u { font-size:13px; font-weight:400; color:var(--mut); margin-left:3px; }
  .wtag { font-size:13px; font-weight:600; padding:2px 10px; border-radius:20px; color:#fff; background:var(--mut); }
  .w-build .wtag { background:var(--cr); } .w-flat .wtag { background:var(--part); } .w-roll .wtag { background:var(--kq); }
  .wnums { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--mut); margin-top:5px; }
  .wnums b { color:var(--fg); }
  .wline { font-size:12.5px; margin-top:7px; }
  .wtrend { margin-top:8px; max-width:640px; }
  .wsub { display:inline-block; margin:6px 14px 0 0; font-size:12px; color:var(--mut); }
  .wsub b { color:var(--fg); }
  .wsub span { margin-left:5px; }
  .pane > section:first-child { border-top:none; }
  /* 파트 머리말. 전체 보기에서 두 파트의 경계를 만든다. */
  .parthead { margin:22px 0 4px; padding:11px 14px; border-radius:7px; color:#fff; }
  .parthead i { display:block; font-size:10px; letter-spacing:2px; font-style:normal; opacity:.85; }
  .parthead b { font-size:16px; }
  .ph-down { background:var(--cr); }
  .ph-up { background:var(--kq); }
  .ph-etf { background:var(--lv); }
  .ph-next { background:var(--nx); }
  .pill.pl { background:var(--lv); }
  #tab-down:focus-visible ~ .tabs label[for="tab-down"],
  #tab-up:focus-visible ~ .tabs label[for="tab-up"],
  #tab-etf:focus-visible ~ .tabs label[for="tab-etf"],
  #tab-next:focus-visible ~ .tabs label[for="tab-next"],
  #tab-all:focus-visible ~ .tabs label[for="tab-all"] { outline:2px solid var(--acc); outline-offset:2px; }
  @media print { .tabs { display:none; } .pane { display:block !important; } }
${cycleCss}

  section { margin-top:32px; padding-top:8px; border-top:1px solid var(--line); }
  h2 { font-size:18px; margin:14px 0 6px; padding-left:9px; border-left:3px solid var(--acc); }
  h3.mh { font-size:15px; margin:22px 0 4px; }
  h3.mh .tag { font-size:11px; color:var(--mut); font-weight:400; }
  h4 { font-size:12.5px; margin:0 0 8px; color:var(--mut); font-weight:600; }
  p.lead { color:var(--mut); font-size:12.5px; margin:0 0 12px; }
  .mkt { margin-top:10px; padding-top:4px; }
  .mkt + .mkt { border-top:1px dashed var(--line); margin-top:26px; padding-top:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr)); gap:10px; margin:12px 0; }
  .card { border:1px solid var(--line); border-radius:7px; padding:10px 12px; }
  .card .lb { font-size:11px; color:var(--mut); }
  .card .vl { font-size:20px; font-variant-numeric:tabular-nums; letter-spacing:-.5px; }
  .card .u { font-size:12px; }
  .card .nt { font-size:11px; color:var(--mut); }
  .neg { color:var(--cr); }
  ul.find { padding-left:19px; margin:10px 0; }
  ul.find li { margin:6px 0; }
  figure { margin:14px 0 0; border:1px solid var(--line); border-radius:8px; padding:14px 14px 10px; overflow-x:auto; }
  figcaption { font-size:11.5px; color:var(--mut); margin-top:6px; }
  svg { width:100%; height:auto; display:block; min-width:430px; }
  .grid { stroke:var(--line); stroke-width:1; }
  /* 누적 면적 차트의 사건 표시선(단일종목 상장일 등) */
  line.mk { stroke:var(--fg); stroke-width:1; stroke-dasharray:3 3; opacity:.45; }
  figure.wide .lg .sw { height:10px; border-radius:2px; }
  .ax { font-size:10px; fill:var(--mut); } .ax.sm { font-size:9px; }
  .unit { font-size:10px; fill:var(--mut); }
  .val { font-size:9px; fill:var(--fg); font-variant-numeric:tabular-nums; }
  .note { font-size:10px; fill:var(--cr); }
  .cyclab { font-size:9.5px; fill:var(--mut); }
  .cyc.c0 { fill:var(--cyc0); } .cyc.c1 { fill:var(--cyc1); }
  .ln-idx { fill:none; stroke:var(--acc); stroke-width:1.2; }
  .ln-kq { fill:none; stroke:var(--kq); stroke-width:1; stroke-dasharray:3 2; }
  .ln-cr { fill:none; stroke:var(--cr); stroke-width:1.6; }
  .ln-margin { fill:none; stroke:var(--acc); stroke-width:1.4; stroke-dasharray:4 3; }
  .dot { fill:var(--acc); }
  .bar { fill:var(--bar); } .bar.hit { fill:var(--hit); } .bar.part { fill:var(--part); }
  .band { fill:var(--band); }
  .lg { display:flex; gap:15px; flex-wrap:wrap; font-size:11px; color:var(--mut); margin-top:8px; }
  .sw { display:inline-block; width:20px; height:3px; vertical-align:middle; margin-right:5px; }
  .sw.hit{background:var(--hit)} .sw.part{background:var(--part)} .sw.bar{background:var(--bar)}
  .sw.acc{background:var(--acc)} .sw.cr{background:var(--cr)} .sw.kq{background:var(--kq)}
  .sw.fin{background:var(--bar)} .sw.fout{background:var(--cr)}
  .sw.mb{background:var(--acc);height:0;border-top:2px dashed var(--acc)}
  .sw.mu{background:var(--cr);height:0;border-top:2px dashed var(--cr)}
  .bar.fin { fill:var(--bar); } .bar.fout { fill:var(--cr); }
  .bar.mk { fill:var(--acc); } .bar.mq { fill:var(--kq); }
  .ln-base { fill:none; stroke:var(--mut); stroke-width:1; stroke-dasharray:3 3; }
  .wmark { stroke-width:1.2; stroke-dasharray:3 3; }
  .wmark.mb { stroke:var(--acc); } .wmark.mu { stroke:var(--cr); }
  .wlab { font-size:9px; } .wlab.mb { fill:var(--acc); } .wlab.mu { fill:var(--cr); }
  .ln-ratio { fill:none; stroke:var(--acc); stroke-width:1.5; }
  .rdot { fill:var(--cr); }
  .range { border:1px solid var(--line); border-left:3px solid var(--cr); border-radius:0 8px 8px 0;
    padding:12px 16px; margin:14px 0; }
  .range .rl { font-size:11px; color:var(--mut); }
  .range .rv { font-size:26px; font-variant-numeric:tabular-nums; letter-spacing:-.5px; }
  .range .rn { font-size:11px; color:var(--mut); }
  .bench { border:1px solid var(--line); border-radius:7px; padding:9px 12px; margin-bottom:9px; }
  .bench .bn { font-size:13px; font-weight:600; }
  .bench .bv { font-size:12px; font-weight:400; color:var(--mut); }
  .bench .bv.neg { color:var(--cr); }
  .bench .bb { font-size:11.5px; color:var(--mut); margin-top:3px; }
  .bench .bc { font-size:11.5px; color:var(--part); margin-top:3px; }
  .tables { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:20px; margin-top:16px; }
  .tw { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; min-width:270px; }
  th,td { padding:5px 9px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
  th { font-size:11px; color:var(--mut); font-weight:600; border-bottom:1px solid var(--fg); }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  td.dim { color:var(--mut); }
  tr.r-hit td { color:var(--hit); } tr.r-part td { color:var(--part); } tr.r-base td { font-weight:700; }
  .ok { color:var(--mut); } .warn { color:var(--part); }
  .box { border:1px solid var(--line); border-left:3px solid var(--acc); border-radius:0 7px 7px 0;
    padding:11px 14px; margin:12px 0; font-size:12.5px; }
  .box.warn { border-left-color:var(--part); }
  .empty { color:var(--mut); font-size:12px; padding:20px; text-align:center; }
  footer { margin-top:32px; padding-top:14px; border-top:1px solid var(--line); font-size:11.5px; color:var(--mut); }
  footer li { margin:4px 0; }
  code { font-size:11.5px; background:color-mix(in srgb, var(--fg) 8%, transparent); padding:1px 4px; border-radius:3px; }
</style>

<div class="wrap">
<header>
  <div class="kicker">Liquidity Analysis</div>
  <h1>사이클별 지수대별 신용융자 누적과 반대매매 진행률</h1>
  <div class="sub">코스피 ${dtFull(co.headline.idxLastDate)} 종가 ${f(co.headline.idxLast)}p ·
    신용융자 ${dtFull(co.headline.creditLastDate)} 기준 ${f(co.headline.creditLastJo)}조원 ·
    ${A.meta.hasSplit ? '유가증권/코스닥 분리 적용' : '시장 합계 기준'}</div>
</header>

${splitBox}

${summarySection}

<input type="radio" name="tab" id="tab-down" class="tabin" checked>
<input type="radio" name="tab" id="tab-up" class="tabin">
${etfSection ? '<input type="radio" name="tab" id="tab-etf" class="tabin">' : ''}
${outlookSection ? '<input type="radio" name="tab" id="tab-next" class="tabin">' : ''}
<input type="radio" name="tab" id="tab-all" class="tabin">
<nav class="tabs">
  <label for="tab-down"><i>PART 1</i><b>신용잔고</b><span>얼마나 더 하락할 수 있나 — 반대매매 잔여</span></label>
  <label for="tab-up"><i>PART 2</i><b>공매도·숏커버링</b><span>얼마나 더 상승할 수 있나 — 대차 되갚기 잔여</span></label>
  ${etfSection ? '<label for="tab-etf"><i>PART 3</i><b>레버리지 ETF</b><span>변동성은 어디서 왔나 — 매일 나가는 강제 매매</span></label>' : ''}
  ${outlookSection ? '<label for="tab-next"><i>PART 4</i><b>다음 주 수급</b><span>지수가 어디로 가면 무엇이 따라 나오나</span></label>' : ''}
  <label for="tab-all" class="t-all"><i>ALL</i><b>전체</b><span>네 파트를 이어서 본다</span></label>
</nav>

<div class="pane p-down">
<div class="parthead ph-down"><i>PART 1</i><b>신용잔고 — 얼마나 더 하락할 수 있나</b></div>

<figure>
  <h4>신용융자 잔고와 지수 추이 — 두 사이클</h4>
  ${timeSeriesChart(A.series.filter(p => p.d >= '20200101'), A.periods)}
  <div class="lg"><span><i class="sw cr"></i>신용융자 합계(좌, 조원)</span><span><i class="sw acc"></i>코스피(우, p)</span><span><i class="sw kq"></i>코스닥(우, 자체 스케일)</span></div>
  <figcaption>음영은 각 사이클의 적립 구간. 신용융자는 결제일 기준이라 지수보다 1~2일 늦게 확정된다.</figcaption>
</figure>

${compare}

${monthlySection}

${ladderCompareSection}

${turnoverCompareSection}

${channelsSection}

${projSection}

${cycleTabs}

<section>
<h2>실측 스트레스 지표</h2>
<div class="box warn">
  금투협이 공표하는 <b>반대매매금액</b>은 위탁매매 미수금(미수거래)에 대한 반대매매다.
  <b>신용융자 반대매매는 별도로 공표되지 않는다.</b> 따라서 이 수치는 위 추정치의 검증값이 아니라
  독립적인 시장 스트레스 지표로만 읽어야 한다. 원 자료가 신용융자 반대매매를 <i>추정</i>한 이유도 같다.
</div>
<div class="tw"><table>
  <thead><tr><th>일자</th><th class="n">코스피</th><th class="n">코스닥</th><th class="n">반대매매(억원)</th><th class="n">위탁매매미수금(억원)</th><th class="n">신용융자 합계(조)</th></tr></thead>
  <tbody>${stressRows}</tbody>
</table></div>
</section>

${unpaidSection}

<section>
<h2>원 자료 재현 검증</h2>
<div class="box">
  삼성자산운용 House View(2026-07-29) 자료의 막대 11개를 같은 방법론으로 재계산한 결과다.
  평균 절대오차 <b>${f(A.reproMAE, 3)}조원</b>. 방법론(500p 버킷 · 양의 순증만 누적 · 마진콜 계수 ${f(A.meta.marginFactor)})이
  일치한다고 보기에 충분하다. 남은 차이는 차트 판독 정밀도와 데이터 확정 시점 차이로 보인다.
  <br>이 검증은 원 자료와 조건을 맞추기 위해 <b>2026 연초 대비 · 전체(시장 합계) · gross(보정 없음)</b> 기준으로 고정했다.
</div>
<div class="tw"><table>
  <thead><tr><th>코스피 구간(p)</th><th class="n">원 자료(조)</th><th class="n">재현(조)</th><th class="n">차이</th></tr></thead>
  <tbody>${reproRows}</tbody>
</table></div>
</section>

</div><!-- /p-down -->

<div class="pane p-up">
<div class="parthead ph-up"><i>PART 2</i><b>공매도·숏커버링 — 얼마나 더 상승할 수 있나</b></div>

${lendingSection}

${coverSection}

</div><!-- /p-up -->

${etfSection ? `<div class="pane p-etf">
<div class="parthead ph-etf"><i>PART 3</i><b>레버리지 ETF — 변동성은 어디서 왔나</b></div>

${etfSection}

</div><!-- /p-etf -->` : ''}

${outlookSection ? `<div class="pane p-next">
<div class="parthead ph-next"><i>PART 4</i><b>다음 주 수급 — 지수가 어디로 가면 무엇이 따라 나오나</b></div>

${outlookSection}

</div><!-- /p-next -->` : ''}

<footer>
  <b>데이터 출처</b>
  <ul>
    <li>신용융자·반대매매금액·위탁매매미수금·투자자예탁금, 코스피/코스닥 지수: 금융투자협회 FREESIS 크로스통계 (일별, ${esc(A.meta.source.fetchedRange)})</li>
    ${A.meta.splitSource ? `<li>유가증권/코스닥 분리 신용거래융자: ${esc(A.meta.splitSource.source)}</li>` : '<li>유가증권/코스닥 분리 신용거래융자: <b>미적용</b></li>'}
    ${A.lending ? `<li>대차잔고(공매도 프록시): ${esc(A.lending.meta.source)}</li>` : ''}
    <li>코스피 종가는 네이버 금융 일별 시세와 교차 확인(${k0(A.meta.crossCheckRows)}영업일).</li>
    <li>투자자예탁금·예탁증권담보융자: 같은 FREESIS 크로스통계 계열(OS0021 / OS0027).</li>
    <li>비교 대상 자료: 삼성자산운용 투자리서치센터, House View 점검 &mdash; 7.29일 급락 코멘트(2026-07-29)</li>
  </ul>
  <b>가정</b>
  <ul>
    <li>담보유지비율 ${f(A.meta.maintenance * 100, 0)}%, 융자비율 ${f(A.meta.loanRatio * 100, 0)}% → 마진콜 계수 ${f(A.meta.marginFactor)} (매수 지수 대비 ${f((1 - A.meta.marginFactor) * 100, 0)}% 하락 시 마진콜)</li>
    <li>버킷 폭은 사이클별 지수 범위에서 자동 결정(버킷 20개 이하가 되는 가장 촘촘한 값). ${A.periods.map(p => `${p.name} ${p.markets['전체'].width}p`).join(', ')}</li>
    <li>버킷 대표 매수 지수는 <b>구간 상단</b>. 원 자료의 '상단기준'과 동일하다.</li>
    <li>청산 판정은 그날까지의 <b>최저 지수</b> 기준. 반대매매는 지수가 반등해도 되돌아오지 않는다.</li>
  </ul>
  <b>한계</b>
  <ul>
    <li>공표되는 것은 일별 <b>순증감</b>뿐이어서 같은 날의 총매수와 총청산을 분리할 수 없다.</li>
    <li><b>churn 보정</b>: 양의 순증만 누적하면 같은 자금이 들어왔다 나갔다 할 때 두 번 세어진다.
      창이 길수록 심해서 2020–21 사이클은 gross 합계가 신용 고점보다 ${f(ca ? ca.headline.buildJo - ca.headline.creditPeakJo : 0)}조 크게 나온다.
      버킷이 알려주는 것은 지수대별 <b>분포</b>이므로, 합계만 사이클 순증에 맞춰 균등 스케일했다. 표에 보정 전 gross 값을 함께 실었다.</li>
    ${A.meta.hasSplit ? '' : '<li>신용융자가 유가증권+코스닥 합계인 채로 코스피 지수로만 버킷을 나눴다. 코스닥 귀속분이 섞여 있다.</li>'}
    <li>담보유지비율은 증권사·계좌·종목별로 130~170%로 다르다. 민감도 표를 함께 볼 것.</li>
    <li>종목별 신용잔고는 지수와 독립적으로 움직일 수 있다.</li>
    ${A.channels ? `<li>마진콜 사다리는 <b>신용융자 채널만</b> 센다. 예탁증권담보융자 ${f(A.channels.last.pledgeJo)}조는
      담보유지비율·청산 트리거가 공표되지 않아 같은 계수를 적용할 근거가 없다 — 사다리는 하한이다(§17).</li>` : ''}
  </ul>
  <div style="margin-top:10px">생성 <code>node scripts/fetch-kospi.mjs &amp;&amp; node scripts/fetch-kofia.mjs &amp;&amp; node scripts/ingest-split.mjs &amp;&amp; node scripts/ingest-lending.mjs &amp;&amp; node scripts/analyze.mjs &amp;&amp; node scripts/build.mjs &amp;&amp; node scripts/build-email.mjs</code></div>
</footer>
</div>`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.log(`index.html 생성 (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`  사이클 ${A.periods.map(p => p.name).join(' / ')}`);
console.log(`  시장 ${A.meta.markets.join(', ')} · 재현 MAE ${f(A.reproMAE, 3)}조 · 분리적용 ${A.meta.hasSplit ? 'O' : 'X'}`);
