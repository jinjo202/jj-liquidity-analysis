// FREESIS '대차거래추이'(STATSCU0100000140) 다운로드 파일을 Supabase lending_balance_raw 에 반영한다.
//
// 왜 필요한가: 공매도는 한국에서 거의 전량 '차입 후 매도'라, 대차잔고(주식 대차거래 잔고)가
// 시장 전체 공매도 잔고의 표준 프록시다. 종목별 순보유잔고(대량보유자 신고 기준)는
// KRX가 공표하지만 시장 전체 합계는 공표되지 않는다. 크로스통계 API 에도 이 지표는 없어서
// (신용융자 분리와 같은 이유로 grid 값이 null만 나온다) 통계 화면에서 내려받아야 한다.
//
// 사용법:
//   node --env-file=.env.local scripts/ingest-lending.mjs [파일경로]
//   경로를 안 주면 data/ 안에서 파일명에 '대차'가 들어간 가장 최근 파일을 찾는다.
//
// 파일 구조(확인됨, FREESIS 대차거래추이 다운로드):
//   헤더 4줄 + 데이터. 컬럼: 일자 | 체결(주수) | 상환(주수) | 잔고 주수 | 잔고 금액
//   단위: [단위 :백만원, 일주] — 금액은 백만원, 주수는 그대로.
//   구분 컬럼 없이 이미 시장 전체 1행/일이다(사용자가 '전체' 기준으로 내려받음).
//
// 파일 형식 판별/파싱 로직은 scripts/lib/xlsx.mjs 를 ingest-split.mjs 와 공유한다.
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readMatrix, toNum, toDate, pickFile } from './lib/xlsx.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

const file = pickFile([DATA, ROOT], process.argv[2], '대차');
if (!file) {
  console.error(`data/ 안에 xlsx/xls/csv 파일이 없다.\n  FREESIS > 주식 > 대차거래 > 대차거래추이`
    + `\n  자료주기 '일', 기간 2010-01-01~최신으로 조회한 뒤 내려받아 data/ 에 넣고 다시 실행할 것.`);
  process.exit(1);
}
const matrix = readMatrix(file);
console.log(`읽음: ${path.basename(file)}  (${matrix.length} 행)`);

const dataRows = matrix
  .map(cells => ({ date: toDate(cells[0]), nums: cells.slice(1).map(toNum) }))
  .filter(r => r.date);

if (!dataRows.length) {
  console.error('날짜로 시작하는 행을 찾지 못했다. 첫 6행을 확인할 것:');
  matrix.slice(0, 6).forEach((r, i) => console.error(`  [${i}] ${JSON.stringify(r.slice(0, 6))}`));
  process.exit(1);
}

// 컬럼: [0]체결(주수) [1]상환(주수) [2]잔고 주수 [3]잔고 금액(백만원).
// 잔고는 항상 양수이고 체결/상환보다 훨씬 크므로(누적 대비 일별 유량), 그걸로 위치를 검증한다.
function locate(nums) {
  for (let i = 0; i + 1 < nums.length; i++) {
    const [shares, jo] = [nums[i], nums[i + 1]];
    if (shares == null || jo == null || shares <= 0 || jo <= 0) continue;
    return i; // 잔고 주수, 잔고 금액이 연속으로 오는 첫 지점
  }
  return -1;
}
const votes = new Map();
for (const r of dataRows.slice(0, 60)) {
  const at = locate(r.nums.slice(2)); // 체결/상환 다음이 잔고
  // at 은 slice(2) 기준 로컬 인덱스(잔고주수 위치). 전역 잔고금액 인덱스 = 2(오프셋) + at + 1.
  if (at >= 0) votes.set(at + 3, (votes.get(at + 3) ?? 0) + 1);
}
if (!votes.size) {
  console.error('잔고 컬럼 위치를 찾지 못했다. 첫 3행 숫자:');
  dataRows.slice(0, 3).forEach(r => console.error(`  ${r.date} ${JSON.stringify(r.nums)}`));
  process.exit(1);
}
const balCol = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`컬럼 위치 확정: 잔고주수=+${balCol - 1}, 잔고금액=+${balCol} (${votes.get(balCol)}행 일치)`);

const series = dataRows
  .map(r => ({
    date: r.date,
    dealShares: r.nums[balCol - 3] ?? null,
    repayShares: r.nums[balCol - 2] ?? null,
    balanceShares: r.nums[balCol - 1],
    balanceMil: r.nums[balCol],
  }))
  .filter(r => Number.isFinite(r.balanceMil))
  .sort((a, b) => a.date.localeCompare(b.date));

const last = series.at(-1);
// 단위 판정: 백만원이면 최근 값이 조 단위(1e8 백만원 안팎), 원이면 훨씬 크다.
const scale = last.balanceMil > 1e10 ? 1e6 : 1;
if (scale !== 1) {
  console.log(`단위가 '원'으로 보인다(최근 잔고금액 ${last.balanceMil}). 백만원으로 환산한다.`);
  for (const r of series) r.balanceMil /= scale;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.'
    + ' node --env-file=.env.local scripts/ingest-lending.mjs 로 실행하세요.');
  process.exit(1);
}
const sb = createClient(url, key);
const payload = series.map(r => ({
  date: r.date,
  deal_shares: r.dealShares,
  repay_shares: r.repayShares,
  balance_shares: r.balanceShares,
  balance_mil: r.balanceMil,
}));
for (let i = 0; i < payload.length; i += 1000) {
  const { error } = await sb.from('lending_balance_raw')
    .upsert(payload.slice(i, i + 1000), { onConflict: 'date' });
  if (error) throw new Error(`lending_balance_raw upsert 실패: ${error.message}`);
}

const f = n => (n / 1e6).toFixed(2);
console.log(`lending_balance_raw 갱신 완료: ${series.length}일  ${series[0].date}..${series.at(-1).date}`);
console.log(`최근 ${last.date}: 대차잔고 ${f(last.balanceMil)}조원 (${(last.balanceShares / 1e8).toFixed(1)}억주)`);

const peak = series.reduce((m, r) => (r.balanceMil > m.balanceMil ? r : m));
console.log(`역대 최고 ${f(peak.balanceMil)}조원 (${peak.date})`);
