// FREESIS '신용공여 잔고 추이' 다운로드 파일을 Supabase credit_split_raw 에 반영한다.
//
// 왜 필요한가: 금투협은 신용거래융자를 전체/유가증권/코스닥으로 나눠 공표하지만,
// 프로그램으로 뚫린 크로스통계 API 에는 '전체'(OS0026)만 노출된다.
// 분리 계열은 통계 화면에서 내려받아야 하고, 이 스크립트가 그 파일을 받아 처리한다.
//
// 사용법:
//   node --env-file=.env.local scripts/ingest-split.mjs [파일경로]
//   경로를 안 주면 data/ 안에서 가장 최근에 받은 후보 파일을 찾는다.
//
// 의존성 없음. xlsx(zip)는 Windows 기본 tar 로 풀고 XML 을 직접 읽는다.
// 파일 형식 판별/파싱 로직은 scripts/lib/xlsx.mjs 로 뽑아내 ingest-lending.mjs 와 공유한다.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readMatrix, toNum, toDate } from './lib/xlsx.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

/* ---------- 입력 파일 찾기 ---------- */

function pickFile() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  // data/ 디렉토리 자체는 git에 안 잡히므로(내용물만 gitignore) 새로 clone한 환경에는
  // 폴더가 아예 없을 수 있다. readdirSync가 raw ENOENT를 던지기 전에 만들어 둔다.
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  const cands = fs.readdirSync(DATA)
    .filter(f => /\.(xlsx|xls|csv|tsv|txt)$/i.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(DATA, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!cands.length) {
    console.error(`data/ 안에 xlsx/xls/csv 파일이 없다.\n  FREESIS > 주식 > 신용공여현황 > 신용공여 잔고 추이`
      + `\n  자료주기 '일', 기간 2010-01-01~최신으로 조회한 뒤 내려받아 data/ 에 넣고 다시 실행할 것.`);
    process.exit(1);
  }
  return path.join(DATA, cands[0].f);
}

/* ---------- 행렬 -> 시계열 ---------- */

const file = pickFile();
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.'
    + ' node --env-file=.env.local scripts/ingest-split.mjs 로 실행하세요.');
  process.exit(1);
}
const sb = createClient(url, key);
const payload = series.map(r => ({ date: r.date, total: r.total, kospi: r.kospi, kosdaq: r.kosdaq }));
for (let i = 0; i < payload.length; i += 1000) {
  const { error } = await sb.from('credit_split_raw')
    .upsert(payload.slice(i, i + 1000), { onConflict: 'date' });
  if (error) throw new Error(`credit_split_raw upsert 실패: ${error.message}`);
}
console.log(`credit_split_raw 갱신 완료: ${series.length}일  ${series[0].date}..${series.at(-1).date}`);
