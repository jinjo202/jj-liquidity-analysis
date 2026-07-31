// 파이프라인 건강 상태를 status.json 으로 남긴다.
//
// 왜 필요한가: 저장소가 private 이라 Actions 로그를 URL 로 열 수 없다.
// 자동 갱신이 실제로 돌고 있는지, 어느 날짜까지 반영됐는지를 배포된 사이트에서
// 바로 확인할 수 있어야 한다 — https://<사이트>/status.json
//
// 시각이 아니라 '날짜'만 적는다. 시각까지 넣으면 실행할 때마다 파일이 달라져
// 의미 없는 커밋이 쌓인다. 하루 한 번 바뀌는 정도면 건강 확인에 충분하다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'analysis.json'), 'utf8'));

const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;

const status = {
  ranOn: new Date().toISOString().slice(0, 10),
  ranBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  runUrl: repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null,
  // selfcheck 를 통과해야 이 스크립트까지 온다(워크플로 순서). 여기 파일이 갱신됐다는 것 자체가
  // 그날 계산이 불변식을 통과했다는 뜻이다.
  selfcheck: 'passed',
  dataThrough: Object.fromEntries((A.daily?.freshness ?? []).map(x => [x.label, x.date])),
  lastSeriesDate: A.series.at(-1).d,
  reproMAE: Number(A.reproMAE.toFixed(4)),
  cycles: A.periods.map(p => p.key),
  note: '자동 갱신 상태 확인용. ranOn 이 며칠째 그대로면 워크플로가 멈춘 것이다.',
};

fs.writeFileSync(path.join(ROOT, 'status.json'), JSON.stringify(status, null, 2) + '\n');
console.log(`status.json 생성 — ${status.ranOn} / ${status.ranBy} / 데이터 ~${status.lastSeriesDate}`);
