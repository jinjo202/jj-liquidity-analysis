// 시장 전체 투자자별 순매수 — 코스피/코스닥 현물(억원) + KOSPI200 선물(억원).
//
// 왜 필요한가: 다른 지표는 전부 '잔고'(신용·대차·좌수)를 본다. 잔고는 부담의 크기를
// 재지만 **방향**은 못 잰다. 외국인이 현물과 선물을 같은 쪽으로 밀고 있는지가 단기
// 방향의 가장 고전적인 수급 신호다 — 그 조각이 이 파일이다.
//
// 소스 이력(§50): 처음에는 네이버 `investorDealTrendDay.naver` 를 긁었다(§44).
// 2026-09 네이버 개편으로 그 경로가 **HTTP 410 Gone** 이 됐고, 9/15 이후 데이터가 멈췄다.
// 같은 개편이 `item/frgn.naver` 도 죽였다(fetch-stock-flows.mjs 머리말).
//
// 지금 쓰는 것: 모바일 API `m.stock.naver.com/api/index/{code}/trend?bizdate=YYYYMMDD`.
//   · 하루에 한 건씩만 온다(기간 조회 없음) — 그래서 최근 N 영업일을 돌며 받는다.
//   · 응답: { bizdate, personalValue, foreignValue, institutionalValue } — 부호 포함 문자열.
//   · 같은 계열인지 겹치는 날짜로 대조했다 — 코스피·코스닥 모두 옛 값과 **정확히 일치**한다.
//
// ★ 선물은 단위가 바뀌었다. 옛 소스는 **계약 수**, 이 API 는 **금액(억원)**이다
//   (겹치는 날 비율이 2.6~2.8 로 지수 수준을 따라 움직인다 = 계약 × 가격). 그래서 옛
//   계약 계열에 이어 붙이지 않고 `futures` 를 금액 계열로 새로 시작한다. 옛 계약 기록은
//   `futuresLegacyContracts` 로 남겨 둔다 — 섞어서 한 선으로 그리면 단위가 뒤섞인 거짓 차트가 된다.
//
// ★ 장중에는 세 값이 모두 0 으로 온다(아직 집계 전). 그 행을 그대로 쓰면 '그날 순매수가
//   0이었다'는 거짓이 되므로 **버린다** — 종가가 null 인 파일로 멀쩡한 데이터를 덮어썼던
//   사고(§stock-flows)와 같은 종류의 실수를 막는다.
//
// 사용법: node scripts/fetch-direction-flows.mjs [영업일수]   (기본 30)
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const OUT = path.join(DIR, 'direction-flows.json');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DAYS = Number(process.argv[2] ?? 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARKETS = [
  { key: 'kospi', code: 'KOSPI', name: '코스피 현물', unit: '억원' },
  { key: 'kosdaq', code: 'KOSDAQ', name: '코스닥 현물', unit: '억원' },
  { key: 'futures', code: 'FUT', name: 'KOSPI200 선물', unit: '억원' },
];

const num = s => {
  const n = Number(String(s ?? '').replace(/[+,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/* ---------- 하루치 조회 ---------- */
async function fetchDay(code, bizdate) {
  const url = `https://m.stock.naver.com/api/index/${code}/trend?bizdate=${bizdate}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // 요청한 날짜가 아니면(파라미터를 무시하고 오늘을 돌려주는 경우) 쓰지 않는다.
  if (String(j.bizdate) !== bizdate) return null;
  const indiv = num(j.personalValue), foreign = num(j.foreignValue), inst = num(j.institutionalValue);
  if (indiv == null || foreign == null || inst == null) return null;
  // 휴장일·장중 미집계는 셋 다 0 으로 온다. 진짜 0 인 날과 구분할 수 없으므로 버린다.
  if (indiv === 0 && foreign === 0 && inst === 0) return null;
  // 기타법인은 이 API 가 주지 않는다. 옛 소스의 4주체 zero-sum 검증은 그래서 못 한다 —
  // 나머지로 역산하면 항등식이 되어 검증이 아니게 되므로 아예 두지 않는다(§50).
  return { d: bizdate, indiv, foreign, inst };
}

/* ---------- 실행 ---------- */
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

// 옛 계약 단위 선물 기록은 한 번만 옮겨 둔다(이미 옮겼으면 그대로).
const legacy = prev?.futuresLegacyContracts
  ?? (prev?.meta?.units?.futures === '계약' ? prev.futures ?? [] : []);

const out = {
  meta: {
    what: '시장 전체 투자자별 일자별 순매수. 방향 수급(외국인 현·선물 동조)의 원천이다(§44·§50).',
    source: '네이버 모바일 API m.stock.naver.com/api/index/{KOSPI|KOSDAQ|FUT}/trend?bizdate=',
    units: { kospi: '억원', kosdaq: '억원', futures: '억원' },
    note: '선물은 2026-09-16 부터 금액(억원)이다 — 옛 소스(계약 수)가 죽어 단위가 바뀌었다. '
      + '옛 계약 기록은 futuresLegacyContracts 에 있고 금액 계열과 섞지 않는다(§50).',
    fetchedAt: new Date().toISOString().slice(0, 10),
  },
  futuresLegacyContracts: legacy,
};

let failed = [];
for (const mk of MARKETS) {
  // 선물은 단위가 바뀌었으므로 옛(계약) 행을 이어받지 않는다.
  const keep = mk.key === 'futures' && prev?.meta?.units?.futures === '계약' ? [] : (prev?.[mk.key] ?? []);
  const byDate = new Map(keep.map(r => [r.d, r]));
  const before = byDate.size;
  let got = 0;
  try {
    const cur = new Date();
    for (let i = 0; i < DAYS; i++) {
      const d = ymd(cur);
      cur.setDate(cur.getDate() - 1);
      if (byDate.has(d)) continue;                 // 이미 있는 날은 건너뛴다
      const row = await fetchDay(mk.code, d);
      if (row) { byDate.set(d, row); got++; }
      await sleep(120);
    }
  } catch (e) {
    failed.push(`${mk.name}(${e.message})`);
  }
  out[mk.key] = [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d));
  console.log(`  ${mk.name.padEnd(13)} ${out[mk.key].length}행 (신규 ${byDate.size - before})`
    + (out[mk.key].length ? `  ${out[mk.key][0].d}~${out[mk.key].at(-1).d}` : ''));
}

// 한 건도 못 받았으면 덮어쓰지 않는다 — 멀쩡한 과거를 빈 파일로 날리지 않기 위해서다.
const total = MARKETS.reduce((s, m) => s + (out[m.key]?.length ?? 0), 0);
if (!total) {
  console.error('한 건도 받지 못했다 — 기존 파일을 유지한다.');
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('direction-flows.json 저장');
if (failed.length) {
  console.log(`실패: ${failed.join(', ')}`);
  process.exitCode = 1;
}
