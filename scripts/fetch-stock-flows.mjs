// PART 2 보조 데이터: 삼성전자·SK하이닉스의 종목별 대차잔고와 외국인 지분율.
//
// 왜 이 두 종목인가: PART 3 에서 코스피 등락의 상당 부분을 이 둘이 설명한다는 것을 이미 확인했다.
// 시장 전체 대차잔고(PART 2)가 "얼마나 더 오를 수 있나" 를 묻는다면, 여기서는 그 잔고가
// 어느 종목에 붙어 있는지를 묻는다.
//
// 소스 둘.
//
// 1) 대차잔고 — FREESIS 대차거래추이. `fetch-lending.mjs` 와 **같은 엔드포인트**이고
//    `tmpV72` 에 종목코드(6자리, 'A' 접두어 없이)를 넣으면 종목별로 온다. 표준코드나
//    종목명을 넣으면 합계 행만 돌아온다 — 6자리 숫자여야 한다.
//    응답: TMPV1 일자, TMPV2 종목명, TMPV3 체결주수, TMPV4 상환주수, TMPV5 잔고주수, TMPV6 잔고금액.
//
//    단위: 잔고금액은 시장 전체와 같은 **백만원**이다. 요청 범위를 셋으로 바꿔 같은 날짜를
//    조회해 같은 값이 오는 것을 확인했고, 주수 × 종가 / 1e6 과 정확히 일치한다.
//    그래도 **금액은 이 컬럼을 쓰지 않고 주수 × 종가로 계산한다.** 주수는 단위 모호성이 없고,
//    PART 3 에서 "좌수로 봐야 가격 착시가 없다" 고 한 것과 같은 이유다. 원본 금액은 남겨서
//    selfcheck 가 둘이 어긋나지 않는지 감시한다 — 어긋나면 소스가 스케일을 바꾼 것이다(§26).
//
// 2) 외국인 지분율 — 네이버 금융 `item/frgn.naver`. 한 페이지 20행이고 EUC-KR 이다.
//    행: 날짜 | 종가 | 전일비 | 등락률 | 거래량 | 기관순매매 | 외국인순매매 | 외국인보유주식수 | 외국인지분율.
//    KRX 정보데이터시스템은 봇 차단이라 못 쓴다(fetch-etf.mjs 의 소스 선정 기록과 같은 이유).
//
// 사용법: node scripts/fetch-stock-flows.mjs [시작일 YYYYMMDD]
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'data', 'stock-flows.json');
const START = process.argv[2] ?? '20250101';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STOCKS = [['005930', '삼성전자'], ['000660', 'SK하이닉스']];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const today = new Date();
const END = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

/* ---------- 1. 대차잔고 (FREESIS) ---------- */
const LEND_URL = 'https://freesis.kofia.or.kr/meta/getMetaDataList.do';

async function fetchLending(code) {
  const res = await fetch(LEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'identity',                 // 압축 응답이 중간에서 깨지는 경우를 배제
      Referer: 'https://freesis.kofia.or.kr/stat/FreeSIS.do',
    },
    body: JSON.stringify({
      dmSearch: {
        tmpV40: '1000000', tmpV41: '1', tmpV1: 'D',
        tmpV45: START, tmpV46: END,
        tmpV72: code,                                 // ← 종목별의 핵심
        OBJ_NM: 'STATSCU0100000140BO',
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  // fetch-lending.mjs 와 같은 방어: 자릿수 넘는 값이 '######' 로 와서 JSON 이 깨진다.
  const deHash = s => s.replace(/:\s*[\d.]*#+/g, ':null');
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  const trimmed = first >= 0 && last > first ? text.slice(first, last + 1) : text;
  let json = null;
  for (const s of [text, deHash(text), trimmed, deHash(trimmed)]) {
    try { json = JSON.parse(s); break; } catch { /* 다음 후보 */ }
  }
  if (!json) throw new Error(`${code}: 대차 응답 파싱 실패 (${text.length}바이트)`);

  // 합계/평균 요약 행은 일자가 숫자가 아니다 — 버린다.
  return (json.ds1 ?? [])
    .filter(r => /^\d{8}$/.test(String(r.TMPV1)))
    .map(r => ({
      d: String(r.TMPV1),
      dealShares: r.TMPV3 ?? null,
      repayShares: r.TMPV4 ?? null,
      balanceShares: r.TMPV5 ?? null,
      balanceMil: r.TMPV6 ?? null,        // 백만원. 표시에는 안 쓰고 selfcheck 교차검증용으로만 남긴다.
    }))
    .filter(r => Number.isFinite(r.balanceShares))
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* ---------- 2. 외국인 지분율 (네이버) ---------- */
const FRGN = 'https://finance.naver.com/item/frgn.naver';
const num = s => {
  const n = Number(String(s).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchForeign(code, fromDate) {
  const rows = [];
  for (let page = 1; page <= 60; page++) {
    const res = await fetch(`${FRGN}?code=${code}&page=${page}`, {
      headers: { 'User-Agent': UA, Referer: `${FRGN}?code=${code}` },
      signal: AbortSignal.timeout(30000),
    });
    const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
    const before = rows.length;
    let oldest = null;

    for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (cells.length < 9 || !/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0])) continue;
      const d = cells[0].replace(/\./g, '');
      oldest = d;
      if (d < fromDate) continue;
      rows.push({
        d,
        close: num(cells[1]),
        foreignShares: num(cells[7]),     // 외국인 보유주식수
        foreignPct: num(cells[8]),        // 외국인 지분율(%)
      });
    }
    // 이 페이지의 가장 오래된 행이 시작일보다 앞서면 더 볼 필요가 없다.
    if (rows.length === before && page > 1) break;
    if (oldest && oldest < fromDate) break;
    await sleep(120);
  }
  const seen = new Set();
  return rows
    .filter(r => r.foreignPct != null && !seen.has(r.d) && seen.add(r.d))
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* ---------- 실행 ---------- */
const out = {
  meta: {
    lending: 'FREESIS 대차거래추이 (STATSCU0100000140, tmpV72=종목코드). 잔고금액(백만원)은 교차검증용으로만 두고, 표시 금액은 주수 × 종가로 계산한다(§26).',
    foreign: '네이버 금융 item/frgn (외국인 보유주식수·지분율). KRX 정보데이터시스템은 봇 차단이라 쓰지 못한다.',
    fetchedAt: new Date().toISOString().slice(0, 10),
    start: START,
  },
  stocks: [],
};

for (const [code, name] of STOCKS) {
  const lending = await fetchLending(code);
  const foreign = await fetchForeign(code, START);
  const fr = new Map(foreign.map(r => [r.d, r]));
  const series = lending.map(r => {
    const f = fr.get(r.d);
    return {
      ...r,
      close: f?.close ?? null,
      foreignShares: f?.foreignShares ?? null,
      foreignPct: f?.foreignPct ?? null,
    };
  });
  out.stocks.push({ code, name, series });
  const last = series.at(-1);
  console.log(`${name}: 대차 ${lending.length}일 / 외국인 ${foreign.length}일 / 병합 ${series.length}일`
    + ` — 최근 ${last.d} 잔고 ${(last.balanceShares / 1e6).toFixed(1)}백만주`
    + `${last.foreignPct != null ? `, 외국인 ${last.foreignPct}%` : ', 외국인 없음'}`);
  await sleep(300);
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`stock-flows.json 저장 — ${out.stocks.length}종목`);
