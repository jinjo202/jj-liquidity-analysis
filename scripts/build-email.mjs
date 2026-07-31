// data/analysis.json 을 모바일 메일 클라이언트에서도 안 깨지는 HTML로 굽는다.
//
// index.html(웹 리포트)이 메일 앱에서 깨지는 이유:
//   - <style> 블록을 통째로 걷어내는 앱이 많다(네이버메일, 일부 Gmail 웹뷰).
//   - CSS 변수(var(--x))·grid·flex 는 메일 렌더러가 대부분 지원 안 한다.
//   - prefers-color-scheme 다크모드 대응이 없으면 강제 리컬러링으로 텍스트가 안 보이게 된다.
//   - 인라인 <svg> 는 앱에 따라 통째로 제거된다.
//
// 그래서 이 스크립트는 완전히 다른 렌더링 전략을 쓴다:
//   - 모든 스타일을 요소에 직접 inline 으로 쓴다. <style> 태그를 아예 안 쓴다.
//   - 레이아웃은 <table> 만 쓴다(뉴스레터 업계 표준 방식). grid/flex 없음.
//   - 다크모드는 <meta name="color-scheme" content="light">, "supported-color-schemes" 로
//     강제 라이트 고정한다. 팔레트는 라이트 하나만 쓴다.
//   - 차트는 SVG 대신 '표 셀 막대'로 그린다: <td width="NN%" bgcolor="..."> 로 막대 길이를 표현한다.
//     이 방식은 오래된 이메일 뉴스레터에서 검증된 크로스 클라이언트 기법이다.
//   - 일별 시계열(1700여 행)은 표로 그리기엔 너무 크므로, 월별 스냅샷으로 축약한다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'analysis.json'), 'utf8'));

const f = (n, d = 2) => (n == null || !Number.isFinite(n) ? '-' : n.toFixed(d));
const k0 = n => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '-');
const dtFull = s => `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- 팔레트 (라이트 고정, 다크모드 대응 없음) ---------- */
const C = {
  bg: '#f2f4f6', card: '#ffffff', fg: '#12181f', mut: '#5a6672', line: '#e2e6ea',
  acc: '#1a56a8', kq: '#2e8b6f', cr: '#c0392b', hit: '#c0392b', part: '#e8883a', bar: '#8b9bb0',
  band: '#fdf1ec', trackBg: '#eef1f4',
};

const FONT = "font-family:Arial,Helvetica,'Malgun Gothic',sans-serif;";
const td = (extra = '') => `style="padding:5px 8px;border-bottom:1px solid ${C.line};${FONT}font-size:12px;color:${C.fg};${extra}"`;
const th = (extra = '') => `style="padding:5px 8px;border-bottom:2px solid ${C.fg};${FONT}font-size:11px;color:${C.mut};text-align:left;${extra}"`;
const nAlign = 'text-align:right;font-variant-numeric:tabular-nums;';

/* ---------- 공통 컴포넌트 ---------- */

function table(head, rows, opts = {}) {
  const w = opts.width ?? '100%';
  // table-layout:fixed 로 열 폭을 강제한다. auto 로 두면 좁은 화면에서 중첩 구조 때문에
  // 콘텐츠 intrinsic width 만큼 표가 옆으로 새어나간다.
  return `<table role="presentation" width="${w}" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${w};table-layout:fixed;margin:6px 0 14px;">
  <tr>${head.map(h => `<th ${th((h.n ? nAlign : '') + 'overflow:hidden;word-break:break-word;')}>${esc(h.label)}</th>`).join('')}</tr>
  ${rows.map(r => `<tr>${r.map((c, i) => `<td ${td((head[i]?.n ? nAlign : '') + 'overflow:hidden;word-break:break-word;')}>${c}</td>`).join('')}</tr>`).join('')}
</table>`;
}

function sectionTitle(text) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 4px;">
  <tr>
    <td width="4" bgcolor="${C.acc}" style="font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:0 0 0 9px;${FONT}font-size:16px;font-weight:bold;color:${C.fg};">${esc(text)}</td>
  </tr>
</table>`;
}

/** 파트 구분(메일에는 탭이 없으므로 큰 머리말로 나눈다). */
function partTitle(no, title, sub, color) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 2px;">
  <tr><td bgcolor="${color}" style="padding:11px 14px;border-radius:7px;">
    <div style="${FONT}font-size:10.5px;letter-spacing:2px;color:#ffffff;opacity:.85;">PART ${no}</div>
    <div style="${FONT}font-size:17px;font-weight:bold;color:#ffffff;">${esc(title)}</div>
    <div style="${FONT}font-size:12px;color:#ffffff;opacity:.9;">${esc(sub)}</div>
  </td></tr>
</table>`;
}

function subTitle(text) {
  return `<div style="${FONT}font-size:12.5px;font-weight:bold;color:${C.mut};margin:14px 0 4px;">${esc(text)}</div>`;
}

function lead(text) {
  return `<div style="${FONT}font-size:12.5px;color:${C.mut};margin:2px 0 12px;line-height:1.6;">${text}</div>`;
}

function box(text, warn = false) {
  const c = warn ? C.part : C.acc;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;">
  <tr>
    <td width="3" bgcolor="${c}" style="font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="${C.card}" style="border:1px solid ${C.line};border-left:none;padding:10px 13px;${FONT}font-size:12.5px;color:${C.fg};line-height:1.6;">${text}</td>
  </tr>
</table>`;
}

/** 스택형 카드(모바일 폭 보장을 위해 한 줄에 하나씩). */
function cards(list) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;">
  ${list.map(c => `<tr><td style="padding:3px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;">
      <tr>
        <td style="padding:9px 13px;">
          <div style="${FONT}font-size:11px;color:${C.mut};">${esc(c.label)}</div>
          <div style="${FONT}font-size:20px;color:${c.neg ? C.cr : C.fg};font-variant-numeric:tabular-nums;">${c.value}<span style="font-size:12px;">${esc(c.unit ?? '')}</span></div>
          <div style="${FONT}font-size:11px;color:${C.mut};">${esc(c.note ?? '')}</div>
        </td>
      </tr>
    </table>
  </td></tr>`).join('')}
</table>`;
}

/**
 * 표 셀 막대 차트. 각 행: 라벨 | (트랙 안에 색칠된 셀 하나) | 값.
 * 모바일 메일에서도 안정적으로 그려지는 유일한 방식이라 SVG 대신 이걸 쓴다.
 */
// table-layout:fixed 로 폭을 percent 에 강제로 고정한다. 그냥 auto 레이아웃으로 두면
// 중첩된 % 테이블의 intrinsic width 계산 때문에 375px 화면에서도 옆으로 몇 px씩 새어나갔다.
function barRows(items, max, colorOf) {
  return items.map(it => {
    const pct = Math.max(0.5, Math.min(100, (it.value / max) * 100));
    return `<tr>
      <td style="${FONT}font-size:10px;color:${C.mut};padding:3px 4px 3px 0;overflow:hidden;width:26%;">${esc(it.label)}</td>
      <td style="padding:3px 0;width:56%;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">
          <tr>
            <td width="${pct.toFixed(1)}%" bgcolor="${colorOf(it)}" style="height:12px;font-size:0;line-height:0;">&nbsp;</td>
            <td width="${(100 - pct).toFixed(1)}%" bgcolor="${C.trackBg}" style="height:12px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td>
      <td style="${FONT}font-size:11px;color:${C.fg};padding:3px 0 3px 4px;text-align:right;overflow:hidden;width:18%;">${f(it.value)}</td>
    </tr>`;
  }).join('');
}

function barChart(title, items, max, colorOf, caption) {
  return `<div style="${FONT}font-size:12px;font-weight:bold;color:${C.mut};margin:12px 0 4px;">${esc(title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;table-layout:fixed;">
  ${barRows(items, max, colorOf)}
</table>
${caption ? `<div style="${FONT}font-size:11px;color:${C.mut};margin-bottom:10px;line-height:1.5;">${caption}</div>` : ''}`;
}

/* ---------- 사이클 x 시장 블록 ---------- */

function marketBlock(name, m, closed) {
  const h = m.headline;
  const rc = m.reconciliation;

  const bucketColor = b => (b.fullyTriggered ? C.hit : b.triggered ? C.part : C.bar);
  const bMax = Math.max(...m.scaledBuckets.map(b => b.jo)) * 1.05;
  const bItems = m.buckets.map((b, i) => ({
    label: `${k0(b.low)}`, value: m.scaledBuckets[i].jo, b,
  })).filter(it => it.value >= 0.01);

  const bChart = barChart(
    `지수대별 누적 신용매수(보정, 버킷 ${m.width}p)`,
    bItems, bMax, it => bucketColor(it.b),
    `빨강=마진콜 전량 진입, 주황=일부 진입, 회색=미진입. 기준선 ${dtFull(m.accBase)} 잔고 이후 증가분을 배분 후 사이클 순증(${f(m.netBuildJo)}조)에 맞춰 보정.`
  );

  const bucketRows = m.buckets.map((b, i) => [
    `${k0(b.low)}–${k0(b.high)}`,
    f(m.scaledBuckets[i].jo),
    k0(b.marginHigh),
    b.fullyTriggered ? '청산완료' : b.triggered ? '청산진행' : '–',
  ]).filter(r => parseFloat(r[1]) >= 0.01);
  const bucketTable = table(
    [{ label: '구간(p)' }, { label: '금액(조)', n: true }, { label: '마진콜(p)', n: true }, { label: '상태' }],
    bucketRows
  );

  // 적립(보정) vs 실제 청산 — 같은 지수대 축에 두 막대
  const accByLow = new Map(m.scaledBuckets.map(b => [b.low, b.jo]));
  const outByLow = new Map(m.unwind.buckets.map(b => [b.low, b.jo]));
  const lows = [...new Set([...accByLow.keys(), ...outByLow.keys()])]
    .filter(l => (accByLow.get(l) ?? 0) >= 0.01 || (outByLow.get(l) ?? 0) >= 0.01)
    .sort((a, b) => a - b);
  const flowMax = Math.max(1, ...lows.map(l => Math.max(accByLow.get(l) ?? 0, outByLow.get(l) ?? 0))) * 1.05;
  const flowItems = lows.flatMap(l => ([
    { label: `${k0(l)} 적립`, value: accByLow.get(l) ?? 0, kind: 'acc' },
    { label: `${k0(l)} 청산`, value: outByLow.get(l) ?? 0, kind: 'out' },
  ]));
  const flowChart = flowItems.some(it => it.value >= 0.01)
    ? barChart(
      '어디서 쌓이고 어디서 털렸는가',
      flowItems.filter(it => it.value >= 0.01), flowMax,
      it => (it.kind === 'acc' ? C.bar : C.cr),
      `회색=적립(보정), 빨강=실제 청산. 청산 국면 ${dtFull(m.unwind.fromDate)}~${dtFull(m.unwind.toDate)},
       가중평균 매수 ${k0(m.unwind.weightedBuildIdx)}p → 청산 ${k0(m.unwind.weightedUnwindIdx)}p.
       진행 중인 사이클은 청산 국면이 짧아 최근 고지수 물량만 반영되니 손실률로 읽지 말 것.`
    )
    : '';

  return `
${subTitle(`${name} · 버킷 ${m.width}p`)}
${cards([
    { label: '지수 고점→저점', value: f(h.idxDrawdownPct, 1), unit: '%', note: `${k0(h.idxPeak)} → ${k0(h.idxTrough)}` },
    { label: '신용융자 고점', value: f(h.creditPeakJo), unit: '조', note: dtFull(h.creditPeakDate) },
    { label: '실측 청산', value: f(h.actualDeclineJo), unit: '조', neg: true, note: `청산률 ${f(h.unwindPct, 1)}%` },
    { label: '마진콜 진입(보정)', value: f(m.scaledExposureJo), unit: '조', neg: true, note: `순증의 ${f(h.exposureOfBuildPct, 0)}%` },
  ])}
${bChart}
${flowChart}
${box(`<b>모델 vs 실측</b> — 보정 모델 ${f(rc.scaledExposureJo)}조, 실측 청산 ${f(rc.actualDeclineJo)}조, 오차 ${f(Math.abs(rc.scaledGapJo))}조.
  ${closed ? '이 사이클은 청산이 끝났으므로 이 대조가 모델의 실질적인 검증이다.'
      : '진행 중인 사이클이다. 결제일 시차와 추가 담보 납입, 자발적 축소가 섞여 있다.'}`,
    Math.abs(rc.scaledGapJo) >= Math.abs(rc.gapJo))}
${m.turnover ? box(`<b>거래대금 대비</b> — 청산 국면 총유출 ${f(m.unwind.totalJo)}조는 그 기간 거래대금(${f(m.turnover.unwindTotalJo)}조)의
  ${f(m.unwind.pctOfTurnover, 2)}%, 그 시대 정상 하루 거래대금(${f(m.turnover.baselineAvgDailyJo)}조)의 ${f(m.unwind.equivDays, 2)}배다.
  그 국면 거래대금은 정상 대비 ${f(m.turnover.unwindVsBaselinePct, 0)}% 수준이었다(100% 미만=청산이 유동성 마른 채로 진행).
  남은 사다리 ${f(m.scaledRemainingJo)}조는 <b>오늘 기준</b> 하루 평균 거래대금(${f(m.turnover.currentAvgDailyJo)}조)의
  ${f(m.scaledRemainingJo / m.turnover.currentAvgDailyJo, 2)}배다.`) : ''}
${bucketTable}
${m.ladder.length ? subTitle('마진콜 사다리 — 지수가 이 아래로 마감하면 열리는 물량') : ''}
${m.ladder.length ? table(
      [{ label: '지수(p) 밑' }, { label: '매수구간(p)' }, { label: '증가(조)', n: true }, { label: '누적(조)', n: true }, { label: '누적/일거래대금', n: true }],
      m.ladder.map(r => [
        k0(r.threshold), `${k0(r.low)}–${k0(r.high)}`, `+${f(r.incrementalJo)}`, f(r.cumulativeJo),
        r.cumulativePctOfDay != null ? `${f(r.cumulativePctOfDay, 1)}%` : '–',
      ])
    ) : ''}
`;
}

/* ---------- 사이클 대조 ---------- */

const P = A.periods;
const closedP = P.find(p => p.closed), openP = P.find(p => !p.closed);
const ca = closedP?.markets['전체'], co = openP?.markets['전체'];

let compareHtml = '';
if (ca && co) {
  const a = ca.headline, b = co.headline;
  compareHtml = `
${sectionTitle('사이클 대조')}
${lead('코스피 레벨이 2021년 3,305p, 2026년 9,115p로 완전히 다르다. 전 기간을 같은 절대 지수 버킷으로 묶으면 두 국면이 섞이므로 사이클을 나눠 계산했다.')}
${table(
    [{ label: '' }, { label: closedP.name, n: true }, { label: openP.name, n: true }],
    [
      ['지수 고점', k0(a.idxPeak), k0(b.idxPeak)],
      ['지수 낙폭', `${f(a.idxDrawdownPct, 1)}%`, `${f(b.idxDrawdownPct, 1)}%`],
      ['신용융자 고점', `${f(a.creditPeakJo)}조`, `${f(b.creditPeakJo)}조`],
      ['실측 청산', `${f(a.actualDeclineJo)}조`, `${f(b.actualDeclineJo)}조`],
      ['청산률', `${f(a.unwindPct, 1)}%`, `${f(b.unwindPct, 1)}%`],
      ['마진콜 진입(보정)', `${f(ca.scaledExposureJo)}조`, `${f(co.scaledExposureJo)}조`],
    ]
  )}
${box(`끝난 2020–21 사이클에서 보정 모델은 청산 규모를 <b>${f(ca.scaledExposureJo)}조</b>로 추정했고 실측은 ${f(-a.actualDeclineJo)}조였다(오차 ${f(Math.abs(ca.reconciliation.scaledGapJo))}조). 마진콜 기반 추정이 실제 청산 대부분을 설명한다.`)}
${box(`현 사이클은 지수 낙폭(${f(b.idxDrawdownPct, 1)}%)이 이미 2022년(${f(a.idxDrawdownPct, 1)}%)보다 깊은데 청산률(${f(b.unwindPct, 1)}%)은 2021 사이클의 ${f(b.unwindPct / a.unwindPct * 100, 0)}% 수준이다.`, true)}
`;
}

/* ---------- 전망 ---------- */

const PJ = A.projection;
/* ---------- 월별 지수·거래대금 비교 ---------- */

function monthlyYearHtml(mo) {
  const idxItems = mo.months.flatMap((m, i) => ([
    { label: `${m.ym.slice(5)} 코스피`, value: mo.kIdxIdx[i], kind: 'k' },
    { label: `${m.ym.slice(5)} 코스닥`, value: mo.qIdxIdx[i] ?? 0, kind: 'q' },
  ])).filter(it => it.value);
  const idxMax = Math.max(...idxItems.map(it => it.value)) * 1.05;

  const toItems = mo.months.flatMap(m => ([
    { label: `${m.ym.slice(5)} 코스피`, value: m.kToJo ?? 0, kind: 'k' },
    { label: `${m.ym.slice(5)} 코스닥`, value: m.qToJo ?? 0, kind: 'q' },
  ])).filter(it => it.value);
  const toMax = Math.max(...toItems.map(it => it.value)) * 1.05;

  const rows = mo.months.map((m, i) => [
    m.ym, k0(m.kIdx), f(mo.kIdxIdx[i], 1),
    m.qIdx != null ? k0(m.qIdx) : '-', mo.qIdxIdx[i] != null ? f(mo.qIdxIdx[i], 1) : '-',
    f(m.kToJo), f(m.qToJo),
  ]);

  return `
${subTitle(`${mo.year}년`)}
${barChart(`지수 (1월=100)`, idxItems, idxMax, it => (it.kind === 'k' ? C.acc : C.kq),
    '')}
${barChart(`월평균 거래대금(조원)`, toItems, toMax, it => (it.kind === 'k' ? C.acc : C.kq),
    '')}
${table(
    [{ label: '월' }, { label: '코스피', n: true }, { label: '지수화', n: true }, { label: '코스닥', n: true }, { label: '지수화', n: true }, { label: '코스피대금', n: true }, { label: '코스닥대금', n: true }],
    rows
  )}`;
}

let monthlyHtml = '';
if (A.monthly?.closed && A.monthly?.open) {
  monthlyHtml = `
${sectionTitle(`월별 지수·거래대금 비교 — ${A.monthly.closed.year}년 vs ${A.monthly.open.year}년`)}
${lead(`코스피(2천~9천대)와 코스닥(6백~1천2백대)은 원 지수 그대로 겹치면 코스닥이 눌린다. 지수는 그 해 1월을 100으로 지수화했다.`)}
<div style="${FONT}font-size:11px;color:${C.mut};margin:4px 0 10px;">
  <span style="display:inline-block;width:10px;height:10px;background:${C.acc};border-radius:2px;vertical-align:-1px;margin-right:4px;"></span>코스피
  <span style="display:inline-block;width:10px;height:10px;background:${C.kq};border-radius:2px;vertical-align:-1px;margin:0 4px 0 12px;"></span>코스닥
</div>
${monthlyYearHtml(A.monthly.closed)}
${monthlyYearHtml(A.monthly.open)}
${box(`<b>${A.monthly.closed.year}년</b>은 지수 등락폭이 작고 거래대금은 1월부터 꾸준히 우하향 — 지수와 거래대금이 따로 움직인 유형이다.
  <b>${A.monthly.open.year}년</b>은 신용 고점이 낀 달(6월)에 지수·거래대금이 나란히 정점을 찍고 다음 달(7월) 함께 무너졌다.
  코스닥은 코스피보다 한 달 먼저(5월) 꺾여, 코스닥이 유가증권보다 먼저·많이 청산됐다는 사실과 시점이 맞아떨어진다.`)}
`;
}

/* ---------- 마진콜 사다리 — 시장별 비교 ---------- */

const OPEN = A.periods.find(p => !p.closed);
let ladderCompareHtml = '';
if (OPEN) {
  const marketBlockLadder = (name, m) => {
    const head = subTitle(`${name} — 지수 ${k0(m.headline.idxTrough)}p 기준`);
    if (!m.ladder.length) {
      return head + lead('안 터진 버킷 없음(전량 마진콜 구간).');
    }
    return head + table(
      [{ label: '지수(p) 밑' }, { label: '매수구간(p)' }, { label: '증가(조)', n: true }, { label: '누적(조)', n: true }, { label: '누적/일거래대금', n: true }],
      m.ladder.map(r => [
        k0(r.threshold), `${k0(r.low)}–${k0(r.high)}`, `+${f(r.incrementalJo)}`, f(r.cumulativeJo),
        r.cumulativePctOfDay != null ? `${f(r.cumulativePctOfDay, 1)}%` : '–',
      ])
    );
  };

  ladderCompareHtml = `
${sectionTitle(`마진콜 사다리 — 시장별 비교 (${esc(OPEN.name)})`)}
${lead('지수가 얼마로 가면 얼마가 풀리는지를 시장별로 나란히 놓는다. 오른쪽 열은 오늘 기준 하루 평균 거래대금 대비 누적 비중이다.')}
${Object.entries(OPEN.markets).map(([name, m]) => marketBlockLadder(name, m)).join('')}
`;
}

/* ---------- 거래대금 대비 규모 — 시장별 비교 ---------- */

let turnoverCompareHtml = '';
if (OPEN) {
  const marketTurnoverBlock = (name, m) => {
    if (!m.turnover) return '';
    const t = m.turnover, u = m.unwind;
    const rows = [
      ['그 시대 정상 하루 거래대금', `${f(t.baselineAvgDailyJo)}조`],
      ['오늘 기준 하루 거래대금', `${f(t.currentAvgDailyJo)}조`],
      [`청산국면(${dtFull(u.fromDate)}~${dtFull(u.toDate)}) 총거래대금`, `${f(t.unwindTotalJo)}조`],
      ['그 국면 일평균, 정상 대비', `${f(t.unwindAvgDailyJo)}조 (${f(t.unwindVsBaselinePct, 0)}%)`],
      ['총유출(gross)', `${f(u.totalJo)}조`],
      ['= 그 국면 거래대금의', `${f(u.pctOfTurnover, 2)}%`],
      ['= 그 시대 정상 하루의', `${f(u.equivDays, 2)}배`],
      ['남은 사다리(보정)', `${f(m.scaledRemainingJo)}조`],
      ['= 오늘 하루의', `${f(m.scaledRemainingJo / t.currentAvgDailyJo, 2)}배`],
    ];
    return subTitle(name) + table([{ label: '지표' }, { label: '값', n: true }], rows);
  };

  const kq = OPEN.markets['코스닥']?.unwind, kospi = OPEN.markets['유가증권']?.unwind;
  const kqT = OPEN.markets['코스닥']?.turnover, kospiT = OPEN.markets['유가증권']?.turnover;

  turnoverCompareHtml = `
${sectionTitle(`거래대금 대비 규모 — 시장별 비교 (${esc(OPEN.name)})`)}
${lead('과거 청산은 그 시대 정상(청산 직전 20일 평균)과, 남은 사다리는 오늘 기준과 대조한다.')}
${Object.entries(OPEN.markets).map(([name, m]) => marketTurnoverBlock(name, m)).join('')}
${kq && kospi ? box(`<b>코스닥이 유가증권보다 거래대금 대비 청산 강도가 훨씬 세다</b> — 총유출이 그 시대 정상 하루 거래대금의
  몇 배였는지로 보면 코스닥 <b>${f(kq.equivDays, 2)}배</b>, 유가증권 <b>${f(kospi.equivDays, 2)}배</b>로 4배 가까이 차이난다.
  청산 국면 거래대금 자체는 코스닥이 정상 대비 ${f(kqT.unwindVsBaselinePct, 0)}%로 유가증권(${f(kospiT.unwindVsBaselinePct, 0)}%)보다
  덜 말랐다 — 코스닥은 유동성이 유지된 채 강한 청산이, 유가증권은 유동성이 마른 채 약한 청산이 진행됐다.`) : ''}
`;
}

/* ---------- 공매도(대차잔고) 추이와 숏커버링 ---------- */

let lendingHtml = '';
if (A.lending) {
  const L = A.lending;
  const dc = L.dayClass;
  const creditUnwindPct = A.periods.find(p => !p.closed)?.markets['전체']?.headline?.unwindPct;
  const total = dc.coverType + dc.jointUnwind + dc.newShort + dc.riskOn;

  const classRows = [
    ['지수↑ 잔고↓ (숏커버형)', dc.coverType, `${f(dc.coverType / total * 100, 0)}%`],
    ['지수↓ 잔고↓ (동반 청산)', dc.jointUnwind, `${f(dc.jointUnwind / total * 100, 0)}%`],
    ['지수↓ 잔고↑ (신규 숏 추정)', dc.newShort, `${f(dc.newShort / total * 100, 0)}%`],
    ['지수↑ 잔고↑', dc.riskOn, `${f(dc.riskOn / total * 100, 0)}%`],
  ];
  const candRows = L.candidates.map(c => [
    dtFull(c.date), k0(c.idx), `+${f(c.dIdxPct, 2)}%`, f(c.balJo), `${f(c.dBalPct, 2)}%`,
  ]);

  lendingHtml = `
${sectionTitle('공매도(대차잔고) 추이와 숏커버링')}
${lead('한국은 공매도가 거의 전량 차입 후 매도라 대차잔고를 시장 전체 공매도 잔고의 표준 프록시로 쓴다. 시장 전체 실제 공매도 잔고는 공표되지 않는다.')}
${cards([
      { label: '역대 최고', value: f(L.allTimePeak.balJo), unit: '조', note: dtFull(L.allTimePeak.date) },
      { label: '현재', value: f(L.last.balJo), unit: '조', note: dtFull(L.last.date) },
      { label: '이번 사이클 고점', value: f(L.cyclePeak.balJo), unit: '조', note: dtFull(L.cyclePeak.date) },
      { label: '고점 대비', value: f(L.cycleDeclinePct, 1), unit: '%', neg: true, note: `신용융자는 같은 기간 ${f(creditUnwindPct, 1)}%` },
    ])}
${box(`<b>대차잔고가 신용융자보다 훨씬 빠르게 풀렸다</b> — 잔고 고점(${dtFull(L.cyclePeak.date)}) 대비 ${f(L.cycleDeclinePct, 1)}% 감소,
  같은 창에서 신용융자(전체)는 ${f(creditUnwindPct, 1)}%였다. 대차거래는 공매도 외 ETF 설정/환매·차익거래에도 쓰이니
  차이 전부가 숏커버링은 아니지만, 방향은 신용보다 훨씬 빠른 디레버리징을 가리킨다.`)}
${subTitle(`잔고 고점 이후 하루 단위 지수·잔고 조합 (${total}일)`)}
${table([{ label: '유형' }, { label: '일수', n: true }, { label: '비중', n: true }], classRows)}
${lead("대부분이 '동반 청산'이다 — 지수와 잔고가 같이 빠졌다. 숏이 밀리며 지수를 떠받친 전형적 '숏커버링 랠리'는 아직 뚜렷하지 않다.")}
${subTitle(`숏커버링 후보일 상위 ${L.candidates.length}일`)}
${table([{ label: '일자' }, { label: '지수', n: true }, { label: '등락', n: true }, { label: '잔고(조)', n: true }, { label: '잔고증감', n: true }], candRows)}
${box(`<b>"오늘 급등"은 이 데이터에 아직 없다</b> — FREESIS 최신 공표일(${dtFull(L.last.date)}) 기준 지수는 여전히 하락 중이었다.
  장중 급등은 EOD 공표 전이라 반영되지 않는다. 데이터가 갱신되면 이 표가 그 날을 자동으로 잡아낸다.`, true)}
`;
}

/* ---------- 숏커버 여력 (상승 압력) ---------- */

let coverHtml = '';
if (A.lending?.cover) {
  const CV = A.lending.cover;
  const benchRows = CV.benches.map(b => [
    esc(b.name), f(b.targetJo),
    b.remainJo > 0 ? f(b.remainJo) : `<span style="color:${C.mut};">소진</span>`,
    b.equivDays != null ? `${f(b.equivDays, 2)}배` : '–',
  ]);

  coverHtml = `
${sectionTitle('숏커버 여력 — 앞으로 얼마나 더 되갚아져야 하는가')}
${lead('대차잔고가 줄어든다는 것은 빌린 주식을 <b>사서 갚는다</b>는 뜻이다 — 매수 압력이다. 신용잔고 쪽에서 "얼마나 더 팔려야 하나"를 본 것과 같은 방식으로 "얼마나 더 사야 하나"를 범위로 본다.')}
${cards([
    { label: '고점 이후 이미 되갚음', value: f(CV.coveredJo), unit: '조', note: `고점의 ${f(CV.coveredPctOfPeak, 1)}%` },
    { label: '= 하루 거래대금의', value: f(CV.coveredEquivDays, 1), unit: '배', note: `최근 20일 평균 ${f(CV.dailyTurnoverJo)}조/일` },
    { label: '현재 잔고/시총', value: f(CV.nowRatio), unit: '%', note: `이번 고점 ${f(CV.peakRatio)}%` },
    { label: '직전 사이클 저점 비율', value: f(CV.prevTroughRatio), unit: '%', note: dtFull(CV.prevTrough.date) },
  ])}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-left:4px solid ${C.kq};border-radius:0 8px 8px 0;margin:8px 0 14px;">
  <tr><td style="padding:12px 15px;">
    <div style="${FONT}font-size:11px;color:${C.mut};">잔여 숏커버 추정 범위</div>
    <div style="${FONT}font-size:24px;color:${C.fg};font-variant-numeric:tabular-nums;">${CV.lowJo > 0 ? f(CV.lowJo) : '0'}조 ~ ${f(CV.highJo)}조</div>
    <div style="${FONT}font-size:11px;color:${C.mut};">음수 벤치마크(이미 소진)는 0으로 본 하한 ~ 최대 벤치마크</div>
  </td></tr>
</table>
${table([{ label: '벤치마크' }, { label: '목표 잔고(조)', n: true }, { label: '잔여 커버(조)', n: true }, { label: '일거래대금 대비', n: true }], benchRows)}
${CV.benches.map(b => box(`<b>${esc(b.name)}</b> — ${esc(b.basis)} → 목표 ${f(b.targetJo)}조<br><span style="color:${C.part};">단서: ${esc(b.caveat)}</span>`)).join('')}
${box(`<b>비율로 보면 되돌림은 이미 끝났다</b> — 대차잔고/시총은 현재 ${f(CV.nowRatio)}%로 직전 사이클 저점 ${f(CV.prevTroughRatio)}%보다 <b>이미 낮다</b>.
  비율 기준 벤치마크 두 개가 모두 '소진'으로 나오는 이유다. 절대 잔고 복귀 벤치마크는 시가총액이 그 사이 배로 커진 것을 무시하므로 상단 과대추정으로 봐야 한다.
  신용잔고 쪽 결론과 같은 구조다 — 양쪽 모두 직전 사이클 대비 정상화가 이미 상당히 진행됐다.`, true)}
${box(`<b>이 숫자를 지수 상승폭으로 환산하지 않는다</b> — 매수 물량 몇 조가 지수 몇 %가 되는지는 이 데이터로 알 수 없다.
  거래대금 대비 배수까지만 제시한다. 대차잔고 감소 전부가 숏커버도 아니다(ETF 환매·차익거래 청산 포함).`)}
`;
}

/* ---------- 예탁금과 2차 레버리지 채널 ---------- */

let channelsHtml = '';
if (A.channels) {
  const CH = A.channels;
  const peak26 = CH.marks.find(m => m.label === '2026 신용 고점');
  const p21 = CH.marks.find(m => m.label === '2021 신용 고점');
  const pledgeDeclinePct = peak26?.pledgeJo ? (CH.last.pledgeJo / peak26.pledgeJo - 1) * 100 : null;
  const creditDeclinePct = peak26 ? (CH.last.creditJo / peak26.creditJo - 1) * 100 : null;
  const levDeclinePct = peak26 ? (CH.last.totalLevJo / peak26.totalLevJo - 1) * 100 : null;

  const markRows = CH.marks.map(m => [
    esc(m.label), f(m.depositJo), f(m.creditJo), f(m.pledgeJo), f(m.totalLevJo), f(m.coverage),
  ]);

  const covMax = Math.max(...CH.marks.map(m => m.coverage)) * 1.15;
  const covChart = barChart(
    '예탁금 커버리지 — 대기자금 ÷ 신용융자 (배)',
    CH.marks.map(m => ({ label: m.label.replace(' 신용', ''), value: m.coverage })),
    covMax, () => C.acc,
    `낮을수록 "빚 대비 실탄이 없다"는 뜻이다. 역대 최저 ${f(CH.covMin.coverage)}배(${dtFull(CH.covMin.date)}) / 최고 ${f(CH.covMax.coverage)}배(${dtFull(CH.covMax.date)}).`
  );

  channelsHtml = `
${sectionTitle('예탁금과 2차 레버리지 채널')}
${lead('여기까지의 분석은 <b>신용융자</b> 한 채널만 봤다. 개인 레버리지에는 <b>예탁증권담보융자</b>라는 두 번째 통로가 있고, 반대편에는 대기자금인 <b>투자자예탁금</b>이 있다.')}
${cards([
    { label: '투자자예탁금', value: f(CH.last.depositJo), unit: '조', note: dtFull(CH.last.date) },
    { label: '신용융자', value: f(CH.last.creditJo), unit: '조', note: '1차 레버리지' },
    { label: '예탁증권담보융자', value: f(CH.last.pledgeJo), unit: '조', note: `총 레버리지의 ${f(CH.pledgeSharePct, 0)}%` },
    { label: '예탁금 커버리지', value: f(CH.last.coverage), unit: '배', note: `역대 ${f(CH.pct, 0)}백분위` },
  ])}
${box(`<b>디레버리징은 신용융자 채널에서만 일어났다</b> — 신용 고점 이후 신용융자는 ${f(creditDeclinePct, 1)}% 줄었는데
  예탁증권담보융자는 ${f(pledgeDeclinePct, 1)}%에 그쳤다. 합친 총 레버리지는 ${f(peak26?.totalLevJo)}조 → ${f(CH.last.totalLevJo)}조,
  <b>${f(levDeclinePct, 1)}%</b>다. 담보융자는 담보유지비율 기준이 달라 강제 청산이 늦게 걸린다 —
  마진콜 사다리는 이 ${f(CH.last.pledgeJo)}조를 세지 않는다.`, true)}
${covChart}
${table(
    [{ label: '기준점' }, { label: '예탁금', n: true }, { label: '신용융자', n: true },
      { label: '담보융자', n: true }, { label: '총레버리지', n: true }, { label: '커버리지', n: true }],
    markRows
  )}
${box(`<b>이 사이클은 2021년보다 실탄이 두껍다</b> — 커버리지는 2021년 신용 고점 ${f(p21?.coverage)}배 대비
  이번 고점 ${f(peak26?.coverage)}배, 현재 ${f(CH.last.coverage)}배(역대 ${f(CH.pct, 0)}백분위)다.
  신용/시총 비율 결론과 방향이 같다. 다만 커버리지가 높다는 것이 그 예탁금이 실제로 매수에 쓰인다는 뜻은 아니다.`)}
`;
}

/* ---------- 미수금 -> 반대매매 전이 ---------- */

let unpaidHtml = '';
if (A.unpaid) {
  const U = A.unpaid;
  const lagRows = U.full.map((s, i) => [`${s.lag}일`, f(s.r, 3), f(U.recent[i]?.r, 3)]);
  const tailRows = U.tail.slice(-8).map(r => [
    dtFull(r.date), f(r.unpaid), f(r.forced, 3), `${f(r.forced / r.unpaid * 100, 1)}%`,
  ]);

  unpaidHtml = `
${sectionTitle('미수금 → 반대매매 전이')}
${lead('<b>위탁매매미수금</b>은 결제하지 못한 외상 매수다. 결제일(D+2)까지 못 채우면 증권사가 <b>반대매매</b>로 처분한다. 기계적으로는 미수금이 2영업일 선행해야 한다 — 실제로 그런지 확인했다.')}
${table([{ label: '시차' }, { label: '전 구간(2010~)', n: true }, { label: '2025년 이후', n: true }], lagRows)}
${lead(`상관은 <b>시차 0일</b>에서 가장 높다. 금투협이 두 계열을 같은 <b>공표일</b> 기준으로 싣기 때문으로 읽는 것이 자연스럽다 —
  즉 이 데이터로는 "미수금 보고 이틀 뒤 반대매매를 예측"할 수 없고, 둘은 같은 날의 동시 지표다.
  전 구간 상관 ${f(U.full[0].r, 2)}가 낮은 것은 국면별 규모 차이 때문이고, 2025년 이후만 보면 ${f(U.recent[0].r, 2)}로 뚜렷하다.`)}
${subTitle('최근 8영업일')}
${table([{ label: '일자' }, { label: '미수금(조)', n: true }, { label: '반대매매(조)', n: true }, { label: '전이율', n: true }], tailRows)}
${box(`<b>지금 미수금은 경보 수준이 아니다</b> — ${dtFull(U.last.date)} 기준 ${f(U.last.unpaid)}조로 최근 60일 평균 ${f(U.avg60)}조의 ${f(U.last.unpaid / U.avg60 * 100, 0)}%다.
  역대 최대는 ${f(U.topUnpaid[0].unpaid)}조(${dtFull(U.topUnpaid[0].date)})였다. 전이율 중앙값 ${f(U.medianTransfer * 100, 1)}% —
  미수금 대부분은 반대매매까지 가지 않고 결제된다. 다만 이것은 <b>미수거래</b>에 대한 반대매매이고, 신용융자 반대매매는 공표되지 않는다.`)}
`;
}

let projHtml = '';
if (PJ) {
  const benchRows = PJ.benches.map(b => [
    esc(b.name), f(b.totalJo),
    b.remainJo > 0 ? `<span style="color:${C.cr};">${f(b.remainJo)}</span>` : `<span style="color:${C.mut};">충족</span>`,
  ]);
  const scenRows = PJ.scenarioRemain.map(s => [
    k0(s.idx), f(s.exposureJo), s.extraJo > 0.005 ? `+${f(s.extraJo)}` : '–',
  ]);

  projHtml = `
${sectionTitle('앞으로 얼마나 더 청산되어야 하는가')}
${lead(`근거가 다른 벤치마크 네 개를 놓는다. 하나로 수렴하지 않으므로 범위로 본다. 이미 청산된 양은 ${f(PJ.doneJo)}조(신용 고점 ${f(PJ.peakJo)}조의 ${f(PJ.doneJo / PJ.peakJo * 100, 1)}%)다.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-left:4px solid ${C.cr};border-radius:0 8px 8px 0;margin:8px 0 14px;">
  <tr><td style="padding:12px 15px;">
    <div style="${FONT}font-size:11px;color:${C.mut};">잔여 청산 추정 범위</div>
    <div style="${FONT}font-size:24px;color:${C.fg};font-variant-numeric:tabular-nums;">${PJ.lowJo > 0 ? f(PJ.lowJo) : '0'}조 ~ ${f(PJ.highJo)}조</div>
    <div style="${FONT}font-size:11px;color:${C.mut};">음수 벤치마크(이미 충족)는 0으로 본 하한 ~ 최대 벤치마크</div>
  </td></tr>
</table>
${table([{ label: '벤치마크' }, { label: '총 청산(조)', n: true }, { label: '잔여(조)', n: true }], benchRows)}
${PJ.benches.map(b => box(`<b>${esc(b.name)}</b> — ${esc(b.basis)}<br><span style="color:${C.part};">단서: ${esc(b.caveat)}</span>`)).join('')}
${subTitle('추가 하락 시 새로 열리는 물량(보정)')}
${table([{ label: '코스피(p)', n: true }, { label: '누적 노출(조)', n: true }, { label: '증가(조)', n: true }], scenRows)}
${box(`<b>신용/시총 비율</b> — 2021 고점 ${f(PJ.prevPeakRatio?.ratio, 3)}% → 2023 저점 ${f(PJ.prevTroughRatio?.ratio, 3)}%.
  2026 고점 ${f(PJ.peakRatio?.ratio, 3)}% → 현재 ${f(PJ.currentRatio?.ratio, 3)}%. 현 사이클은 신용 고점에서도 2021년 고점의
  절반 수준이었고, 지금 비율이 오른 것은 신용이 늘어서가 아니라 시가총액이 더 빨리 줄었기 때문이다.
  현재 비율은 이미 2023년 저점보다 낮다 — "2022년처럼 풀려야 한다"는 전제가 그대로 적용되지 않는다.`)}
`;
}

/* ---------- 월별 스냅샷 (일별 시계열 대체) ---------- */

function monthlySnapshot(series) {
  const rows = [];
  let lastM = null;
  for (const p of series) {
    const m = p.d.slice(0, 6);
    if (m !== lastM) { rows.push(p); lastM = m; }
  }
  return rows;
}
const snap = monthlySnapshot(A.series.filter(p => p.d >= '20200101'));
const snapRows = snap.map(p => [
  `${p.d.slice(0, 4)}.${p.d.slice(4, 6)}`, k0(p.i), p.q != null ? k0(p.q) : '-',
  p.c != null ? f(p.c / 1e6) : '-',
]);

/* ---------- 실측 스트레스 / 재현 검증 ---------- */

const stressRows = A.stress.slice(-10).map(s => [
  dtFull(s.date), f(s.idx), f(s.kosdaq), k0(s.forced / 100), k0(s.unpaid / 100),
  s.credit == null ? '미공표' : f(s.credit / 1e6),
]);

const reproRows = A.repro.map(r => [
  `${k0(r.low)}–${k0(r.high)}`, f(r.pdf), f(r.mine),
  `<span style="color:${Math.abs(r.diff) > 0.1 ? C.part : C.mut};">${r.diff >= 0 ? '+' : ''}${f(r.diff)}</span>`,
]);

/* ---------- 문서 조립 ---------- */

const hasSplit = A.meta.hasSplit;
const lastIdxDate = co.headline.idxLastDate;

const splitNote = hasSplit ? '' : box(
  `<b>유가증권/코스닥 분리 미적용</b> — 신용융자는 유가증권+코스닥 합계이며 코스피 지수로만 버킷을 나눴다.`, true);

const spotNote = A.spot ? box(
  `<b>공표 이후 지수가 ${A.spot.changePct >= 0 ? '반등' : '추가 하락'}했다</b> — FREESIS 최종 공표일 ${dtFull(A.spot.baseDate)} ${k0(A.spot.baseIdx)}p 대비
   ${dtFull(A.spot.date)} 현재 <b>${k0(A.spot.idx)}p (${A.spot.changePct >= 0 ? '+' : ''}${f(A.spot.changePct, 2)}%)</b>.
   ${esc(A.spot.note)} 마진콜 판정은 그날까지의 <b>최저 지수</b> 기준이라, 이미 터진 물량은 지수가 되돌아와도 되돌아오지 않는다 — 반등은 <b>추가</b> 청산만 막는다.`,
  A.spot.changePct < 0) : '';

const body = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};margin:0;padding:0;">
<tr><td align="center" style="padding:18px 10px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${C.card};border-radius:8px;">
<tr><td style="padding:22px 18px 8px;">

  <div style="${FONT}font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:${C.mut};">Liquidity Analysis</div>
  <div style="${FONT}font-size:20px;font-weight:bold;color:${C.fg};margin:5px 0 3px;">사이클별 지수대별 신용융자와 반대매매 진행률</div>
  <div style="${FONT}font-size:12px;color:${C.mut};margin-bottom:14px;line-height:1.6;">
    코스피 ${dtFull(lastIdxDate)} 종가 ${f(co.headline.idxLast)}p ·
    신용융자 ${dtFull(co.headline.creditLastDate)} 기준 ${f(co.headline.creditLastJo)}조원 ·
    ${hasSplit ? '유가증권/코스닥 분리 적용' : '시장 합계 기준'}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="2" bgcolor="${C.fg}" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>

  ${spotNote}
  ${splitNote}

  ${partTitle(1, '신용잔고', '얼마나 더 하락할 수 있나 — 반대매매 잔여', C.cr)}
  ${compareHtml}
  ${monthlyHtml}
  ${ladderCompareHtml}
  ${turnoverCompareHtml}
  ${channelsHtml}
  ${projHtml}

  ${A.periods.map(p => `
  ${sectionTitle(esc(p.name))}
  ${lead(`${esc(p.note)} 적립 ${dtFull(p.accBase)}~${dtFull(p.accEnd)} · 청산 판정 ~${dtFull(p.evalEnd)}`)}
  ${Object.entries(p.markets).map(([nm, m]) => marketBlock(nm, m, p.closed)).join('')}
  `).join('')}

  ${sectionTitle('신용융자 잔고와 지수 — 월별 스냅샷')}
  ${lead('일별 시계열은 표로 옮기기엔 너무 커서 매월 첫 관측치만 남겼다. 전체 SVG 차트는 웹 리포트(index.html) 참조.')}
  ${table(
    [{ label: '월' }, { label: '코스피', n: true }, { label: '코스닥', n: true }, { label: '신용융자(조)', n: true }],
    snapRows
  )}

  ${sectionTitle('실측 스트레스 지표 (최근 10영업일)')}
  ${box(`금투협이 공표하는 <b>반대매매금액</b>은 위탁매매 미수금에 대한 반대매매다. <b>신용융자 반대매매는 공표되지 않는다.</b> 검증값이 아니라 독립 스트레스 축으로만 본다.`, true)}
  ${table(
    [{ label: '일자' }, { label: '코스피', n: true }, { label: '코스닥', n: true }, { label: '반대매매(억)', n: true }, { label: '미수금(억)', n: true }, { label: '신용융자(조)', n: true }],
    stressRows
  )}

  ${unpaidHtml}

  ${sectionTitle('원 자료 재현 검증')}
  ${box(`삼성자산운용 House View(2026-07-29) 자료의 막대 11개를 같은 방법론으로 재계산했다. 평균 절대오차 <b>${f(A.reproMAE, 3)}조원</b>. 2026 연초 대비·전체(시장 합계)·gross 기준으로 조건을 맞췄다.`)}
  ${table(
    [{ label: '코스피 구간(p)' }, { label: '원 자료(조)', n: true }, { label: '재현(조)', n: true }, { label: '차이', n: true }],
    reproRows
  )}

  ${partTitle(2, '공매도 · 숏커버링', '얼마나 더 상승할 수 있나 — 대차 되갚기 잔여', C.kq)}
  ${lendingHtml}
  ${coverHtml}

  <div style="${FONT}font-size:11px;color:${C.mut};margin-top:24px;padding-top:12px;border-top:1px solid ${C.line};line-height:1.7;">
    <b>데이터 출처</b> — 금융투자협회 FREESIS 크로스통계(일별), 코스피 종가는 네이버 금융과 교차 확인.
    비교 대상: 삼성자산운용 투자리서치센터 House View(2026-07-29).<br>
    <b>가정</b> — 담보유지비율 ${f(A.meta.maintenance * 100, 0)}%, 융자비율 ${f(A.meta.loanRatio * 100, 0)}%
    → 마진콜 계수 ${f(A.meta.marginFactor)}. 버킷 대표 지수는 구간 상단.<br>
    <b>한계</b> — 일별 순증감만 공표되어 총매수/총청산 분리 불가. gross 누적은 사이클 순증에 맞춰 보정.
    ${hasSplit ? '' : '신용융자가 유가증권+코스닥 합계인 채로 코스피 지수로만 배분.'}
    담보유지비율은 계좌별로 다르니 참고용으로만 볼 것.<br><br>
    이 메일은 모바일 메일 클라이언트용 표 기반 버전이다. 인터랙티브 차트가 있는 전체 웹 리포트는 index.html 참조.
  </div>

</td></tr>
</table>
</td></tr>
</table>
`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>사이클별 지수대별 신용잔고와 반대매매 추정 — ${dtFull(lastIdxDate)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
${body}
</body>
</html>`;

const OUT = path.join(ROOT, 'email.html');
fs.writeFileSync(OUT, html);

// 메일 렌더러가 못 여는 요소가 섞여 있는지 마지막으로 확인한다.
const banned = ['<style', 'var(--', 'display:grid', 'display:flex', '@media', '<svg', 'position:'];
const hits = banned.filter(b => html.includes(b));
console.log(`email.html 생성 (${(html.length / 1024).toFixed(0)} KB)`);
if (hits.length) console.log(`  경고: 메일 비호환 패턴 검출 -> ${hits.join(', ')}`);
else console.log('  메일 비호환 패턴 없음 (style 블록/CSS 변수/grid/flex/media query/svg 미사용)');
