// PART 3 원천 데이터: 레버리지 ETF 의 일별 상장좌수·종가·거래대금, 그리고 기초 종목(삼성전자·SK하이닉스).
//
// 왜 상장좌수인가: AUM 은 좌수 x NAV 라, 좌수를 봐야 "값이 빠진 건지 돈이 빠진 건지" 를 가른다.
// 좌수가 줄면 실제 환매(디레버리징), 좌수가 그대로면 물량은 남아 있는 것이다(§23).
//
// 소스 선정 기록(2026-08-02):
//   KRX 정보데이터시스템 - getJsonData 는 세션이 있어도 400 LOGOUT, OTP/CSV 경로는 403. 처음엔 봇 차단으로
//     판단했는데, 2026-08-03 재확인 결과 사이트가 'KRX Data Marketplace' 로 바뀌어 로그인 페이지가 뜬다.
//     즉 인증이 필요한 것이고 익명 요청으로는 불가다(§23.1).
//   네이버 ETF 페이지    - 상장좌수 항목이 없다(NAV 만 있음).
//   다음 금융 일별시세   - 행마다 listedSharesCount 가 실려 있고 날짜별로 실제로 변한다(46행 중 43일 변동 확인). 채택.
// 종목명은 네이버 ETF 목록(EUC-KR)에서 받아 유니버스를 자동 구성한다 — 이 카테고리는 신규 상장이 계속 나온다.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const START = process.argv[2] ?? '20250101';   // 이보다 오래된 행은 버린다
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. 유니버스 구성 ---------- */
// 이름 규칙으로 뽑는다. 그룹은 리밸런싱 계수와 해석이 서로 달라 반드시 구분해야 한다.
const GROUPS = [
  { key: 'single_lev', label: '단일종목 레버리지 2X', lev: 2,
    test: n => /(삼성전자|SK하이닉스).*(단일종목).*레버리지/.test(n) },
  { key: 'single_inv', label: '단일종목 인버스 2X', lev: -2,
    test: n => /(삼성전자|SK하이닉스).*(단일종목).*인버스2X/.test(n) },
  { key: 'sector_lev', label: '반도체·IT 섹터 레버리지', lev: 2,
    test: n => /(반도체|200IT).*레버리지/.test(n) && !/미국|필라델피아|차이나|일본|한중|글로벌/.test(n) },
  { key: 'index_lev', label: '지수 레버리지(대조군)', lev: 2,
    test: n => /^(KODEX 레버리지|TIGER 레버리지|KODEX 코스닥150레버리지|TIGER 코스닥150 레버리지)$/.test(n) },
  { key: 'index_inv', label: '지수 인버스2X(대조군)', lev: -2,
    test: n => /^KODEX 200선물인버스2X$/.test(n) },
];

// 기초 종목. ETF 와 같은 소스에서 받아 시총 비중까지 한 번에 만든다.
const UNDERLYING = [
  { code: '005930', name: '삼성전자', group: 'underlying', lev: null },
  { code: '000660', name: 'SK하이닉스', group: 'underlying', lev: null },
];

async function fetchUniverse() {
  const res = await fetch('https://finance.naver.com/api/sise/etfItemList.nhn', {
    headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/sise/etf.naver' },
  });
  if (!res.ok) throw new Error(`네이버 ETF 목록 ${res.status}`);
  // 이 API 는 EUC-KR 이다. res.json() 으로 읽으면 한글이 전부 깨져 이름 규칙이 하나도 안 맞는다.
  const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
  const rows = JSON.parse(text)?.result?.etfItemList ?? [];
  if (!rows.length) throw new Error('네이버 ETF 목록이 비어 있다');

  const picked = [];
  for (const r of rows) {
    const g = GROUPS.find(x => x.test(r.itemname));
    if (g) picked.push({ code: r.itemcode, name: r.itemname, group: g.key, lev: g.lev });
  }
  console.log(`ETF 목록 ${rows.length}종 중 유니버스 ${picked.length}종`);
  for (const g of GROUPS) {
    const n = picked.filter(p => p.group === g.key).length;
    console.log(`  ${g.label}: ${n}종`);
  }
  return [...picked, ...UNDERLYING];
}

/* ---------- 2. 일별 시세 + 상장좌수 ---------- */
async function fetchDaily(code) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://finance.daum.net/api/quote/A${code}/days`
      + `?symbolCode=A${code}&page=${page}&perPage=100&pagination=true`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://finance.daum.net/quotes/A${code}` },
    });
    if (!res.ok) throw new Error(`${code} p${page} ${res.status}`);
    const data = JSON.parse(await res.text()).data ?? [];
    if (!data.length) break;

    for (const x of data) {
      rows.push({
        d: String(x.date).slice(0, 10).replace(/-/g, ''),
        close: x.tradePrice,
        open: x.openingPrice, high: x.highPrice, low: x.lowPrice,
        volume: x.accTradeVolume,
        valueMil: Math.round(x.accTradePrice / 1e6),   // 거래대금(백만원)
        units: x.listedSharesCount,                     // 상장좌수(주식이면 상장주식수)
      });
    }
    const oldest = data.at(-1);
    if (String(oldest.date).slice(0, 10).replace(/-/g, '') <= START) break;
    await sleep(300);
  }
  return rows
    .filter(r => r.d >= START && Number.isFinite(r.close) && Number.isFinite(r.units))
    .sort((a, b) => a.d.localeCompare(b.d))
    .filter((r, i, a) => i === 0 || r.d !== a[i - 1].d);
}

/* ---------- 3. 실행 ---------- */
const universe = await fetchUniverse();
const series = {};
const failed = [];

for (const item of universe) {
  try {
    const rows = await fetchDaily(item.code);
    if (!rows.length) { failed.push(`${item.name}(행 없음)`); continue; }
    series[item.code] = rows;
    const first = rows[0], last = rows.at(-1);
    const uniqUnits = new Set(rows.map(r => r.units)).size;
    console.log(`  ${item.code} ${item.name}  ${rows.length}행 ${first.d}..${last.d}`
      + `  좌수 ${(first.units / 1e6).toFixed(1)}M -> ${(last.units / 1e6).toFixed(1)}M (고유 ${uniqUnits})`);
    // 좌수가 한 값으로 고정돼 오면 소스가 현재값을 복사해 넣은 것이다. 조용히 넘어가면 안 된다.
    if (uniqUnits === 1 && rows.length > 20) console.log(`     주의: 좌수 고정 — 유출입 분해 불가`);
  } catch (e) {
    failed.push(`${item.name}(${e.message})`);
  }
  await sleep(300);
}

const out = {
  fetchedAt: new Date().toISOString().slice(0, 10),
  start: START,
  groups: GROUPS.map(({ key, label, lev }) => ({ key, label, lev })),
  universe: universe.filter(u => series[u.code]),
  series,
};
fs.writeFileSync(path.join(DIR, 'etf-daily.json'), JSON.stringify(out));

const n = Object.keys(series).length;
const lastDates = Object.values(series).map(s => s.at(-1).d).sort();
console.log(`\netf-daily.json 생성: ${n}종목 / 최신 ${lastDates.at(-1)}`);
if (failed.length) console.log(`실패 ${failed.length}: ${failed.join(', ')}`);
