// FREESIS '대차거래추이'(STATSCU0100000140)를 받아 data/lending-balance.json 으로 저장한다.
//
// 경로를 찾은 과정 (docs/methodology.md §16.2):
//   이 엔드포인트(/meta/getMetaDataList.do)는 예전에도 시도했지만 날짜 골격만 오고
//   값 컬럼이 전부 null 이었다. 원인은 파라미터 누락이었다 — OBJ_NM 만 보냈고
//   tmpV40(행수)·tmpV41(페이지)·tmpV72(종목)를 안 보냈다.
//   헤드리스 브라우저로 실제 화면을 띄워 앱이 보내는 요청 본문을 그대로 캡처해서 알아냈다.
//   알아낸 뒤에는 브라우저가 필요 없다 — 평범한 POST 한 번이면 된다.
//
// 응답 형태:
//   { unit:"", ds1:[ {TMPV1:일자, TMPV2:구분, TMPV3:체결주수, TMPV4:상환주수,
//                     TMPV5:잔고주수, TMPV6:잔고금액(백만원)} ... ], dsmHeader:"" }
//   - 최신일이 먼저 오는 내림차순이다.
//   - 마지막 두 행은 '합계'/'평균' 요약이라 일자가 숫자가 아니다. 반드시 걸러낸다.
import fs from 'node:fs';
import path from 'node:path';

const URL_DATA = 'https://freesis.kofia.or.kr/meta/getMetaDataList.do';
const OUT = path.join(import.meta.dirname, '..', 'data', 'lending-balance.json');

const START = '20100101';
const today = new Date();
const END = process.argv[2]
  ?? `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

// 연 단위로 끊어서 받는다. 16년치를 한 번에 요구하면 응답이 424KB 가 되는데,
// GitHub 러너에서 그 응답이 중간에 잘려 와 JSON.parse 가 깨졌다(로컬에서는 멀쩡했다).
// fetch-kofia.mjs 가 같은 이유로 연 단위로 받는다. 조각당 30KB 안팎이면 안전하다.
async function fetchRange(from, to, attempt = 1) {
  try {
    const res = await fetch(URL_DATA, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        Referer: 'https://freesis.kofia.or.kr/stat/FreeSIS.do',
      },
      body: JSON.stringify({
        dmSearch: {
          tmpV40: '1000000',   // 최대 행수. 작게 주면 잘려서 온다.
          tmpV41: '1',         // 페이지
          tmpV1: 'D',          // 자료주기: 일별
          tmpV45: from,
          tmpV46: to,
          tmpV72: '',          // 종목 선택: 빈 값 = 전체
          OBJ_NM: 'STATSCU0100000140BO',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    // WAF 뒤라 차단 시 200 으로 HTML 이 오기도 하고, 러너에서는 본문 앞뒤에 이물질이
    // 붙어 오는 경우가 있었다(로컬에서는 깨끗했다). 상태코드로는 성공/실패가 안 갈린다.
    // 그래서 먼저 그대로 파싱하고, 실패하면 첫 '{' ~ 마지막 '}' 만 잘라 다시 시도한다.
    const attemptParse = s => { try { return JSON.parse(s); } catch { return null; } };
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    const json = attemptParse(text)
      ?? (first >= 0 && last > first ? attemptParse(text.slice(first, last + 1)) : null);
    if (!json) {
      const clean = s => s.replace(/\s+/g, ' ');
      throw new Error(`${from}~${to}: JSON 아님 (status ${res.status}, ${text.length}바이트,`
        + ` 머리 [${clean(text.slice(0, 80))}], 꼬리 [${clean(text.slice(-40))}])`);
    }
    return json.ds1 ?? [];
  } catch (e) {
    if (attempt >= 3) throw e;
    console.log(`  ${e.message} — 재시도 ${attempt}`);
    await new Promise(r => setTimeout(r, attempt * 3000));
    return fetchRange(from, to, attempt + 1);
  }
}

// 실패를 한 줄로 내보낸다. 노드 기본 예외 출력은 코드 프레임과 스택이 앞에 붙어
// 워크플로가 잘라 담을 때 정작 필요한 메시지(상태·길이·본문 머리)가 날아간다.
const byDate = new Map();
try {
  const endYear = Number(END.slice(0, 4));
  for (let y = Number(START.slice(0, 4)); y <= endYear; y++) {
    const chunk = await fetchRange(`${y}0101`, y === endYear ? END : `${y}1231`);
    for (const r of chunk) byDate.set(String(r.TMPV1), r);
    console.log(`${y}: ${chunk.length} rows`);
  }
} catch (e) {
  console.error(`LENDING_FAIL ${e.message}`);
  process.exit(1);
}
const rows = [...byDate.values()];
if (!rows.length) throw new Error('빈 응답. 파라미터 규격이 바뀌었는지 확인할 것.');

const series = rows
  .filter(r => /^\d{8}$/.test(String(r.TMPV1)))     // '합계'/'평균' 요약 행 제거
  .map(r => ({
    date: String(r.TMPV1),
    dealShares: Number(r.TMPV3),
    repayShares: Number(r.TMPV4),
    balanceShares: Number(r.TMPV5),
    balanceMil: Number(r.TMPV6),
  }))
  .filter(r => Number.isFinite(r.balanceMil))
  .sort((a, b) => a.date.localeCompare(b.date));

if (!series.length) throw new Error('일자 행을 하나도 못 찾았다. 응답 컬럼명이 바뀌었을 수 있다.');

// 덮어쓰기 전에 행이 줄지 않았는지 본다(fetch-kofia 와 같은 이유).
if (fs.existsSync(OUT)) {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).series ?? [];
  if (prev.length > series.length) {
    console.log(`  경고: 기존 ${prev.length}행 -> 신규 ${series.length}행 (마지막 ${prev.at(-1).date} -> ${series.at(-1).date}). 덮어쓴다.`);
  }
}

fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    source: 'FREESIS 대차거래추이 (STATSCU0100000140, /meta/getMetaDataList.do)',
    unit: '백만원(잔고금액), 주(잔고/체결/상환 주수)',
    note: '시장 전체(전체 구분) 기준. 한국은 공매도 전량이 대차 후 매도라 대차잔고를 공매도 잔고의 표준 프록시로 쓴다. '
      + '시장 전체 실제 공매도 잔고는 별도로 공표되지 않는다(종목별 순보유잔고, 대량보유자 신고 기준만 공표).',
    fetchedRange: `${series[0].date}~${series.at(-1).date}`,
  },
  series,
}, null, 0));

const f = n => (n / 1e6).toFixed(2);
const last = series.at(-1);
console.log(`rows=${series.length}  ${series[0].date}..${last.date}`);
console.log(`최근 ${last.date}: 대차잔고 ${f(last.balanceMil)}조원 (${(last.balanceShares / 1e8).toFixed(1)}억주)`);
const peak = series.reduce((m, r) => (r.balanceMil > m.balanceMil ? r : m));
console.log(`역대 최고 ${f(peak.balanceMil)}조원 (${peak.date})`);
