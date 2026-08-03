// 투자자별 순매수(개인/기관/외국인)를 종목·ETF 단위로 받는다.
//
// 왜 필요한가: 좌수가 늘었다는 것만으로는 "누가 사서 늘렸는지" 를 모른다(§27).
// 개인이 팔았는데 기관이 받아 좌수가 그대로일 수도 있다. 항복 판정은 이 조각이 있어야 선다.
//
// 소스 선정 기록(2026-08-03):
//   KRX 정보데이터시스템 — 개인을 직접 주지만 로그인이 필요하다(KRX Data Marketplace). 익명 요청은 400 LOGOUT.
//   네이버 item/frgn, 다음 investor/days — 기관·외국인만 준다. 개인은 없다.
//   ★ 네이버 모바일 m.stock.naver.com/api/stock/{code}/trend — individualPureBuyQuant 로
//     개인 순매수를 **직접** 준다. 개별주·ETF 모두 동작한다. 채택.
//
// ★ 결정적 제약: 이 API 는 page 파라미터를 무시하고 **최근 20거래일만** 준다
//   (page=1,2,3 이 전부 같은 20행. pageSize=100 은 실패). 그래서 과거는 못 만든다 —
//   매일 받아서 파일에 누적해야 히스토리가 생긴다. 홍콩 CSOP 좌수와 같은 방식이다.
//   워크플로에 넣어 두면 하루라도 거르지 않는 한 20일 창이 계속 이어진다.
//
// 사용법: node scripts/fetch-investor-flows.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const OUT = path.join(DIR, 'investor-flows.json');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => {
  const n = Number(String(s ?? '').replace(/[+,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ---------- 대상 구성 ---------- */
// 두 종목(주식)은 고정. ETF 는 etf-daily.json 의 유니버스에서 레버리지·인버스 계열을 따라간다 —
// 신규 상장이 계속 나오는 카테고리라 목록을 손으로 들고 있지 않는다.
const targets = [
  { code: '005930', name: '삼성전자', kind: 'stock' },
  { code: '000660', name: 'SK하이닉스', kind: 'stock' },
];
const etfPath = path.join(DIR, 'etf-daily.json');
if (fs.existsSync(etfPath)) {
  const E = JSON.parse(fs.readFileSync(etfPath, 'utf8'));
  for (const u of E.universe ?? []) {
    if (!['single_lev', 'single_inv', 'index_lev'].includes(u.group)) continue;
    targets.push({ code: u.code, name: u.name, kind: 'etf', group: u.group });
  }
}

/* ---------- 조회 ---------- */
async function fetchTrend(code) {
  const url = `https://m.stock.naver.com/api/stock/${code}/trend?pageSize=20&page=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://m.stock.naver.com/domestic/stock/${code}/trend`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('배열이 아니다');
  return rows
    .filter(r => /^\d{8}$/.test(String(r.bizdate)))
    .map(r => ({
      d: String(r.bizdate),
      individual: num(r.individualPureBuyQuant),
      foreign: num(r.foreignerPureBuyQuant),
      institution: num(r.organPureBuyQuant),
      close: num(r.closePrice),
    }))
    .filter(r => r.individual != null)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* ---------- 누적 ---------- */
// 20일 창만 오므로 기존 파일과 병합한다. 같은 날짜는 새 값으로 덮는다(장중 조회분 보정).
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { items: [] };
const prevByCode = new Map((prev.items ?? []).map(x => [x.code, x]));

const out = { meta: {
  source: '네이버 모바일 m.stock.naver.com/api/stock/{code}/trend (individualPureBuyQuant). 최근 20거래일만 오므로 매일 받아 누적한다(§27).',
  unit: '순매수 수량(주). 금액이 아니라서 종목 간 직접 비교는 할 수 없다.',
  fetchedAt: new Date().toISOString().slice(0, 10),
}, items: [] };

let added = 0, failed = [];
for (const t of targets) {
  try {
    const fresh = await fetchTrend(t.code);
    const merged = new Map((prevByCode.get(t.code)?.series ?? []).map(r => [r.d, r]));
    const before = merged.size;
    for (const r of fresh) merged.set(r.d, r);
    added += merged.size - before;
    out.items.push({
      ...t,
      series: [...merged.values()].sort((a, b) => a.d.localeCompare(b.d)),
    });
  } catch (e) {
    failed.push(`${t.name}(${e.message})`);
    const old = prevByCode.get(t.code);
    if (old) out.items.push(old);          // 실패하면 어제 것을 그대로 남긴다
  }
  await sleep(200);
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const span = out.items[0]?.series ?? [];
console.log(`investor-flows.json — ${out.items.length}종목, 신규 ${added}행`
  + (span.length ? `, 기간 ${span[0].d}~${span.at(-1).d}` : ''));
if (failed.length) {
  console.log(`실패: ${failed.join(', ')}`);
  process.exitCode = 1;
}
