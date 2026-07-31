// 금융투자협회 FREESIS 에서 일별 신용융자/반대매매/미수금/예탁금 시계열을 받아온다.
//
// 경로를 찾은 과정:
//   FREESIS 통계 화면은 eXBuilder6 SPA 라서 화면을 띄우지 않으면 렌더되지 않고,
//   각 통계 서비스가 쓰는 제네릭 서브미션(/CommSubmit/egovXbuilder.do)은
//   MAPPER/QRY 값을 알 수 없어 호출이 불가능했다.
//   대신 '크로스 통계' 앱은 지표별 전용 엔드포인트를 쓴다.
//     - /crossStatsCustom/STATCRSIDXIDINFOBO.do  : 지표 카탈로그(코드 + sqlKey)
//     - /crossStatsCustom/STATCRS0600000011BO.do : 지표 시계열 조회
//   요청 DataMap 이름이 "data" 이므로 평범한 JSON 바디로 그대로 호출된다.
//
// 검증: 20260728 신용융자 = 33,194,040 백만원 (FREESIS 메인 화면 표기와 일치)
import fs from 'node:fs';
import path from 'node:path';

const URL_DATA = 'https://freesis.kofia.or.kr/crossStatsCustom/STATCRS0600000011BO.do';
const OUT = path.join(import.meta.dirname, '..', 'data', 'kofia-daily.json');

// 지표 코드 -> [표시명, sqlKey, 단위]
const INDICATORS = {
  OS0001: ['KOSPI지수', 'STATCRS0600000010VM001', 'P'],
  OS0002: ['KOSDAQ지수', 'STATCRS0600000010VM002', 'P'],
  OS0008: ['KOSPI시가총액', 'STATCRS0600000010VM008', '억원'],
  OS0009: ['KOSDAQ시가총액', 'STATCRS0600000010VM009', '억원'],
  OS0011: ['KOSPI거래대금', 'STATCRS0600000010VM010', '억원'],
  OS0012: ['KOSDAQ거래대금', 'STATCRS0600000010VM011', '억원'],
  OS0026: ['신용융자', 'STATCRS0600000010VM021', '백만원'],
  OS0025: ['반대매매금액', 'STATCRS0600000010VM020', '백만원'],
  OS0024: ['위탁매매미수금', 'STATCRS0600000010VM019', '백만원'],
  OS0021: ['투자자예탁금', 'STATCRS0600000010VM016', '백만원'],
  OS0027: ['예탁증권담보융자', 'STATCRS0600000010VM022', '백만원'],
};

const START_YEAR = 2010; // FREESIS 서비스 메타의 FORM_SRTDT 가 20100101
// 기본 종료일은 '오늘'이다. 날짜를 상수로 박아두면 다음에 그냥 돌렸을 때
// 이미 받아둔 최근 며칠이 조용히 사라진다(실제로 20260730 이 한 번 사라졌다).
const today = new Date();
const END = process.argv[2]
  ?? `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

const codes = Object.keys(INDICATORS);

async function fetchRange(from, to) {
  const res = await fetch(URL_DATA, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/json',
      Referer: 'https://freesis.kofia.or.kr/',
    },
    body: JSON.stringify({
      data: {
        userId: '',
        serviceId: 'STATCRS0600000011',
        tmpV1: 'D', // 자료주기: 일별
        tmpV45: from,
        tmpV46: to,
        tmpV108: codes.join(','),
        sqlKey: codes.map(c => INDICATORS[c][1]).join(','),
        searchLog: 'N',
        ipAddress: '',
      },
    }),
  });
  if (!res.ok) throw new Error(`kofia ${res.status} for ${from}~${to}`);
  const json = await res.json();
  if (!json.success) throw new Error(`kofia said: ${json.message}`);
  return json.dsDataGrid ?? [];
}

// 연 단위로 끊어서 받는다. 한 번에 16년을 요구하면 응답이 커지고 서버에도 부담이다.
const byDate = new Map();
const endYear = Number(END.slice(0, 4));
for (let y = START_YEAR; y <= endYear; y++) {
  const from = `${y}0101`;
  const to = y === endYear ? END : `${y}1231`;
  const rows = await fetchRange(from, to);
  for (const row of rows) {
    const date = row.TMPV1;
    const rec = byDate.get(date) ?? { date };
    for (const c of codes) {
      // 미공표 구간은 "null" 이라는 문자열로 내려오기도 한다. 숫자로 읽히는 값만 담는다.
      const v = Number(row[c]);
      if (row[c] != null && row[c] !== '' && Number.isFinite(v)) rec[c] = v;
    }
    byDate.set(date, rec);
  }
  console.log(`${y}: ${rows.length} rows`);
}

const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

// 덮어쓰기 전에 행이 줄지 않았는지 본다. 줄었다면 END 를 너무 이르게 잡았거나
// 원 소스가 최근 행을 회수한 것이므로, 알아채지 못하고 지나가면 안 된다.
if (fs.existsSync(OUT)) {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).series ?? [];
  if (prev.length > series.length) {
    console.log(`  경고: 기존 ${prev.length}행 -> 신규 ${series.length}행 (마지막 ${prev.at(-1).date} -> ${series.at(-1).date}). 덮어쓴다.`);
  }
}

fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    source: 'KOFIA FREESIS 크로스통계 (crossStatsCustom)',
    endpoint: URL_DATA,
    indicators: Object.fromEntries(
      Object.entries(INDICATORS).map(([c, [nm, , unit]]) => [c, { name: nm, unit }])),
    note: '신용융자는 유가증권+코스닥 합계이며 결제일 기준. 2007.7.2 이후 ETF 신용공여 포함.',
    // 요청 종료일(END)이 아니라 실제로 받아진 데이터의 범위를 적는다.
    // END 를 적으면 새 데이터가 없는 날에도 파일이 매일 바뀌어, 자동 갱신이 빈 커밋을 만든다.
    fetchedRange: `${series[0].date}~${series.at(-1).date}`,
  },
  series,
}, null, 0));

const withCredit = series.filter(r => r.OS0026 != null);
const peak = withCredit.reduce((m, r) => (r.OS0026 > m.OS0026 ? r : m));
console.log(`\nrows=${series.length}  ${series[0].date}..${series.at(-1).date}`);
console.log(`신용융자 최고 ${(peak.OS0026 / 1e6).toFixed(2)}조 (${peak.date})`);
console.log(`신용융자 최종 ${(withCredit.at(-1).OS0026 / 1e6).toFixed(2)}조 (${withCredit.at(-1).date})`);
