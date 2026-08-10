// 국가별 포지셔닝. 씨티의 'Weekly Futures Activity' 차트를 공개 데이터로 재현한다.
//
// ★ 원 차트는 **지수 선물**의 미결제약정을 네 갈래로 쪼갠다.
//   신규 롱 / 신규 숏 / 롱 청산 / 숏 커버 + 순합계(Net).
//   그런데 그 네 갈래는 마법이 아니라 **미결제약정 변화의 부호**다. 늘면 신규 진입,
//   줄면 청산. 롱·숏 어느 쪽인지는 계열을 나눠 보면 된다.
//
// ★ 문제: 지수 선물 미결제약정은 거래소마다 따로 공표하고 익명으로는 안 준다.
//   실제로 다 찔러 봤다(2026-08-10) — KRX 403, 네이버 선물 siseJson 빈 배열,
//   SGX API 파라미터 비공개, HKEX 404, JPX HTML, CME 400, stooq JS 게이트.
//   그래서 **선물이 아니라 미국 상장 국가별 ETF** 로 같은 질문을 묻는다.
//
//   ETF 로 바꾸면 네 갈래가 이렇게 잡힌다 — 둘 다 공개 데이터다.
//     롱 사이드 = 상장좌수 변화(설정·환매). 좌수 = 순자산 ÷ NAV (§30 과 같은 분해)
//     숏 사이드 = FINRA 공매도 잔고 변화
//
//   한계는 분명히 적어 둔다: **선물과 ETF 는 다른 도구다.** 선물은 헤지·차익 수요가 크고
//   ETF 는 자산배분 수요가 크다. 다만 외국인이 나라를 통째로 사고파는 주된 통로가
//   국가 ETF 라, "어느 나라에 베팅이 쌓이고 어디서 풀리나" 라는 **질문 자체는 같다**.
//
// ★ 두 계열의 주기가 다르다. 섞으면 안 된다(§34 와 같은 함정).
//   공매도 잔고: 월 2회 정산, 8영업일 지연. **백필 가능**(정산일이 주소다).
//   순자산·NAV: 매일. 그런데 **과거를 주는 API 가 없다** — 오늘부터 쌓아야 한다.
//                CSOP 좌수(§23.6)·투자자별 순매수(§27)와 같은 제약이다.
//   즉 처음 돌리면 숏 사이드는 1년치가 있고 롱 사이드는 오늘부터 시작한다.
//
// 사용법: node scripts/fetch-country-flows.mjs [공매도거래량_백필일수]
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const OUT = path.join(DIR, 'country-flows.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BACKFILL = Number(process.argv[2] ?? 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 씨티 차트의 다섯 나라 + 이 리포트 맥락에서 필요한 둘(대만=반도체 비교군, 신흥국=벤치마크).
// issuer 가 ishares 인 것만 순자산·NAV 를 받을 수 있다 — 나머지는 숏 사이드만 나온다.
const FUNDS = [
  { s: 'EWJ', country: '일본', name: 'iShares MSCI Japan', issuer: 'ishares', citi: 'Nikkei 225' },
  { s: 'EWY', country: '한국', name: 'iShares MSCI South Korea', issuer: 'ishares', citi: 'KOSPI 200' },
  { s: 'EWH', country: '홍콩', name: 'iShares MSCI Hong Kong', issuer: 'ishares', citi: 'Hang Seng' },
  { s: 'FXI', country: '중국(대형주)', name: 'iShares China Large-Cap', issuer: 'ishares', citi: 'China A50' },
  { s: 'ASHR', country: '중국(A주)', name: 'Xtrackers CSI 300', issuer: 'other', citi: 'China A50' },
  { s: 'EWA', country: '호주', name: 'iShares MSCI Australia', issuer: 'ishares', citi: 'ASX 200' },
  { s: 'EWT', country: '대만', name: 'iShares MSCI Taiwan', issuer: 'ishares', citi: null },
  { s: 'EEM', country: '신흥국', name: 'iShares MSCI Emerging Markets', issuer: 'ishares', citi: null },
];
const WANT = new Set(FUNDS.map(f => f.s));

/* ---------- 1. 순자산·NAV (iShares 제품 스크리너) ---------- */
// 좌수를 직접 안 주므로 순자산 ÷ NAV 로 만든다. 둘 다 같은 시점(navAmountAsOf)이라 나눠도 된다.
const ISHARES = 'https://www.ishares.com/us/product-screener/product-screener-v3.1.jsn'
  + '?dcrPath=/templatedata/config/product-screener-v3/data/en/us-ishares/ishares-product-screener-backend-config'
  + '&siteEntryPassthrough=true';

async function fetchAum() {
  const res = await fetch(ISHARES, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`iShares HTTP ${res.status}`);
  const all = await res.json();
  const out = {};
  for (const p of Object.values(all)) {
    const s = p.localExchangeTicker;
    if (!WANT.has(s)) continue;
    const tna = p.totalNetAssets?.r, nav = p.navAmount?.r;
    if (!Number.isFinite(tna) || !Number.isFinite(nav) || nav <= 0) continue;
    out[s] = { tna, nav, shares: tna / nav, asOf: p.navAmountAsOf?.r ?? p.navAmountAsOf ?? null };
  }
  return out;
}

/* ---------- 2. 공매도 잔고 (FINRA, 월 2회) ---------- */
const SI_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
async function shortInterest(settlementDate) {
  const res = await fetch(SI_URL, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      limit: 100,
      compareFilters: [{ fieldName: 'settlementDate', fieldValue: settlementDate, compareType: 'equal' }],
      domainFilters: [{ fieldName: 'symbolCode', values: [...WANT] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`short interest HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows : null;
}

// 정산일 후보(매월 15일·말일)를 최근부터. 1년치를 노린다.
function settlementCandidates(n = 14) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const eom = new Date(Date.UTC(y, m + 1, 0));
    out.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(eom.getUTCDate()).padStart(2, '0')}`);
    out.push(`${y}-${String(m + 1).padStart(2, '0')}-15`);
    d.setUTCMonth(m - 1);
  }
  return [...new Set(out)].sort().reverse();
}

/* ---------- 3. 일별 공매도 거래량 (Reg SHO) ---------- */
async function shortVolume(ymd) {
  const res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd}.txt`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.startsWith('Date|Symbol')) return null;
  const out = {};
  for (const line of text.split('\n')) {
    const c = line.split('|');
    if (c.length < 5 || !WANT.has(c[1])) continue;
    const sv = Number(c[2]), tv = Number(c[4]);
    if (!Number.isFinite(sv) || !Number.isFinite(tv) || tv <= 0) continue;
    out[c[1]] = { shortVol: sv, totalVol: tv, shortPct: (sv / tv) * 100 };
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- 4. 종가 (야후) — 금액 환산과 수익률에 쓴다 ---------- */
async function prices(sym, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`yahoo ${sym} HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`yahoo ${sym} 빈 응답`);
  const close = r.indicators.quote[0].close;
  return r.timestamp.map((t, i) => ({
    d: new Date(t * 1000).toISOString().slice(0, 10).replace(/-/g, ''),
    c: close[i],
  })).filter(x => Number.isFinite(x.c));
}

/* ---------- 실행 ---------- */
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const failed = [];

// 순자산·NAV: 오늘 값을 한 줄 붙인다. 같은 날짜는 덮어쓴다(장중에 여러 번 돌 수 있다).
const aumByDate = new Map((prev?.aum ?? []).map(r => [r.d, r]));
try {
  const a = await fetchAum();
  if (Object.keys(a).length) aumByDate.set(today, { d: today, ...a });
} catch (e) { failed.push(`iShares(${e.message})`); }

// 공매도 잔고: 아직 안 받은 정산일만.
const siByDate = new Map((prev?.shortInterest ?? []).map(r => [r.settlementDate, r]));
let siNew = 0;
for (const d of settlementCandidates()) {
  if (siByDate.has(d)) continue;
  try {
    const rows = await shortInterest(d);
    if (!rows) continue;
    siByDate.set(d, {
      settlementDate: d,
      items: rows.map(r => ({
        s: r.symbolCode,
        shortQty: Number(r.currentShortPositionQuantity) || null,
        prevQty: Number(r.previousShortPositionQuantity) || null,
        avgDailyVol: Number(r.averageDailyVolumeQuantity) || null,
        daysToCover: Number(r.daysToCoverQuantity) || null,
        changePct: Number(r.changePercent) || null,
      })),
    });
    siNew++;
  } catch (e) { failed.push(`잔고 ${d}(${e.message})`); }
  await sleep(200);
}

// 일별 공매도 거래량: 오늘부터 거꾸로, 이미 있는 날은 건너뛴다.
const volByDate = new Map((prev?.shortVolume ?? []).map(r => [r.d, r]));
let volNew = 0;
{
  const cur = new Date();
  for (let i = 0; i < BACKFILL; i++) {
    const ymd = `${cur.getUTCFullYear()}${String(cur.getUTCMonth() + 1).padStart(2, '0')}${String(cur.getUTCDate()).padStart(2, '0')}`;
    cur.setUTCDate(cur.getUTCDate() - 1);
    const dow = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`).getUTCDay();
    if (dow === 0 || dow === 6 || volByDate.has(ymd)) continue;
    try {
      const v = await shortVolume(ymd);
      if (v) { volByDate.set(ymd, { d: ymd, ...v }); volNew++; }
    } catch { /* 하루 실패는 넘긴다 */ }
    await sleep(120);
  }
}

// 종가: 매번 1년치를 다시 받아 덮는다(작고, 수정 반영이 필요하다).
const px = { ...(prev?.px ?? {}) };
for (const f of FUNDS) {
  try {
    const rows = await prices(f.s);
    if (rows.length) px[f.s] = rows;
  } catch (e) { failed.push(`${f.s} 종가(${e.message})`); }
  await sleep(150);
}

const out = {
  meta: {
    what: '국가별 포지셔닝. 씨티 Weekly Futures Activity 를 미국 상장 국가 ETF 로 재현한다(§36).',
    longSide: 'iShares 제품 스크리너의 순자산 ÷ NAV = 상장좌수. 과거를 주는 API 가 없어 수집 시작일부터만 쌓인다.',
    shortSide: 'FINRA consolidatedShortInterest. 월 2회 정산이라 백필은 되지만 일별은 원천적으로 불가능하다.',
    caveat: '선물이 아니라 ETF 다. 헤지·차익 수요가 큰 선물과 자산배분 수요가 큰 ETF 는 같은 수가 아니다.',
    funds: FUNDS,
    fetchedAt: new Date().toISOString().slice(0, 10),
  },
  aum: [...aumByDate.values()].sort((a, b) => a.d.localeCompare(b.d)),
  shortInterest: [...siByDate.values()].sort((a, b) => a.settlementDate.localeCompare(b.settlementDate)),
  shortVolume: [...volByDate.values()].sort((a, b) => a.d.localeCompare(b.d)),
  px,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

console.log(`country-flows.json — 종목 ${FUNDS.length}`);
console.log(`  순자산·NAV ${out.aum.length}일 (누적, ${out.aum[0]?.d ?? '-'}~${out.aum.at(-1)?.d ?? '-'})`);
console.log(`  공매도 잔고 ${out.shortInterest.length}개 정산일 (신규 ${siNew}), 최신 ${out.shortInterest.at(-1)?.settlementDate ?? '-'}`);
console.log(`  일별 공매도 거래량 ${out.shortVolume.length}일 (신규 ${volNew})`);
console.log(`  종가 ${Object.entries(px).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);
if (failed.length) {
  console.log(`  실패: ${failed.join(', ')}`);
  process.exitCode = 1;
}
