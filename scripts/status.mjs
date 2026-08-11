// 파이프라인 건강 상태를 status.json 으로 남긴다.
//
// 왜 필요한가: 저장소가 public(§0.2)이라 Actions 로그도 볼 수는 있지만, 매번 Actions 탭을
// 여는 것보다 빠르다. 자동 갱신이 실제로 돌고 있는지, 어느 날짜까지 반영됐는지를 배포된
// 사이트에서 바로 확인할 수 있어야 한다 — https://<사이트>/status.json
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
  // 실패한 실행이 남기는 값. 성공하면 null 이고, 실패하면 어느 단계에서 멈췄는지가 들어간다.
  // 실패 실행은 커밋 단계까지 가지 못하므로 워크플로의 'Report failure' 가 대신 커밋한다.
  failedStage: (process.env.FAILED_STAGE ?? '').trim() || null,
  selfcheck: process.env.FAILED_STAGE ? 'not reached' : 'passed',
  // 소스별 실패는 워크플로가 여기로 넘겨준다. 하나가 막혀도 나머지는 갱신되므로,
  // '값이 안 움직인 것'과 '못 받아온 것'을 이 필드로 구분한다.
  fetchErrors: (process.env.FETCH_ERRORS ?? '').trim() || null,
  lendingError: (process.env.LENDING_ERR ?? '').trim().slice(0, 400) || null,
  dataThrough: Object.fromEntries((A.daily?.freshness ?? []).map(x => [x.label, x.date])),
  lastSeriesDate: A.series.at(-1).d,
  reproMAE: Number(A.reproMAE.toFixed(4)),
  cycles: A.periods.map(p => p.key),
  // 매일 확인할 지표 하나. 사이트를 열지 않고도 이 파일만 보면 판정이 나온다(§23.2).
  // verdict: building(쌓이는 중) / flat(정체) / rolling(꺾였다)
  singleStockEtfUnits: (() => {
    const u = A.etf?.unitsTrend?.single;
    if (!u) return null;
    const r = n => (Number.isFinite(n) ? Number(n.toFixed(1)) : null);
    return {
      date: u.last.d,
      unitsMillion: Math.round(u.last.unitsM),
      verdict: u.verdict,
      changePct: { d1: r(u.d1), d5: r(u.d5), d10: r(u.d10) },
      peak: { date: u.peak.d, unitsMillion: Math.round(u.peak.unitsM), fromPeakPct: r(u.fromPeakPct), tradingDaysSince: u.daysSincePeak },
      consecutiveDownDays: u.downStreak,
    };
  })(),
  // 리포트 최상단의 종합 판정(§35). 사이트를 안 열고도 오늘의 결론을 가져갈 수 있게 넣는다.
  verdict: (() => {
    const V = A.verdict;
    if (!V) return null;
    return {
      asOf: V.asOf,
      stance: V.stance.key,
      stanceLabel: V.stance.label,
      score: V.total,
      signals: V.n,
      headline: V.headline.replace(/\*\*/g, ''),
      axes: Object.fromEntries(V.axes.map(a => [a.axis, { ok: a.ok, alert: a.alert, n: a.n }])),
      alerts: V.signals.filter(s => s.state === 'alert').map(s => `${s.label} ${s.value}`),
    };
  })(),
  note: '자동 갱신 상태 확인용. ranOn 이 며칠째 그대로면 워크플로가 멈춘 것이다.'
    + ' singleStockEtfUnits.verdict 가 rolling 으로 바뀌면 레버리지 ETF 환매가 실제로 시작된 것이다.',
};

fs.writeFileSync(path.join(ROOT, 'status.json'), JSON.stringify(status, null, 2) + '\n');
console.log(`status.json 생성 — ${status.ranOn} / ${status.ranBy} / 데이터 ~${status.lastSeriesDate}`);
