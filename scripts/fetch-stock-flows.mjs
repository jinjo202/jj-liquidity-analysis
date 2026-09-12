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
// 2) 종가·외국인 지분율 — 네이버 시세 API `siseJson.naver`. 기간 조회가 되어 한 번에 온다.
//    헤더: 날짜 | 시가 | 고가 | 저가 | 종가 | 거래량 | 외국인소진율.
//    KRX 정보데이터시스템은 로그인이 필요해 익명으로는 못 쓴다(§23.1).
//
//    2026-09-10 네이버 개편으로 옛 경로 `item/frgn.naver` 가 죽었다. EUC-KR 표를 긁던
//    방식이었는데 UTF-8 SPA 로 바뀌어 `<tr>` 이 **0개**가 됐다. 파서는 예외 없이 0행을
//    돌려줬고 스크립트는 성공으로 끝나 **종가가 전부 null 인 파일**을 썼다. 그래서 9/10
//    오후부터 selfcheck 가 "교차검증할 행이 0개" 로 막아 매 실행이 실패했다.
//    같은 일이 또 나지 않게, 받아온 게 없으면 **덮어쓰지 않고 실패한다**(아래 참조).
//
//    옛 소스와 같은 계열임은 대조로 확인했다 — 20260909 종가 269500 · 지분율 46.81 로 일치.
//    다만 새 소스에는 **외국인 보유주식수가 없다**. 지분율에서 되살린다(`foreignSharesOf`).
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

/* ---------- 2. 종가·외국인 지분율 (네이버 시세 API) ---------- */
const SISE = 'https://api.finance.naver.com/siseJson.naver';
const num = s => {
  const n = Number(String(s).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchForeign(code, fromDate) {
  const res = await fetch(
    `${SISE}?symbol=${code}&requestType=1&startTime=${fromDate}&endTime=${END}&timeframe=day`,
    { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' },
      signal: AbortSignal.timeout(30000) });
  // 작은따옴표를 쓰는 준-JSON 이다. 첫 행은 헤더라 버린다.
  const rows = JSON.parse((await res.text()).replace(/'/g, '"'));
  const seen = new Set();
  return rows
    .filter(r => Array.isArray(r) && /^\d{8}$/.test(String(r[0])))
    .map(r => ({ d: String(r[0]), close: num(r[4]), foreignPct: num(r[6]) }))
    .filter(r => r.foreignPct != null && !seen.has(r.d) && seen.add(r.d))
    .sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * 외국인 보유주식수. 개편 전 네이버는 이 값을 직접 줬지만 새 소스는 지분율만 준다.
 * **지분율 × 상장주식수로 되살린다.** 상장주식수는 analyze 가 이미 믿고 쓰는
 * `etf-daily.json` 의 날짜별 `units` 를 그대로 쓴다(§23).
 *
 * 지분율이 소수점 둘째 자리에서 끊겨 하루치 차분에는 양자화 오차가 섞인다. 그래도
 * 쓸 수 있는 이유는 analyze 가 이 값을 **차분의 누적**으로만 쓰기 때문이다 — 누적은
 * (현재지분율 − 시작지분율) × 상장주식수로 접히므로 오차가 쌓이지 않고 끝에서도
 * 상장주식수의 0.01% 안에 머문다.
 */
function listedSharesByDate() {
  const f = path.join(import.meta.dirname, '..', 'data', 'etf-daily.json');
  if (!fs.existsSync(f)) return {};
  const series = JSON.parse(fs.readFileSync(f, 'utf8')).series ?? {};
  return Object.fromEntries(Object.entries(series).map(
    ([code, rows]) => [code, new Map(rows.map(r => [r.d, r.units]))]));
}
const LISTED = listedSharesByDate();

function foreignSharesOf(code, d, foreignPct) {
  if (foreignPct == null) return null;
  const byDate = LISTED[code];
  // 그날 값이 없으면(가장 최근 거래일 등) 마지막으로 아는 상장주식수를 쓴다.
  const units = byDate?.get(d) ?? [...(byDate?.values() ?? [])].at(-1);
  return units ? Math.round((foreignPct / 100) * units) : null;
}

/* ---------- 실행 ---------- */
const out = {
  meta: {
    lending: 'FREESIS 대차거래추이 (STATSCU0100000140, tmpV72=종목코드). 잔고금액(백만원)은 교차검증용으로만 두고, 표시 금액은 주수 × 종가로 계산한다(§26).',
    foreign: '네이버 시세 API siseJson (종가·외국인소진율). 외국인 보유주식수는 소스에 없어 지분율 × 상장주식수로 되살린다. KRX 정보데이터시스템은 로그인이 필요해 익명 수집은 안 된다.',
    fetchedAt: new Date().toISOString().slice(0, 10),
    start: START,
  },
  stocks: [],
};

for (const [code, name] of STOCKS) {
  const lending = await fetchLending(code);
  const foreign = await fetchForeign(code, START);

  /*
   * 한 건도 못 받았으면 소스가 바뀐 것이다. 여기서 멈춰야 한다 —
   * 그대로 진행하면 종가가 전부 null 인 파일로 **멀쩡한 기존 데이터를 덮어쓴다.**
   * 던지면 워크플로가 이 소스를 FETCH_ERRORS 에 적고(status.json 에 남는다)
   * 지난 데이터로 리포트를 계속 낸다. 조용히 비는 것보다 이쪽이 낫다.
   */
  if (!foreign.length) {
    throw new Error(`${name}(${code}): 종가·외국인 지분율을 한 건도 못 받았다 — `
      + '소스가 바뀐 것으로 보인다. 기존 데이터를 덮지 않고 멈춘다.');
  }

  const fr = new Map(foreign.map(r => [r.d, r]));
  const series = lending.map(r => {
    const f = fr.get(r.d);
    return {
      ...r,
      close: f?.close ?? null,
      foreignShares: foreignSharesOf(code, r.d, f?.foreignPct ?? null),
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
