// data/analysis.json 을 읽어 index.html 한 장으로 굽는다.
// 차트는 빌드 시점에 SVG 문자열로 만들어 넣는다. 런타임 의존성이 없어야
// file:// 로 열어도 그대로 보이고, fetch 로 데이터를 읽지 않으므로 CORS 문제도 없다.
import fs from 'node:fs';
import path from 'node:path';
import { placeLabels, clampX, labelWidth } from './lib/labels.mjs';

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

/* ---------- 축 단위 ---------- */
// 차트 제목에 '(조원)' 처럼 섞여 있던 단위를 떼어내 **축 옆에 따로 찍는다**.
// 대화형 차트는 정적 SVG 를 걷어내고 다시 그리는데, 거기엔 제목줄이 없어서
// 단위가 화면에서 아예 사라져 있었다 — 눈금 숫자만 남아 뭘 재는지 알 수 없었다.
//
// 표기도 통일한다. 같은 값을 어떤 차트는 '조', 어떤 차트는 '조원' 으로 쓰고 있었다.
const UNIT_ALIAS = { 조: '조원', 억: '억원', 배수: '배' };
const KNOWN_UNITS = new Set([
  '조원', '억원', '백만원', '만원', '천원', '원',
  '십억달러', '억달러', '백만달러', '달러', '지수',
  '%', '%p', 'p', '배', '회',
  '억주', '백만주', '만주', '천주', '주',
  '억좌', '백만좌', '만좌', '좌',
  '천계약', '계약',
]);
const normUnit = u => UNIT_ALIAS[u] ?? u;

/** '대차잔고 공매도 프록시 (백만주)' -> { title: '대차잔고 — 공매도 프록시', axis: '백만주' } */
function splitUnit(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return { title: '', axis: '' };
  if (KNOWN_UNITS.has(normUnit(raw))) return { title: '', axis: normUnit(raw) };
  const found = [];
  const title = raw
    // 괄호 안 첫 토큰이 알려진 단위일 때만 떼어낸다. '(조원, 상장좌수 × 종가)' 는 '조원'만 취한다.
    .replace(/[(（]\s*([^()（）]+?)\s*[)）]/g, (all, inner) => {
      const u = normUnit(inner.split(/[,·]/)[0].trim());
      if (!KNOWN_UNITS.has(u)) return all;
      if (!found.includes(u)) found.push(u);
      return '';
    })
    .replace(/\s{2,}/g, ' ').replace(/^[\s—·,]+|[\s—·,]+$/g, '').trim();
  // 한 축에 단위가 둘이면(마진콜 비율 % + 미수금 조원) 둘 다 찍는다 — 숨기면 오히려 오해한다.
  return { title: title || raw, axis: found.join(' / ') };
}

/**
 * 눈금 라벨. 자리수 구분 쉼표를 넣고, **눈금끼리 구분되는 최소 소수점**만 쓴다.
 * dg 를 그대로 쓰면 5,632.398 처럼 읽을 수 없는 숫자가 축에 박힌다.
 */
/**
 * 축 단위 라벨의 x. 눈금 열 위에 붙이되 **뷰박스를 벗어나지 않게** 민다.
 * '% / 조원' 처럼 긴 단위를 왼쪽 눈금 열(x=38)에 우측 정렬했더니 x=-2 로 잘려 나갔다.
 * 항상 anchor=start 로 그리고 위치만 여기서 정한다.
 */
function axuX(x, text, W, anchorEnd = false) {
  const w = labelWidth(text, 10.5);
  return Math.min(Math.max(anchorEnd ? x - w : x, 2), W - w - 2);
}

function tickFmt(vals, dg = 3) {
  let d = 0;
  for (; d < dg; d++) if (new Set(vals.map(v => v.toFixed(d))).size === vals.length) break;
  return v => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })
    // 0 에 아주 가까운 음수(-1e-13)가 '-0' 으로 찍힌다. 눈금에 마이너스 0 은 없다.
    .replace(/^-(0(?:[.,]0+)?)$/, '$1');
}

/** 신용융자 잔고 + 지수 이중축 시계열. 사이클 적립 구간을 음영으로 표시한다. */
const CHARTS = {};
let chartSeq = 0;
// 660px 폭 차트에 4,000점을 실어봐야 화면에서 구분되지 않는다. 그런데 그 데이터는
// 파일 크기로 그대로 남는다 — 실측으로 241KB 였다. 균등 솎되 처음·끝은 반드시 남긴다
// (구간 요약의 시작/끝 값이 어긋나면 안 된다).
const MAX_PTS = 900;
function thin(spec) {
  const n = spec.dates.length;
  if (n <= MAX_PTS) return spec;
  const keep = [];
  for (let i = 0; i < n; i += Math.ceil(n / MAX_PTS)) keep.push(i);
  if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
  return {
    ...spec,
    dates: keep.map(i => spec.dates[i]),
    series: spec.series.map(s => ({ ...s, vals: keep.map(i => s.vals[i]) })),
  };
}
// 방금 만든 차트의 id. 계열 토글 체크박스처럼 차트 밖에서 같은 id를 참조해야 하는
// 마크업을 만들 때 쓴다 — levelChart() 등은 문자열만 돌려주므로 이렇게 옆으로 흘려둔다.
let lastChartId = null;
function interactive(spec, staticSvg) {
  // 점이 두 개 미만이면 대화형으로 만들 이유가 없다.
  if (!spec?.dates?.length || spec.dates.length < 2) { lastChartId = null; return staticSvg; }
  const id = `c${++chartSeq}`;
  // 제목/단위 분리는 여기서 한 번만 한다 — 래퍼 여섯 개에 같은 코드를 흩뿌리지 않는다.
  const { title, axis } = splitUnit(spec.unit);
  CHARTS[id] = thin({
    ...spec, title, axis,
    // 툴팁 접미사는 단위가 하나일 때만 붙인다. '% / 조원' 처럼 둘이면 붙이는 게 오히려 틀린다.
    suffix: spec.suffix ?? (axis && !axis.includes('/') ? axis : ''),
  });
  lastChartId = id;
  return `<div class="ichart" data-chart="${id}">${staticSvg}</div>`;
}

/**
 * 계열 켜기/끄기 체크박스. levelChart() 등으로 차트를 그린 바로 뒤에 호출해
 * lastChartId 를 참조한다 — 두 계열짜리 범례를 세 계열 토글로 바꿀 때 이 함수만 쓰면 된다.
 * JS 없으면 `hidden` 속성 그대로 안 보인다(정적 SVG 는 항상 전부 겹쳐 보이므로 토글이 필요 없다).
 */
function seriesToggle(lines, colors) {
  const id = lastChartId;
  if (!id) return '';
  return `<div class="ictoggle" data-for="${id}" hidden>${lines.map((l, i) => `<label>
    <input type="checkbox" checked data-idx="${i}"><i style="background:${colors[i]}"></i><span>${esc(l)}</span>
  </label>`).join('')}</div>`;
}

/**
 * 범주형(막대) 차트를 대화형으로 감싼다. 지수대·월·국가처럼 날짜가 아닌 축이라
 * interactive() 의 구간 선택·thin() 는 적용하지 않는다 — chart-client.js 의 drawBars() 가
 * 별도 경로로 그린다. spec 의 unit 만 title/axis 로 쪼개고 나머지는 그대로 넘긴다.
 */
function interactiveBars(spec, staticSvg) {
  if (!spec?.categories?.length) { lastChartId = null; return staticSvg; }
  const id = `c${++chartSeq}`;
  const { title, axis } = splitUnit(spec.unit);
  const norm = s => (s ? { ...s, suffix: s.suffix ?? (axis && !axis.includes('/') ? axis : '') } : s);
  CHARTS[id] = { ...spec, kind: 'cat', title, axis, suffix: spec.suffix ?? (axis && !axis.includes('/') ? axis : ''), line: norm(spec.line) };
  lastChartId = id;
  return `<div class="ichart" data-chart="${id}">${staticSvg}</div>`;
}
// 색은 CSS 변수 문자열로 넘긴다 — stroke 와 툴팁 색점 양쪽에서 그대로 쓰인다.
const CL = {
  acc: 'var(--acc)', cr: 'var(--cr)', kq: 'var(--kq)', lv: 'var(--lv)', nx: 'var(--nx)', mut: 'var(--mut)',
  bar: 'var(--bar)', hit: 'var(--hit)', part: 'var(--part)',
};


function trendChartStatic(points, unit, dg, spanLabel = '최근 1년') {
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
    if (q === lastQ) return;
    lastQ = q;
    // 계열이 연말에서 시작하면 첫 눈금(24.12)과 다음 분기 눈금(25.01)이 하루 차이로 붙어
    // 라벨이 포개진다. 'YY.MM' 은 26px 안팎이라 그보다 좁으면 그 분기는 건너뛴다.
    if (ticksX.length && xAt(i) - xAt(ticksX.at(-1).i) < 34) return;
    ticksX.push({ i, label: `${p.d.slice(2, 4)}.${p.d.slice(4, 6)}` });
  });

  const iMax = vs.indexOf(hi), iMin = vs.indexOf(lo);
  // 최고·최저가 계열 끝에 있으면 가운데 정렬 라벨의 절반이 밖으로 잘렸다('저 200' 실측).
  // 오른쪽은 눈금 숫자가 있는 자리라, 플롯 폭(M.l+iw) 안으로만 민다.
  const short = d => `${d.slice(2, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  const mark = placeLabels([
    { cx: xAt(iMax), cy: yAt(hi) - 7, dotY: yAt(hi), cls: 'hi', text: `고 ${f(hi, dg)} ${short(points[iMax].d)}` },
    { cx: xAt(iMin), cy: yAt(lo) + 13, dotY: yAt(lo), cls: 'lo', text: `저 ${f(lo, dg)} ${short(points[iMin].d)}` },
  ], { W: M.l + iw, minY: M.t })
    .map(p => `<circle class="tdot ${p.cls}" cx="${p.cx.toFixed(1)}" cy="${p.dotY.toFixed(1)}" r="2.8"/>
    <text class="ax sm" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">${esc(p.text)}</text>`).join('');

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join('');
  const area = `${d}L${xAt(points.length - 1).toFixed(1)},${(M.t + ih).toFixed(1)}L${xAt(0).toFixed(1)},${(M.t + ih).toFixed(1)}Z`;

  const tv = ticks(dom[0], dom[1], 3), tf = tickFmt(tv, dg);
  const { title, axis } = splitUnit(unit);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 1년 추세">
  ${tv.map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l + iw + 6}" y="${(yAt(v) + 3.5).toFixed(1)}">${tf(v)}</text>`).join('')}
  ${axis ? `<text class="axu" x="${axuX(M.l + iw + 6, axis, W).toFixed(1)}" y="${M.t - 5}">${esc(axis)}</text>` : ''}
  ${ticksX.map(t => `<text class="ax" x="${clampX(xAt(t.i), t.label, W).toFixed(1)}" y="${M.t + ih + 15}" text-anchor="middle">${t.label}</text>`).join('')}
  <path class="tarea" d="${area}"/>
  <path class="tline" d="${d}"/>
  ${mark}
  <circle class="tdot now" cx="${xAt(points.length - 1).toFixed(1)}" cy="${yAt(vs.at(-1)).toFixed(1)}" r="3.4"/>
  <text class="unit" x="${M.l}" y="12">${esc(title || unit)} · ${esc(spanLabel)} (${points.length}영업일)</text>
</svg>`;
}

// 호출부는 그대로 두고 여기서 대화형으로 감싼다 — 이 한 함수가 요약 미니차트부터
// 좌수·거래대금·개인 순매수까지 전부를 덮는다.
function trendChart(points, unit, dg, spanLabel = '최근 1년') {
  const pts = (points ?? []).filter(p => p && p.d && Number.isFinite(p.v));
  return interactive({
    unit, dg, h: 200,
    dates: pts.map(p => p.d),
    series: [{ name: '', color: CL.acc, vals: pts.map(p => p.v) }],
  }, trendChartStatic(points, unit, dg, spanLabel));
}

/**
 * 그룹별 AUM 을 쌓아 올린 면적 차트. 레버리지 ETF 시장 전체가 어떻게 부풀었다 꺼졌는지를
 * 한 장으로 본다. 선 여러 개를 겹치면 합계가 눈에 안 들어와서 누적 면적을 쓴다.
 */
function stackChartStatic(rows, keys, unit, marks = []) {
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

  const tvS = ticks(dom[0], dom[1], 4), tfS = tickFmt(tvS, 1);
  const su = splitUnit(unit);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">
  ${tvS.map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l + iw + 6}" y="${(yAt(v) + 3.5).toFixed(1)}">${tfS(v)}</text>`).join('')}
  ${su.axis ? `<text class="axu" x="${axuX(M.l + iw + 6, su.axis, W).toFixed(1)}" y="${M.t - 5}">${esc(su.axis)}</text>` : ''}
  ${ticksX.map(t => `<text class="ax" x="${clampX(xAt(t.i), t.label, W).toFixed(1)}" y="${M.t + ih + 15}" text-anchor="middle">${t.label}</text>`).join('')}
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
  <text class="unit" x="${M.l}" y="12">${esc(su.title || unit)}</text>
</svg>`;
}

/** 같은 단위(조원) 계열 여러 개를 한 축에 겹쳐 그린다. */
// dg: 축 눈금 소수 자리. zeroBase:false 면 값 범위에 맞춰 하한을 올린다 —
// 외국인 지분율(46~56%)처럼 0에서 먼 계열은 0 기준으로 그리면 움직임이 안 보인다.
function levelChartStatic(rows, lines, unit, { dg = 0, zeroBase = true } = {}) {
  const W = 660, H = 260, M = { t: 22, r: 16, b: 34, l: 50 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vals = lines.flatMap(L => rows.map(r => r[L.key]).filter(Number.isFinite));
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
  const vMin = zeroBase ? 0 : lo - pad;
  const vMax = zeroBase ? hi * 1.1 : hi + pad;
  const xAt = i => scale(i, [0, rows.length - 1], [M.l, M.l + iw]);
  const yAt = v => scale(v, [vMin, vMax], [M.t + ih, M.t]);

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

  const tv = ticks(vMin, vMax), tf = tickFmt(tv, dg);
  const { title, axis } = splitUnit(unit);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">
  ${tv.map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${tf(v)}</text>`).join('')}
  ${axis ? `<text class="axu" x="${axuX(M.l - 8, axis, W, true).toFixed(1)}" y="${M.t - 5}">${esc(axis)}</text>` : ''}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  ${paths}
  ${title ? `<text class="unit" x="${M.l}" y="13">${esc(title)}</text>` : ''}
</svg>`;
}

// 선 클래스 -> 색. 대화형 쪽은 CSS 클래스를 못 쓰는 자리(툴팁 색점)가 있어 값이 필요하다.
const CLS_COLOR = { 'ln-idx': CL.acc, 'ln-cr': CL.cr, 'ln-kq': CL.kq, 'ln-ratio': CL.acc, 'ln-base': CL.mut };

/**
 * PART 1 첫 차트. 신용융자를 전체·코스피·코스닥으로 나눠 같은 축(조원)에 겹치고,
 * 코스피 지수를 보조축(점선)으로 곁들인다. 예전엔 이 차트(지수 겹치기)와 별도로
 * "신용융자 시장별 겹쳐보기" 차트가 하나 더 있었는데, 코스피·코스닥 신용융자 자체를
 * 비교하는 게 핵심이라 둘을 합쳤다 — 지수는 참고용 점선 하나로 충분하다.
 *
 * rows 는 A.creditByMarket.series: {d, total, kospi, kosdaq, idx}(조원·조원·조원·p).
 */
function timeSeriesChartStatic(rows, periods) {
  const W = 660, H = 330, M = { t: 24, r: 64, b: 46, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const cVals = rows.flatMap(r => [r.total, r.kospi, r.kosdaq]).filter(Number.isFinite);
  const cDom = [0, Math.max(...cVals) * 1.08];
  const iDom = [0, Math.max(...rows.map(r => r.idx ?? 0)) * 1.08];

  const xAt = i => scale(i, [0, rows.length - 1], [M.l, M.l + iw]);
  const cAt = v => scale(v, cDom, [M.t + ih, M.t]);
  const iAt = v => scale(v, iDom, [M.t + ih, M.t]);

  // 코스피·코스닥은 최근 1~2주가 null(§8, 수동 갱신 지연) 이다. 점을 건너뛰고 있는
  // 점만 이어 그린다 — 이 프로젝트의 다계열 정적 SVG 가 늘 하던 방식이다.
  const line = (get, yFn) => rows
    .map((r, i) => (get(r) == null ? null : `${xAt(i).toFixed(1)},${yFn(get(r)).toFixed(1)}`))
    .filter(Boolean).map((s, i) => `${i ? 'L' : 'M'}${s}`).join('');

  const idxOfDate = d => {
    const i = rows.findIndex(r => r.d >= d);
    return i < 0 ? rows.length - 1 : i;
  };

  const bands = periods.map((p, n) => {
    const x0 = xAt(idxOfDate(p.accBase)), x1 = xAt(idxOfDate(p.accEnd));
    return `<rect class="cyc c${n}" x="${x0.toFixed(1)}" y="${M.t}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}"/>
      <text class="cyclab" x="${((x0 + x1) / 2).toFixed(1)}" y="${M.t + ih + 32}" text-anchor="middle">${esc(p.name)} 적립</text>`;
  }).join('');

  const yearTicks = [];
  let lastY = null;
  rows.forEach((r, i) => {
    const y = r.d.slice(0, 4);
    if (y !== lastY) { yearTicks.push({ i, label: `'${y.slice(2)}` }); lastY = y; }
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="신용융자 시장별 잔고와 코스피 지수 추이">
  ${bands}
  ${ticks(0, cDom[1]).map(v => `<line class="grid" x1="${M.l}" y1="${cAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${cAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(cAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 0)}</text>`).join('')}
  ${ticks(0, iDom[1]).map(v => `<text class="ax" x="${M.l + iw + 8}" y="${(iAt(v) + 3.5).toFixed(1)}">${k0(v)}</text>`).join('')}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  <path d="${line(r => r.idx, iAt)}" fill="none" stroke="${CL.mut}" stroke-width="1" stroke-dasharray="4 3"/>
  <path d="${line(r => r.kosdaq, cAt)}" fill="none" stroke="${CL.kq}" stroke-width="1.4"/>
  <path d="${line(r => r.kospi, cAt)}" fill="none" stroke="${CL.acc}" stroke-width="1.4"/>
  <path d="${line(r => r.total, cAt)}" fill="none" stroke="${CL.cr}" stroke-width="1.8"/>
  <text class="unit" x="${M.l}" y="14">조원</text>
  <text class="unit" x="${M.l + iw}" y="14" text-anchor="end">코스피 지수(p, 점선)</text>
</svg>`;
}

/** 지수대별 누적 신용매수(churn 보정) 막대 + 마진콜 레벨 선(우축) */
function bucketChart(m) {
  const buckets = m.scaledBuckets.filter(b => b.jo >= 0.005);
  if (!buckets.length) return '<div class="empty">표시할 버킷이 없다.</div>';
  return interactiveBars({
    unit: '신용융자 누적(보정) (조원)', dg: 1, rotate: buckets.length > 12,
    axis2Unit: '마진콜 지수(p)', dg2: 0,
    // 막대마다 항상 값이 찍혀 있어 최고/최저 라벨을 더 얹으면 중복이다.
    markExtent: false,
    categories: buckets.map(b => k0(b.low)),
    bars: [{
      name: '누적(보정)', color: CL.bar,
      colors: buckets.map(b => (b.fullyTriggered ? CL.hit : b.triggered ? CL.part : CL.bar)),
      vals: buckets.map(b => b.jo),
    }],
    line: { name: '마진콜 레벨(p)', color: CL.acc, axis2: true, vals: buckets.map(b => b.marginHigh) },
  }, bucketChartStatic(m));
}

function bucketChartStatic(m) {
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
  const acc = new Map(m.scaledBuckets.map(b => [b.low, b.jo]));
  const out = new Map(m.unwind.buckets.map(b => [b.low, b.jo]));
  const lows = [...new Set([...acc.keys(), ...out.keys()])]
    .filter(l => (acc.get(l) ?? 0) >= 0.005 || (out.get(l) ?? 0) >= 0.005)
    .sort((a, b) => a - b);
  if (!lows.length) return '<div class="empty">표시할 구간이 없다.</div>';
  return interactiveBars({
    unit: '조원', dg: 1, rotate: lows.length > 12,
    // 적립·청산은 서로 다른 두 계열이라 둘을 더한 '카테고리 합계'가 의미가 없다 —
    // 가중평균매수/청산 마커(정적 전용, 아래)와 겹치는 대신 여기선 끈다.
    markExtent: false,
    categories: lows.map(l => k0(l)),
    bars: [
      { name: '적립(보정)', color: CL.bar, vals: lows.map(l => acc.get(l) ?? 0) },
      { name: '청산', color: CL.cr, vals: lows.map(l => out.get(l) ?? 0) },
    ],
  }, flowChartStatic(m));
}

function flowChartStatic(m) {
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

  // 평균매수·평균청산이 한 버킷 안에 들면 두 라벨이 같은 자리에 찍힌다(실측 913 vs 956).
  const xOfIdx = v => M.l + bw * ((v - lows[0]) / width + 0.5);
  const mark = placeLabels(
    [[m.unwind.weightedBuildIdx, 'mb', '평균매수'], [m.unwind.weightedUnwindIdx, 'mu', '평균청산']]
      .filter(([v]) => v != null && xOfIdx(v) >= M.l && xOfIdx(v) <= M.l + iw)
      .map(([v, cls, lb]) => ({ cx: xOfIdx(v), cy: M.t - 4, cls, text: `${lb} ${k0(v)}` })),
    { W, minY: 2 }
  ).map(p => `<line class="wmark ${p.cls}" x1="${p.cx.toFixed(1)}" y1="${M.t}" x2="${p.cx.toFixed(1)}" y2="${(M.t + ih).toFixed(1)}"/>
      <text class="wlab ${p.cls}" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">${esc(p.text)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="지수대별 적립과 청산 비교">
  ${ticks(0, vMax).map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${f(v, 1)}</text>`).join('')}
  ${pair}${mark}${xLab}
  <text class="unit" x="${M.l}" y="14">조원</text>
</svg>`;
}

/**
 * 월별 지수 추이(그 해 1월=100 지수화). 코스피(2천~9천대)와 코스닥(6백~1천2백대)을
 * 원 지수로 겹치면 코스닥이 눌리므로, 축을 하나로 맞추려고 각자 1월 대비 지수화한다.
 * 두 축을 쓰는 대신(왜곡의 원인) 지수화로 한 축에 놓는 표준적인 해법이다.
 */
// 월을 날짜처럼 다뤄(각 월 1일) 기존 시계열 엔진(interactive)에 그대로 태운다 —
// 새 렌더러를 만들지 않고도 호버·고점/저점을 공짜로 얻는다. 폴백은 전용 정적 SVG를
// 그대로 쓴다(월별 x축 라벨·기준선 100 은 범용 levelChartStatic 으론 못 그린다 —
// levelChartStatic 의 x축은 '연도가 바뀔 때'만 찍어서, 한 해 12개월엔 라벨이 하나뿐이다).
function monthlyIndexChart(mo) {
  const rows = mo.months.map((m, i) => ({
    d: `${m.ym.replace('-', '')}01`, k: mo.kIdxIdx[i], q: mo.qIdxIdx[i],
  }));
  // 이 차트는 2열 그리드의 좁은 칸에 들어간다(옆에 거래대금 막대차트가 나란히 붙는다).
  // 대화형 엔진의 뷰박스 너비는 660 으로 고정이라, 좁은 칸에서도 원래 정적 차트의 비율
  // (320:210 ≈ 1.5:1)에 가깝게 보이도록 h 를 올려 뷰박스 자체를 세로로 늘였다.
  return interactive({
    unit: '코스피·코스닥 1월=100 지수화 (지수)', dg: 1, zeroBase: false, h: 320,
    dates: rows.map(r => r.d),
    series: [
      { name: '코스피', color: CL.acc, vals: rows.map(r => r.k ?? null) },
      { name: '코스닥', color: CL.kq, vals: rows.map(r => r.q ?? null) },
    ],
  }, monthlyIndexChartStatic(mo));
}

function monthlyIndexChartStatic(mo) {
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
  return interactiveBars({
    unit: '조원', dg: 1,
    categories: mo.months.map(m => m.ym.slice(5)),
    bars: [
      { name: '코스피', color: CL.acc, vals: mo.months.map(m => m.kToJo ?? null) },
      { name: '코스닥', color: CL.kq, vals: mo.months.map(m => m.qToJo ?? null) },
    ],
  }, monthlyTurnoverChartStatic(mo));
}

function monthlyTurnoverChartStatic(mo) {
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

/* ---------- 시장별 되돌림 진척 ---------- */
// 합계(PART 1 본문)는 "아직 덜 풀렸다"로 읽힌다. 그런데 쪼개면 두 시장이 정반대라,
// 합계만 보면 코스닥의 완료와 코스피의 잔여가 서로를 가린다. 그 결론을 여기서 따로 말한다.
const divergenceSection = !A.divergence ? '' : (() => {
  const D = A.divergence;
  const K = D.items.find(x => x.market === '유가증권'), Q = D.items.find(x => x.market === '코스닥');
  if (!K || !Q) return '';
  const done = D.doneMarkets.length === 1 ? D.doneMarkets[0] : null;
  const cols = [K, Q];
  const row = (label, fn, note = '') => `<tr><td>${label}${note ? ` <span class="mut">${note}</span>` : ''}</td>
    ${cols.map(c => `<td class="n">${fn(c)}</td>`).join('')}</tr>`;

  return `<section>
<h2>같은 사이클을 두 시장이 다르게 지나고 있다</h2>
<p class="lead">위의 청산률은 유가증권+코스닥 <b>합계</b>다. 합계는 두 시장의 정반대 움직임을 평균 내
  어느 쪽 이야기도 하지 못한다. 나눠 보면 결론이 갈린다 — 코스닥은 이번 사이클에 쌓은 신용을
  거의 다 토해냈고, 코스피는 대부분 들고 있다.</p>

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt"><b>코스닥은 되돌림이 사실상 끝났다</b> — 쌓은 것의 ${f(Q.retracedPctOfBuild, 0)}%를 반납해
    잔고가 사이클 시작의 ${f(Q.multipleOfStart, 2)}배까지 내려왔고, 신용/시총은 직전 사이클 저점보다도 낮다.
    <b>코스피는 ${f(K.retracedPctOfBuild, 0)}%만 되돌렸다</b> — 잔고가 아직 시작의 <b>${f(K.multipleOfStart, 2)}배</b>다.
    남은 하락 위험은 지수 전체가 아니라 <b>유가증권 쪽에 몰려 있다</b>.</div>
</div>

<div class="tw"><table>
  <thead><tr><th>항목 <span class="mut">잔고는 ${dtFull(D.asOf)} 확정치</span></th>${cols.map(c => `<th class="n">${esc(c.market)}</th>`).join('')}</tr></thead>
  <tbody>
    ${row('사이클 시작 잔고(조)', c => f(c.startJo), `${dtFull(K.startDate)}`)}
    ${row('고점 잔고(조)', c => `${f(c.peakJo)} <span class="mut">${dtFull(c.peakDate)}</span>`)}
    ${row('현재 잔고(조)', c => f(c.lastJo), `${dtFull(D.asOf)}`)}
    ${row('이번 사이클에 쌓은 것(조)', c => f(c.builtJo))}
    ${row('되돌린 것(조)', c => f(c.retracedJo))}
    ${row('<b>쌓은 것 대비 되돌림</b>', c => `<b>${f(c.retracedPctOfBuild, 0)}%</b>`)}
    ${row('현재 잔고 / 시작 잔고', c => `${f(c.multipleOfStart, 2)}배`,
      `${dtFull(D.asOf)} ÷ ${dtFull(K.startDate)}`)}
    ${row('고점 대비 청산률', c => f(c.unwindPct, 1) + '%')}
    ${row('직전 사이클 최종 청산률', c => f(c.prevUnwindPct, 1) + '%', '(완주한 값)')}
    ${row('신용/시총', c => c.now ? f(c.now.ratio, 3) + '%' : '-')}
    ${row('직전 사이클 저점 비율', c => c.prevTrough ? f(c.prevTrough.ratio, 3) + '%' : '-')}
    ${row('<b>저점 비율 대비</b>', c => c.ratioVsPrevTrough == null ? '-'
      : `<b class="${c.ratioVsPrevTrough <= 1 ? 'up' : 'dn'}">${f(c.ratioVsPrevTrough, 2)}배</b>`)}
    ${row('저점 비율까지 더 풀릴 여지(조)', c => c.toPrevTroughJo == null ? '-'
      : (c.toPrevTroughJo > 0 ? f(c.toPrevTroughJo) : '<b>0</b>'))}
  </tbody>
</table></div>

<div class="tables">
  <div class="box">
    <b>코스닥 — 네 지표가 전부 같은 쪽을 가리킨다</b><br>
    ① 쌓은 ${f(Q.builtJo)}조 중 ${f(Q.retracedJo)}조를 반납해 잔고가 시작 수준(${f(Q.startJo)}조 → ${f(Q.lastJo)}조)이다.
    ② 고점 대비 청산률 ${f(Q.unwindPct, 1)}%는 <b>직전 사이클이 완주해서 낸 ${f(Q.prevUnwindPct, 1)}%를 이미 넘겼다</b>.
    ③ 신용/시총 ${f(Q.now.ratio, 3)}%는 직전 저점 ${f(Q.prevTrough.ratio, 3)}%의 ${f(Q.ratioVsPrevTrough, 2)}배로 <b>저점 아래</b>다.
    ④ 그래서 저점 비율 기준으로 더 풀릴 여지가 남지 않는다.
    지수가 더 빠지면 새 물량이 열리는 것과는 별개로, <b>이번 사이클에 쌓인 몫은 정리됐다</b>고 읽는다.
  </div>
  <div class="box warn">
    <b>코스피 — 잔여가 여기 있다</b><br>
    지수는 ${f(K.idxDrawdownPct, 1)}% 빠졌는데 잔고는 ${f(K.startJo)}조 → ${f(K.peakJo)}조 → ${f(K.lastJo)}조로,
    쌓은 ${f(K.builtJo)}조 중 ${f(K.retracedJo)}조만 나갔다.
    고점 대비 청산률 ${f(K.unwindPct, 1)}%는 직전 사이클 완주치 ${f(K.prevUnwindPct, 1)}%의
    ${f(K.unwindPct / K.prevUnwindPct * 100, 0)}% 수준이다.
    신용/시총으로 봐도 ${f(K.now.ratio, 3)}%로 직전 저점 ${f(K.prevTrough.ratio, 3)}%의 ${f(K.ratioVsPrevTrough, 2)}배라,
    그 비율까지 내려가려면 <b>${f(K.toPrevTroughJo)}조</b>가 더 풀려야 한다.
  </div>
</div>

<div class="box">
  <b>두 시장의 신용/시총 <i>수준</i>을 직접 비교하면 안 된다</b> — 코스닥은 평시에도 코스피의 서너 배다
  (직전 저점끼리 ${f(Q.prevTrough.ratio, 3)}% vs ${f(K.prevTrough.ratio, 3)}%). 그래서 위 표는 두 시장을 서로 견주지 않고
  <b>각자의 과거</b>와 견줬다. 또 비율의 분모인 시가총액이 급락으로 빠르게 줄어 비율이 실제보다 높게 보인다 —
  코스피가 저점 비율 위에 있다는 판정은 그만큼 <b>보수적</b>이고, 코스닥이 저점 아래라는 판정은 그만큼 <b>더 강하다</b>.
  <br><b>기준일</b> — "시작"은 ${dtFull(K.startDate)}로, 이번 사이클의 적립 기준일(2025년에 쌓인 몫을 재는
  출발선)이다. "현재"는 ${dtFull(D.asOf)}로, <b>시장별 분리 잔고가 나와 있는 마지막 날</b>이다.
  신용융자는 결제일 기준이라 지수(${dtFull(A.series.at(-1).d)})보다 늦게 확정되고, 분리 계열은
  전체 계열(${dtFull(A.channels?.last?.date ?? D.asOf)})보다 하루 더 늦다. 배수는 이 두 날짜의 잔고 비다.
</div>
</section>`;
})();

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

function ratioChartStatic(rows, marks, unit = '신용융자 / 시가총액 (%)', suf = '%', dg = 3) {
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

  // 기준점 라벨은 서로 겹치고 오른쪽 끝에서 잘렸다 — 배치는 labels.mjs 가 푼다(selfcheck 가 검증).
  const mk = placeLabels(
    marks.filter(Boolean)
      .map(mm => ({ mm, i: rows.findIndex(r => r.date >= mm.date) }))
      .filter(x => x.i >= 0)
      .map(({ mm, i }) => ({
        cx: xAt(i), cy: yAt(mm.ratio) - 8, dotY: yAt(mm.ratio),
        text: `${mm.label} ${f(mm.ratio, dg)}${suf}`,
      })),
    { W, minY: M.t }
  ).map(p => `<circle class="rdot" cx="${p.cx.toFixed(1)}" cy="${p.dotY.toFixed(1)}" r="3.2"/>
      <text class="ax sm" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">${esc(p.text)}</text>`).join('');

  const tv = ticks(0, vMax), tf = tickFmt(tv, dg);
  const { title, axis } = splitUnit(unit);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="신용융자 대 시가총액 비율">
  ${tv.map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${tf(v)}</text>`).join('')}
  ${axis ? `<text class="axu" x="${axuX(M.l - 8, axis, W, true).toFixed(1)}" y="${M.t - 5}">${esc(axis)}</text>` : ''}
  ${yearTicks.map(t => `<text class="ax" x="${xAt(t.i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${t.label}</text>`).join('')}
  <path class="ln-ratio" d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(r.ratio).toFixed(1)}`).join('')}"/>
  ${mk}
  ${title ? `<text class="unit" x="${M.l}" y="13">${esc(title)}</text>` : ''}
</svg>`;
}

/** 지표 하나의 1년 추세. 핵심 요약에서 지표를 펼치면 나온다. */
/* ---------- 대화형 차트 등록 ---------- */
// 런타임은 lib/chart-client.js 를 그대로 인라인한다. 외부 파일을 참조하면 file:// 에서 깨진다.
function chartRuntime() {
  // 축 단위가 비어 있으면 대화형 차트는 눈금 숫자만 남는다 — 무엇을 재는 그림인지 알 수 없다.
  // 원인은 늘 하나다: 단위 문자열이 KNOWN_UNITS 에 없어서 splitUnit 이 못 떼어냈다.
  // 조용히 넘어가면 알아채는 데 며칠이 걸리므로 빌드를 세운다('만원' 을 빼먹어 실제로 겪었다).
  const noAxis = Object.entries(CHARTS).filter(([, c]) => !c.axis).map(([id, c]) => `${id}(${c.unit})`);
  if (noAxis.length) {
    throw new Error(`축 단위를 못 읽은 차트 ${noAxis.length}개: ${noAxis.join(', ')}`
      + ' — 단위를 KNOWN_UNITS 에 넣거나 제목의 괄호 표기를 맞춰라');
  }
  // 단위와 값의 자릿수가 맞는지. 정적 SVG 는 원자료를 나눠 그리는데 대화형 래퍼가 안 나눠서
  // 신용융자 축이 '40,000,000 조원' 으로 찍힌 적이 있다 — 백만원을 조원이라 label 한 것이다.
  // 배수 오류(1e6)만 잡으면 되므로 상한은 느슨하게 둔다. 여기서 걸리면 래퍼의 스케일을 봐라.
  const SANE = {
    조원: 1e4, 억원: 1e6, 백만원: 1e8, 만원: 1e5, 천원: 1e6, 원: 1e8,
    십억달러: 1e4, 억달러: 1e5, 백만달러: 1e7, 달러: 1e9, 지수: 1e4,
    '%': 1e4, '%p': 1e4, p: 1e5, 배: 1e3, 회: 1e3,
    억주: 1e4, 백만주: 1e5, 만주: 1e7, 천주: 1e8, 주: 1e12,
    억좌: 1e4, 백만좌: 1e5, 만좌: 1e7, 좌: 1e12,
  };
  // 범주형(kind:'cat')은 .series 가 아니라 .bars/.line/.net 에 값이 있다 — 같은 검사를
  // 그 모양에 맞게 한다.
  const valsOf = c => (c.kind === 'cat'
    ? [...(c.bars ?? []).flatMap(b => b.vals), ...(c.line ? c.line.vals : []), ...(c.net ? c.net.vals : [])]
    : c.series.flatMap(s => s.vals));
  const insane = Object.entries(CHARTS).map(([id, c]) => {
    const cap = SANE[c.axis];
    if (!cap) return null;                      // 이중 단위('% / 조원') 는 건너뛴다
    const mx = Math.max(0, ...valsOf(c).filter(Number.isFinite).map(Math.abs));
    return mx > cap ? `${id} ${c.axis} 최대 ${mx.toLocaleString()} (상한 ${cap.toLocaleString()})` : null;
  }).filter(Boolean);
  if (insane.length) {
    throw new Error(`단위와 값의 자릿수가 안 맞는 차트 ${insane.length}개:\n  ${insane.join('\n  ')}`
      + '\n  — 대화형 래퍼가 원자료를 나누지 않았을 가능성이 크다(정적 SVG 쪽 스케일과 맞춰라)');
  }
  const js = fs.readFileSync(path.join(import.meta.dirname, 'lib', 'chart-client.js'), 'utf8');
  // </script> 가 데이터 안에 들어가면 스크립트가 조기 종료된다.
  const data = JSON.stringify(CHARTS).replace(/<\//g, '<\\/');
  return `window.__CHARTS__=${data};
${js}
${tabScrollJs()}`;
}

// 탭(파트 1~6·전체)을 누르면 그 내용으로 스크롤한다. 탭 자체는 라디오+형제 선택자라
// JS 없이도 전환되지만(§9), 요약이 늘 위에 고정되어 있어 "눌렀는데 화면이 그대로다"로
// 보인다는 지적이 있었다 — 전환은 됐는데 이동한 게 안 보이는 것이다. 라디오의 change 에
// 얹어서 해당 파트의 머리글로 스크롤한다. 스크립트가 없으면 이 동작만 빠지고 전환 자체는
// 그대로 동작한다.
function tabScrollJs() {
  return `(function(){
  var inputs = document.querySelectorAll('input.tabin');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('change', function () {
      if (!this.checked) return;
      // 라디오가 포커스를 받으면 브라우저가 자체적으로 (보이지도 않는) input 을
      // 화면에 넣으려는 스크롤을 같이 걸 때가 있어, smooth 애니메이션끼리 겹쳐
      // 엉뚱한 위치로 튄다. blur 로 그 경쟁을 없앤 뒤 우리가 원하는 곳으로 보낸다.
      this.blur();
      var target = this.id === 'tab-all'
        ? document.querySelector('.pane')
        : document.querySelector('.pane.p-' + this.id.slice(4) + ' .parthead');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
})();`;
}

// 서버가 그린 SVG 는 그대로 두고, 같은 데이터를 window.__CHARTS__ 로 함께 내보낸다.
// JS 가 살아 있으면 lib/chart-client.js 가 그 자리를 대화형 차트로 바꾼다(호버 값·구간 선택).
// 스크립트가 없으면 지금까지와 똑같은 정적 SVG 가 보인다 — 인쇄·메일·file:// 이 그대로 동작한다.

// 예전엔 여기(신용융자 시장별 겹쳐보기)에 별도 차트가 하나 더 있었다. PART 1 첫 차트가
// 전체·코스피·코스닥을 토글로 다 보여주게 되면서(§40) 완전히 중복이라 지웠다 —
// 코스닥이 빠진 채였던 그 차트와 이 차트를 나란히 둘 이유가 없었다.

function levelChart(rows, lines, unit, opts = {}) {
  const rs = (rows ?? []).filter(r => r && r.d);
  return interactive({
    unit, dg: opts.dg ?? 0, zeroBase: opts.zeroBase !== false, h: 240,
    stack: !!opts.stack,
    dates: rs.map(r => r.d),
    series: lines.map(L => ({
      name: L.name ?? '',
      color: L.color ?? CLS_COLOR[L.cls] ?? CL.acc,
      line: !!L.line, opacity: L.opacity,
      vals: rs.map(r => (Number.isFinite(r[L.key]) ? r[L.key] : null)),
    })),
  }, levelChartStatic(rows, lines, unit, opts));
}

// 나머지 시계열 차트 래퍼. 정적 SVG 는 그대로 두고 같은 데이터를 대화형으로 함께 낸다.
function ratioChart(rows, marks, unit, suf = '%', dg = 3) {
  const rs = (rows ?? []).filter(r => r && r.date && Number.isFinite(r.ratio));
  return interactive({
    unit: unit ?? '신용융자 / 시가총액 (%)', dg, zeroBase: false, h: 240, suffix: suf,
    dates: rs.map(r => r.date),
    series: [{ name: '', color: CL.acc, vals: rs.map(r => r.ratio) }],
  }, ratioChartStatic(rows, marks, unit, suf, dg));
}

function stackChart(rows, keys, unit, marks = []) {
  const rs = (rows ?? []).filter(r => r && r.d);
  const palette = [CL.lv, CL.cr, CL.acc, CL.nx, CL.kq];
  return interactive({
    unit, dg: 1, zeroBase: true, h: 250,
    dates: rs.map(r => r.d),
    series: keys.map((k, i) => ({
      name: k.label ?? k.key, color: palette[i % palette.length],
      vals: rs.map(r => (Number.isFinite(r[k.key]) ? r[k.key] : null)),
    })),
  }, stackChartStatic(rows, keys, unit, marks));
}

function lendingChart(series, cyclePeakDate) {
  const rs = (series ?? []).filter(r => r && r.d);
  return interactive({
    unit: '대차잔고 (조원)', dg: 1, zeroBase: false, h: 250,
    axis2Unit: '코스피(p)', dg2: 0,
    dates: rs.map(r => r.d),
    series: [
      { name: '대차잔고', color: CL.cr, vals: rs.map(r => (Number.isFinite(r.bal) ? r.bal : null)) },
      // 코스피는 눈금이 있는 보조축에 정확히 태운다. 정적 SVG 의 코스닥 선은 애초에
      // "자체 스케일"(숫자 눈금 없는 형태만 참고용)이라 정밀 판독 대상이 아니었다 —
      // 보조축 하나로는 코스피·코스닥을 동시에 정확히 태울 수 없어(코스닥만 뭉개진다)
      // 정밀 판독이 필요 없던 코스닥은 대화형에서 생략한다(정적 폴백엔 그대로 남는다).
      { name: '코스피', color: CL.acc, axis2: true, vals: rs.map(r => (Number.isFinite(r.idx) ? r.idx : null)) },
    ],
  }, lendingChartStatic(series, cyclePeakDate));
}

function timeSeriesChart(rows, periods) {
  const rs = (rows ?? []).filter(r => r && r.d);
  const html = interactive({
    unit: '신용융자 (조원)', dg: 1, zeroBase: true, h: 280,
    axis2Unit: '코스피 지수(p)', dg2: 0,
    // 사이클 적립 구간 음영. 대화형으로 바뀌며 조용히 빠졌던 것 중 하나 — 정적 SVG 는
    // 늘 그렸는데 여기 series 만 넘기고 밴드를 안 넘겼었다(§39.1).
    bands: periods.map((p, n) => ({ from: p.accBase, to: p.accEnd, label: `${p.name} 적립`, cls: `c${n}` })),
    dates: rs.map(r => r.d),
    // 처음 세 계열만 토글 대상이다(아래 seriesToggle 이 딱 이 순서·개수로 체크박스를 만든다).
    // 코스피 지수는 늘 켜져 있는 참고선이라 토글에서 뺐다 — axis2 라 단위도 다르다.
    series: [
      { name: '전체', color: CL.cr, vals: rs.map(r => r.total ?? null) },
      { name: '코스피', color: CL.acc, vals: rs.map(r => r.kospi ?? null) },
      { name: '코스닥', color: CL.kq, vals: rs.map(r => r.kosdaq ?? null) },
      { name: '코스피 지수', color: CL.mut, axis2: true, vals: rs.map(r => r.idx ?? null) },
    ],
  }, timeSeriesChartStatic(rows, periods));
  return seriesToggle(['전체', '코스피', '코스닥'], [CL.cr, CL.acc, CL.kq]) + html;
}

/* ---------- 대차잔고(공매도 프록시) 차트 ---------- */

/**
 * 국가별 포지셔닝 막대 (PART 6). 0 을 기준으로 매수는 위, 매도는 아래로 쌓고
 * 순합계를 마름모로 찍는다 — 씨티 'Weekly Futures Activity' 와 같은 읽기다.
 *
 * 시계열이 아니라 범주형(국가)이라 drawBars() 의 divergeStack 모드를 쓴다.
 */
function countryBarChart(items, unit = '정산 구간 포지션 변화 (백만달러)') {
  if (!items?.length) return '';
  return interactiveBars({
    unit, dg: 0,
    categories: items.map(it => it.country),
    // 씨티 대응 지수명은 x축에 두 줄째로 늘 보이던 것 — 호버 헤더로 옮긴다(아래 표에도 있다).
    subLabels: items.map(it => it.citi || null),
    divergeStack: true,
    zeroBase: false,
    // 매 막대 아래 Net 이 이미 항상 보인다 — 별도 최고/최저 라벨은 중복이라 끈다.
    markExtent: false,
    bars: [
      { name: '숏 커버', color: CL.part, opacity: 0.55, vals: items.map(it => it.coverShorts) },
      { name: '신규 롱', color: CL.acc, vals: items.map(it => it.newLongs ?? 0) },
      { name: '신규 숏', color: CL.cr, vals: items.map(it => it.newShorts) },
      { name: '롱 청산', color: CL.bar, opacity: 0.75, vals: items.map(it => it.coverLongs ?? 0) },
    ],
    net: { name: 'Net', color: '#f2c744', vals: items.map(it => it.net) },
  }, countryBarChartStatic(items, unit));
}

function countryBarChartStatic(items, unit = '정산 구간 포지션 변화 (백만달러)') {
  if (!items?.length) return '';
  const W = 980, H = 340, M = { t: 26, r: 16, b: 74, l: 58 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const n = items.length;
  const band = iw / n, bw = Math.min(46, band * 0.5);

  const up = it => (it.newLongs ?? 0) + it.coverShorts;         // 0 위로 쌓이는 것(매수)
  const dn = it => (it.coverLongs ?? 0) + it.newShorts;         // 0 아래로 쌓이는 것(매도)
  const vals = items.flatMap(it => [up(it), dn(it), it.net]);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const dom = [lo - pad, hi + pad];
  const xAt = i => M.l + band * (i + 0.5);
  const yAt = v => scale(v, dom, [M.t + ih, M.t]);

  const tv = ticks(dom[0], dom[1], 5), tf = tickFmt(tv, 0);
  const { title, axis } = splitUnit(unit);

  // 층을 하나씩 쌓는다. null(롱 사이드 미수집)은 건너뛴다 — 0 으로 그리면 '없었다'는 거짓이다.
  const bars = items.map((it, i) => {
    const x = xAt(i) - bw / 2;
    const layers = [];
    let acc = 0;
    for (const [v, cls] of [[it.coverShorts, 'b-cs'], [it.newLongs ?? 0, 'b-nl']]) {
      if (!v) continue;
      layers.push(`<rect class="${cls}" x="${x.toFixed(1)}" y="${yAt(acc + v).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${Math.abs(yAt(acc + v) - yAt(acc)).toFixed(1)}"/>`);
      acc += v;
    }
    acc = 0;
    for (const [v, cls] of [[it.newShorts, 'b-ns'], [it.coverLongs ?? 0, 'b-cl']]) {
      if (!v) continue;
      layers.push(`<rect class="${cls}" x="${x.toFixed(1)}" y="${yAt(acc).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${Math.abs(yAt(acc + v) - yAt(acc)).toFixed(1)}"/>`);
      acc += v;
    }
    const ny = yAt(it.net);
    layers.push(`<path class="b-net" d="M${xAt(i).toFixed(1)},${(ny - 5.5).toFixed(1)}
      L${(xAt(i) + 5.5).toFixed(1)},${ny.toFixed(1)} L${xAt(i).toFixed(1)},${(ny + 5.5).toFixed(1)}
      L${(xAt(i) - 5.5).toFixed(1)},${ny.toFixed(1)}Z"/>`);
    return layers.join('');
  }).join('');

  const labels = items.map((it, i) => `<text class="ax" x="${xAt(i).toFixed(1)}" y="${M.t + ih + 16}" text-anchor="middle">${esc(it.country)}</text>
    ${it.citi ? `<text class="ax sm" x="${xAt(i).toFixed(1)}" y="${M.t + ih + 29}" text-anchor="middle">${esc(it.citi)}</text>` : ''}
    <text class="ax sm" x="${xAt(i).toFixed(1)}" y="${M.t + ih + 44}" text-anchor="middle">${it.net >= 0 ? '+' : ''}${k0(it.net)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="국가별 포지션 변화">
  ${tv.map(v => `<line class="grid" x1="${M.l}" y1="${yAt(v).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(v).toFixed(1)}"/>
    <text class="ax" x="${M.l - 8}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${tf(v)}</text>`).join('')}
  ${axis ? `<text class="axu" x="${axuX(M.l - 8, axis, W, true).toFixed(1)}" y="${M.t - 6}">${esc(axis)}</text>` : ''}
  <line class="zero" x1="${M.l}" y1="${yAt(0).toFixed(1)}" x2="${M.l + iw}" y2="${yAt(0).toFixed(1)}"/>
  ${bars}
  ${labels}
  ${title ? `<text class="unit" x="${M.l}" y="13">${esc(title)}</text>` : ''}
</svg>`;
}

function lendingChartStatic(series, cyclePeakDate) {
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

  // '잔고 고점' 라벨은 M.t-4 에 있어 축 제목 줄(y=14)과 같은 높이였고, 고점이 계열 끝쪽이라
  // 오른쪽의 '코스피(p)' 와 겹쳤다. 축 제목 줄을 비켜 플롯 안쪽으로 내리고, 오른쪽 끝에서는
  // 라벨이 잘리지 않게 안으로 민다.
  const peakI = series.findIndex(p => p.d === cyclePeakDate);
  const peakMark = peakI < 0 ? '' : (() => {
    const [p] = placeLabels(
      [{ cx: xAt(peakI), cy: M.t + 12, text: '잔고 고점' }],
      { W: M.l + iw, minY: M.t }
    );
    return `<line class="wmark mu" x1="${xAt(peakI).toFixed(1)}" y1="${M.t}" x2="${xAt(peakI).toFixed(1)}" y2="${(M.t + ih).toFixed(1)}"/>
       <text class="wlab mu" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">잔고 고점</text>`;
  })();

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

/* ---------- 해외 반도체 공매도 ---------- */
// 국내 대차잔고와 같은 질문을 미국 반도체에 묻는다. 두 계열의 주기가 달라 표를 나눈다.
/* ---------- PART 6 국가별 포지셔닝 (§36) ---------- */
const countrySection = !A.countryFlow ? '' : (() => {
  const C = A.countryFlow;
  const sgn = (n, d = 0) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(d)}` : '-');
  const sell = C.items.filter(x => x.net < 0);
  const buy = C.items.filter(x => x.net > 0);
  const worst = C.items[0];
  const kr = C.items.find(x => x.s === 'EWY');

  const rows = C.items.map(it => `<tr${it.s === 'EWY' ? ' class="r-base"' : ''}>
    <td>${esc(it.country)} <span class="mut">${esc(it.s)}</span></td>
    <td class="mut">${it.citi ? esc(it.citi) : '-'}</td>
    <td class="n">${k0(it.siQty / 1e6)}</td>
    <td class="n ${it.changePct >= 0 ? 'dn' : 'up'}">${sgn(it.changePct, 1)}%</td>
    <td class="n">${sgn(it.z, 2)}</td>
    <td class="n">${it.newShorts ? k0(it.newShorts) : '-'}</td>
    <td class="n">${it.coverShorts ? '+' + k0(it.coverShorts) : '-'}</td>
    <td class="n">${it.hasLong ? sgn(it.newLongs + it.coverLongs) : '<span class="mut">수집중</span>'}</td>
    <td class="n"><b>${sgn(it.net)}</b></td>
    <td class="n ${it.retPct >= 0 ? 'up' : 'dn'}">${sgn(it.retPct, 1)}%</td>
    <td class="n">${f(it.svLast, 1)}%</td>
    <td class="n">${f(it.daysToCover, 2)}</td>
  </tr>`).join('');

  // 정산일별 Net 추이 — 이번 창이 유별난지 아니면 원래 그런지 본다.
  const dates = C.items[0].history.map(h => h.d.replace(/-/g, ''));
  const netRows = dates.map((d, i) => {
    const r = { d };
    for (const it of C.items) r[it.s] = it.history[i]?.net ?? null;
    return r;
  });
  const LINE = ['ln-cr', 'ln-idx', 'ln-kq', 'ln-base', 'ln-base', 'ln-base', 'ln-base', 'ln-base'];
  const focus = ['EWY', 'EWJ', 'EWH', 'FXI'];

  return `<section>
<h2>국가별 포지셔닝 — 돈이 어느 나라에서 빠지고 어디로 도는가</h2>
<p class="lead">공매도 잔고와 상장좌수의 <b>변화 부호</b>를 네 갈래로 쪼갠다. 늘면 신규 진입, 줄면 청산이다.
매수(숏 커버·신규 롱)는 0 위로, 매도(신규 숏·롱 청산)는 0 아래로 쌓고 순합계를 마름모로 찍는다.</p>

<figure>
  <h4>${dtFull(C.windowFrom.replace(/-/g, ''))} → ${dtFull(C.windowTo.replace(/-/g, ''))} 정산 구간</h4>
  ${countryBarChart(C.items)}
  <div class="lg"><span><i class="sw acc"></i>신규 롱</span><span><i class="sw cr"></i>신규 숏</span><span><i class="sw bar"></i>롱 청산</span><span><i class="sw part"></i>숏 커버</span><span><i class="sw net"></i>Net</span></div>
  <figcaption>막대 아래 숫자가 Net(백만달러). ${C.withLong === 0
    ? `<b>신규 롱·롱 청산은 아직 비어 있다</b> — 좌수(순자산÷NAV)는 과거를 주는 API 가 없어
       ${dtFull(C.longSideFrom)}부터 쌓기 시작했고 지금 ${C.longSideDays}일치다. 다음 정산일부터 채워진다.
       0 으로 그리면 "설정·환매가 없었다" 는 거짓이 되므로 비워 뒀다.`
    : `롱 사이드는 ${dtFull(C.longSideFrom)} 이후 수집분(${C.longSideDays}일)으로 계산한 ${C.withLong}종목만 나온다.`}
  </figcaption>
</figure>

<div class="box${kr && kr.net < 0 ? ' warn' : ''}">
  <b>${sell.length ? `${sell.map(x => x.country).join('·')}에 매도, ${buy.map(x => x.country).join('·')}에 매수` : '전 지역 매수 우위'}</b> —
  ${kr ? `한국은 <b>${k0(kr.net)}백만달러</b>로 ${worst.s === 'EWY' ? '이 구간 최대 매도' : `${worst.country} 다음`}다.
  공매도 잔고가 ${sgn(kr.changePct, 1)}% 늘어 이 종목 과거 정산 구간 대비 <b>${sgn(kr.z, 2)}σ</b>,
  같은 구간 주가는 <b>${sgn(kr.retPct, 1)}%</b>였다.
  ${kr.changePct > 0 && kr.retPct < 0
    ? '<b>빠지는 와중에 숏이 새로 붙었다</b> — 차익실현이 아니라 방향성 베팅이다.'
    : kr.changePct > 0 ? '오르는데도 숏이 붙었다 — 반등에 맞선 포지션이다.'
      : '잔고가 줄어 되갚기 국면이다.'}` : ''}
</div>

<div class="tw"><table>
  <thead><tr><th>국가</th><th>씨티 대응</th><th class="n">공매도잔고(백만주)</th><th class="n">변화</th>
    <th class="n">z</th><th class="n">신규 숏</th><th class="n">숏 커버</th><th class="n">롱 사이드</th>
    <th class="n">Net</th><th class="n">구간 수익률</th><th class="n">일별 공매도비중</th><th class="n">DTC</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="lead">금액은 전부 <b>백만달러</b>. z 는 이 종목의 과거 ${C.settlements}개 정산 구간 대비 잔고 변화폭이다.
DTC(days to cover)는 평균 거래량으로 잔고를 되갚는 데 걸리는 날 수 — 낮을수록 숏이 쉽게 빠져나간다.</p>

<figure>
  <h4>정산 구간별 Net 추이 — 이번이 유별난가</h4>
  ${levelChart(netRows, C.items.filter(x => focus.includes(x.s)).map((x, i) => ({
    key: x.s, cls: LINE[i], name: x.country,
  })), '국가별 Net 포지션 변화 (백만달러)', { dg: 0, zeroBase: false })}
  <div class="lg">${C.items.filter(x => focus.includes(x.s)).map((x, i) =>
    `<span><i class="sw ${['cr', 'acc', 'kq', 'mut'][i]}"></i>${esc(x.country)}</span>`).join('')}</div>
  <figcaption>정산일 ${C.settlements}개. 0 아래면 그 구간에 그 나라에서 돈이 빠졌다는 뜻이다.</figcaption>
</figure>

${C.unitsRows.length < 2 ? '' : `<figure>
  <h4>일별 좌수(상장주식수) 추이 — EWY vs 주요 국가 ETF</h4>
  ${levelChart(C.unitsRows, C.ishareSyms.filter(s => focus.includes(s)).map((s, i) => ({
    key: s, cls: LINE[i], name: C.items.find(x => x.s === s)?.country ?? s,
  })), '상장좌수 (백만좌)', { dg: 1, zeroBase: false })}
  <div class="lg">${C.ishareSyms.filter(s => focus.includes(s)).map((s, i) =>
    `<span><i class="sw ${['cr', 'acc', 'kq', 'mut'][i]}"></i>${esc(C.items.find(x => x.s === s)?.country ?? s)} <span class="mut">${esc(s)}</span></span>`).join('')}</div>
  <figcaption>정산 구간(2주)과 달리 이건 진짜 매일이다 — iShares 는 순자산·NAV 를 매일 공표해서 좌수(= 순자산÷NAV)를
    바로 계산할 수 있다. 과거를 주는 API 가 없어 ${dtFull(C.longSideFrom)}부터 ${C.longSideDays}일치만 쌓였다 —
    짧지만 매일 늘어난다. 좌수가 늘면 설정(매수 유입), 줄면 환매(매도 유출)다.</figcaption>
</figure>`}

<div class="box">
  <b>이건 선물이 아니라 ETF 다</b> — 원 차트는 지수 선물 미결제약정을 쓴다. 그런데 선물 미결제약정은
  거래소마다 따로 공표하고 익명으로는 안 준다(KRX·SGX·HKEX·JPX·CME 전부 확인). 그래서 같은 질문을
  <b>미국 상장 국가 ETF</b> 에 물었다. 선물은 헤지·차익 수요가 크고 ETF 는 자산배분 수요가 커서
  <b>같은 수가 나오지는 않는다</b>. 다만 외국인이 나라를 통째로 사고파는 주된 통로가 국가 ETF 라
  방향과 상대 순위는 비교할 만하다. 실제로 이 구간 한국 Net(${k0(kr?.net ?? 0)}백만달러)은
  씨티가 코스피200 선물에서 집계한 −23억달러와 부호·크기 모두 가깝다.
</div>

<div class="box">
  <b>주간이 아니라 정산 구간이다</b> — 씨티는 주간으로 끊지만 FINRA 공매도 잔고는 <b>월 2회</b>(15일·말일)
  정산이라 주간으로 만들 수 없다. 없는 주기를 보간해 지어내지 않고 정산 구간 그대로 쓴다.
  구간 사이의 온도는 표의 <b>일별 공매도비중</b>(Reg SHO, 매일)이 대신 보여준다.
</div>
</section>`;
})();

const globalSemisSection = !A.globalSemis ? '' : (() => {
  const G = A.globalSemis;
  const dram = G.items.find(x => x.s === 'MU');
  const M = G.memory;
  const hot = [...G.items].filter(x => x.z != null).sort((a, b) => b.z - a.z)[0];
  const cold = [...G.items].filter(x => x.z != null).sort((a, b) => a.z - b.z)[0];
  const row = it => `<tr>
    <td>${esc(it.s)} <span class="mut">${esc(it.name)}${it.note ? ` · ${esc(it.note)}` : ''}</span></td>
    <td class="n">${f(it.last.pct, 1)}%</td>
    <td class="n">${f(it.avg20, 1)}%</td>
    <td class="n ${it.z >= 1 ? 'dn' : it.z <= -1 ? 'up' : ''}">${it.z == null ? '-' : `${it.z >= 0 ? '+' : ''}${f(it.z, 2)}`}</td>
    <td class="n">${it.shortQty == null ? '-' : f(it.shortQty / 1e6, 1)}</td>
    <td class="n">${it.daysToCover ?? '-'}</td>
    <td class="n ${(it.siChangePct ?? 0) >= 0 ? 'dn' : 'up'}">${it.siChangePct == null ? '-' : `${it.siChangePct >= 0 ? '+' : ''}${f(it.siChangePct, 1)}%`}</td>
  </tr>`;
  return `<section>
<h2>해외 반도체 공매도 — 같은 질문을 미국에 묻는다</h2>
<p class="lead">국내는 대차잔고를 공매도 프록시로 쓴다(§16). 미국은 <b>공매도 잔고가 직접 공표</b>되므로
  프록시가 필요 없다. 대신 <b>주기가 다른 두 계열</b>을 섞지 않는 게 중요하다.</p>

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">${!M ? '' : `<b>공매도가 메모리 쪽에 쏠려 있다</b> — 메모리 계열 평균 z <b>${f(M.avgZ, 2)}</b> vs
    비메모리 ${f(M.nonMemoryAvgZ, 2)}.
    ${M.etf ? `메모리 순수 테마인 <b>DRAM ETF 는 공매도 잔고가 직전 정산 대비 ${M.etf.siChangePct >= 0 ? '+' : ''}${f(M.etf.siChangePct, 1)}%</b>
    (${f(M.etf.shortQty / 1e6, 1)}백만주)로 급증했는데, 일별 거래 비중은 ${f(M.etf.last.pct, 1)}%로 평소(${f(M.etf.avg20, 1)}%)와 같다 —
    <b>매일 격하게 팔리는 게 아니라 잔고가 쌓인 것</b>이다.` : ''}
    ${dram ? ` 개별주에서는 마이크론(MU)이 z <b>${f(dram.z, 2)}</b>로 가장 높다.` : ''}`}</div>
</div>

${!M ? '' : `<h3>메모리(DRAM) 계열</h3>
<div class="tw"><table>
  <thead><tr><th>종목</th><th class="n">공매도 거래비중<br><span class="mut">${dtFull(G.to)}</span></th>
    <th class="n">20일 평균</th><th class="n">z</th>
    <th class="n">공매도 잔고<br><span class="mut">백만주 · ${G.siDate ?? '-'}</span></th>
    <th class="n">잔고 변화</th></tr></thead>
  <tbody>${M.items.map(it => `<tr>
    <td>${esc(it.s)} <span class="mut">${esc(it.name)}${it.note ? ` · ${esc(it.note)}` : ''}</span></td>
    <td class="n">${f(it.last.pct, 1)}%</td>
    <td class="n">${f(it.avg20, 1)}%</td>
    <td class="n ${it.z >= 1 ? 'dn' : it.z <= -1 ? 'up' : ''}">${it.z == null ? '-' : `${it.z >= 0 ? '+' : ''}${f(it.z, 2)}`}</td>
    <td class="n">${it.shortQty == null ? '-' : f(it.shortQty / 1e6, 1)}</td>
    <td class="n ${(it.siChangePct ?? 0) >= 0 ? 'dn' : 'up'}">${it.siChangePct == null ? '-' : `${it.siChangePct >= 0 ? '+' : ''}${f(it.siChangePct, 1)}%`}</td>
  </tr>`).join('')}</tbody>
</table></div>
<div class="box">
  <b>DRAM ETF 는 국내 단일종목 레버리지와 같은 구조다</b> — Roundhill Memory ETF(<code>DRAM</code>)는
  2026-04-02 상장한 세계 최초의 메모리 순수 테마 ETF 로, DRAM·HBM·NAND·SSD 를 담는다.
  ${M.lev.length ? `2배 레버리지도 <b>${M.lev.map(x => esc(x.s)).join('·')}</b> 로 나와 있다(${M.lev.map(x => `${esc(x.s)} ${f(x.last.pct, 1)}%`).join(', ')}).` : ''}
  국내 삼성·하이닉스 단일종목 레버리지(§33.1)와 <b>같은 기초자산에 같은 방식으로 걸린 돈</b>이라,
  국내만 보면 메모리에 걸린 레버리지·공매도를 절반만 보는 셈이다.
  <span class="mut">RAML 은 2026-07-23 상장이라 ${G.siDate} 정산 잔고에는 아직 없다.</span>
</div>`}

<h3>반도체 전체</h3>

<div class="tw"><table>
  <thead><tr><th>종목</th><th class="n">공매도 거래비중<br><span class="mut">${dtFull(G.to)}</span></th>
    <th class="n">20일 평균</th><th class="n">z</th>
    <th class="n">공매도 잔고<br><span class="mut">백만주</span></th><th class="n">DTC</th>
    <th class="n">잔고 변화<br><span class="mut">${G.siPrevDate ? `vs ${G.siPrevDate}` : ''}</span></th></tr></thead>
  <tbody>${G.items.map(row).join('')}</tbody>
</table></div>

<figure>
  <h4>공매도 거래 비중 추이 — DRAM·레버리지 ETF</h4>
  ${(() => {
    const pick = ['MU', 'NVDA', 'SOXL'].map(sym => G.items.find(x => x.s === sym)).filter(Boolean);
    if (pick.length < 2) return '';
    const dates = [...new Set(pick.flatMap(p => p.series.map(r => r.d)))].sort();
    const rows = dates.map(d => {
      const o = { d };
      for (const p of pick) o[p.s] = p.series.find(r => r.d === d)?.pct ?? null;
      return o;
    });
    const cls = ['ln-cr', 'ln-idx', 'ln-kq'];
    return `${levelChart(rows, pick.map((p, i) => ({ key: p.s, cls: cls[i], name: p.s })),
      '공매도 거래량 / 총 거래량 (%)', { dg: 1, zeroBase: false })}
    <div class="lg">${pick.map((p, i) => `<span><i class="sw ${['cr', 'acc', 'kq'][i]}"></i>${esc(p.s)}</span>`).join('')}</div>`;
  })()}
  <figcaption>${dtFull(G.from)}~${dtFull(G.to)}, ${G.days}거래일. FINRA Reg SHO 일별 파일에서 받는다.</figcaption>
</figure>

<div class="box warn">
  <b>이 표를 읽는 법 — 두 계열의 주기가 다르다</b>
  <ul style="margin:6px 0 0 18px">
    <li><b>공매도 거래비중은 매일</b> 갱신된다. 그날 매도 중 공매도가 차지한 몫이다.</li>
    <li><b>공매도 잔고는 월 2회</b>(15일·말일 정산)만 나오고 8영업일가량 지연된다.
      최신이 <b>${G.siDate}</b>인 이유다 — <b>매일 갱신할 수 없는 계열</b>이다.</li>
  </ul>
  그리고 <b>거래비중의 절대 수준을 "공매도가 심하다" 로 읽으면 안 된다.</b> 마켓메이커의 헤지성 매도가
  섞여 미국 대형주는 평시에도 40~50%가 흔하다. 그래서 표에 <b>z점수</b>(같은 종목의 ${G.days}일 평균 대비)를
  같이 뒀다 — 절대 수준이 아니라 <b>그 종목 기준으로 평소보다 높은가</b>를 봐야 한다.
  <br><b>대상</b>: 메모리 순수 테마 ETF(DRAM)와 그 2배 레버리지(RAML·RAM), 메모리 개별주(MU·SNDK·WDC·STX),
  반도체 대형주, 반도체 ETF(SMH·SOXX), 반도체 3배 레버리지(SOXL·SOXS).
</div>
</section>`;
})();

/* ---------- 종목별 대차잔고·외국인 지분율 ---------- */
// 시장 전체 잔고는 "얼마나 더 오를 수 있나" 를 묻는다. 여기서는 그 잔고가 어디에 붙어 있는지를 묻는다.
const stockFlowSection = !A.stockFlow ? '' : (() => {
  const S = A.stockFlow, items = S.items;
  const [a, b] = items;
  const cls = ['ln-idx', 'ln-cr'];

  // 두 종목을 한 축에 놓으려면 정규화가 필요하다 — 주수는 스케일이 8배, 금액은 주가가 6.5배 차이라
  // 둘 다 그대로는 비교가 안 된다. 상장주식수 대비 비중이 유일하게 같은 자로 잰 값이다.
  const merge = key => {
    const dates = [...new Set(items.flatMap(it => it.series.map(r => r.d)))].sort();
    const by = items.map(it => new Map(it.series.map(r => [r.d, r[key]])));
    return dates.map(d => ({ d, ...Object.fromEntries(items.map((it, i) => [it.code, by[i].get(d) ?? null])) }));
  };
  const lines = items.map((it, i) => ({ key: it.code, cls: cls[i], name: it.name }));
  const legend = items.map((it, i) => `<span><i class="sw ${i ? 'cr' : 'acc'}"></i>${esc(it.name)}</span>`).join('');

  const row = (label, fn) => `<tr><td>${label}</td>${items.map(it => `<td class="n">${fn(it)}</td>`).join('')}</tr>`;

  return `<section>
<h2>오늘의 현황 — 매일 보는 자리</h2>
<div class="cards">
  ${items.map(it => `<div class="card">
    <div class="lb">${esc(it.name)} 대차잔고</div>
    <div class="vl">${f(it.last.shares / 1e6, 1)}<span class="u">백만주</span></div>
    <div class="nt">상장 대비 ${f(it.last.pctListed, 2)}% · 20일 ${it.d20Pct >= 0 ? '+' : ''}${f(it.d20Pct, 1)}%
      · 고점대비 ${f(it.fromPeakPct, 1)}%</div>
  </div>`).join('')}
  ${items.map(it => !it.foreign ? '' : `<div class="card">
    <div class="lb">${esc(it.name)} 외국인 지분율</div>
    <div class="vl">${f(it.foreign.last.foreignPct, 2)}<span class="u">%</span></div>
    <div class="nt">저점 대비 +${f(it.foreign.fromLowPp, 2)}%p · 20일 ${it.foreign.d20Pp >= 0 ? '+' : ''}${f(it.foreign.d20Pp, 2)}%p
      · 최고 ${f(it.foreign.high.foreignPct, 2)}%</div>
  </div>`).join('')}
</div>
<p class="lead">${dtFull(S.asOf)} 기준. 매일 자동으로 갱신된다 —
  대차잔고는 FREESIS 종목별 대차거래, 외국인 지분율은 네이버 금융 일별에서 받는다(§26).
  아래 차트는 커서를 올리면 그날 값이 뜨고, 맨 위 구간 상자로 기간을 좁힐 수 있다.</p>

<h2>그 잔고는 어디에 붙어 있나 — 삼성전자·SK하이닉스</h2>
<p class="lead">시장 전체 대차잔고(위)가 얼마나 남았는지를 물었다면, 여기서는 <b>어느 종목에</b> 남았는지를 본다.
  코스피 등락의 상당 부분을 두 종목이 설명하므로(PART 3), 지수의 상방 여력을 볼 때 이 둘의 잔고가
  시장 평균과 같이 움직이는지가 중요하다. 외국인 지분율을 나란히 놓은 이유는, 되갚기(숏커버)와
  외국인 재유입이 상방을 만드는 두 축이기 때문이다.</p>

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">두 종목이 갈렸다. <b>${esc(a.name)}는 대차잔고가 다시 쌓이는 중</b>(20일 ${a.d20Pct >= 0 ? '+' : ''}${f(a.d20Pct, 1)}%)이고,
    <b>${esc(b.name)}는 고점 대비 ${f(b.fromPeakPct, 1)}%</b>로 이미 대부분 정리됐다(20일 ${b.d20Pct >= 0 ? '+' : ''}${f(b.d20Pct, 1)}%).
    외국인 지분율은 반대로 <b>${esc(b.name)}가 저점에서 ${f(b.foreign.fromLowPp, 2)}%p 되돌아왔고</b>
    ${esc(a.name)}는 ${f(a.foreign.fromLowPp, 2)}%p로 아직 저점 근처다.</div>
</div>

<figure>
  <h4>대차잔고 — 상장주식수 대비 비중</h4>
  ${levelChart(merge('pctListed'), lines, '대차잔고 / 상장주식수 (%)', { dg: 1, zeroBase: false })}
  <div class="lg">${legend}</div>
  <figcaption>주수를 상장주식수로 나눠 같은 자로 맞췄다. 주수 그대로는 ${esc(a.name)}가
    ${f(a.last.shares / b.last.shares, 1)}배라 한 축에 못 놓고, 금액으로는 주가가 달라
    ${f(a.last.valueJo)}조 vs ${f(b.last.valueJo)}조로 <b>거의 같아 보이는 착시</b>가 생긴다.</figcaption>
</figure>

${items.map(it => {
  const B = it.foreignBand;
  if (!B) return '';
  const rows = it.series.filter(r => r.foreignPct != null)
    .map(r => ({ d: r.d, v: r.foreignPct, mean: B.mean, hi: B.hi1, lo: B.lo1 }));
  if (rows.length < 20) return '';
  const z = B.z;
  return `<figure>
  <h4>${esc(it.name)} 외국인 지분율 — 평균 대비 어디쯤인가</h4>
  ${levelChart(rows, [
    { key: 'v', cls: 'ln-idx', name: '지분율' },
    { key: 'mean', cls: 'ln-cr', name: '평균' },
    { key: 'hi', cls: 'ln-base', name: '+1σ' },
    { key: 'lo', cls: 'ln-base', name: '-1σ' },
  ], `${esc(it.name)} 외국인 지분율 (%)`, { dg: 1, zeroBase: false })}
  <div class="lg"><span><i class="sw acc"></i>지분율</span><span><i class="sw cr"></i>평균 ${f(B.mean, 2)}%</span><span><i class="sw" style="background:var(--mut)"></i>±1σ (${f(B.lo1, 2)}~${f(B.hi1, 2)}%)</span></div>
  <figcaption>현재 <b>${f(it.foreign.last.foreignPct, 2)}%</b>는 이 구간 평균 ${f(B.mean, 2)}%에서
    <b class="${z <= -2 ? 'dn' : ''}">${f(z, 2)} 표준편차</b> 떨어져 있다(표본 ${B.n}일, σ=${f(B.sd, 2)}%p).
    ${z <= -2 ? '<b>−2σ 아래</b>다 — 외국인 비중이 이 구간에서 가장 낮은 축이라는 뜻이다.'
      : z <= -1 ? '−1σ 아래로, 평균보다 뚜렷이 낮다.' : '평균 근처다.'}
    <b>주의</b>: 표본이 ${B.n}일이라 여기서 말하는 '평균' 은 장기 평균이 아니라 <b>이 구간의 평균</b>이다.
    수집이 쌓일수록 밴드가 넓어질 수 있다.</figcaption>
</figure>`;
}).join('')}

<figure>
  <h4>외국인 지분율 — 두 종목 비교</h4>
  ${levelChart(merge('foreignPct'), lines, '외국인 지분율 (%)', { dg: 1, zeroBase: false })}
  <div class="lg">${legend}</div>
  <figcaption>네이버 금융 일별(외국인 보유주식수 ÷ 상장주식수). 0 기준이 아니라 값 범위에 맞춰 그렸다 —
    46~56% 구간의 움직임을 0부터 그리면 직선으로 보인다.</figcaption>
</figure>

${items.map(it => {
  const s = it.series.filter(r => r.close && r.foreignPct != null);
  if (s.length < 20) return '';
  const first = s[0], last = s.at(-1);
  const pxPct = (last.close / first.close - 1) * 100;
  const shPct = (last.shares / first.shares - 1) * 100;
  const frPp = last.foreignPct - first.foreignPct;
  const span = `${dtFull(first.d)} 이후`;
  // 세 계열을 한 축에 얹을 수 없다 — 주가는 이 구간에 몇 배가 됐고 지분율은 몇 %p 움직였다.
  // 지수화(=100)해도 주가가 나머지를 눌러 평평하게 만든다. x축만 맞춘 3단으로 쌓는다.
  return `<figure>
  <h4>${esc(it.name)} — 주가 · 대차잔고 · 외국인 지분율</h4>
  ${trendChart(s.map(r => ({ d: r.d, v: r.close / 1e4 })), `${esc(it.name)} 주가 (만원)`, 1, span)}
  ${trendChart(s.map(r => ({ d: r.d, v: r.shares / 1e6 })), '대차잔고 공매도 프록시 (백만주)', 0, span)}
  ${trendChart(s.map(r => ({ d: r.d, v: r.foreignPct })), '외국인 지분율 (%)', 1, span)}
  <figcaption>같은 기간 주가 <b>${pxPct >= 0 ? '+' : ''}${f(pxPct, 0)}%</b>,
    대차잔고 주수 <b>${shPct >= 0 ? '+' : ''}${f(shPct, 1)}%</b>,
    외국인 지분율 <b>${frPp >= 0 ? '+' : ''}${f(frPp, 2)}%p</b>.
    세 계열은 축이 서로 달라 <b>따로 그렸다</b> — 지수화해서 겹치면 주가가 나머지를 눌러 평평하게 만든다.
    x축 구간만 같다.</figcaption>
</figure>`;
}).join('')}

<div class="box">
  <b>주가가 오르는 내내 외국인 비중은 줄었다</b> — 이 구간은 전체로 보면 급등장이다
  (${esc(items[0].name)} ${f((items[0].last.close / items[0].series[0].close - 1) * 100, 0)}%,
  ${esc(items[1].name)} ${f((items[1].last.close / items[1].series[0].close - 1) * 100, 0)}%).
  그런데 외국인 지분율은 오히려 ${f(items[0].foreign.first.foreignPct - items[0].foreign.last.foreignPct, 1)}~${f(items[1].foreign.first.foreignPct - items[1].foreign.last.foreignPct, 1)}%p 낮아졌다.
  <b>올라가는 주식을 외국인이 덜어냈다</b>는 뜻이고, 그 물량을 받은 쪽이 개인이다(PART 3 투자자별 순매수).
  대차잔고 주수도 구간 전체로는 줄었다 — <b>다만 최근 흐름은 종목별로 갈린다</b>(위 판정 참조).
  주가 급등을 공매도 탓으로, 급락을 공매도 급증 탓으로 돌리는 설명은 이 세 계열 어디에서도 잘 지지되지 않는다.
</div>

<div class="tw"><table>
  <thead><tr><th>${dtFull(S.asOf)} 기준</th>${items.map(it => `<th class="n">${esc(it.name)}</th>`).join('')}</tr></thead>
  <tbody>
    ${row('주가(원)', it => k0(it.last.close))}
    ${row('대차잔고(백만주)', it => f(it.last.shares / 1e6, 1))}
    ${row('상장주식수 대비', it => f(it.last.pctListed, 2) + '%')}
    ${row('잔고 평가액(조)', it => f(it.last.valueJo))}
    ${row('사이클 고점', it => `${f(it.peak.shares / 1e6, 1)} <span class="mut">${dtFull(it.peak.d)}</span>`)}
    ${row('고점 대비', it => `<b class="${it.fromPeakPct <= -30 ? 'up' : 'dn'}">${f(it.fromPeakPct, 1)}%</b>`)}
    ${row('최근 20일', it => `<b class="${it.d20Pct >= 0 ? 'dn' : 'up'}">${it.d20Pct >= 0 ? '+' : ''}${f(it.d20Pct, 1)}%</b>`)}
    ${row('최근 60일', it => `${it.d60Pct >= 0 ? '+' : ''}${f(it.d60Pct, 1)}%`)}
    ${row('외국인 지분율', it => it.foreign ? f(it.foreign.last.foreignPct, 2) + '%' : '-')}
    ${row('외국인 최고', it => it.foreign ? `${f(it.foreign.high.foreignPct, 2)}% <span class="mut">${dtFull(it.foreign.high.d)}</span>` : '-')}
    ${row('외국인 최저', it => it.foreign ? `${f(it.foreign.low.foreignPct, 2)}% <span class="mut">${dtFull(it.foreign.low.d)}</span>` : '-')}
    ${row('저점 대비 회복', it => it.foreign ? `<b class="${it.foreign.fromLowPp >= 1 ? 'up' : ''}">+${f(it.foreign.fromLowPp, 2)}%p</b>` : '-')}
  </tbody>
</table></div>

<div class="box">
  <b>왜 대차잔고를 주수로 보나</b> — 금액으로 보면 ${esc(a.name)} ${f(a.last.valueJo)}조,
  ${esc(b.name)} ${f(b.last.valueJo)}조로 거의 같다. 그런데 주수는
  ${f(a.last.shares / 1e6, 1)}백만주 vs ${f(b.last.shares / 1e6, 1)}백만주로 ${f(a.last.shares / b.last.shares, 1)}배 차이다.
  주가가 오르면 한 주도 안 늘어도 금액이 커진다 — PART 3 에서 ETF 를 AUM 이 아니라 좌수로 본 것과 같은 이유다.
</div>

<div class="box warn">
  <b>한계</b> — 대차잔고는 공매도의 <b>프록시</b>일 뿐이다. 빌린 주식이 전부 공매도로 나가는 것은 아니고
  (차익거래·ETF 설정·의결권 관련 대차가 섞인다), 반대로 되갚기가 전부 숏커버 매수인 것도 아니다.
  외국인 지분율은 <b>보유 기준</b>이라 대차로 빌려준 주식도 그대로 잡힌다 — 두 계열을 더하거나 빼면 안 되고,
  각각의 방향만 읽어야 한다. 종목별 실제 공매도 잔고(순보유잔고)는 KRX 가 따로 공표하지만
  정보데이터시스템이 <b>로그인 필요(KRX Data Marketplace)</b>로 바뀌어 익명 수집이 안 된다(§26).
</div>
</section>`;
})();

let coverSection = '';
if (A.lending?.cover) {
  const CV = A.lending.cover, L = A.lending;
  const SH = CV.shares;                    // 주수 기준. 금액만 보면 가격 효과에 속는다(§16.4).
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
  <div class="card"><div class="lb">금액 기준 고점 대비</div><div class="vl">${f(CV.coveredJo)}<span class="u">조</span></div><div class="nt">고점의 ${f(CV.coveredPctOfPeak, 1)}% — <b>되갚음이 아니다</b></div></div>
  ${SH ? `<div class="card"><div class="lb">주수 기준 고점 대비</div><div class="vl">${f(SH.fromPeakPct, 1)}<span class="u">%</span></div><div class="nt">${f(SH.nowShares / 1e8, 2)}억주 · 최저 ${f(SH.troughFromPeakPct, 1)}%(${dtFull(SH.troughDate)})</div></div>
  <div class="card"><div class="lb">최저 이후 재증가</div><div class="vl">+${f(SH.fromTroughPct, 1)}<span class="u">%</span></div><div class="nt">주수 기준 · 최근 20일 ${SH.d20Pct >= 0 ? '+' : ''}${f(SH.d20Pct, 1)}%</div></div>`
    : `<div class="card"><div class="lb">= 하루 거래대금의</div><div class="vl">${f(CV.coveredEquivDays, 1)}<span class="u">배</span></div><div class="nt">최근 20일 평균 ${f(CV.dailyTurnoverJo)}조/일</div></div>`}
  <div class="card"><div class="lb">현재 잔고/시총</div><div class="vl">${f(CV.nowRatio)}<span class="u">%</span></div><div class="nt">이번 고점 ${f(CV.peakRatio)}% · 직전 저점 ${f(CV.prevTroughRatio)}%</div></div>
</div>

${SH ? `<div class="box warn">
  <b>맨 왼쪽 카드를 "이미 ${f(CV.coveredJo)}조가 되갚아졌다"로 읽으면 안 된다.</b>
  대차잔고는 <b>주수 × 주가</b>라, 지수가 빠지면 한 주도 갚지 않아도 금액이 줄어든다.
  금액 고점(${dtFull(SH.moneyPeakDate)}) 이후를 로그로 쪼개면 금액 <b>${f(SH.moneyDeclinePct, 1)}%</b> 중
  주수는 오히려 <b>${SH.sharesSinceMoneyPeakPct >= 0 ? '+' : ''}${f(SH.sharesSinceMoneyPeakPct, 1)}%</b>이고,
  감소분의 <b>${f(SH.priceShareOfMoveePct, 0)}%가 가격</b>이다. 빌린 주식은 갚아지지 않았다.
  PART 3 에서 ETF 를 AUM 이 아니라 좌수로 본 것과 <b>정확히 같은 함정</b>이다(§16.4).
</div>` : ''}

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

${SH ? `<figure>
  <h4>대차잔고 — 주수 기준 (억주)</h4>
  ${trendChart(SH.series, '대차잔고 주수 (억주)', 2, `${dtFull(SH.series[0].d)} 이후`)}
  <figcaption>같은 기간 금액 곡선은 지수를 따라 출렁이지만 주수는 그렇지 않다.
    사이클 시작 ${f(SH.series[0].v, 2)}억주에서 고점 ${dtFull(SH.peakDate)} ${f(SH.peakShares / 1e8, 2)}억주까지
    <b>${f(SH.peakShares / 1e8 / SH.series[0].v, 1)}배</b>로 쌓였고, 되돌린 것은 최저 ${dtFull(SH.troughDate)}
    ${f(SH.troughShares / 1e8, 2)}억주(고점 대비 ${f(SH.troughFromPeakPct, 1)}%)까지가 전부다.
    현재 ${f(SH.nowShares / 1e8, 2)}억주로 <b>7월 중순 이후 다시 늘고 있다</b> —
    1차 되돌림은 ${dtFull(SH.troughDate)}에 멈췄고, 그 뒤로는 되갚기가 아니라 재차 쌓이는 국면이다.
    <span class="mut">차트의 '저' 표시는 그린 구간 전체의 최저(사이클 시작 수준)이고,
    되돌림의 최저는 ${dtFull(SH.troughDate)} ${f(SH.troughShares / 1e8, 2)}억주다.</span></figcaption>
</figure>` : ''}

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
  const CD = C.creditToDeposit;      // 커버리지의 역수 + 정상 수준 기준선
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
    { key: 'dep', cls: 'ln-idx', name: '예탁금' }, { key: 'cr', cls: 'ln-cr', name: '신용융자' },
    { key: 'pl', cls: 'ln-kq', name: '담보융자' },
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

${!CD ? '' : `<h3>같은 값을 뒤집어서 — 예탁금 대비 신용융자</h3>
<p class="lead">커버리지(예탁금 ÷ 신용융자)를 뒤집으면 <b>"빚이 대기자금의 몇 %인가"</b>가 된다. 같은 정보지만
  이쪽이 과열 여부를 묻기 쉽다. 그리고 <b>고점 대비로만 보면 안 된다</b> — 그 고점이 정상이었을 수도 있기 때문에,
  중앙값을 기준선으로 같이 놓는다.</p>

<div class="cards">
  <div class="card"><div class="lb">현재 신용융자/예탁금</div><div class="vl">${f(CD.last.ratio, 1)}<span class="u">%</span></div><div class="nt">${f(CD.last.creditJo)}조 ÷ ${f(CD.last.depositJo, 0)}조 · 역대 ${f(CD.pct, 0)}분위</div></div>
  <div class="card"><div class="lb">역대 최고</div><div class="vl">${f(CD.high.ratio, 1)}<span class="u">%</span></div><div class="nt">${dtFull(CD.high.date)} · 현재는 그 ${f(CD.last.ratio / CD.high.ratio * 100, 0)}% 수준</div></div>
  <div class="card"><div class="lb">정상 수준(최근 3년 중앙값)</div><div class="vl">${f(CD.normal.y3, 1)}<span class="u">%</span></div><div class="nt">전 구간 ${f(CD.normal.all, 1)}% · 2024년 ${f(CD.normal.y2024, 1)}%</div></div>
  ${CD.total ? `<div class="card"><div class="lb">총 레버리지/예탁금</div><div class="vl">${f(CD.total.last.ratio, 1)}<span class="u">%</span></div><div class="nt">담보융자 포함 · 역대 ${f(CD.total.pct, 0)}분위</div></div>` : ''}
</div>

<div class="box warn">
  <b>신용 고점달도 과열이 아니었다</b> — 신용융자 절대액이 사상 최대 ${f(CD.atCreditPeak?.creditJo)}조를 찍은
  ${dtFull(CD.atCreditPeak?.date)}조차 이 비율은 <b>${f(CD.atCreditPeak?.ratio, 1)}%</b>였다. 예탁금이
  ${f(CD.atCreditPeak?.depositJo, 0)}조로 같이 불어났기 때문이다. 그 달 최대치도 ${f(CD.peakMonthHigh?.ratio, 1)}%로
  최근 3년 중앙값 ${f(CD.normal.y3, 1)}%보다 <b>낮았다</b>.
  현재 ${f(CD.last.ratio, 1)}%는 "정상까지 내려왔다"가 아니라 <b>정상보다 아래</b>다.
</div>

${CD.divergesFromTotal ? `<div class="box warn">
  <b>담보융자를 더하면 방향이 뒤집힌다</b> — 신용융자만 보면 신용 고점달 ${f(CD.peakMonthHigh.ratio, 1)}% →
  현재 ${f(CD.last.ratio, 1)}%로 내려왔다. 그런데 총 레버리지(신용+담보융자) 기준으로는
  그 달 ${f(CD.total.peakMonthHigh.totRatio, 1)}% → 현재 <b>${f(CD.total.last.ratio, 1)}%로 오히려 높다</b>.
  담보융자가 안 줄어드는 사이 <b>예탁금이 더 빨리 빠졌기</b> 때문이다.
  위에서 말한 "사다리가 안 세는 레버리지"가 비율에서도 똑같이 드러난다.
</div>` : ''}

<div class="box">
  <b>이 비율이 낮다고 안전한 것은 아니다</b> — 분모인 예탁금이 급락 때 같이 빠진다.
  실제로 ${dtFull(CD.atCreditPeak?.date)} ${f(CD.atCreditPeak?.depositJo, 0)}조 → ${dtFull(CD.last.date)} ${f(CD.last.depositJo, 0)}조로
  ${f((1 - CD.last.depositJo / (CD.atCreditPeak?.depositJo ?? 1)) * 100, 0)}% 줄었다. 분자와 분모가 같은 방향으로 움직이면
  비율은 위험을 <b>과소평가</b>한다. 역대 최고 ${f(CD.high.ratio, 1)}%(${dtFull(CD.high.date)})가 나온 것도
  예탁금 규모가 지금과 전혀 달랐던 시절이기 때문이다. 또 예탁금은 <b>대기자금</b>이지 반드시 매수에 쓰이는 돈이 아니다.
</div>`}

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

/* ---------- 오늘의 종합 판정 (§35) ---------- */
// 페이지 최상단. 여기 있는 문장·판정·점수는 전부 analyze.mjs 의 dailyVerdict() 가
// 매일 다시 계산한다 — 이 파일에는 고정된 결론 문구가 하나도 없어야 한다.
const verdictSection = !A.verdict ? '' : (() => {
  const V = A.verdict;
  const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const MARK = { ok: '완화', watch: '중립', alert: '경계' };

  const axisBlock = a => `<div class="vax vax-${a.axis}">
    <div class="vaxh"><b>${esc(a.label)}</b><span class="mut">${esc(a.q)}?</span></div>
    <div class="vaxs"><i class="vc ok"></i>${a.ok}<i class="vc watch"></i>${a.n - a.ok - a.alert}<i class="vc alert"></i>${a.alert}</div>
    ${V.signals.filter(s => s.axis === a.axis).map(s => `<div class="vsig">
      <div class="vsh"><span class="vst s-${s.state}">${MARK[s.state]}</span>
        <span class="vsl">${esc(s.label)}</span><span class="vsv">${esc(s.value)}</span></div>
      <div class="vsw">${md(s.why)}</div>
    </div>`).join('')}
  </div>`;

  return `<section class="today" id="top-verdict">
<div class="tdh">
  <div>
    <div class="kicker">오늘의 종합 판정</div>
    <h2>${V.asOf ? dtFull(V.asOf) : ''} 기준 — ${esc(V.stance.label)}</h2>
  </div>
  <div class="tdscore s-${V.stance.key}">
    <b>${V.total >= 0 ? '+' : ''}${V.total}</b>
    <span>${V.n}개 지표 중<br>완화 ${V.signals.filter(s => s.state === 'ok').length} · 경계 ${V.signals.filter(s => s.state === 'alert').length}</span>
  </div>
</div>

<p class="tdlead">${md(V.headline)}</p>

${V.moves.length ? `<div class="tdmoves"><span class="mut">오늘 움직인 것</span>${V.moves.map(m => `<span class="tdm">
  ${esc(m.label)} <b>${f(m.value)}${esc(m.unit)}</b>
  <i class="${m.pct >= 0 ? 'up' : 'dn'}">${m.pct >= 0 ? '+' : ''}${f(m.pct, 2)}%</i></span>`).join('')}</div>` : ''}

<div class="vaxes">${V.axes.map(axisBlock).join('')}</div>

<p class="tdfoot">${md(V.caveat)} 각 판정의 계산은 아래 <b>핵심 요약</b>과 PART 1~5 에 그대로 이어진다.</p>
</section>`;
})();

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
  const DV = A.divergence && {
    k: A.divergence.items.find(x => x.market === '유가증권'),
    q: A.divergence.items.find(x => x.market === '코스닥'),
  };

  const downList = [
    li(`지수는 ${f(b.idxDrawdownPct, 1)}% 빠졌는데 신용은 ${f(b.unwindPct, 1)}%만 청산됐다`,
      `겉보기로는 잔여가 크다. 2021 사이클 청산률(${f(ca.headline.unwindPct, 1)}%)을 그대로 대입하면 ${f(PJ.benches.find(x => x.key === 'unwindRate')?.remainJo)}조가 더 남는다.`),
    li('그런데 레버리지 강도가 그때와 다르다',
      `신용/시총은 현재 <b>${f(PJ.currentRatio?.ratio, 3)}%</b>로 <b>2023년 저점 ${f(PJ.prevTroughRatio?.ratio, 3)}%보다 이미 낮다</b>.
       "2022년처럼 풀려야 한다"는 전제 자체가 이 사이클에는 그대로 적용되지 않는다.`),
    li('남은 위험은 시간이 아니라 지수 경로다',
      `마진콜 모델 기준 현재 지수에서 새로 열리는 물량은 없다. 코스피가 5,000p 밑으로 마감해야 +${f(at5000)}조가 새로 마진콜 구간에 들어온다.`),
    DV ? li('그리고 그 위험은 코스피에만 남았다',
      `코스닥은 이번 사이클에 쌓은 것의 <b>${f(DV.q.retracedPctOfBuild, 0)}%</b>를 되돌려 잔고가 시작의 ${f(DV.q.multipleOfStart, 2)}배이고,
       신용/시총도 직전 저점의 ${f(DV.q.ratioVsPrevTrough, 2)}배로 <b>이미 저점 아래</b>다 — 되돌림이 끝났다.
       코스피는 <b>${f(DV.k.retracedPctOfBuild, 0)}%</b>만 되돌려 잔고가 아직 시작의 ${f(DV.k.multipleOfStart, 2)}배다.
       합계 청산률 ${f(b.unwindPct, 1)}%는 이 둘을 평균 낸 값이라 어느 쪽도 설명하지 못한다.`) : '',
    CH ? li(`사각지대 — 사다리가 안 세는 레버리지 ${f(CH.last.pledgeJo)}조`,
      `예탁증권담보융자는 청산 트리거가 공표되지 않아 마진콜 모델에서 빠져 있다.
       신용융자만 ${f(creditDeclinePct, 1)}% 풀렸고, 둘을 합친 총 레버리지는 <b>${f(levDeclinePct, 1)}%</b>만 줄었다.`) : '',
    CH ? li('대신 실탄은 2021년보다 두껍다',
      `예탁금 커버리지 ${f(CH.last.coverage)}배(역대 ${f(CH.pct, 0)}백분위). 2021년 신용 고점 당시 ${f(p21?.coverage)}배였다.`) : '',
  ].filter(Boolean).join('');

  const upList = CV ? [
    CV.shares ? li('금액은 줄었는데 빌린 주식은 안 줄었다',
      `대차잔고 금액은 고점 대비 ${f(CV.shares.moneyDeclinePct, 1)}%(${f(CV.coveredJo)}조)지만
       <b>주수는 ${CV.shares.sharesSinceMoneyPeakPct >= 0 ? '+' : ''}${f(CV.shares.sharesSinceMoneyPeakPct, 1)}%</b>다 —
       감소분의 ${f(CV.shares.priceShareOfMoveePct, 0)}%가 가격이다. 되갚아진 게 아니라 평가액이 빠진 것이다.`)
      : li(`이미 ${f(CV.coveredJo)}조가 되갚아졌다`,
        `대차잔고 고점의 ${f(CV.coveredPctOfPeak, 1)}%. 오늘 하루 거래대금의 ${f(CV.coveredEquivDays, 1)}배에 해당하는 매수가 이미 지나갔다.`),
    CV.shares ? li('1차 되돌림은 7월 중순에 멈췄다',
      `주수 기준 고점 대비 ${f(CV.shares.troughFromPeakPct, 1)}%까지 줄었다가(${dtFull(CV.shares.troughDate)})
       다시 <b>+${f(CV.shares.fromTroughPct, 1)}%</b> 늘어 현재 고점 대비 ${f(CV.shares.fromPeakPct, 1)}%다.
       지금은 되갚는 국면이 아니라 <b>다시 쌓이는 국면</b>이다.`) : '',
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

  // PART 3·4 도 같은 형식으로 결론을 올린다. 본문과 어긋나지 않게 숫자는 전부
  // 본문이 쓰는 것과 같은 필드에서 끌어온다(A.etf / A.outlook).
  const E = A.etf, O = A.outlook;
  const gsum = k => E?.groups.find(g => g.key === k && g.count) ?? null;
  const gPct = g => (g && g.sums[0].units > 0 ? (g.sums.at(-1).units / g.sums[0].units - 1) * 100 : null);
  const sgl = gsum('single_lev'), sec = gsum('sector_lev'), TA = E?.aumTotal;
  const unitsMult = sgl && sgl.sums[0].units > 0 ? sgl.sums.at(-1).units / sgl.sums[0].units : null;
  const era = Object.values(E?.stockDaily ?? {})[0] ?? null;
  const hk7709s = E?.hk?.products.find(p => p.ticker === '7709') ?? null;
  const hkInv = E?.hk?.products.find(p => p.lev < 0 && p.trend?.fromPeakPct != null) ?? null;

  const etfList = !E ? '' : [
    unitsMult ? li(`AUM은 반토막인데 좌수는 ${f(unitsMult, 1)}배다`,
      `단일종목 레버리지 좌수 ${f(sgl.sums[0].units / 1e6, 0)}백만 → <b>${f(sgl.sums.at(-1).units / 1e6, 0)}백만좌</b>.
       ${TA ? `합계 AUM은 고점 대비 ${f(TA.fromPeakPct, 1)}% 빠졌지만` : 'AUM은 줄었지만'}
       그 감소는 <b>환매가 아니라 가격</b>이다. 물량은 그대로 남아 있다.`) : '',
    sec ? li('같은 "레버리지"인데 두 계열이 정반대다',
      `반도체 섹터 레버리지는 좌수가 <b>${f(gPct(sec), 0)}%</b> — 여기선 실제 환매가 일어났다.
       단일종목만 쌓이고 있다. 한 덩어리로 묶어 "레버리지가 정리됐다"고 읽으면 틀린다.`) : '',
    era?.eras ? li('그래도 ETF를 변동성의 범인으로 지목하진 않는다',
      `${esc(era.name)} 평균 일중 진폭은 상장 전 이미 ${f(era.eras.before2025.meanAmplitude, 1)}% →
       ${f(era.eras.before2026.meanAmplitude, 1)}%로 올라와 있었다(상장 후 ${f(era.eras.after.meanAmplitude, 1)}%).
       <b>변동성 상승은 상장 전에 시작됐다</b> — 증폭은 했어도 원인은 아니다.`) : '',
    hk7709s ? li('홍콩도 같은 그림이다',
      `7709(하이닉스 2X) 좌수 5일 <b>${hk7709s.trend?.d5 >= 0 ? '+' : ''}${f(hk7709s.trend?.d5, 1)}%</b>로
       아직 쌓이는 쪽이다.
       ${hkInv ? `반면 인버스 상품은 고점 대비 <b>${f(hkInv.trend.fromPeakPct, 0)}%</b>로,
       역방향 베팅이 이미 쓸려 나갔다.` : ''}`) : '',
    li('공표된 청산 규칙이 없다는 점은 PART 1·2와 다르다',
      '리밸런싱 필요액은 상품 설계상 반드시 나가야 하는 매매지만, 체결 시각과 스왑 상대방의 헤지 방식은 공개되지 않는다. 사다리처럼 문턱을 찍어 말할 수 없다.'),
  ].filter(Boolean).join('');

  const nextList = !O ? '' : [
    O.firstTrigger ? li(`아래쪽은 ${f(Math.abs(O.firstTrigger.gapPct), 1)}% 버퍼가 생겼다`,
      `마진콜 첫 문턱이 ${k0(O.firstTrigger.threshold)}p다. 다음 주에 신용발 강제 매도가 나오려면
       그만큼 <b>더 빠져야</b> 한다. 지금 지수에서 새로 열리는 물량은 없다.`) : '',
    O.short ? li('위쪽은 오히려 연료가 쌓였다',
      `대차잔고 ${f(O.short.balJo)}조, 직전일 <b>${O.short.dBalPct >= 0 ? '+' : ''}${f(O.short.dBalPct, 1)}%</b>.
       지수가 크게 오른 날 잔고가 같이 늘었다면 <b>반등에 맞서 새로 짠 숏</b>이고,
       더 오르면 되갚아야 할 물량이다.`) : '',
    O.scenarios?.length ? (() => {
      const s5 = O.scenarios.at(-1);
      return li(`지수 ±${f(Math.abs(s5.retPct), 0)}%면 그날 ${f(Math.abs(s5.flowJo), 2)}조가 기계적으로 나온다`,
        `두 종목 하루 거래대금의 ${f(s5.pctOfTurnover, 1)}%. 오르면 사고 내리면 파는 크기가 <b>대칭</b>이라
         방향이 아니라 <b>진폭</b>을 키운다. 좌수가 사상 최대이므로 증폭기는 장전된 상태다.`);
    })() : '',
    (() => {
      const base = O.baseRates.find(x => x.n > 100);
      return base ? li('과거 유사 국면으로 방향은 못 읽는다',
        `조건을 건 표본들이 기준선(${base.n}일, 중앙값 ${base.median >= 0 ? '+' : ''}${f(base.median, 1)}%,
         상승확률 ${f(base.upRate, 0)}%)과 크게 다르지 않다. 이 표는 <b>진폭의 참고치</b>지 방향의 근거가 아니다.`) : '';
    })(),
    O.anchors ? li('외사와 갈리는 지점은 하나다 — AUM이냐 좌수냐',
      `${esc(O.anchors.sources.map(s => s.house).join('·'))} 모두 ETF AUM 반토막을 디레버리징의 진척으로 읽는다.
       우리 분해로는 그 감소가 거의 전부 가격이고 좌수는 늘었다.
       <b>AUM으로 보면 끝나가고, 좌수로 보면 시작도 안 했다.</b>`) : '',
  ].filter(Boolean).join('');

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

  // 매일 확인할 지표 둘째 — 신용융자 상승 추세. 메인 차트(PART 1 첫 그림)는 2020년부터라
  // 최근 며칠의 상승이 6년치 등락 옆에서 안 보인다. 여기는 최근 3개월만 잘라 보여준다.
  const CT = A.creditTrend;
  const creditSeries = A.daily?.items?.find(x => x.key === 'credit')?.series ?? [];
  const CVERD = {
    building: { label: '연속 상승 중', cls: 'w-build', line: '신용융자가 며칠째 다시 쌓이고 있다. 정리된 만큼 다시 채워지는 중이다.' },
    flat: { label: '방향 불분명', cls: 'w-flat', line: '하루짜리 반등인지 추세 전환인지 아직 구분할 수 없다.' },
    easing: { label: '정리 중', cls: 'w-roll', line: '되돌림이 계속되고 있다. 연속 상승은 아직 없다.' },
    unknown: { label: '판정 불가', cls: 'w-flat', line: '표본이 모자란다.' },
  };
  const creditBox = !CT || !creditSeries.length ? '' : (() => {
    const v = CVERD[CT.verdict];
    const sg = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${f(x, d)}%` : '-');
    return `<div class="watch ${v.cls}">
  <div class="wl">매일 볼 것 · 신용융자 상승 추세</div>
  <div class="wmain">
    <div class="wv">${f(CT.last.v)}<span class="u">조</span></div>
    <div class="wtag">${esc(v.label)}</div>
  </div>
  <div class="wnums">
    <span>전일 <b class="${CT.d1 >= 0 ? 'up' : 'dn'}">${sg(CT.d1)}</b></span>
    <span>5일 <b class="${CT.d5 >= 0 ? 'up' : 'dn'}">${sg(CT.d5)}</b></span>
    <span>10일 <b class="${CT.d10 >= 0 ? 'up' : 'dn'}">${sg(CT.d10)}</b></span>
    <span>연속 상승 <b>${CT.upStreak}일</b></span>
  </div>
  <div class="wline">${esc(v.line)} 메인 차트(PART 1)는 2020년부터라 최근 등락은 여기서 확대해서 본다.</div>
  <div class="wtrend">${trendChart(creditSeries.slice(-90), '신용융자 (조원)', 2, '최근 3개월')}</div>
</div>`;
  })();

  // 좌수가 "환매가 있었나" 라면 AUM 은 "시장에 주는 충격이 얼마나 큰가" 다 — 리밸런싱 필요액도,
  // 시장 거래대금에서 차지하는 몫도 AUM 에 비례한다. 좌수만 보면 그 축소를 놓친다.
  // 마진콜 스트레스 — 반대매매 ÷ 미수금(5일 이동평균). 절대액이 아니라 비율이라
  // "미수를 낸 사람들이 실제로 얼마나 털렸나" 가 바로 나온다. 평시 중앙값이 기준선이다.
  const MS = A.marginStress;
  const stressBox = !MS ? '' : `<div class="watch w-stress">
  <div class="wl">함께 볼 것 · 마진콜 스트레스</div>
  <div class="wmain">
    <div class="wv">${f(MS.last.ma5, 1)}<span class="u">%</span></div>
    <div class="wtag">평시의 ${f(MS.vsMedian, 2)}배</div>
  </div>
  <div class="wnums">
    <span>평시 중앙값 <b>${f(MS.med, 1)}%</b></span>
    <span>역대 <b>${f(MS.pct, 0)}백분위</b></span>
    <span>최근 고점 <b>${f(MS.peak.ma5, 1)}%</b> <span class="mut">(${dtFull(MS.peak.d)})</span></span>
    <span>미수금 <b>${f(MS.last.recvJo, 2)}조</b></span>
  </div>
  <div class="wline">반대매매 ÷ 위탁매매미수금, 5일 이동평균. ${MS.vsMedian <= 1.3
    ? '<b>평시 수준으로 돌아왔다</b> — 급락기에 터진 강제 청산은 대체로 소화됐다는 뜻이다.'
    : '<b>아직 평시보다 높다</b> — 강제 청산이 계속 나오고 있다.'}
    다만 이 비율은 <b>미수거래</b> 기준이라 신용융자 반대매매는 안 센다(§18).</div>
  <div class="wtrend">${levelChart(MS.series, [
    { key: 'ma5', cls: 'ln-cr', name: '반대매매/미수금 5MA (%)' },
    { key: 'recvJo', cls: 'ln-idx', name: '미수금 (조원)' },
  ], '마진콜 비율 (%) · 미수금 (조원)', { dg: 1, zeroBase: true })}</div>
  <div class="lg"><span><i class="sw cr"></i>반대매매/미수금 5MA(%)</span><span><i class="sw acc"></i>미수금(조)</span></div>
</div>`;

  const AUMT = A.etf?.aumTotal ?? null;
  const TURN = A.etf?.turnover?.single_lev ?? null;
  const impactBox = !AUMT ? '' : `<div class="watch w-aum">
  <div class="wl">함께 볼 것 · 레버리지 ETF 규모와 회전</div>
  <div class="wmain">
    <div class="wv">${f(AUMT.last.total, 1)}<span class="u">조</span></div>
    <div class="wtag">고점 대비 ${f(AUMT.fromPeakPct, 1)}%</div>
  </div>
  <div class="wnums">
    <span>전일 <b class="${AUMT.d1 >= 0 ? 'up' : 'dn'}">${AUMT.d1 >= 0 ? '+' : ''}${f(AUMT.d1, 1)}%</b></span>
    <span>5일 <b class="${AUMT.d5 >= 0 ? 'up' : 'dn'}">${AUMT.d5 >= 0 ? '+' : ''}${f(AUMT.d5, 1)}%</b></span>
    <span>20일 <b class="${AUMT.d20 >= 0 ? 'up' : 'dn'}">${AUMT.d20 >= 0 ? '+' : ''}${f(AUMT.d20, 1)}%</b></span>
    <span>고점 <b>${f(AUMT.peak.total, 1)}조</b> <span class="mut">(${dtFull(AUMT.peak.d)})</span></span>
    ${TURN ? `<span>단일종목 거래대금 <b>${f(TURN.last.valJo)}조</b> <span class="mut">회전율 ${f(TURN.avgTurnover, 2)}회</span></span>` : ''}
  </div>
  <div class="wline">좌수가 "환매가 있었나" 를 묻는다면 <b>AUM 은 충격의 크기</b>다 —
    리밸런싱 필요액도, 시장 거래대금에서 차지하는 몫도 AUM 에 비례한다.
    좌수는 안 줄었는데 AUM 이 반토막이면 <b>물량은 남았지만 시장에 미치는 힘은 그만큼 줄어든</b> 상태다.</div>
  ${(() => {
    // 홍콩분은 NAV 수집 시작(2026-08) 이후만 있다 — 없는 날은 null 로 두고 거기서부터 그린다.
    const CB = A.etf.aumCombined, CM = A.etf.aumCombinedMeta;
    if (!CB) return `<div class="wtrend">${trendChart(A.etf.aumDaily.map(r => ({ d: r.d, v: r.total })),
      '레버리지 ETF 합계 AUM (조원)', 1, `${dtFull(A.etf.aumDaily[0].d)} 이후`)}</div>`;
    return `<div class="wtrend">${levelChart(CB, [
      { key: 'domestic', cls: 'ln-cr', name: '국내' },
      { key: 'hk', cls: 'ln-kq', name: '홍콩 CSOP' },
      { key: 'total', cls: 'ln-idx', name: '합계' },
    ], '레버리지 ETF AUM — 국내 + 홍콩 (조원)', { dg: 1, zeroBase: false })}</div>
  <div class="lg"><span><i class="sw cr"></i>국내</span><span><i class="sw kq"></i>홍콩 CSOP</span><span><i class="sw acc"></i>합계</span></div>
  <div class="wline mut">홍콩분은 <b>${dtFull(CM.hkFrom)}부터</b> 있다 — CSOP 은 과거 NAV 를 주는 API 가 없어
    수집을 시작한 날부터만 쌓인다(§23.6). 없는 구간을 0 으로 채우면 없던 자금이 빠진 것처럼 보이므로 비워 뒀다.
    USD→원 환산은 그날 환율(최신 ${CM.fxLast ? k0(CM.fxLast.krw) : '-'}원)을 쓴다.
    ${CM.last ? `최신 ${dtFull(CM.last.d)} 기준 국내 ${f(CM.last.domestic, 1)}조 + 홍콩 <b>${f(CM.last.hk, 1)}조</b>
    = <b>${f(CM.last.total, 1)}조</b> (홍콩이 국내의 ${f(CM.last.hk / CM.last.domestic * 100, 0)}%)` : ''}</div>`;
  })()}
  ${TURN ? `<div class="wtrend">${trendChart(TURN.series.map(r => ({ d: r.d, v: r.valJo })),
    '단일종목 레버리지 거래대금 (조원)', 1, `${dtFull(TURN.from)} 이후`)}</div>` : ''}
</div>`;

  summarySection = `<section class="summary" id="top-summary">
<h2>핵심 요약</h2>
<p class="lead">차트를 하나도 보지 않고도 가져갈 수 있는 결론만 모았다. 숫자는 본문과 같은 계산에서 나온다.</p>

<div class="wgrid">
${watchBox}
${creditBox}
${impactBox}
${stressBox}
</div>

${deltaStrip}

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">${A.verdict
    ? esc(A.verdict.headline).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    : `양방향 모두 <b>직전 사이클 기준으로는 정상화가 이미 상당히 진행</b>됐다.
       남은 하락 위험과 남은 상승 여력 둘 다 <b>지수가 어디로 가느냐</b>에 달려 있다.`}</div>
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
  ${etfList ? `<div class="sumcol c-etf">
    <h4><span class="pill pl">PART 3</span> 변동성은 어디서 왔나 — 레버리지 ETF</h4>
    <ul class="find">${etfList}</ul>
  </div>` : ''}
  ${nextList ? `<div class="sumcol c-next">
    <h4><span class="pill pn">PART 4</span> 지수가 어디로 가면 뭐가 따라 나오나 — 다음 주 수급</h4>
    <ul class="find">${nextList}</ul>
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
    <td class="n">${p.trend?.d5 == null ? '-' : sgn(p.trend.d5, 1) + '%'}</td>
    <td class="n">${p.trend?.fromPeakPct == null ? '-' : f(p.trend.fromPeakPct, 1) + '%'}</td>
    <td class="n">${f(p.notionalUsd / 1e9)}</td>
  </tr>`).join('');
  // 홍콩 최대 상품(7709)의 좌수 추이. 국내 '매일 볼 것' 차트와 같은 질문을 홍콩에 묻는 것이다.
  const hk7709 = E.hk?.products.find(p => p.ticker === '7709');
  const hkChart = hk7709?.series?.length >= 10
    ? trendChart(hk7709.series.map(r => ({ d: r.d, v: r.unitsM })),
      '7709 CSOP SK Hynix 2x 상장좌수 (백만좌)', 0, `상장(${dtFull(hk7709.series[0].d)}) 이후`)
    : '';

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
  ${stackChart(E.aumDaily, stackKeys, '국내 상장 레버리지·인버스 ETF 합계 순자산 (조원)',
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

${!A.etf.breakdown ? '' : (() => {
  const B = A.etf.breakdown;
  return `<figure class="wide">
  <h4>AUM 이 왜 줄었나 — 자금이 빠진 건가, 값이 빠진 건가</h4>
  <p class="lead">규모도 회전도 같이 줄었다. <b>시장 대비 비율</b>로 보면 얼마나 줄었는지가 분명해진다.</p>
  <div class="tw"><table>
    <thead><tr><th>지표</th><th class="n">고점</th><th class="n">현재</th><th class="n">변화</th></tr></thead>
    <tbody>
      <tr><td>AUM(조)</td><td class="n">${f(B.peak.aum, 1)} <span class="mut">${dtFull(B.peak.d)}</span></td>
        <td class="n">${f(B.last.aum, 1)}</td><td class="n dn">${f((B.last.aum / B.peak.aum - 1) * 100, 0)}%</td></tr>
      <tr><td>AUM / 시가총액</td><td class="n">${f(B.peak.aumPctMcap, 2)}%</td>
        <td class="n">${f(B.last.aumPctMcap, 2)}%</td><td class="n dn">${f(B.last.aumPctMcap - B.peak.aumPctMcap, 2)}%p</td></tr>
      <tr><td><b>레버리지 익스포저(조)</b> <span class="mut">AUM × 배수</span></td>
        <td class="n">${f(B.expoPeak.exposure, 1)} <span class="mut">${dtFull(B.expoPeak.d)}</span></td>
        <td class="n">${f(B.last.exposure, 1)}</td><td class="n dn">${f((B.last.exposure / B.expoPeak.exposure - 1) * 100, 0)}%</td></tr>
      <tr><td><b>익스포저 / 시가총액</b></td><td class="n"><b>${f(B.expoPeak.exposurePctMcap, 2)}%</b></td>
        <td class="n"><b>${f(B.last.exposurePctMcap, 2)}%</b></td>
        <td class="n dn">${f(B.last.exposurePctMcap - B.expoPeak.exposurePctMcap, 2)}%p</td></tr>
      ${!B.valPeak ? '' : `<tr><td>거래대금(조/일)</td>
        <td class="n">${f(B.valPeak.valJo, 1)} <span class="mut">${dtFull(B.valPeak.d)}</span></td>
        <td class="n">${f(B.valAvg5, 1)} <span class="mut">최근5일평균</span></td>
        <td class="n dn">${f((B.valAvg5 / B.valPeak.valJo - 1) * 100, 0)}%</td></tr>`}
      ${!B.sharePeak ? '' : `<tr><td><b>거래대금 / 시장 전체 거래대금</b></td>
        <td class="n"><b>${f(B.sharePeak.valPctMarket, 1)}%</b> <span class="mut">${dtFull(B.sharePeak.d)}</span></td>
        <td class="n"><b>${f(B.shareAvg5, 1)}%</b></td>
        <td class="n dn">${f(B.shareAvg5 - B.sharePeak.valPctMarket, 1)}%p</td></tr>`}
    </tbody>
  </table></div>

${!A.etf.split ? '' : (() => {
  const SP = A.etf.split;
  const dom = SP.domSingle.find(g => g.group === 'single_lev') ?? { aumJo: 0, expoJo: 0, n: 0 };
  const domInv = SP.domSingle.find(g => g.group === 'single_inv') ?? { aumJo: 0, expoJo: 0, n: 0 };
  const hkBy = u => SP.hk.filter(x => x.underlying === u);
  const sum = (arr, k) => arr.reduce((s2, x) => s2 + (x[k] ?? 0), 0);
  const domTot = dom.aumJo + domInv.aumJo, domExpo = dom.expoJo + domInv.expoJo;
  const grand = domTot + SP.hkTotalAumJo, grandExpo = domExpo + SP.hkTotalExpoJo;
  return `<h3>단일종목 레버리지는 어디에 있나 — 국내와 홍콩</h3>
<p class="lead">삼성전자·SK하이닉스에 걸린 단일종목 레버리지는 국내에만 있는 게 아니다.
  홍콩 CSOP 상품이 같은 두 종목을 기초자산으로 삼는다 — 합쳐야 실제 익스포저가 나온다.</p>
<div class="tw"><table>
  <thead><tr><th>${dtFull(SP.asOf)} 기준</th><th class="n">AUM(조)</th><th class="n">익스포저(조)</th><th class="n">비중</th></tr></thead>
  <tbody>
    <tr><td><b>국내 상장</b> <span class="mut">단일종목 레버리지 ${dom.n}종</span></td>
      <td class="n">${f(dom.aumJo)}</td><td class="n">${f(dom.expoJo)}</td>
      <td class="n">${f(dom.aumJo / grand * 100, 0)}%</td></tr>
    <tr><td>국내 상장 <span class="mut">단일종목 인버스 ${domInv.n}종</span></td>
      <td class="n">${f(domInv.aumJo)}</td><td class="n">${f(domInv.expoJo)}</td>
      <td class="n">${f(domInv.aumJo / grand * 100, 0)}%</td></tr>
    ${['SK하이닉스', '삼성전자'].map(u => {
      const ps = hkBy(u);
      if (!ps.length) return '';
      return `<tr><td><b>홍콩 CSOP</b> <span class="mut">${esc(u)} ${ps.map(x => x.ticker).join('·')}</span></td>
        <td class="n">${f(sum(ps, 'aumJo'))}</td><td class="n">${f(sum(ps, 'expoJo'))}</td>
        <td class="n">${f(sum(ps, 'aumJo') / grand * 100, 0)}%</td></tr>`;
    }).join('')}
    <tr style="border-top:2px solid var(--line)"><td><b>합계</b></td>
      <td class="n"><b>${f(grand)}</b></td><td class="n"><b>${f(grandExpo)}</b></td><td class="n">100%</td></tr>
  </tbody>
</table></div>
<div class="box">
  <b>홍콩이 국내보다 크다</b> — 국내 단일종목 ${f(domTot)}조 vs 홍콩 CSOP <b>${f(SP.hkTotalAumJo)}조</b>
  (전체의 ${f(SP.hkTotalAumJo / grand * 100, 0)}%). 특히 <b>SK하이닉스는 홍콩 7709 한 종목이 ${f(sum(hkBy('SK하이닉스'), 'aumJo'))}조</b>로
  국내 단일종목 레버리지 전체와 맞먹는다. 국내만 보면 이 종목에 걸린 레버리지를 절반쯤 놓친다.
  <span class="mut">USD→원 환산은 ${SP.fxLast ? k0(SP.fxLast) + '원' : '-'} 기준. 홍콩 익스포저는 CSOP 이 공시하는 명목(ContractValue)이다.</span>
</div>

${!SP.etfMarket ? '' : `<div class="box">
  <b>ETF 시장 안에서의 크기</b> — 국내 단일종목 레버리지·인버스의 거래대금은 <b>${f(SP.singleValJo)}조</b>로
  <b>전체 ETF 거래대금(${f(SP.etfMarket.valJo)}조, ${k0(SP.etfMarket.n)}종)의 ${f(SP.singlePctOfEtfMarket, 1)}%</b>다.
  AUM 으로는 ETF 시가총액 ${f(SP.etfMarket.capJo, 0)}조의 <b>${f(SP.singleAumPctOfEtfCap, 1)}%</b>에 그친다.
  <b>덩치는 작은데 거래는 그 ${f(SP.singlePctOfEtfMarket / SP.singleAumPctOfEtfCap, 1)}배로 한다</b> —
  회전율이 다른 상품군과 자릿수가 다르다는 뜻이고, 시장에 주는 영향이 AUM 비중보다 큰 이유다.
  <span class="mut">전체 ETF 수치는 ${dtFull(SP.etfMarket.d)} 스냅샷이다 — 과거를 주는 소스가 없어 매일 누적한다(§33.1).</span>
</div>`}`;
})()}
  <div class="box">
    <b>회전이 더 크게 줄었다</b> — AUM 은 ${f((B.last.aum / B.peak.aum - 1) * 100, 0)}%,
    익스포저는 ${f((B.last.exposure / B.expoPeak.exposure - 1) * 100, 0)}% 줄었는데
    <b>거래대금은 ${f((B.valAvg5 / B.valPeak.valJo - 1) * 100, 0)}%</b> 줄었다.
    시장 거래대금에서 차지하던 몫도 <b>${f(B.sharePeak.valPctMarket, 1)}% → ${f(B.shareAvg5, 1)}%</b>다.
    잔고보다 <b>회전이 먼저, 더 크게 식는다</b> — 변동성을 만들던 건 잔고가 아니라 회전이었다는 뜻이다.
    <span class="mut">ETF 는 유가증권시장에 상장돼 그 거래대금이 시장 합계에 <b>포함</b>된다 — 별도로 더해지는 몫이 아니라 비중이다.</span>
  </div>
  ${levelChart(B.series, [
    { key: 'flowCum', cls: 'ln-kq', name: '시작규모+누적 유출입', opacity: 0.6 },
    { key: 'priceCum', cls: 'ln-mut', name: '가격 기여분', color: 'var(--bar)', opacity: 0.45 },
    { key: 'aum', cls: 'ln-idx', name: 'AUM 합계', line: true },
  ], '레버리지 ETF AUM 분해 (조원)', { dg: 1, zeroBase: true, stack: true })}
  <div class="lg"><span><i class="sw kq"></i>누적 유출입(자금)</span><span><i class="sw" style="background:var(--bar)"></i>가격 기여분</span><span><i class="sw acc"></i>AUM 합계</span></div>
  <figcaption>일별 유출입 = <b>Δ좌수 × 그날 종가</b>로 잡아 누적했고, AUM 에서 그걸 뺀 나머지가 가격 기여분이다.
    <b>고점 ${f(B.peak.aum, 1)}조(${dtFull(B.peak.d)}) → 현재 ${f(B.last.aum, 1)}조,
    ${f(B.dropFromPeak, 1)}조가 줄었는데 그중 가격이 ${f(B.priceShareOfDrop, 0)}%</b>다.
    자금은 ${B.flowShareOfDrop < 0 ? `오히려 ${f(-B.flowShareOfDrop, 0)}%만큼 <b>들어왔다</b>` : `${f(B.flowShareOfDrop, 0)}% 빠졌다`} —
    같은 기간 좌수가 늘었다는 §23.2 의 관찰과 같은 이야기다.
    <br><b>시총 대비 익스포저</b>는 자유유통(free float)이 아니라 <b>전체 시가총액</b> 기준이다 —
    유통주식만으로 나누면 이 비율은 더 커진다. 자유유통 비율은 이 파이프라인에 없다(§31.1).</figcaption>
</figure>`;
})()}

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
    <th class="n">좌수(백만)</th><th class="n">좌수 5일</th><th class="n">좌수 고점 대비</th><th class="n">명목 익스포저(US$bn)</th></tr></thead>
  <tbody>${hkRows}</tbody>
</table></div>
${hkChart ? `<figure>
  <h4>7709 좌수 추이 — 홍콩도 같은 질문: 꺾였는가</h4>
  ${hkChart}
  <figcaption>상장~2026-08-01 은 HKEX CCASS 조회(SDW)의 <b>등록기관 발행좌수</b>로 백필했고,
    이후는 CSOP 신고좌수(딜링일 기준)다. 창출·환매가 T+2 로 결제되는 동안 두 기준이 어긋날 수 있어
    이음새(2026-08-01/02)에 단차가 보일 수 있다 — 7/31 실측으로 등록기관 829M vs CSOP 984M vs
    CCASS 보유 1,048M 이었다(§23.6). 추세를 읽는 데는 지장이 없다.</figcaption>
</figure>` : ''}
<div class="box warn">홍콩분은 <b>매일 자동 수집</b>되고(운용사 내부 API, §23.6), 상장 이후 구간은
  HKEX CCASS(SDW) 조회로 백필해 좌수 추이를 읽을 수 있다(<code>data/csop-daily.json</code>).
  다만 <b>일별 리밸런싱 계산에서는 여전히 제외</b>한다 — 일별 NAV 소스가 없어 국내와 같은
  "계수 × AUM × 수익률"을 홍콩분에 적용할 수 없기 때문이다. 위 표와 차트는 규모·추세 비교용이고,
  아래 리밸런싱 수치는 홍콩분이 빠진 만큼 <b>과소</b>다.
  SDW 는 12개월 창만 열어 두므로 상장 초기 구간은 지금 받아 둔 것이 마지막이다.</div>` : ''}

<div class="box warn"><b>한계</b> — 대차거래·신용융자와 달리 이 계산에는 공표된 강제 청산 규칙이 없다.
  리밸런싱 필요액은 상품 설계상 <b>반드시 나가야 하는 매매</b>지만, 실제 체결 시각·분할 여부·스왑 상대방의
  헤지 방식은 공개되지 않는다. 또 AUM은 NAV가 아니라 <b>종가 × 좌수</b>로 계산했다(일별 NAV 소스 없음).
  괴리율만큼 오차가 있다.</div>
</section>`;
})();

/* ---------- 단일종목 레버리지 ETF 거래대금 ---------- */
// 좌수·AUM 이 "얼마나 쌓였나" 라면 거래대금은 "얼마나 돌리나" 다. 같은 물량이라도
// 하루에 몇 번 손바뀜하는지가 다르면 성격이 다른 상품이다.
const turnoverSection = !A.etf?.turnover?.single_lev ? '' : (() => {
  const T = A.etf.turnover.single_lev, SC = A.etf.turnover.sector_lev;
  const span = `${dtFull(T.from)} 이후`;
  const valPts = T.series.filter(r => Number.isFinite(r.valJo)).map(r => ({ d: r.d, v: r.valJo }));
  const shPts = T.series.filter(r => Number.isFinite(r.marketPct)).map(r => ({ d: r.d, v: r.marketPct }));
  const trPts = T.series.filter(r => Number.isFinite(r.turnover)).map(r => ({ d: r.d, v: r.turnover }));

  return `<section>
<h2>얼마나 쌓였나가 아니라 얼마나 돌리나 — 거래대금</h2>
<p class="lead">여기까지는 좌수와 AUM, 즉 <b>쌓인 양</b>을 봤다. 거래대금은 다른 질문에 답한다 —
  그 물량이 <b>하루에 몇 번 손바뀜하는가</b>. 같은 1조라도 한 달에 한 번 도는 돈과
  하루에 한 번 도는 돈은 시장에 주는 충격이 다르다.</p>

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">단일종목 레버리지 ${T.series.at(-1).n}종이 <b>시장 전체 거래대금의 최대 ${f(T.sharePeak.marketPct, 1)}%</b>를
    차지한 날이 있었다(${dtFull(T.sharePeak.d)}). 평균으로도 <b>${f(T.avgSharePct, 1)}%</b>다.
    회전율은 하루 평균 <b>${f(T.avgTurnover, 2)}회</b> — <b>AUM 전체가 매일 한 번쯤 손바뀜</b>했다는 뜻이다.
    ${SC ? `같은 레버리지인 섹터 상품은 회전율 ${f(SC.avgTurnover, 2)}회, 시장 대비 ${f(SC.avgSharePct, 1)}%에 그친다 —
    <b>덩치의 문제가 아니라 성격의 문제다.</b>` : ''}</div>
</div>

<figure>
  <h4>단일종목 레버리지 ETF 거래대금</h4>
  ${trendChart(valPts, '거래대금 (조원)', 1, span)}
  ${shPts.length ? trendChart(shPts, '시장 전체 거래대금 대비 (%)', 1, span) : ''}
  ${trPts.length ? trendChart(trPts, '회전율 = 거래대금 ÷ AUM (회)', 2, span) : ''}
  <figcaption>시장 전체는 코스피+코스닥 거래대금이다. 상장(${dtFull(T.from)}) 이후 ${T.days}거래일.
    거래가 없던 날(장 시작 전 조회분)은 회전율을 왜곡해서 뺐다.</figcaption>
</figure>

<div class="tw"><table>
  <thead><tr><th>${dtFull(T.to)} 기준</th><th class="n">단일종목 레버리지</th>${SC ? '<th class="n">섹터 레버리지</th>' : ''}</tr></thead>
  <tbody>
    <tr><td>거래대금(조)</td><td class="n">${f(T.last.valJo)}</td>${SC ? `<td class="n">${f(SC.last.valJo)}</td>` : ''}</tr>
    <tr><td>AUM(조)</td><td class="n">${f(T.last.aumJo, 1)}</td>${SC ? `<td class="n">${f(SC.last.aumJo, 1)}</td>` : ''}</tr>
    <tr><td><b>평균 회전율(회/일)</b></td><td class="n"><b>${f(T.avgTurnover, 2)}</b></td>${SC ? `<td class="n">${f(SC.avgTurnover, 2)}</td>` : ''}</tr>
    <tr><td>최근 20일 회전율</td><td class="n">${f(T.avgTurnover20, 2)}</td>${SC ? `<td class="n">${f(SC.avgTurnover20, 2)}</td>` : ''}</tr>
    <tr><td>회전율 최고</td><td class="n">${f(T.turnoverPeak.turnover, 2)} <span class="mut">${dtFull(T.turnoverPeak.d)}</span></td>${SC ? `<td class="n">${f(SC.turnoverPeak.turnover, 2)}</td>` : ''}</tr>
    <tr><td>거래대금 최고(조)</td><td class="n">${f(T.valPeak.valJo)} <span class="mut">${dtFull(T.valPeak.d)}</span></td>${SC ? `<td class="n">${f(SC.valPeak.valJo)}</td>` : ''}</tr>
    <tr><td><b>시장 대비 최고</b></td><td class="n"><b>${f(T.sharePeak.marketPct, 1)}%</b> <span class="mut">${dtFull(T.sharePeak.d)}</span></td>${SC?.sharePeak ? `<td class="n">${f(SC.sharePeak.marketPct, 1)}%</td>` : ''}</tr>
    <tr><td>시장 대비 평균</td><td class="n">${f(T.avgSharePct, 1)}%</td>${SC ? `<td class="n">${f(SC.avgSharePct, 1)}%</td>` : ''}</tr>
  </tbody>
</table></div>

<div class="box">
  <b>이 숫자가 PART 3 의 질문에 답한다</b> — "변동성은 어디서 왔나". 시가총액 기준으로는
  단일종목 레버리지 ETF 의 AUM ${f(T.last.aumJo, 1)}조가 시장에서 큰 비중이 아니다.
  그런데 <b>거래대금으로는 시장의 5분의 1 안팎을 차지했다.</b>
  잔고가 아니라 회전이 충격을 만든다 — §23.3 의 리밸런싱 필요액과 별개로,
  이 상품들이 그날그날 실제로 밀어낸 매매가 이만큼이었다는 뜻이다.
</div>

<div class="box warn">
  <b>단서</b> — 거래대금은 <b>매수와 매도를 합친 값</b>이라 순유입이 아니다. 같은 물량이 하루에 여러 번
  오가면 그만큼 부풀려진다(회전율이 높다는 건 정확히 그 뜻이다). 그리고 ETF 거래대금 전부가
  기초자산 매매로 이어지지도 않는다 — 유통시장에서 투자자끼리 주고받으면 설정·환매 없이 끝난다.
  기초자산에 실제로 나가는 매매는 §23.3 의 <b>리밸런싱 필요액</b>이고, 그건 이 표와 다른 계산이다.
</div>
</section>`;
})();

/* ---------- 투자자별 순매수 ---------- */
// 좌수가 늘었다는 사실만으로는 누가 샀는지 모른다. 항복(자발적 투항)인지 물타기인지는
// 여기서만 갈린다 — 강제 청산 지표(반대매매·미수금)와 정반대 얘기를 할 수 있다.
const investorSection = !A.investorFlow ? '' : (() => {
  const V = A.investorFlow, S = V.summary;
  const LF = V.levFlow;              // 금액 기준 수급. 수량만 보면 매도 전환을 놓친다.
  const M = n => `${n >= 0 ? '+' : ''}${f(n / 1e6, 2)}`;
  const rows = [...V.items]
    .filter(x => x.kind === 'stock' || x.group === 'single_lev' || x.group === 'single_inv')
    .slice(0, 12)
    .map(x => `<tr>
      <td>${esc(x.name)}${x.kind === 'stock' ? ' <span class="mut">주식</span>' : ''}</td>
      <td class="n ${x.individual >= 0 ? 'dn' : 'up'}"><b>${M(x.individual)}</b></td>
      <td class="n">${M(x.institution)}</td>
      <td class="n">${M(x.foreign)}</td>
      <td class="n">${x.buyDays}/${x.sellDays}</td>
      <td class="n ${x.retPct >= 0 ? 'up' : 'dn'}">${x.retPct == null ? '-' : `${x.retPct >= 0 ? '+' : ''}${f(x.retPct, 1)}%`}</td>
    </tr>`).join('');

  const inv = V.items.filter(x => x.group === 'single_inv');
  const invSold = inv.filter(x => x.individual < 0);

  return `<section>
<h2>좌수를 떠받친 건 누구인가 — 투자자별 순매수</h2>
<p class="lead">좌수가 늘었다는 것은 <b>설정(creation)</b>이 일어났다는 뜻이고, 설정은 순매수가 있어야 일어난다.
  그런데 좌수만 봐서는 <b>누가</b> 샀는지 모른다 — 개인이 팔았는데 기관이 받아 좌수가 유지될 수도 있다.
  그래서 투자자별 순매수를 따로 받는다. 이게 있어야 "개인이 항복했나"에 답할 수 있다.</p>

<div class="verdict">
  <div class="vl">한 줄 판정</div>
  <div class="vt">${!LF ? '' : LF.last5Eok < 0 && LF.prevEok > 0
    ? `<b>수량으로는 순매수, 금액으로는 이미 매도 전환이다.</b>
       ${V.days}거래일 동안 ${S.total}종목 중 ${S.netBuyers}종목이 수량 기준 순매수였지만,
       단일종목 레버리지 ${S.levCount}종의 <b>금액</b>을 보면 누적 순매수가
       ${dtFull(LF.cumPeak.d)} ${k0(LF.cumPeak.cumEok)}억에서 <b>${k0(LF.cumEok)}억으로
       ${f(LF.givenBackPct, 0)}% 반납</b>됐다. ${dtFull(LF.worst.d)} 하루에만 <b>${k0(Math.abs(LF.worst.eok))}억</b>을 던졌다.
       최근 5일 합계는 ${k0(LF.last5Eok)}억으로, 그 이전 ${LF.totalDays - 5}일의 ${k0(LF.prevEok)}억과 부호가 갈린다.`
    : `<b>개인은 항복하지 않았다 — 물타기했다.</b> ${V.days}거래일 동안 ${S.total}종목 중
       <b>${S.netBuyers}종목</b>에서 개인이 순매수였고, 금액으로도 누적 ${k0(LF.cumEok)}억 순매수다.`}</div>
</div>

${!LF ? '' : `<figure>
  <h4>단일종목 레버리지 ETF — 개인 순매수 누적 (억원)</h4>
  ${trendChart(LF.series.map(r => ({ d: r.d, v: r.cumEok / 1e4 })), '개인 순매수 누적 (조원)', 2, `${dtFull(LF.series[0].d)} 이후`)}
  ${trendChart(LF.series.map(r => ({ d: r.d, v: r.eok / 1e4 })), '개인 순매수 일별 (조원)', 2, `${dtFull(LF.series[0].d)} 이후`)}
  <figcaption>순매수액 = 순매수 수량 × 종가(근사). <b>수량이 아니라 금액으로 봐야 "얼마나 팔았나"에 답이 된다</b> —
    1좌 가격이 상품마다 달라 수량은 더할 수도 없다. 순매도일 ${LF.sellDays}/${LF.totalDays}일.</figcaption>
</figure>

${!A.unitsAgreement ? '' : `<div class="box warn">
  <b>"좌수가 줄어야 개인이 판 것" 은 아니다</b><br>
  좌수 변화와 개인 순매수의 <b>부호가 어긋난 날이 ${f(A.unitsAgreement.mismatchPct, 0)}%</b>다
  (${A.unitsAgreement.total}쌍 중 ${A.unitsAgreement.total - A.unitsAgreement.agree}쌍).
  ${A.unitsAgreement.examples[0] ? `예를 들어 ${dtFull(A.unitsAgreement.examples[0].d)}
  ${esc(A.unitsAgreement.examples[0].name)}은 개인이 ${f(Math.abs(A.unitsAgreement.examples[0].indM), 1)}백만주를
  <b>순매도</b>했는데 좌수는 ${f(Math.abs(A.unitsAgreement.examples[0].duM), 1)}백만주 <b>늘었다</b>.` : ''}
  <br>이유는 구조에 있다. 좌수는 <b>모든 투자자를 합친 순(net) 결과</b>이고, 그마저 LP/AP 가
  설정·환매를 걸어야 움직인다.
  <ul style="margin:6px 0 0 18px">
    <li><b>필요조건이 아니다</b> — 개인이 팔아도 다른 투자자가 받으면 좌수는 그대로거나 오히려 는다.</li>
    <li><b>충분조건도 아니다</b> — 기관·외국인이 판 것이 환매로 이어져도 좌수는 준다. 좌수는 <b>누가</b> 팔았는지 말하지 않는다.</li>
  </ul>
  그래서 <b>"개인이 팔았나" 는 투자자별 순매수로</b>, <b>"자금이 상품에서 빠졌나" 는 좌수로</b>,
  <b>"시장에 주는 충격" 은 AUM·익스포저로</b> 각각 봐야 한다. 하나로 셋을 대신할 수 없다.
</div>

<div class="box warn">
  <b>그래도 좌수가 무의미한 건 아니다 — 3거래일 늦을 뿐이다</b><br>`}
  개인이 판다고 좌수가 그날 줄지 않는다. 좌수는 LP/AP 가 설정·환매를 걸어야 움직인다(§27.4).
  실제로 재 보면 <b>개인 순매수와 좌수 변화의 당일 상관은 −0.04로 사실상 0</b>이고,
  <b>3거래일 뒤에 상관이 +0.72로 튄다</b>(14종 중 13종이 같은 부호, lag 4에서 감쇠).
  그래서 ${dtFull(LF.worst.d)}의 ${k0(Math.abs(LF.worst.eok))}억 순매도는 <b>아직 좌수에 안 나타났다</b> —
  며칠 뒤 좌수가 꺾이는지가 이 판정의 확인 절차다.
</div>`}

<div class="tw"><table>
  <thead><tr><th>종목 <span class="mut">${dtFull(V.from)}~${dtFull(V.asOf)}</span></th>
    <th class="n">개인(백만주)</th><th class="n">기관</th><th class="n">외국인</th>
    <th class="n">개인 매수일/매도일</th><th class="n">기간 등락</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>

${invSold.length ? `<div class="box">
  <b>방향이 일관된다 — 내리는 걸 사고 오르는 걸 팔았다</b><br>
  같은 기간 인버스 상품에서는 개인이 순매도다(${invSold.map(x => `${esc(x.name)} ${M(x.individual)}백만주,
  그 상품 수익률 ${x.retPct >= 0 ? '+' : ''}${f(x.retPct, 1)}%`).join(' / ')}).
  <b>오른 상품(인버스)은 팔고 빠진 상품(레버리지)은 샀다</b> — 반등에 베팅하는 전형적인 물타기다.
  하락에 베팅한 쪽이 이익 실현으로 빠져나가는 국면이기도 하다.
</div>` : ''}

<div class="box warn">
  <b>이 표를 항복 지표로 쓸 때의 한계</b><br>
  ① <b>수량(주)이지 금액이 아니다.</b> 1좌 가격이 상품마다 달라 종목 간 절대량 비교는 의미가 없다 —
  각 종목의 방향과 자기 기준 강도만 읽어야 한다.
  ② 소스가 <b>최근 ${V.days}거래일</b>만 준다(§27). 그 이전은 누적 수집으로만 늘어나므로
  지금은 이 창 안에서의 판정이다.
  ③ 순매수는 <b>순(net)</b>이라 같은 개인 안에서 사는 사람과 파는 사람이 상쇄된다.
  "개인 전체가 샀다"가 아니라 "개인 합계가 순매수였다"로 읽어야 한다.
</div>

<div class="box">
  <b>강제 청산 지표와 정반대다</b> — 같은 기간 반대매매는 역대 상위 0.3%, 위탁매매미수금은 역대 6위였다(PART 1).
  <b>신용으로 산 개인은 강제로 털렸는데, 현금·ETF로 산 개인은 오히려 사들였다.</b>
  자발적 투항(항복)은 아직 안 나왔다는 뜻이고, 팔아야 할 물량이 남아 있다는 쪽으로 읽는 게 자연스럽다.
</div>
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

/* ---------- 방향 수급 — 외국인 현·선물 동조 (PART 4, §44) ---------- */
// 잔고(신용·대차·좌수)는 부담의 크기를, 이 절은 방향을 본다. 원래 목표였던 옵션
// (풋/콜·VKOSPI)은 무인증 일별 소스가 없어 제외했다 — fetch-direction-flows.mjs 머리 참조.
const directionSection = !A.directionFlow ? '' : (() => {
  const D = A.directionFlow;
  const sg1 = (n, d = 1) => `${n >= 0 ? '+' : ''}${f(n, d)}`;
  const cumRows = D.kospi.series.map(r => ({ d: r.d, cum: r.cum, idx: r.idx }));
  const fut = D.futures.series;
  const futRows = fut.map((r, i) => {
    const back = k => fut.slice(Math.max(0, i - k + 1), i + 1).reduce((t, x) => t + x.v, 0);
    return { d: r.d, f5: back(5) / 1e3, f20: back(20) / 1e3 };
  });

  const cumChart = interactive({
    unit: '외국인 누적 순매수 (조원)', dg: 1, zeroBase: false, h: 250,
    axis2Unit: '코스피(p)', dg2: 0,
    dates: cumRows.map(r => r.d),
    series: [
      { name: '누적 순매수(코스피 현물)', color: CL.acc, vals: cumRows.map(r => r.cum) },
      { name: '코스피', color: CL.mut, axis2: true, vals: cumRows.map(r => r.idx) },
    ],
  }, levelChartStatic(cumRows, [{ key: 'cum', cls: 'ln-idx', name: '누적 순매수' }],
    '외국인 누적 순매수 (조원)', { dg: 1, zeroBase: false }));

  const alignBox = {
    'aligned-buy': ['<b>현물과 선물이 같이 매수다</b> — 헤지가 아니라 방향 베팅이고, 위쪽을 보고 있다.', ''],
    'aligned-sell': ['<b>현물과 선물이 같이 매도다</b> — 자금이 방향성으로 빠지는 국면이다.', ' warn'],
    mixed: ['<b>현물과 선물이 엇갈려 있다</b> — 한쪽이 헤지일 가능성이 커서 방향 신호로 읽으면 안 된다. 동조로 돌아서는 쪽이 다음 방향이다.', ''],
  }[D.align];

  return `<section>
<h2>외국인 방향 수급 — 현물과 선물이 같은 쪽인가</h2>
<p class="lead">앞의 지표들은 전부 <b>잔고</b>(부담의 크기)다. 이 절은 <b>방향</b>을 본다 —
외국인이 현물과 선물을 같은 쪽으로 밀면 방향 베팅, 엇갈리면 헤지·차익 성격이라 동조 여부 자체가 신호다.
원래는 옵션(풋/콜 비율·VKOSPI)을 붙이려 했으나 무인증 일별 소스가 없다(§44).</p>

<div class="cards">
  <div class="card"><div class="lb">코스피 현물 20일</div><div class="vl ${D.kospi.f20 >= 0 ? 'up' : 'neg'}">${sg1(D.kospi.f20)}<span class="u">조</span></div>
    <div class="nt">5일 ${sg1(D.kospi.f5)}조 · 연속 ${D.kospi.streak.days}일 ${D.kospi.streak.sign > 0 ? '순매수' : '순매도'}</div></div>
  <div class="card"><div class="lb">코스닥 현물 20일</div><div class="vl ${D.kosdaq.f20 >= 0 ? 'up' : 'neg'}">${sg1(D.kosdaq.f20)}<span class="u">조</span></div>
    <div class="nt">5일 ${sg1(D.kosdaq.f5)}조</div></div>
  <div class="card"><div class="lb">K200 선물 20일</div><div class="vl ${D.futures.f20 >= 0 ? 'up' : 'neg'}">${sg1(D.futures.f20 / 1e3)}<span class="u">천계약</span></div>
    <div class="nt">5일 ${sg1(D.futures.f5 / 1e3)}천계약 · 연속 ${D.futures.streak.days}일 ${D.futures.streak.sign > 0 ? '순매수' : '순매도'}</div></div>
  <div class="card"><div class="lb">동조 판정</div><div class="vl">${{ 'aligned-buy': '동시 매수', 'aligned-sell': '동시 매도', mixed: '엇갈림' }[D.align]}</div>
    <div class="nt">20일 누적 부호 기준</div></div>
</div>

<div class="box${alignBox[1]}">${alignBox[0]}</div>

<figure>
  <h4>외국인 코스피 현물 누적 순매수 vs 코스피</h4>
  ${cumChart}
  <div class="lg"><span><i class="sw acc"></i>누적 순매수(조, 좌)</span><span><i class="sw" style="background:var(--mut)"></i>코스피(p, 우)</span></div>
  <figcaption>${dtFull(D.from)}부터의 누적이다(수집 시작일 기준 — 그 이전 누적分은 0 으로 둔 상대값).
    누적선이 꺾이는 지점이 외국인 태도가 바뀐 날이다.</figcaption>
</figure>

<figure>
  <h4>외국인 K200 선물 순매수 — 5일합·20일합</h4>
  ${levelChart(futRows, [
    { key: 'f5', cls: 'ln-cr', name: '5일합' },
    { key: 'f20', cls: 'ln-idx', name: '20일합' },
  ], '외국인 선물 순매수 합 (천계약)', { dg: 1, zeroBase: false })}
  <div class="lg"><span><i class="sw cr"></i>5일합</span><span><i class="sw acc"></i>20일합</span></div>
  <figcaption>0 위면 선물 매수 우위, 아래면 매도 우위다. 5일합이 20일합을 위로 가로지르면
    태도 전환이 빠르게 진행 중이라는 뜻이다. 계약수라 금액과 직접 비교할 수 없다 —
    방향과 전환 시점만 읽는다.</figcaption>
</figure>

<div class="box">
  <b>옵션이 빠진 이유</b> — 풋/콜 비율과 VKOSPI 는 KRX 정보데이터시스템이 익명 접근을 막았고
  (LOGOUT), KRX Open API 는 키 발급에 로그인이 필요해 자동 파이프라인에 넣지 않았다.
  네이버의 옵션 투자자별 표는 구조만 남고 행이 비어 있다. 방향 신호는 현·선물 동조로 대신한다 —
  옵션이 주는 추가 정보(기대 변동성의 가격)는 이 구도에 없다는 한계를 그대로 둔다(§44).
</div>
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
    --cyc0:rgba(26,86,168,.07); --cyc1:rgba(192,57,43,.07); --lv:#7b4fb5; --nx:#b8792a; --stk:#2f7d8c; --ctry:#8a5a2b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#10151b; --fg:#e6ebf0; --mut:#93a1b0; --line:#26303a; --acc:#5c9ce6; --kq:#5fc4a2;
      --cr:#e8705f; --hit:#e8705f; --part:#f0a868; --bar:#5f7994; --band:#2a1c19; --surf:#1b2431;
      --cyc0:rgba(92,156,230,.10); --cyc1:rgba(232,112,95,.10); --lv:#a78bda; --nx:#d9a05b; --stk:#5fb4c6; --ctry:#c99055; }
  }
  :root[data-theme="light"] { --bg:#fff; --fg:#12181f; --mut:#5a6672; --line:#e2e6ea; --acc:#1a56a8;
    --kq:#2e8b6f; --cr:#c0392b; --hit:#c0392b; --part:#e8883a; --bar:#7f95ad; --band:#fdf1ec; --surf:#f3f5f8;
    --cyc0:rgba(26,86,168,.07); --cyc1:rgba(192,57,43,.07); --lv:#7b4fb5; --nx:#b8792a; --stk:#2f7d8c; --ctry:#8a5a2b; }
  :root[data-theme="dark"] { --bg:#10151b; --fg:#e6ebf0; --mut:#93a1b0; --line:#26303a; --acc:#5c9ce6;
    --kq:#5fc4a2; --cr:#e8705f; --hit:#e8705f; --part:#f0a868; --bar:#5f7994; --band:#2a1c19; --surf:#1b2431;
    --cyc0:rgba(92,156,230,.10); --cyc1:rgba(232,112,95,.10); --lv:#a78bda; --nx:#d9a05b; --stk:#5fb4c6; --ctry:#c99055; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:14px; line-height:1.62;
    font-family:"Malgun Gothic","Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:1400px; margin:0 auto; padding:30px 26px 60px; }
  header { border-bottom:2px solid var(--fg); padding-bottom:12px; margin-bottom:18px;
    display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; }
  .hub-link { font-size:12px; color:var(--acc); border:1px solid var(--line); border-radius:6px;
    padding:5px 10px; white-space:nowrap; text-decoration:none; }
  .hub-link:hover { background:var(--surf); }
  .kicker { font-size:11px; letter-spacing:2.5px; text-transform:uppercase; color:var(--mut); }
  h1 { font-size:24px; margin:6px 0 4px; letter-spacing:-.4px; }
  .sub { color:var(--mut); font-size:13px; }
  /* 오늘의 종합 판정 — 페이지 최상단 */
  .today { border:1px solid var(--line); border-top:3px solid var(--acc); border-radius:3px 3px 9px 9px;
    background:var(--surf); padding:16px 18px 14px; margin:18px 0 6px; }
  .tdh { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  .tdh h2 { font-size:20px; margin:3px 0 0; letter-spacing:-.4px; border:none; padding:0; }
  .tdscore { display:flex; align-items:center; gap:9px; border:1px solid var(--line); border-radius:8px;
    background:var(--bg); padding:7px 12px; }
  .tdscore b { font-size:25px; font-variant-numeric:tabular-nums; letter-spacing:-1px; }
  .tdscore span { font-size:10.5px; color:var(--mut); line-height:1.35; }
  .tdscore.s-clearing b, .tdscore.s-easing b { color:var(--kq); }
  .tdscore.s-mixed b { color:var(--part); }
  .tdscore.s-stressed b { color:var(--cr); }
  .tdlead { font-size:14.5px; line-height:1.72; margin:11px 0 0; }
  .tdmoves { display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; margin:11px 0 2px;
    padding:8px 0 0; border-top:1px solid var(--line); font-size:11.5px; }
  .tdm { font-variant-numeric:tabular-nums; }
  .tdm i { font-style:normal; margin-left:3px; }
  .tdm i.up { color:var(--cr); } .tdm i.dn { color:var(--acc); }
  .vaxes { display:grid; grid-template-columns:1fr; gap:12px; margin:14px 0 0; }
  @media (min-width:1000px) { .vaxes { grid-template-columns:repeat(3,1fr); } }
  /* grid 자식은 min-width:auto 라 콘텐츠(특히 svg{min-width:430px})의 최소폭만큼 트랙을 밀어낸다.
     그러면 페이지 전체에 가로 스크롤이 생긴다. 0 으로 눌러 figure 안쪽에서만 스크롤되게 한다. */
  .vaxes > *, .wgrid > *, .tables > * { min-width:0; }
  .vax { border:1px solid var(--line); border-radius:8px; background:var(--bg); padding:11px 13px 4px; }
  .vaxh b { display:block; font-size:13px; }
  .vaxh .mut { display:block; font-size:11px; color:var(--mut); }
  .vaxs { display:flex; align-items:center; gap:3px; margin:6px 0 9px; font-size:11px;
    color:var(--mut); font-variant-numeric:tabular-nums; }
  .vaxs .vc { width:8px; height:8px; border-radius:2px; display:inline-block; margin-left:9px; }
  .vaxs .vc:first-child { margin-left:0; }
  .vc.ok { background:var(--kq); } .vc.watch { background:var(--bar); } .vc.alert { background:var(--cr); }
  .vsig { border-top:1px solid var(--line); padding:8px 0; }
  .vsh { display:flex; align-items:baseline; gap:7px; }
  .vst { font-size:10px; padding:1px 6px; border-radius:3px; color:#fff; flex:none; }
  .vst.s-ok { background:var(--kq); } .vst.s-watch { background:var(--bar); } .vst.s-alert { background:var(--cr); }
  .vsl { font-size:12.5px; font-weight:700; }
  .vsv { margin-left:auto; font-size:13px; font-variant-numeric:tabular-nums; letter-spacing:-.3px; }
  .vsw { font-size:11.5px; line-height:1.6; color:var(--mut); margin-top:3px; }
  .vsw b { color:var(--fg); }
  .tdfoot { font-size:11px; color:var(--mut); margin:12px 0 0; }
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
  /* 대화형 차트. JS 가 있을 때만 .ic-on 이 붙고 그때 정적 SVG 를 감춘다 —
     스크립트가 없으면 지금까지와 똑같이 정적 SVG 가 보인다. */
  .ichart { position:relative; }
  .ic-on .ichart > svg:not(.ic-svg) { display:none; }   /* 정적 폴백만 감춘다 */
  .ichart .ic-svg { width:100%; height:auto; display:block; }
  .ic-tip { position:absolute; top:6px; pointer-events:none; z-index:5;
    background:var(--surf); border:1px solid var(--line); border-radius:7px;
    padding:7px 9px; font-size:11.5px; line-height:1.7; color:var(--fg);
    box-shadow:0 2px 10px rgba(0,0,0,.13); white-space:nowrap; }
  .ic-tip b { font-weight:600; }
  .ic-tip span { display:block; color:var(--mut); }
  .ic-tip span b { color:var(--fg); }
  .ic-tip i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:5px; }
  .ic-guide { stroke:var(--mut); stroke-width:1; stroke-dasharray:3 3; }
  /* 대화형 차트의 고점/저점 라벨. 눈금 글자보다 살짝 진하게 — 그냥 축이 아니라
     "이 지점을 보라"는 표시라는 걸 구분한다. */
  .mk-lab { font-size:8.5px; font-weight:600; fill:var(--fg); }
  /* 라벨 뒤 배경판. 데이터가 조밀한 구간(여러 계열이 같은 날 바닥을 찍는 등)에서는
     라벨을 아무리 밀어도 선 자체와 겹친다 — 피해 다니는 대신 뒤에 판을 깔아 항상 읽히게 한다. */
  .mk-bg { fill: var(--bg); opacity: .88; }
  /* 범주형(막대) 차트. 시계열 svg 와 같은 축(.ax/.axu/.grid/.zero) 스타일을 그대로 쓴다. */
  .catbar { cursor:default; }
  .ic-sum { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:4px;
    font-size:11.5px; color:var(--mut); }
  .ic-sum i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:5px; }
  .ic-sum b { color:var(--fg); }
  .ic-sum em { font-style:normal; }
  .ic-sum em.up { color:var(--kq); } .ic-sum em.dn { color:var(--cr); }
  .ic-sum .ic-range { color:var(--fg); font-weight:600; }
  .ic-empty { padding:26px 0; text-align:center; color:var(--mut); font-size:12px; }
  /* 계열 토글. JS 없으면 hidden 속성 그대로 안 보인다 — 정적 SVG 는 항상 전부 겹쳐
     보이므로 켜고 끌 필요가 없다(범례 .lg 로 충분). boot() 가 hidden 을 지운다. */
  .ictoggle { display:flex; flex-wrap:wrap; gap:6px 14px; margin:2px 0 8px; font-size:12px; }
  .ictoggle label { display:flex; align-items:center; gap:6px; cursor:pointer;
    color:var(--fg); user-select:none; }
  .ictoggle input[type=checkbox] { width:14px; height:14px; cursor:pointer; accent-color:var(--acc); margin:0; }
  .ictoggle i { display:inline-block; width:16px; height:3px; border-radius:2px; }
  .ictoggle input:not(:checked) ~ i, .ictoggle input:not(:checked) ~ span { opacity:.35; }
  /* 구간 선택 툴바 — 스크롤해도 위에 붙어 있어야 아무 차트에서나 바로 바꾼다. */
  /* 메뉴(.tabs, top:0, 높이 ~41px)와 겹치지 않게 그 아래에 붙인다. */
  .ic-bar { position:sticky; top:41px; z-index:20; display:flex; flex-wrap:wrap;
    align-items:center; gap:8px 14px; margin:14px 0 4px; padding:9px 13px;
    background:var(--surf); border:1px solid var(--line); border-radius:9px; font-size:12.5px; }
  .ic-bar label { display:flex; align-items:center; gap:6px; color:var(--mut); }
  .ic-bar input[type=date] { font:inherit; padding:3px 6px; border:1px solid var(--line);
    border-radius:6px; background:var(--bg); color:var(--fg); }
  .ic-presets { display:flex; gap:5px; margin-left:auto; }
  .ic-presets button { font:inherit; font-size:11.5px; padding:4px 10px; cursor:pointer;
    border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--mut); }
  .ic-presets button:hover { border-color:var(--mut); color:var(--fg); }
  @media print { .ic-bar, .ictoggle { display:none; } .ic-on .ichart > svg:not(.ic-svg) { display:block; } .ic-svg, .ic-tip, .ic-sum { display:none; } }
  .c-etf { border-top:3px solid var(--lv); }
  .c-next { border-top:3px solid var(--nx); }
  .pill { display:inline-block; font-size:9.5px; letter-spacing:1.5px; padding:2px 6px; border-radius:4px;
    color:#fff; vertical-align:2px; margin-right:5px; font-weight:600; }
  .pill.pd { background:var(--cr); } .pill.pu { background:var(--kq); }

  /* 탭: 라디오 + 형제 선택자만 쓴다. JS 없이 file:// 에서도 그대로 동작한다. */
  /* 선택된 탭은 색으로 꽉 채운다. 테두리만으로 구분하면 흰 배경에서 거의 안 보였다. */
  .tabin { position:absolute; opacity:0; pointer-events:none; }
  /* 화면에 붙는 메뉴. .wrap 의 좌우 패딩을 음수 마진으로 상쇄해 화면 끝까지 깔린다. */
  .tabs { position:sticky; top:0; z-index:30; display:flex; gap:6px; flex-wrap:wrap; align-items:center;
    margin:10px -26px 8px; padding:8px 26px; background:var(--bg);
    border-bottom:1px solid var(--line); box-shadow:0 6px 14px -12px rgba(0,0,0,.5); }
  .tabs label, .tabs a.tj { flex:0 0 auto; cursor:pointer; padding:6px 12px; line-height:1.3;
    border:1.5px solid var(--line); border-radius:8px; background:var(--surf);
    color:var(--mut); text-decoration:none; white-space:nowrap; }
  .tabs label i { font-size:9.5px; letter-spacing:1px; font-style:normal; opacity:.7; margin-right:5px; }
  .tabs label b, .tabs a.tj { font-size:13px; letter-spacing:-.2px; color:var(--fg); font-weight:700; }
  .tabs label:hover, .tabs a.tj:hover { border-color:var(--mut); }
  /* 요약·판정으로 돌아가는 링크는 파트 탭과 성격이 달라 점선으로 구분한다. */
  .tabs a.tj { border-style:dashed; background:transparent; }
  @media (max-width:700px) {
    .tabs { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; }
    .tabs::-webkit-scrollbar { display:none; }
  }
  /* 앵커로 이동할 때 sticky 메뉴가 제목을 덮지 않게 한다. */
  .today, .summary, .pane h2, .pane, .parthead { scroll-margin-top:60px; }
  /* 선택 상태 — 배경을 파트 색으로 채우고 글자를 흰색으로 뒤집는다. */
  #tab-down:checked ~ .tabs label[for="tab-down"],
  #tab-up:checked ~ .tabs label[for="tab-up"],
  #tab-etf:checked ~ .tabs label[for="tab-etf"],
  #tab-next:checked ~ .tabs label[for="tab-next"],
  #tab-stock:checked ~ .tabs label[for="tab-stock"],
  #tab-ctry:checked ~ .tabs label[for="tab-ctry"],
  #tab-all:checked ~ .tabs label[for="tab-all"] { color:#fff; }
  #tab-down:checked ~ .tabs label[for="tab-down"] b,
  #tab-up:checked ~ .tabs label[for="tab-up"] b,
  #tab-etf:checked ~ .tabs label[for="tab-etf"] b,
  #tab-next:checked ~ .tabs label[for="tab-next"] b,
  #tab-stock:checked ~ .tabs label[for="tab-stock"] b,
  #tab-ctry:checked ~ .tabs label[for="tab-ctry"] b,
  #tab-all:checked ~ .tabs label[for="tab-all"] b { color:#fff; }
  #tab-down:checked ~ .tabs label[for="tab-down"] { background:var(--cr); border-color:var(--cr); }
  #tab-up:checked ~ .tabs label[for="tab-up"] { background:var(--kq); border-color:var(--kq); }
  #tab-etf:checked ~ .tabs label[for="tab-etf"] { background:var(--lv); border-color:var(--lv); }
  #tab-next:checked ~ .tabs label[for="tab-next"] { background:var(--nx); border-color:var(--nx); }
  #tab-stock:checked ~ .tabs label[for="tab-stock"] { background:var(--stk); border-color:var(--stk); }
  #tab-ctry:checked ~ .tabs label[for="tab-ctry"] { background:var(--ctry); border-color:var(--ctry); }
  #tab-all:checked ~ .tabs label[for="tab-all"] { background:var(--acc); border-color:var(--acc); }
  /* 선택 안 된 탭에도 파트 색을 왼쪽 띠로 조금 남겨 어느 축인지 알 수 있게 한다. */
  .tabs label[for="tab-down"] { border-left:5px solid var(--cr); }
  .tabs label[for="tab-up"] { border-left:5px solid var(--kq); }
  .tabs label[for="tab-etf"] { border-left:5px solid var(--lv); }
  .tabs label[for="tab-next"] { border-left:5px solid var(--nx); }
  .tabs label[for="tab-stock"] { border-left:5px solid var(--stk); }
  .tabs label[for="tab-ctry"] { border-left:5px solid var(--ctry); }
  .tabs label[for="tab-all"] { border-left:5px solid var(--acc); }
  .pane { display:none; }
  #tab-down:checked ~ .p-down, #tab-up:checked ~ .p-up, #tab-etf:checked ~ .p-etf,
  #tab-next:checked ~ .p-next, #tab-stock:checked ~ .p-stock, #tab-ctry:checked ~ .p-ctry,
  #tab-all:checked ~ .pane { display:block; }
  tr.dim td { opacity:.55; }
  td.up { color:var(--kq); } td.dn { color:var(--cr); }
  /* 매일 볼 것 — 첫 화면 고정 박스. 판정에 따라 색이 바뀐다. */
  .watch { margin:18px 0 4px; padding:14px 16px 12px; border-radius:10px;
    border:1.5px solid var(--line); border-left:6px solid var(--mut); background:var(--surf); }
  .watch.w-build { border-left-color:var(--cr); }
  .watch.w-flat { border-left-color:var(--part); }
  .watch.w-roll { border-left-color:var(--kq); }
  .watch.w-aum { border-left-color:var(--lv); }
  .watch.w-stress { border-left-color:var(--nx); }
  .w-stress .wtag { background:var(--nx); }
  /* 세 지표를 한 줄에 — 좌수(환매)·AUM(충격)·마진콜(스트레스)은 같이 봐야 한다. */
  .wgrid { display:grid; grid-template-columns:1fr; gap:14px; margin:18px 0 4px; }
  @media (min-width:1000px) { .wgrid { grid-template-columns:repeat(3,1fr); } }
  .wgrid .watch { margin:0; }
  .wgrid .wv { font-size:26px; }
  .wgrid .wnums { font-size:11px; }
  .wgrid .wtrend { max-width:none; }
  .w-aum .wtag { background:var(--lv); }
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
  /* 파트 안쪽 목차. 한 파트가 화면 열 장을 넘어가서 위 메뉴만으로는 안쪽을 못 찾는다. */
  .secnav { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0 0 6px;
    padding:9px 12px; border:1px solid var(--line); border-top:none; border-radius:0 0 8px 8px; }
  .secnav b { font-size:10.5px; letter-spacing:1.5px; color:var(--mut); margin-right:4px; }
  .secnav a { font-size:12px; color:var(--acc); text-decoration:none; padding:3px 9px;
    border:1px solid var(--line); border-radius:20px; max-width:23em; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .secnav a:hover { background:var(--surf); border-color:var(--acc); }
  .parthead { margin:22px 0 0; padding:11px 14px; border-radius:7px 7px 0 0; color:#fff; }
  .parthead i { display:block; font-size:10px; letter-spacing:2px; font-style:normal; opacity:.85; }
  .parthead b { font-size:16px; }
  .ph-down { background:var(--cr); }
  .ph-up { background:var(--kq); }
  .ph-etf { background:var(--lv); }
  .ph-next { background:var(--nx); }
  .ph-stock { background:var(--stk); }
  .ph-ctry { background:var(--ctry); }
  /* 국가별 포지션 막대 — 씨티 차트 색을 그대로 따른다(파랑 신규롱 / 빨강 신규숏 /
     연파랑 롱청산 / 분홍 숏커버 / 노란 마름모 Net). 색이 곧 범례라 임의로 바꾸지 않는다. */
  .b-nl { fill:var(--acc); } .b-ns { fill:var(--cr); }
  .b-cl { fill:var(--bar); opacity:.75; } .b-cs { fill:var(--part); opacity:.55; }
  .b-net { fill:#f2c744; stroke:var(--fg); stroke-width:1; }
  .zero { stroke:var(--fg); stroke-width:1.2; }
  .sw.net { background:#f2c744; height:9px; width:9px; transform:rotate(45deg); border:1px solid var(--fg); }
  .pill.pl { background:var(--lv); } .pill.pn { background:var(--nx); }
  #tab-down:focus-visible ~ .tabs label[for="tab-down"],
  #tab-up:focus-visible ~ .tabs label[for="tab-up"],
  #tab-etf:focus-visible ~ .tabs label[for="tab-etf"],
  #tab-next:focus-visible ~ .tabs label[for="tab-next"],
  #tab-stock:focus-visible ~ .tabs label[for="tab-stock"],
  #tab-all:focus-visible ~ .tabs label[for="tab-all"] { outline:2px solid var(--acc); outline-offset:2px; }
  @media print { .tabs, .secnav { display:none; } .pane { display:block !important; }
    .parthead { border-radius:7px; margin-top:22px; } }
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
  /* min-width 는 figure(가로 스크롤 있음) 안의 본문 차트용이다. 요약칸의 미니 차트는
     폭 170~360px 칸에 들어가므로 그대로 두면 칸을 뚫고 나가 페이지에 가로 스크롤이 생긴다. */
  .trend svg, .wtrend svg { min-width:0; }
  .grid { stroke:var(--line); stroke-width:1; }
  /* 누적 면적 차트의 사건 표시선(단일종목 상장일 등) */
  line.mk { stroke:var(--fg); stroke-width:1; stroke-dasharray:3 3; opacity:.45; }
  figure.wide .lg .sw { height:10px; border-radius:2px; }
  .ax { font-size:10px; fill:var(--mut); } .ax.sm { font-size:9px; }
  .unit { font-size:10px; fill:var(--mut); }
  /* 축 단위. 눈금 숫자보다 진하고 굵게 — 무엇을 재는 그림인지가 제목이 아니라 축에서 읽혀야 한다. */
  .axu { font-size:10.5px; font-weight:700; fill:var(--fg); opacity:.75; }
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
  /* 파트가 넷이라 auto-fit 으로 두면 넓은 화면에서 3+1 로 갈려 마지막 컬럼만 혼자 남는다.
     2×2 로 고정한다 — 1·2(잔고 양방향)와 3·4(ETF·전망)가 줄로도 짝이 맞는다. */
  .tables { display:grid; grid-template-columns:1fr; gap:20px; margin-top:16px; }
  @media (min-width:760px) { .tables { grid-template-columns:1fr 1fr; } }
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
  <div>
    <div class="kicker">Liquidity Analysis</div>
    <h1>사이클별 지수대별 신용융자 누적과 반대매매 진행률</h1>
    <div class="sub">코스피 ${dtFull(co.headline.idxLastDate)} 종가 ${f(co.headline.idxLast)}p ·
      신용융자 ${dtFull(co.headline.creditLastDate)} 기준 ${f(co.headline.creditLastJo)}조원 ·
      ${A.meta.hasSplit ? '유가증권/코스닥 분리 적용' : '시장 합계 기준'}</div>
  </div>
  <a class="hub-link" href="https://pf-dash-a3k9m-sigma.vercel.app/portfolio.html">← 허브로</a>
</header>

${splitBox}

<div id="ic-bar" class="ic-bar" hidden></div>

<!-- 라디오는 .tabs 와 .pane 보다 앞에 있어야 한다(형제 선택자 ~ 로 둘 다 제어한다).
     탭 자체는 결론 위로 올린다 — 요약 아래에 두면 스크롤해야 보여서 파트 이동을 못 찾는다. -->
<input type="radio" name="tab" id="tab-down" class="tabin" checked>
<input type="radio" name="tab" id="tab-up" class="tabin">
${etfSection ? '<input type="radio" name="tab" id="tab-etf" class="tabin">' : ''}
${outlookSection ? '<input type="radio" name="tab" id="tab-next" class="tabin">' : ''}
${stockFlowSection ? '<input type="radio" name="tab" id="tab-stock" class="tabin">' : ''}
${countrySection ? '<input type="radio" name="tab" id="tab-ctry" class="tabin">' : ''}
<input type="radio" name="tab" id="tab-all" class="tabin">
<!-- 화면에 늘 붙어 있는 메뉴. 파트 설명은 각 파트 머리(.parthead)가 이미 달고 있으니
     여기서는 한 줄로 줄인다 — 세 줄짜리 카드를 sticky 로 붙이면 화면을 너무 먹는다. -->
<nav class="tabs">
  <a class="tj" href="#top-verdict">판정</a>
  <a class="tj" href="#top-summary">요약</a>
  <label for="tab-down"><i>1</i><b>신용잔고</b></label>
  <label for="tab-up"><i>2</i><b>공매도·숏커버</b></label>
  ${etfSection ? '<label for="tab-etf"><i>3</i><b>레버리지 ETF</b></label>' : ''}
  ${outlookSection ? '<label for="tab-next"><i>4</i><b>다음 주 수급</b></label>' : ''}
  ${stockFlowSection ? '<label for="tab-stock"><i>5</i><b>종목 트래킹</b></label>' : ''}
  ${countrySection ? '<label for="tab-ctry"><i>6</i><b>국가별 포지션</b></label>' : ''}
  <label for="tab-all" class="t-all"><b>전체</b></label>
</nav>

${verdictSection}

${summarySection}

<div class="pane p-down">
<div class="parthead ph-down"><i>PART 1</i><b>신용잔고 — 얼마나 더 하락할 수 있나</b></div>

<figure>
  <h4>신용융자 — 시장별 잔고와 코스피 지수 (두 사이클)</h4>
  ${A.creditByMarket ? timeSeriesChart(A.creditByMarket.series, A.periods)
    : timeSeriesChart(A.series.filter(p => p.d >= '20200101').map(p => ({ d: p.d, total: p.c != null ? p.c / 1e6 : null, idx: p.i })), A.periods)}
  <div class="lg"><span><i class="sw cr"></i>전체</span><span><i class="sw acc"></i>코스피</span><span><i class="sw kq"></i>코스닥</span><span><i class="sw" style="background:var(--mut)"></i>코스피 지수(우, 점선)</span></div>
  <figcaption>체크박스로 전체·코스피·코스닥을 하나씩, 또는 원하는 조합으로 겹쳐 볼 수 있다(기본 전체 켜짐).
    음영은 각 사이클의 적립 구간. 전체는 결제일 기준이라 지수보다 1~2일 늦게 확정되고, 코스피·코스닥
    분리분은 수동으로 올리는 분리 파일(§8) 기준이라 <b>그보다 1~2주 더 늦다</b> — 오른쪽 끝의 빈 구간은
    누락이 아니라 그 지연이다.</figcaption>
</figure>

${compare}

${divergenceSection}

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

${turnoverSection}

${investorSection}

</div><!-- /p-etf -->` : ''}

${outlookSection ? `<div class="pane p-next">
<div class="parthead ph-next"><i>PART 4</i><b>다음 주 수급 — 지수가 어디로 가면 무엇이 따라 나오나</b></div>

${outlookSection}

${directionSection}

</div><!-- /p-next -->` : ''}

${countrySection ? `<div class="pane p-ctry">
<div class="parthead ph-ctry"><i>PART 6</i><b>국가별 포지션 — 돈이 어느 나라에서 빠지나</b></div>

${countrySection}

</div><!-- /p-ctry -->` : ''}

${stockFlowSection ? `<div class="pane p-stock">
<div class="parthead ph-stock"><i>PART 5</i><b>종목 트래킹 — 삼성전자·SK하이닉스</b></div>

${stockFlowSection}

${globalSemisSection}

</div><!-- /p-stock -->` : ''}

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
<script>${chartRuntime()}</script>
</div>`;

/**
 * 파트 안쪽 목차. 한 파트가 화면 열 장을 넘어가서, 파트에 들어와도 무엇이 어디 있는지
 * 알 수 없었다 — 위 메뉴는 파트 사이만 옮겨 준다.
 *
 * h2 서른 개에 손으로 id 를 달지 않는다. 조립이 끝난 HTML 에서 한 번에 처리한다 —
 * 각 파트 끝에 `<!-- /p-키 -->` 주석이 있어 경계를 정확히 잡을 수 있다.
 */
function addPaneIndexes(doc) {
  let made = 0;
  const out = doc.replace(/(<div class="pane p-([a-z]+)">)([\s\S]*?)(<!-- \/p-\2 -->)/g,
    (all, open, key, body, close) => {
      let n = 0;
      const items = [];
      const withIds = body.replace(/<h2([^>]*)>([\s\S]*?)<\/h2>/g, (m, attrs, inner) => {
        if (/\bid=/.test(attrs)) return m;
        const id = `s-${key}-${++n}`;
        items.push({ id, text: inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() });
        return `<h2 id="${id}"${attrs}>${inner}</h2>`;
      });
      if (items.length < 2) return all;         // 섹션이 하나면 목차가 의미 없다
      made++;
      const idx = `<nav class="secnav"><b>이 파트 안에서</b>${
        items.map(i => `<a href="#${i.id}">${esc(i.text)}</a>`).join('')}</nav>`;
      // 파트 머리 바로 뒤에 끼운다.
      return open + withIds.replace(/(<div class="parthead[^>]*>[\s\S]*?<\/div>)/, `$1\n${idx}`) + close;
    });
  if (!made) throw new Error('파트 목차를 하나도 못 만들었다 — pane 마커나 h2 구조가 바뀌었다');
  return out;
}

const doc = addPaneIndexes(html);
fs.writeFileSync(path.join(ROOT, 'index.html'), doc);
console.log(`index.html 생성 (${(doc.length / 1024).toFixed(0)} KB)`);
console.log(`  사이클 ${A.periods.map(p => p.name).join(' / ')}`);
console.log(`  시장 ${A.meta.markets.join(', ')} · 재현 MAE ${f(A.reproMAE, 3)}조 · 분리적용 ${A.meta.hasSplit ? 'O' : 'X'}`);
