// data/analysis.json 의 불변식을 검사한다. analyze.mjs 를 고친 뒤 이걸 돌려서
// 조용히 깨진 계산이 없는지 본다.  node scripts/selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const A = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'data', 'analysis.json'), 'utf8'));

const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (허용 ${tol})`);

// 원 자료 재현이 무너지면 방법론이 바뀐 것이다(§2.5 는 0.051조).
assert.ok(A.reproMAE < 0.1, `재현 MAE 가 커졌다: ${A.reproMAE}`);

// 마진콜 계수 = 담보유지비율 x 융자비율 (§2.2)
near(A.meta.marginFactor, A.meta.maintenance * A.meta.loanRatio, 1e-9, '마진콜 계수');

// 사이클별: 청산액은 고점-저점과 같아야 하고, 청산률 부호는 음수여야 한다.
for (const p of A.periods) {
  const h = p.markets['전체'].headline;
  near(h.actualDeclineJo, h.creditTroughJo - h.creditPeakJo, 1e-6, `${p.key} 청산액`);
  assert.ok(h.unwindPct <= 0, `${p.key} 청산률이 양수다`);
}

// §17 레버리지 채널 산술
if (A.channels) {
  const c = A.channels.last;
  near(c.totalLevJo, c.creditJo + c.pledgeJo, 1e-9, '총 레버리지');
  near(c.coverage, c.depositJo / c.creditJo, 1e-9, '커버리지');
  assert.ok(A.channels.pct >= 0 && A.channels.pct <= 100, `백분위 범위 밖: ${A.channels.pct}`);
  assert.ok(A.channels.covMin.coverage <= c.coverage && c.coverage <= A.channels.covMax.coverage,
    '현재 커버리지가 역대 최저~최고 밖에 있다');
  for (const m of A.channels.marks) near(m.totalLevJo, m.creditJo + m.pledgeJo, 1e-9, `${m.label} 총 레버리지`);
}

// §18 미수금 전이
if (A.unpaid) {
  assert.equal(A.unpaid.full.length, 4, '시차 표가 0~3일이 아니다');
  for (const s of A.unpaid.full) assert.ok(s.r >= -1 && s.r <= 1, `상관계수 범위 밖: ${s.r}`);
  assert.ok(A.unpaid.full.every(s => s.r <= A.unpaid.best.r), 'best 가 최대가 아니다');
  assert.ok(A.unpaid.medianTransfer > 0 && A.unpaid.medianTransfer < 1,
    `전이율 중앙값이 0~100% 밖: ${A.unpaid.medianTransfer}`);
  near(A.unpaid.impliedForcedJo, A.unpaid.last.unpaid * A.unpaid.medianTransfer, 1e-9, '함의 반대매매');
}

// §20 숏커버 여력
if (A.lending?.cover) {
  const cv = A.lending.cover, L = A.lending;
  near(cv.coveredJo, L.cyclePeak.balJo - L.last.balJo, 1e-9, '이미 되갚은 양');
  assert.ok(cv.benches.length >= 2, '숏커버 벤치마크가 2개 미만이다');
  for (const b of cv.benches) {
    near(b.remainJo, L.last.balJo - b.targetJo, 1e-9, `${b.key} 잔여 커버`);
    if (b.equivDays != null) near(b.equivDays, b.remainJo / cv.dailyTurnoverJo, 1e-9, `${b.key} 거래대금 배수`);
  }
  const rs = cv.benches.map(b => b.remainJo);
  near(cv.lowJo, Math.min(...rs), 1e-9, '잔여 하한');
  near(cv.highJo, Math.max(...rs), 1e-9, '잔여 상한');
  assert.ok(cv.dailyTurnoverJo > 0, '일평균 거래대금이 0 이하다');
}

// §19 장중 지수는 FREESIS 최종일보다 뒤여야 한다.
if (A.spot) {
  assert.ok(A.spot.date > A.spot.baseDate, 'spot 날짜가 기준일보다 앞선다');
  near(A.spot.changePct, (A.spot.idx / A.spot.baseIdx - 1) * 100, 1e-9, 'spot 등락률');
}

// 시계열은 날짜 오름차순에 중복이 없어야 한다.
const dates = A.series.map(r => r.d);
assert.deepEqual(dates, [...dates].sort(), '시계열이 정렬돼 있지 않다');
assert.equal(new Set(dates).size, dates.length, '시계열에 중복 날짜가 있다');

console.log(`selfcheck OK — ${A.series.length}행, 재현 MAE ${A.reproMAE.toFixed(3)}조, `
  + `사이클 ${A.periods.length}개, 채널 ${A.channels ? 'O' : 'X'}, 미수금 ${A.unpaid ? 'O' : 'X'}`);
