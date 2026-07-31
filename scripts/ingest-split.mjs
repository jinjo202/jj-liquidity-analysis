// FREESIS '신용공여 잔고 추이' 다운로드 파일을 data/credit-split.json 으로 정규화한다.
//
// 왜 필요한가: 금투협은 신용거래융자를 전체/유가증권/코스닥으로 나눠 공표하지만,
// 프로그램으로 뚫린 크로스통계 API 에는 '전체'(OS0026)만 노출된다.
// 분리 계열은 통계 화면에서 내려받아야 하고, 이 스크립트가 그 파일을 받아 처리한다.
//
// 사용법:
//   node scripts/ingest-split.mjs [파일경로]
//   경로를 안 주면 data/ 안에서 가장 최근에 받은 후보 파일을 찾는다.
import fs from 'node:fs';
import path from 'node:path';
import { readMatrix, toNum, toDate, pickFile } from './lib/xlsx.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'credit-split.json');

const file = pickFile([DATA, ROOT], process.argv[2], '신용공여');
if (!file) {
  console.error(`data/ 안에 xlsx/xls/csv 파일이 없다.\n  FREESIS > 주식 > 신용공여현황 > 신용공여 잔고 추이`
    + `\n  자료주기 '일', 기간 2010-01-01~최신으로 조회한 뒤 내려받아 data/ 에 넣고 다시 실행할 것.`);
  process.exit(1);
}
const matrix = readMatrix(file);
console.log(`읽음: ${path.basename(file)}  (${matrix.length} 행)`);

// 날짜가 든 행만 데이터로 본다. 헤더가 몇 줄이든 상관없다.
const dataRows = matrix
  .map(cells => ({ date: toDate(cells[0]), nums: cells.slice(1).map(toNum) }))
  .filter(r => r.date);

if (!dataRows.length) {
  console.error('날짜로 시작하는 행을 찾지 못했다. 첫 5행을 확인할 것:');
  matrix.slice(0, 5).forEach((r, i) => console.error(`  [${i}] ${JSON.stringify(r.slice(0, 12))}`));
  process.exit(1);
}

// 컬럼 순서(그리드 헤더 기준):
//   신용거래융자 전체 / 유가증권 / 코스닥, 신용거래대주 전체 / 유가증권 / 코스닥,
//   청약자금 대출, 예탁증권담보융자
// 앞의 세 개만 쓴다. 숫자 컬럼 위치가 밀릴 수 있으니 '전체 = 유가증권 + 코스닥' 으로 검증한다.
function locate(nums) {
  for (let i = 0; i + 2 < nums.length; i++) {
    const [t, k, q] = [nums[i], nums[i + 1], nums[i + 2]];
    if (t == null || k == null || q == null) continue;
    if (t > 0 && Math.abs(t - (k + q)) <= Math.max(2, t * 0.001)) return i;
  }
  return -1;
}

const votes = new Map();
for (const r of dataRows.slice(0, 60)) {
  const at = locate(r.nums);
  if (at >= 0) votes.set(at, (votes.get(at) ?? 0) + 1);
}
if (!votes.size) {
  console.error("'전체 = 유가증권 + 코스닥' 을 만족하는 컬럼 조합을 찾지 못했다. 첫 3행 숫자:");
  dataRows.slice(0, 3).forEach(r => console.error(`  ${r.date} ${JSON.stringify(r.nums.slice(0, 12))}`));
  process.exit(1);
}
const base = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`컬럼 위치 확정: 전체=+${base + 1}, 유가증권=+${base + 2}, 코스닥=+${base + 3} (${votes.get(base)}행 일치)`);

const series = dataRows
  .map(r => ({
    date: r.date,
    total: r.nums[base],
    kospi: r.nums[base + 1],
    kosdaq: r.nums[base + 2],
  }))
  .filter(r => r.total != null && r.kospi != null && r.kosdaq != null)
  .sort((a, b) => a.date.localeCompare(b.date));

// 단위 판정: 백만원이면 최근 값이 3천만 내외(33조), 원이면 1e13 규모.
const last = series.at(-1);
const scale = last.total > 1e10 ? 1e6 : 1; // 원 단위로 왔으면 백만원으로 환산
if (scale !== 1) {
  console.log(`단위가 '원'으로 보인다(최근 전체 ${last.total}). 백만원으로 환산한다.`);
  for (const r of series) { r.total /= scale; r.kospi /= scale; r.kosdaq /= scale; }
}

fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    source: `FREESIS 신용공여 잔고 추이 (${path.basename(file)})`,
    unit: '백만원',
    note: '신용거래융자 기준. 전체 = 유가증권 + 코스닥.',
  },
  series,
}, null, 0));

const f = n => (n / 1e6).toFixed(2);
console.log(`\ncredit-split.json 생성: ${series.length}일  ${series[0].date}..${series.at(-1).date}`);
console.log(`최근 ${last.date}: 전체 ${f(series.at(-1).total)}조 = 유가증권 ${f(series.at(-1).kospi)}조 + 코스닥 ${f(series.at(-1).kosdaq)}조`);
console.log(`  유가증권 비중 ${(series.at(-1).kospi / series.at(-1).total * 100).toFixed(1)}%`);

// 이미 확보한 '전체' 계열과 교차 검증
const kofiaPath = path.join(DATA, 'kofia-daily.json');
if (fs.existsSync(kofiaPath)) {
  const k = JSON.parse(fs.readFileSync(kofiaPath, 'utf8')).series;
  const km = new Map(k.filter(r => Number.isFinite(r.OS0026)).map(r => [r.date, r.OS0026]));
  let n = 0, bad = 0, maxDiff = 0, maxDate = '';
  for (const r of series) {
    const v = km.get(r.date);
    if (v == null) continue;
    n++;
    const d = Math.abs(v - r.total);
    if (d > maxDiff) { maxDiff = d; maxDate = r.date; }
    if (d > Math.max(2, v * 0.001)) bad++;
  }
  console.log(`\n교차검증 vs 크로스통계 OS0026: ${n}일 비교, 불일치 ${bad}일, 최대차 ${maxDiff.toLocaleString()} 백만원 (${maxDate})`);
}
