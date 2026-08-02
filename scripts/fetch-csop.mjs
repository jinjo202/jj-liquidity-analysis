// 홍콩 CSOP 단일종목 L&I 상품(삼성전자·SK하이닉스)의 좌수·순자산을 받아온다.
//
// 경로를 찾기까지(§23.6): 상품 페이지는 값을 JS 로 채워 정적 fetch 로는 빈 칸만 온다.
// 페이지가 로드하는 상품 전용 JS(asset/lai/js/hk-skhy-2l.js)를 읽어 보니 요청 바디가
// {"productName": "<상품 전체 영문명>"} 이었다 — fundCode/slug 가 아니라 이름 전문이라
// 추측으로는 맞출 수 없었던 것이다(전부 500). 이 바디로 POST 하면 통화별(HKD/USD)로
// NAV·AUM·Shares(좌수)·기준일이 온다. 과거 시계열 엔드포인트(ChartData)는 403 이라
// 히스토리는 못 받는다 — 대신 이 스크립트가 매일 돌며 data/csop-daily.json 에 하루씩
// 쌓는다. 좌수 추이는 수집을 시작한 20260802 이후부터만 존재한다.
//
// 산출물 두 개:
//   data/csop-daily.json     기준일별 히스토리(append, 같은 날짜는 갱신)
//   data/csop-snapshot.json  최신 스냅샷 — analyze.mjs 가 읽는 기존 형식 그대로
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const API = 'https://website-api.csopasset.com/cmsApi/NAV/product';

// productName 은 CSOP 상품 등록명과 글자 단위로 같아야 한다(대소문자·괄호·Max 포함).
// 이름이 바뀌면(실제로 2026 년 'Daily' -> 'Daily Max' 개명이 있었다) 여기도 바꿔야 한다.
const PRODUCTS = [
  {
    ticker: '7709', slug: 'hk-skhy-2l', underlying: '000660', lev: 2, listingDate: '20251016',
    name: 'CSOP SK Hynix Daily Max (2x) Leveraged Product',
  },
  {
    ticker: '7747', slug: 'hk-smsn-2l', underlying: '005930', lev: 2,
    name: 'CSOP Samsung Electronics Daily Max (2x) Leveraged Product',
  },
  {
    ticker: '7347', slug: 'hk-smsn-2i', underlying: '005930', lev: -2,
    name: 'CSOP Samsung Electronics Daily Max (-2x) Inverse Product',
  },
];

const num = v => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchProduct(p) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      Origin: 'https://www.csopasset.com',
      Referer: 'https://www.csopasset.com/',
    },
    body: JSON.stringify({ productName: p.name }),
  });
  if (!res.ok) throw new Error(`${p.ticker} HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${p.ticker} 빈 응답`);

  // 통화별 행이 온다. USD 행이 본체(AUM·명목 익스포저), HKD 행은 상장 통화 시세다.
  const usd = rows.find(r => r.Currency === 'USD') ?? rows[0];
  const hkd = rows.find(r => r.Currency === 'HKD') ?? null;
  const d = String(usd.HstDateFormat ?? '').replace(/-/g, '');
  if (!/^\d{8}$/.test(d)) throw new Error(`${p.ticker} 기준일 형식 이상: ${usd.HstDateFormat}`);

  const row = {
    d,
    units: num(usd.Shares),
    totalNavUsd: num(usd.AUM),
    navPerUnitUsd: num(usd.NAV),
    navPerUnitHkd: hkd ? num(hkd.NAV) : null,
    closeHkd: hkd ? num(hkd.closePrice) : null,
    notionalUsd: num(usd.ContractValue),      // 스왑·옵션 명목 익스포저
    deemedNavUsd: num(usd.DeemedNav),
  };
  if (!row.units || !row.totalNavUsd) throw new Error(`${p.ticker} 좌수/AUM 누락`);
  return row;
}

/* ---------- 수집 ---------- */
const results = [];
const failed = [];
for (const p of PRODUCTS) {
  try {
    results.push({ ...p, row: await fetchProduct(p) });
  } catch (e) {
    failed.push(`${p.ticker}(${e.message})`);
  }
}
if (!results.length) {
  console.error(`CSOP 수집 전부 실패: ${failed.join(', ')}`);
  process.exit(1);
}

/* ---------- csop-daily.json — 히스토리 누적 ---------- */
const dailyPath = path.join(DIR, 'csop-daily.json');
const daily = fs.existsSync(dailyPath)
  ? JSON.parse(fs.readFileSync(dailyPath, 'utf8'))
  : { products: [] };

for (const r of results) {
  let entry = daily.products.find(x => x.ticker === r.ticker);
  if (!entry) {
    entry = { ticker: r.ticker, slug: r.slug, name: r.name, underlying: r.underlying, lev: r.lev, series: [] };
    daily.products.push(entry);
  }
  entry.name = r.name;   // 개명 이력 반영
  const i = entry.series.findIndex(x => x.d === r.row.d);
  if (i >= 0) entry.series[i] = r.row; else entry.series.push(r.row);
  entry.series.sort((a, b) => a.d.localeCompare(b.d));
}
daily.updatedAt = new Date().toISOString().slice(0, 10);
daily.source = 'website-api.csopasset.com/cmsApi/NAV/product (POST {productName})';
daily.note = '기준일(HstDateFormat)별 1행. 과거 API 가 없어 20260802 수집 시작 이후만 존재한다(§23.6).';
fs.writeFileSync(dailyPath, JSON.stringify(daily, null, 1));

/* ---------- csop-snapshot.json — analyze.mjs 가 읽는 최신 스냅샷 ---------- */
const snapshot = {
  _note: 'fetch-csop.mjs 가 자동 생성한다(§23.6). 손으로 고쳐도 다음 실행에서 덮어써진다. '
    + '일별 히스토리는 data/csop-daily.json 에 쌓인다.',
  asOf: results.map(r => r.row.d).sort().at(-1),
  scrapedAt: daily.updatedAt,
  source: API,
  products: results.map(r => ({
    ticker: r.ticker, slug: r.slug, name: r.name, underlying: r.underlying, lev: r.lev,
    ...(r.listingDate ? { listingDate: r.listingDate } : {}),
    totalNavUsd: r.row.totalNavUsd,
    outstandingUnits: r.row.units,
    navPerUnitUsd: r.row.navPerUnitUsd,
    ...(r.row.navPerUnitHkd != null ? { navPerUnitHkd: r.row.navPerUnitHkd } : {}),
    ...(r.row.closeHkd != null ? { closeHkd: r.row.closeHkd } : {}),
    notionalUsd: r.row.notionalUsd,
  })),
};
fs.writeFileSync(path.join(DIR, 'csop-snapshot.json'), JSON.stringify(snapshot, null, 1));

/* ---------- 콘솔 ---------- */
for (const r of results) {
  const x = r.row;
  const days = daily.products.find(p => p.ticker === r.ticker)?.series.length ?? 0;
  console.log(`${r.ticker} ${r.name}`);
  console.log(`  ${x.d}  좌수 ${(x.units / 1e6).toFixed(1)}M  NAV US$${(x.totalNavUsd / 1e9).toFixed(2)}bn`
    + `  명목 US$${x.notionalUsd != null ? (x.notionalUsd / 1e9).toFixed(2) : '-'}bn  (히스토리 ${days}일)`);
}
if (failed.length) console.log(`실패: ${failed.join(', ')}`);
console.log(`csop-daily.json / csop-snapshot.json 갱신 — asOf ${snapshot.asOf}`);
