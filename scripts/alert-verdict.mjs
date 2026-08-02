// 단일종목 레버리지 ETF 좌수 판정이 '바뀐 날'만 알린다.
//
// 매일 같은 메시지가 오면 사흘 만에 안 보게 된다. 중요한 건 매일의 숫자가 아니라
// building -> flat -> rolling 으로 넘어가는 순간이다(§23.7). 그래서 이 스크립트는
// 직전 판정을 파일에 적어 두고, 달라졌을 때만 ALERT 를 낸다.
//
// 사용법:  node scripts/alert-verdict.mjs
//   출력 첫 줄이 ALERT 면 그 아래 본문을 그대로 카카오톡으로 보내면 된다.
//   NOCHANGE 면 아무것도 보내지 않는다(조용한 게 정상이다).
//   --dry 를 주면 상태 파일을 갱신하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = 'https://jj-liquidity-analysis.vercel.app/status.json';
const STATE = path.join(os.homedir(), '.jj-liquidity-verdict.json');
const LOCAL = path.join(import.meta.dirname, '..', 'status.json');
const dry = process.argv.includes('--dry');

const LABEL = {
  building: '아직 쌓이는 중',
  flat: '정체(꺾이는 길목)',
  rolling: '꺾였다 — 환매 시작',
  unknown: '판정 불가',
};

async function loadStatus() {
  try {
    const res = await fetch(URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (res.ok) return { src: 'deployed', json: await res.json() };
  } catch { /* 배포본을 못 받으면 로컬로 떨어진다 */ }
  if (fs.existsSync(LOCAL)) return { src: 'local', json: JSON.parse(fs.readFileSync(LOCAL, 'utf8').replace(/^﻿/, '')) };
  throw new Error('status.json 을 배포본에서도 로컬에서도 못 읽었다');
}

const { src, json } = await loadStatus();
const u = json.singleStockEtfUnits;
if (!u) {
  console.log('NOCHANGE');
  console.log('status.json 에 singleStockEtfUnits 가 없다 — 파이프라인이 아직 갱신되지 않았다.');
  process.exit(0);
}

// BOM 을 붙여 저장하는 도구(파워셸 Set-Content 등)가 한 번이라도 이 파일을 건드리면
// JSON.parse 가 죽는다. 스케줄 실행에서 죽으면 알림이 조용히 사라지므로 앞머리를 벗겨 읽는다.
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const prev = fs.existsSync(STATE) ? readJson(STATE) : null;
const changed = prev && prev.verdict !== u.verdict;
const first = !prev;

// 카카오톡 메모챗은 200자 제한이다. 넘치면 잘리므로 처음부터 짧게 쓴다.
const body = [
  `[레버리지ETF] ${LABEL[prev?.verdict] ?? '?'} → ${LABEL[u.verdict]}`,
  `${u.date} 좌수 ${u.unitsMillion}백만좌 (5일 ${u.changePct.d5 >= 0 ? '+' : ''}${u.changePct.d5}%, 연속감소 ${u.consecutiveDownDays}일)`,
  `고점 ${u.peak.unitsMillion}백만좌 대비 ${u.peak.fromPeakPct}%`,
  'jj-liquidity-analysis.vercel.app',
].join('\n');

if (!dry) {
  fs.writeFileSync(STATE, JSON.stringify({
    verdict: u.verdict, date: u.date, unitsMillion: u.unitsMillion,
    checkedAt: new Date().toISOString().slice(0, 10),
  }, null, 2));
}

if (changed) {
  console.log('ALERT');
  console.log(body.slice(0, 200));
} else {
  console.log('NOCHANGE');
  console.log(first
    ? `첫 실행 — 현재 판정 ${u.verdict}(${LABEL[u.verdict]})을 기록만 했다. 다음부터 바뀌면 알린다.`
    : `판정 그대로 ${u.verdict}(${LABEL[u.verdict]}) · ${u.date} ${u.unitsMillion}백만좌 · 출처 ${src}`);
}
