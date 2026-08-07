// 해외 주요 반도체 종목·ETF 의 공매도. 국내 대차잔고(§16)와 같은 질문을 미국 쪽에 묻는다.
//
// ★ 미국 공매도는 두 가지가 서로 다른 주기로 나온다. 섞으면 안 된다.
//
//   1) 공매도 잔고(short interest) — FINRA API. **월 2회**(15일·말일 전후 정산) 공표에
//      영업일 8일가량 지연. "매일 업데이트" 가 원천적으로 불가능한 계열이다.
//      필드: currentShortPositionQuantity(잔고 주수), daysToCoverQuantity(DTC), changePercent.
//      정렬 제약이 있어 settlementDate 를 **등호**로 지정해야 한다(gte 로 주면 400).
//
//   2) 일별 공매도 거래량 — FINRA Reg SHO 일별 파일. 진짜 **일별**이고 무인증이다.
//      `공매도 거래량 / 총 거래량` 이 그날 매도 중 공매도 비중이다.
//      주의: 이건 **거래량**이지 잔고가 아니다. 마켓메이커의 헤지성 매도가 섞여 실제
//      방향성 베팅보다 높게 나온다(미국 대형주는 평시에도 40~50%가 흔하다).
//      절대 수준보다 **같은 종목의 시계열 변화**로 읽어야 한다.
//
// 대상: 메모리 계열 + 반도체 대형주 + ETF.
//   ★ DRAM 전용 ETF 가 실재한다 — Roundhill Memory ETF(티커 DRAM), 2026-04-02 Cboe 상장.
//     세계 최초의 메모리 순수 테마 ETF 로 DRAM·HBM·NAND·SSD 를 담는다. 상장 25거래일 만에 AUM 50억 달러.
//     2배 레버리지도 둘 있다 — RAML(Leverage Shares, 2026-07-23), RAM(T-REX/Roundhill).
//     이건 국내 단일종목 레버리지(§33.1)와 정확히 같은 성격이라 특히 중요하다.
//   메모리 개별주는 MU(마이크론)와 스토리지 3사(SNDK·WDC·STX)를 담는다.
//   SOXL/SOXS(3배 레버리지 반도체)는 반도체 전반의 레버리지 수요를 본다.
//
// 사용법: node scripts/fetch-global-semis.mjs [백필일수]
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const OUT = path.join(DIR, 'global-semis.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BACKFILL = Number(process.argv[2] ?? 45);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TICKERS = [
  // --- 메모리(DRAM) 계열 ---
  { s: 'DRAM', name: 'Roundhill Memory ETF', kind: 'etf', note: '메모리 순수 테마' },
  { s: 'RAML', name: '2X Long Memory (Leverage Shares)', kind: 'etf', lev: 2, note: 'DRAM 2배' },
  { s: 'RAM', name: '2X DRAM (T-REX)', kind: 'etf', lev: 2, note: 'DRAM 2배' },
  { s: 'MU', name: '마이크론', kind: 'stock', note: 'DRAM 순수주' },
  { s: 'SNDK', name: '샌디스크', kind: 'stock', note: 'NAND' },
  { s: 'WDC', name: 'WD', kind: 'stock', note: '스토리지' },
  { s: 'STX', name: '시게이트', kind: 'stock', note: '스토리지' },
  // --- 반도체 대형주 ---
  { s: 'NVDA', name: '엔비디아', kind: 'stock' },
  { s: 'AMD', name: 'AMD', kind: 'stock' },
  { s: 'INTC', name: '인텔', kind: 'stock' },
  { s: 'TSM', name: 'TSMC', kind: 'stock' },
  { s: 'ASML', name: 'ASML', kind: 'stock' },
  { s: 'AVGO', name: '브로드컴', kind: 'stock' },
  { s: 'QCOM', name: '퀄컴', kind: 'stock' },
  { s: 'TXN', name: 'TI', kind: 'stock' },
  { s: 'ARM', name: 'ARM', kind: 'stock' },
  { s: 'SMH', name: 'VanEck 반도체 ETF', kind: 'etf' },
  { s: 'SOXX', name: 'iShares 반도체 ETF', kind: 'etf' },
  { s: 'SOXL', name: '반도체 3X 레버리지', kind: 'etf', lev: 3 },
  { s: 'SOXS', name: '반도체 3X 인버스', kind: 'etf', lev: -3 },
];
const WANT = new Set(TICKERS.map(t => t.s));

/* ---------- 1. 일별 공매도 거래량 (Reg SHO) ---------- */
async function shortVolume(ymd) {
  const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd}.txt`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;                       // 휴장일은 파일이 없다
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

/* ---------- 2. 공매도 잔고 (월 2회) ---------- */
const SI_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
async function shortInterest(settlementDate) {
  const res = await fetch(SI_URL, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      limit: 200,
      compareFilters: [{ fieldName: 'settlementDate', fieldValue: settlementDate, compareType: 'equal' }],
      domainFilters: [{ fieldName: 'symbolCode', values: [...WANT] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 204) return null;            // 아직 공표 전
  if (!res.ok) throw new Error(`short interest HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows : null;
}

// 정산일 후보를 최근부터 만든다 — 매월 15일과 말일. 공표 전이면 204 로 걸러진다.
function settlementCandidates(n = 8) {
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

/* ---------- 실행 ---------- */
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const volByDate = new Map((prev?.shortVolume ?? []).map(r => [r.d, r]));

// 백필: 오늘부터 거꾸로. 이미 있는 날짜는 건너뛴다(주말·휴장일은 파일이 없어 null 로 스킵).
let added = 0, tried = 0;
const cur = new Date();
for (let i = 0; i < BACKFILL && tried < BACKFILL; i++) {
  const ymd = `${cur.getUTCFullYear()}${String(cur.getUTCMonth() + 1).padStart(2, '0')}${String(cur.getUTCDate()).padStart(2, '0')}`;
  cur.setUTCDate(cur.getUTCDate() - 1);
  tried++;
  const dow = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  if (volByDate.has(ymd)) continue;
  try {
    const v = await shortVolume(ymd);
    if (v) { volByDate.set(ymd, { d: ymd, ...v }); added++; }
  } catch { /* 개별 날짜 실패는 넘긴다 */ }
  await sleep(120);
}

// 잔고: 최신 공표분을 찾을 때까지 후보를 훑는다. 이미 받은 정산일은 다시 안 부른다.
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
  } catch (e) {
    console.log(`잔고 ${d} 실패: ${e.message}`);
  }
  await sleep(200);
}

const out = {
  meta: {
    shortVolume: 'FINRA Reg SHO 일별 공매도 거래량(무인증). 거래량이지 잔고가 아니다 — 마켓메이커 헤지가 섞인다.',
    shortInterest: 'FINRA consolidatedShortInterest. 월 2회 정산(15일·말일)이라 일별 갱신이 불가능한 계열이다.',
    tickers: TICKERS,
    fetchedAt: new Date().toISOString().slice(0, 10),
  },
  shortVolume: [...volByDate.values()].sort((a, b) => a.d.localeCompare(b.d)),
  shortInterest: [...siByDate.values()].sort((a, b) => a.settlementDate.localeCompare(b.settlementDate)),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

const sv = out.shortVolume;
console.log(`global-semis.json — 일별 공매도 거래량 ${sv.length}일 (신규 ${added})`
  + (sv.length ? `, ${sv[0].d}~${sv.at(-1).d}` : ''));
console.log(`  공매도 잔고 ${out.shortInterest.length}개 정산일 (신규 ${siNew})`
  + (out.shortInterest.length ? `, 최신 ${out.shortInterest.at(-1).settlementDate}` : ''));
