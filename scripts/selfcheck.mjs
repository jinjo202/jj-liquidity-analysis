// data/analysis.json 의 불변식을 검사한다. analyze.mjs 를 고친 뒤 이걸 돌려서
// 조용히 깨진 계산이 없는지 본다.  node scripts/selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { placeLabels } from './lib/labels.mjs';

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

// §23 레버리지 ETF(PART 3)
if (A.etf) {
  const E = A.etf;
  assert.ok(E.checkpoints.length >= 3, '비교 시점이 3개 미만이다');
  const cps = E.checkpoints.map(c => c.date);
  assert.deepEqual(cps, [...cps].sort(), '비교 시점이 정렬돼 있지 않다');

  // 리밸런싱 계수. 인버스가 레버리지보다 커야 한다 — 이게 뒤집히면 부호 규칙이 깨진 것이다.
  assert.equal(E.coef.lev2, 2, '2X 리밸런싱 계수가 2가 아니다');
  assert.equal(E.coef.inv2, 6, '-2X 리밸런싱 계수가 6이 아니다');
  assert.ok(E.coef.inv2 > E.coef.lev2, '인버스 계수가 레버리지보다 작다');

  // 로그 분해: AUM = 좌수 x 가격 이므로 Δln 이 정확히 더해져야 한다.
  for (const f of E.perFund) {
    for (const d of [f.full, ...(f.legs ?? [])].filter(Boolean)) {
      if (d.dAum == null || d.dUnits == null || d.dPrice == null) continue;
      near(d.dAum, d.dUnits + d.dPrice, 1e-9, `${f.code} AUM 분해`);
      near(d.aumFromJo, (d.unitsFrom * d.closeFrom) / 1e12, 1e-9, `${f.code} 시작 AUM`);
      near(d.aumToJo, (d.unitsTo * d.closeTo) / 1e12, 1e-9, `${f.code} 종료 AUM`);
    }
  }

  // 그룹 합계는 구성종목 합과 같아야 한다.
  for (const g of E.groups) {
    const members = E.perFund.filter(f => f.group === g.key);
    g.sums.forEach((s, i) => {
      const sum = members.reduce((acc, m) => acc + (m.snaps[i].aumJo ?? 0), 0);
      near(s.aumJo, sum, 1e-9, `${g.key} 그룹 합계`);
    });
  }

  // 리밸런싱은 추세 증폭이다 — 필요 매매액 부호가 기초자산 수익률과 같아야 한다.
  // (2X 는 계수 2, -2X 는 6 으로 둘 다 양수이므로 부호는 항상 r 을 따른다.)
  for (const s of Object.values(E.stockDaily)) {
    assert.ok(s.series.length > 10, `${s.name} 일별 계열이 너무 짧다`);
    for (const r of s.series) {
      if (Math.abs(r.ret) < 1e-9 || Math.abs(r.flowJo) < 1e-9) continue;
      assert.ok(Math.sign(r.flowJo) === Math.sign(r.ret),
        `${s.name} ${r.d} 리밸 부호가 수익률과 다르다 (${r.flowJo} vs ${r.ret})`);
      if (r.flowPctTurnover != null) assert.ok(r.flowPctTurnover >= 0, '거래대금 대비가 음수다');
    }
    assert.ok(s.funds.length > 0, `${s.name} 에 연결된 ETF 가 없다`);
  }

  // 좌수 추이(매일 보는 지표). 판정이 실제 변화율과 어긋나면 안 된다.
  for (const [k, u] of Object.entries(E.unitsTrend ?? {})) {
    if (!u) continue;
    const ds = u.series.map(r => r.d);
    assert.deepEqual(ds, [...ds].sort(), `${k} 좌수 계열이 정렬돼 있지 않다`);
    assert.equal(new Set(ds).size, ds.length, `${k} 좌수 계열에 중복 날짜가 있다`);
    assert.ok(u.peak.unitsM >= u.last.unitsM - 1e-6, `${k} 최대 좌수가 최신보다 작다`);
    assert.ok(u.fromPeakPct <= 1e-6, `${k} 고점 대비가 양수다`);
    assert.ok(u.downStreak >= 0 && u.downStreak < u.series.length, `${k} 연속 감소일이 범위 밖`);
    const expect = u.d5 == null ? 'unknown' : u.d5 > 1 ? 'building' : u.d5 < -1 ? 'rolling' : 'flat';
    assert.equal(u.verdict, expect, `${k} 판정이 5일 변화율과 어긋난다 (${u.d5})`);
  }

  // 지수 기여는 산술 분해라, 두 종목 몫이 지수 등락을 넘어서면 계산이 틀린 것이다.
  // (다만 다른 종목이 반대로 움직이면 100% 를 넘을 수 있어 상한은 크게 잡는다.)
  for (const r of E.indexContrib) {
    if (r.sharePct == null) continue;
    assert.ok(Math.abs(r.sharePct) < 1000, `${r.d} 지수 기여 몫이 비정상: ${r.sharePct}`);
  }

  // §23.6 홍콩 CSOP: NAV(1좌) x 좌수 = 총순자산 이어야 한다. API 가 이름 규칙으로 조회하는
  // 구조라, 상품 개명 등으로 응답이 어긋나면 이 항등식이 먼저 깨진다.
  for (const p of E.hk?.products ?? []) {
    assert.ok(p.outstandingUnits > 0 && p.totalNavUsd > 0, `${p.ticker} 좌수/AUM 이 0 이하`);
    if (p.navPerUnitUsd) {
      near(p.navPerUnitUsd * p.outstandingUnits / p.totalNavUsd, 1, 0.02, `${p.ticker} NAV×좌수 vs AUM`);
    }
    // 명목 익스포저 부호는 배수 부호를 따른다(레버리지 +, 인버스 -).
    if (Number.isFinite(p.notionalUsd) && p.notionalUsd !== 0) {
      assert.ok(Math.sign(p.notionalUsd) === Math.sign(p.lev), `${p.ticker} 명목 익스포저 부호가 배수와 다르다`);
    }
    // 좌수 히스토리(SDW 백필 + CSOP 일별): 정렬·중복·양수. 기준 혼합(§23.6)은 허용하되 순서는 지켜야 한다.
    const ds = (p.series ?? []).map(r => r.d);
    assert.deepEqual(ds, [...ds].sort(), `${p.ticker} 좌수 계열이 정렬돼 있지 않다`);
    assert.equal(new Set(ds).size, ds.length, `${p.ticker} 좌수 계열에 중복 날짜가 있다`);
    for (const r of p.series ?? []) assert.ok(r.unitsM > 0, `${p.ticker} ${r.d} 좌수가 0 이하`);
  }
}

// §24 다음 주 수급 전망(PART 4)
if (A.outlook) {
  const O = A.outlook;

  // 시나리오는 대칭이어야 한다 — 같은 크기의 상승·하락에 같은 크기의 반대 부호 물량.
  for (const s of O.scenarios) {
    const mirror = O.scenarios.find(x => x.retPct === -s.retPct);
    if (!mirror) continue;
    near(s.flowJo, -mirror.flowJo, 1e-6, `시나리오 ${s.retPct}% 대칭성`);
    assert.ok(Math.sign(s.flowJo) === Math.sign(s.retPct) || s.flowJo === 0,
      `시나리오 ${s.retPct}% 부호가 뒤집혔다`);
  }

  // 사다리 거리: 문턱은 현재 지수보다 아래여야 하고(gap 음수), 누적은 단조 증가여야 한다.
  for (let i = 0; i < O.ladder.length; i++) {
    const r = O.ladder[i];
    if (r.gapPct != null) assert.ok(r.gapPct < 0, `사다리 문턱 ${r.threshold} 이 현재 지수 위에 있다`);
    if (i > 0) assert.ok(r.cumulativeJo >= O.ladder[i - 1].cumulativeJo, '사다리 누적이 줄었다');
  }

  // base rate 는 분위수 순서와 확률 범위가 지켜져야 한다.
  for (const b of O.baseRates) {
    assert.ok(b.n >= 0, `${b.key} 표본 수가 음수다`);
    if (!b.n) continue;
    assert.ok(b.p25 <= b.median && b.median <= b.p75, `${b.key} 분위수 순서가 깨졌다`);
    assert.ok(b.min <= b.p25 && b.p75 <= b.max, `${b.key} 최소/최대가 분위수 밖에 없다`);
    assert.ok(b.upRate >= 0 && b.upRate <= 100, `${b.key} 상승확률 범위 밖: ${b.upRate}`);
  }
  // 기준선은 전 구간이라 표본이 가장 커야 한다 — 조건부가 더 크면 조건이 안 걸린 것이다.
  const all = O.baseRates.find(b => b.key === 'all');
  if (all) for (const b of O.baseRates) assert.ok(b.n <= all.n, `${b.key} 표본이 전 구간보다 크다`);
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

// 워크플로 YAML: 한 줄 `run:` 안의 ': '(콜론+공백)은 YAML 이 키 구분자로 읽어
// 워크플로 전체를 파싱 실패시킨다. 실제로 두 번 당했다. 블록 스칼라(|)를 쓰면 안전하다.
const wfDir = path.join(import.meta.dirname, '..', '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  for (const f of fs.readdirSync(wfDir).filter(n => /\.ya?ml$/.test(n))) {
    fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n').forEach((line, i) => {
      const m = /^\s+(run|name|if):\s+([^|>].*)$/.exec(line);
      assert.ok(!(m && /:\s/.test(m[2])), `${f}:${i + 1} 한 줄 ${m?.[1]}: 안에 ': ' 가 있다 — 블록 스칼라(|)로 바꿀 것`);
    });
  }
}

// 예탁금 대비 신용융자(§28). 커버리지의 역수라 둘이 어긋나면 둘 중 하나가 틀린 것이다.
if (A.channels?.creditToDeposit) {
  const CD = A.channels.creditToDeposit;
  near(CD.last.ratio, (CD.last.creditJo / CD.last.depositJo) * 100, 1e-6, '신용/예탁금');
  near(CD.last.ratio, 100 / A.channels.last.coverage, 1e-6, '커버리지의 역수와 불일치');
  assert.ok(CD.high.ratio >= CD.last.ratio, '역대 최고가 현재보다 낮다');
  assert.ok(CD.low.ratio <= CD.last.ratio, '역대 최저가 현재보다 높다');
  assert.ok(CD.pct >= 0 && CD.pct <= 100, `백분위 범위 밖: ${CD.pct}`);
  for (const [k, v] of Object.entries(CD.normal)) {
    assert.ok(v > 0 && v < 100, `정상 기준선 ${k} 가 범위 밖이다: ${v}`);
  }
  if (CD.total) {
    // 총 레버리지는 신용을 포함하므로 언제나 신용 단독보다 크거나 같아야 한다.
    assert.ok(CD.total.last.ratio >= CD.last.ratio,
      `총 레버리지 비율(${CD.total.last.ratio})이 신용 단독(${CD.last.ratio})보다 작다`);
    assert.equal(CD.divergesFromTotal,
      CD.last.ratio < CD.peakMonthHigh.ratio && CD.total.last.ratio > CD.total.peakMonthHigh.totRatio,
      '역전 판정이 값과 어긋난다');
  }
}

// 해외 반도체 공매도(§34). 거래량 비중과 잔고를 섞지 않았는지, 값이 범위 안인지 본다.
if (A.globalSemis) {
  const G = A.globalSemis;
  assert.ok(G.items.length >= 5, `해외 반도체 종목이 ${G.items.length}개뿐이다`);
  for (const it of G.items) {
    assert.ok(it.last.pct > 0 && it.last.pct <= 100, `${it.s}: 공매도 비중 범위 밖 ${it.last.pct}`);
    assert.ok(it.avg20 == null || (it.avg20 > 0 && it.avg20 <= 100), `${it.s}: 20일 평균 범위 밖`);
    if (it.z != null && it.sd > 0) near(it.z, (it.last.pct - it.mean) / it.sd, 1e-6, `${it.s} z점수`);
    // 잔고는 월 2회라 없을 수 있다 — 있으면 양수여야 한다.
    assert.ok(it.shortQty == null || it.shortQty > 0, `${it.s}: 공매도 잔고가 0 이하다`);
  }
  // 잔고 정산일이 일별 최신일보다 뒤일 수는 없다.
  if (G.siDate) {
    assert.ok(G.siDate.replace(/-/g, '') <= G.to, `잔고 정산일(${G.siDate})이 일별 최신일(${G.to})보다 늦다`);
  }
}

// 국내/홍콩 분해(§33.1). 단위를 틀리기 쉬운 자리라 범위로 잡아 둔다 —
// 실제로 marketSum 을 백만원으로 읽어 ETF 시총이 4.5조로 나온 적이 있다(정답은 억원, 445조).
if (A.etf?.split) {
  const SP = A.etf.split;
  for (const g of SP.domSingle) {
    assert.ok(g.expoJo >= g.aumJo - 1e-9, `${g.group}: 익스포저가 AUM 보다 작다`);
  }
  for (const p2 of SP.hk) {
    assert.ok(p2.aumJo == null || p2.aumJo >= 0, `홍콩 ${p2.ticker}: AUM 이 음수다`);
    assert.ok(['삼성전자', 'SK하이닉스', '기타'].includes(p2.underlying), `홍콩 ${p2.ticker}: 기초자산 분류 실패`);
  }
  if (SP.etfMarket) {
    assert.ok(SP.etfMarket.capJo > 100 && SP.etfMarket.capJo < 2000,
      `ETF 시총이 범위 밖이다(${SP.etfMarket.capJo}조) — marketSum 단위(억원) 확인할 것`);
    assert.ok(SP.etfMarket.valJo > 0 && SP.etfMarket.valJo < 200,
      `ETF 거래대금이 범위 밖이다(${SP.etfMarket.valJo}조) — amonut 단위(백만원) 확인할 것`);
    assert.ok(SP.singlePctOfEtfMarket > 0 && SP.singlePctOfEtfMarket < 100,
      `단일종목 거래대금 비중 범위 밖: ${SP.singlePctOfEtfMarket}`);
  }
}

// 마진콜 스트레스와 AUM 분해, 외인 지분율 밴드(§31).
if (A.marginStress) {
  const M = A.marginStress;
  near(M.last.ratio, (M.last.callJo / M.last.recvJo) * 100, 1e-6, '마진콜 비율');
  assert.ok(M.pct >= 0 && M.pct <= 100, `백분위 범위 밖: ${M.pct}`);
  assert.ok(M.peak.ma5 >= M.last.ma5 || M.peak.d === M.last.d, '최근 고점이 현재보다 낮다');
  assert.ok(M.series.length > 100, `마진콜 차트 표본 부족: ${M.series.length}`);
}
if (A.etf?.breakdown) {
  const B = A.etf.breakdown;
  for (const r of B.series) {
    // 항등식: AUM = (시작규모 + 누적 유출입) + 가격 기여분
    near(r.aum, r.flowCum + r.priceCum, 1e-6, `${r.d} AUM 분해 항등식`);
  }
  assert.ok(B.peak.aum >= B.last.aum, 'AUM 고점이 현재보다 작다');
  if (B.priceShareOfDrop != null && B.flowShareOfDrop != null) {
    near(B.priceShareOfDrop + B.flowShareOfDrop, 100, 1e-6, '가격+자금 기여분 합계');
  }
}
for (const it of A.stockFlow?.items ?? []) {
  const B = it.foreignBand;
  if (!B) continue;
  assert.ok(B.sd > 0, `${it.name}: 표준편차가 0 이하다`);
  near(B.z, (it.foreign.last.foreignPct - B.mean) / B.sd, 1e-6, `${it.name} z점수`);
  near(B.hi1 - B.mean, B.sd, 1e-9, `${it.name} +1σ`);
}

// 투자자별 순매수(§27). 소스가 20거래일 창만 주므로 누적이 끊기지 않았는지,
// 그리고 합계·판정이 계열과 어긋나지 않는지 본다.
if (A.investorFlow) {
  const V = A.investorFlow;
  assert.ok(V.items.length > 5, `투자자 계열이 ${V.items.length}종목뿐이다`);
  for (const x of V.items) {
    near(x.individual, x.series.reduce((s, r) => s + r.i, 0), 1e-6, `${x.name} 개인 합계`);
    assert.equal(x.buyDays + x.sellDays <= x.days, true, `${x.name} 매수일+매도일이 관측일을 넘는다`);
    assert.ok(x.series.length === x.days, `${x.name} 계열 길이 불일치`);
    const ds = x.series.map(r => r.d);
    assert.deepEqual(ds, [...ds].sort(), `${x.name} 날짜가 정렬돼 있지 않다`);
    assert.equal(new Set(ds).size, ds.length, `${x.name} 날짜 중복`);
  }
  assert.equal(V.summary.netBuyers, V.items.filter(x => x.individual > 0).length, '순매수 종목 수 불일치');
  assert.equal(V.summary.verdict,
    V.summary.netBuyers > V.items.length / 2 ? 'averaging-down' : 'capitulating', '판정이 집계와 어긋난다');
}

// 대차잔고 주수 분해(§16.4.1). 금액만 보고 "되갚아졌다" 고 읽던 실수를 다시 하지 않게,
// 분해 항등식(Δln금액 = Δln주수 + Δln단가)이 성립하는지 검사한다.
if (A.lending?.cover?.shares) {
  const S = A.lending.cover.shares;
  const dm = Math.log(1 + S.moneyDeclinePct / 100);
  const ds = Math.log(1 + S.sharesSinceMoneyPeakPct / 100);
  near(S.priceShareOfMoveePct, ((dm - ds) / dm) * 100, 1e-6, '가격 기여분');
  assert.ok(S.peakShares >= S.nowShares, '주수 고점이 현재보다 작다');
  assert.ok(S.troughShares <= S.nowShares, '주수 최저가 현재보다 크다');
  assert.ok(S.troughDate >= S.peakDate, '주수 최저가 고점보다 앞선다');
  near(S.fromTroughPct, (S.nowShares / S.troughShares - 1) * 100, 1e-6, '최저 대비 재증가');
  near(S.fromPeakPct, (S.nowShares / S.peakShares - 1) * 100, 1e-6, '고점 대비');
  assert.ok(S.series.length > 20, `주수 차트 포인트가 ${S.series.length}개뿐이다`);
}

// 종목별 대차잔고·외국인 지분율. 원본 잔고금액(백만원)과 주수 × 종가가 어긋나면
// 소스가 스케일이나 컬럼 의미를 바꾼 것이다 — 그때 조용히 10배 틀린 숫자를 싣지 않게 막는다.
if (A.stockFlow) {
  const raw = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, '..', 'data', 'stock-flows.json'), 'utf8'));
  for (const st of raw.stocks) {
    const cmp = st.series.filter(r => r.close && r.balanceMil && r.balanceShares);
    assert.ok(cmp.length > 100, `${st.name}: 교차검증할 행이 ${cmp.length}개뿐이다`);
    for (const r of cmp) {
      const rel = Math.abs((r.balanceShares * r.close) / 1e6 - r.balanceMil) / r.balanceMil;
      assert.ok(rel < 0.01,
        `${st.name} ${r.d}: 잔고금액이 주수×종가와 ${(rel * 100).toFixed(1)}% 어긋난다 — 소스 단위가 바뀌었는지 확인할 것`);
    }
  }
  for (const it of A.stockFlow.items) {
    assert.ok(it.listedShares > 0, `${it.name}: 상장주식수가 없다`);
    assert.ok(it.peak.shares >= it.last.shares, `${it.name}: 고점이 현재보다 작다`);
    assert.ok(it.last.pctListed > 0 && it.last.pctListed < 20,
      `${it.name}: 상장주식수 대비 ${it.last.pctListed}% — 범위 밖이다`);
    if (it.foreign) {
      assert.ok(it.foreign.fromLowPp >= 0, `${it.name}: 저점 대비 회복이 음수다`);
      assert.ok(it.foreign.high.foreignPct >= it.foreign.last.foreignPct,
        `${it.name}: 외국인 최고가 현재보다 낮다`);
    }
  }
}

// 시장별 되돌림 진척. 표에 그대로 나가는 숫자라 자기모순이 없어야 한다.
if (A.meta.hasSplit) {
  assert.ok(A.divergence, '분리 데이터가 있는데 divergence 가 없다');
  assert.equal(A.divergence.items.length, 2, 'divergence 는 유가증권·코스닥 둘이어야 한다');
  for (const it of A.divergence.items) {
    near(it.builtJo, it.peakJo - it.startJo, 1e-6, `${it.market} builtJo`);
    near(it.retracedJo, it.peakJo - it.lastJo, 1e-6, `${it.market} retracedJo`);
    near(it.retracedPctOfBuild, (it.retracedJo / it.builtJo) * 100, 1e-6, `${it.market} 되돌림%`);
    assert.ok(it.peakJo >= it.lastJo, `${it.market}: 현재 잔고가 고점보다 크다`);
    for (const k of ['now', 'prevPeak', 'prevTrough']) {
      const r = it[k];
      assert.ok(r, `${it.market}.${k} 비율이 비어 있다`);
      near(r.ratio, (r.creditJo / r.mcapJo) * 100, 1e-6, `${it.market}.${k} 비율`);
    }
    assert.ok(it.toPrevTroughJo >= 0, `${it.market}: 남은 여지가 음수다`);
    // 저점 비율 아래면 더 풀릴 여지가 0, 위면 양수여야 한다 — 판정과 금액이 어긋나면 안 된다.
    assert.equal(it.ratioVsPrevTrough <= 1, it.toPrevTroughJo === 0,
      `${it.market}: 저점 대비 ${it.ratioVsPrevTrough}배인데 여지가 ${it.toPrevTroughJo}조다`);
    assert.equal(A.divergence.doneMarkets.includes(it.market), it.ratioVsPrevTrough <= 1,
      `${it.market}: 완료 판정이 비율과 어긋난다`);
  }
}

// 차트 라벨 배치(lib/labels.mjs). 예탁금 커버리지 차트에서 '26 고점'과 '현재'가 한 달 차이라
// 라벨이 같은 자리에 겹쳐 찍혔고, 맨 오른쪽 라벨은 절반이 뷰박스 밖으로 잘렸다. 둘 다 여기서 막는다.
{
  const W = 660, minY = 22;
  const placed = placeLabels([
    { cx: 640, cy: 113, text: '2026 고점 3.53배' },
    { cx: 644, cy: 120, text: '현재 3.25배' },      // 위와 4px 차이 — 예전엔 그대로 겹쳤다
    { cx: 468, cy: 132, text: '2021 고점 2.74배' },
  ], { W, minY });
  for (const p of placed) {
    assert.ok(p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= W, `라벨이 뷰박스 밖이다: ${p.text}`);
    assert.ok(p.y > minY, `라벨이 차트 위로 넘쳤다: ${p.text}`);
  }
  for (const [a, b] of placed.flatMap((x, i) => placed.slice(i + 1).map(y => [x, y]))) {
    const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < 13;   // 실측 글자 높이 12.27
    assert.ok(!overlap, `라벨이 겹친다: "${a.text}" vs "${b.text}"`);
  }
}

// 오늘의 종합 판정(§35). 이건 페이지 맨 위에 결론으로 나가는 값이라 본문 숫자와
// 어긋나면 리포트 전체의 신뢰가 무너진다. 그래서 값이 아니라 **본문 필드와의 일치**를 검사한다.
if (A.verdict) {
  const V = A.verdict;
  const by = k => V.signals.find(s => s.key === k);
  assert.ok(V.signals.length >= 8, `판정 지표가 ${V.signals.length}개뿐이다 — 소스가 빠졌다`);
  assert.equal(new Set(V.signals.map(s => s.key)).size, V.signals.length, '판정 지표 key 가 중복된다');
  for (const s of V.signals) {
    assert.ok(['ok', 'watch', 'alert'].includes(s.state), `알 수 없는 판정 상태: ${s.state}`);
    assert.ok(s.why && s.why.length > 30, `${s.key}: 근거가 비어 있다 — 판정만 있고 근거가 없으면 안 된다`);
    assert.ok(!/undefined|NaN|null/.test(`${s.value}${s.why}`), `${s.key}: 문장에 미계산 값이 들어갔다 — ${s.value} / ${s.why}`);
  }
  assert.ok(!/undefined|NaN/.test(V.headline), `한 줄 판정에 미계산 값이 있다: ${V.headline}`);

  // 점수는 상태의 집계여야 한다 — 손으로 쓴 숫자가 아니다.
  const sc = V.signals.reduce((t, s) => t + (s.state === 'ok' ? 1 : s.state === 'alert' ? -1 : 0), 0);
  assert.equal(V.total, sc, '판정 총점이 지표 상태 합과 다르다');
  near(V.norm, V.total / V.signals.length, 1e-9, '판정 정규화 점수');
  assert.equal(V.axes.reduce((t, a) => t + a.n, 0), V.signals.length, '축별 지표 수 합이 전체와 다르다');

  // 각 판정이 본문의 같은 필드에서 나왔는지. 여기가 어긋나면 요약과 본문이 서로 다른 말을 한다.
  const cr = by('creditRatio');
  if (cr) assert.equal(cr.state === 'ok', A.projection.currentRatio.ratio < A.projection.prevTroughRatio.ratio,
    '신용/시총 판정이 projection 값과 어긋난다');
  const cd = by('creditDeposit');
  if (cd) assert.equal(cd.state === 'ok', A.channels.creditToDeposit.last.ratio < A.channels.creditToDeposit.normal.y3,
    '예탁금 대비 신용융자 판정이 channels 값과 어긋난다');
  const sr = by('shortRatio');
  if (sr) assert.equal(sr.state === 'ok', A.lending.cover.nowRatio < A.lending.cover.prevTroughRatio,
    '대차/시총 판정이 lending 값과 어긋난다');
  const eu = by('etfUnits');
  if (eu) assert.equal(eu.state === 'ok', A.etf.unitsTrend.single.verdict === 'rolling',
    '좌수 판정이 §23.7 판정과 어긋난다');
  const dv = by('divergence');
  if (dv) assert.ok(dv.value.includes(String(Math.round(A.divergence.items.find(x => x.market === '유가증권').retracedPctOfBuild))),
    '시장별 되돌림 판정 값이 divergence 와 어긋난다');

  // '오늘 움직인 것'은 전일 대비에서만 나와야 한다 — 임의로 고른 숫자를 올리지 않는다.
  for (const m of V.moves) {
    assert.ok((A.daily?.items ?? []).some(d => d.label === m.label && d.value === m.value),
      `오늘 움직인 것에 daily 에 없는 항목이 있다: ${m.label}`);
  }
}

console.log(`selfcheck OK — ${A.series.length}행, 재현 MAE ${A.reproMAE.toFixed(3)}조, `
  + `사이클 ${A.periods.length}개, 채널 ${A.channels ? 'O' : 'X'}, 미수금 ${A.unpaid ? 'O' : 'X'}, `
  + `ETF ${A.etf ? `O(${A.etf.perFund.length}종)` : 'X'}`);
