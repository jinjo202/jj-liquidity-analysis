// 홍콩 CSOP 좌수 히스토리를 HKEXnews CCASS 조회(SDW)에서 백필한다.
//
// 왜 여기인가(§23.6): CSOP API 는 최신값만 준다. 그런데 홍콩 상장 종목은 HKEXnews 의
// CCASS Shareholding Search 가 과거 12개월까지 날짜별 조회를 열어 둔다. 응답 요약 블록의
// "Total number of Issued Shares/Warrants/Units" 가 그 날짜 기준 발행좌수(등록기관 기준)다.
//
// 기준이 셋이라는 것을 알고 써야 한다(7/31 실측):
//   등록기관 발행좌수 829M  ≤  CSOP 신고좌수(딜링일 기준) 984M  ≤  CCASS 보유총량 1,048M
// 창출·환매가 T+2 로 결제되는 동안 세 값이 벌어진다. 평시엔 1% 안쪽으로 붙는다(6/16: 707.5 vs 717).
// 백필 행은 발행좌수를 units 로 쓰고 src:'hkex-sdw' 를 남긴다 — CSOP 행(src 없음)과 구분된다.
//
// 사용법: node scripts/backfill-csop-units.mjs [시작일 YYYYMMDD]
//   기본 시작일은 7709 상장일(20251016). 이미 있는 날짜는 건너뛰므로 갭 패치용으로 재실행해도 된다.
//   워크플로에는 넣지 않는다 — 하루 ~600 요청을 매일 반복할 이유가 없다. 일상 갱신은 fetch-csop.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const URL = 'https://www3.hkexnews.hk/sdw/search/searchsdw.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const START = process.argv[2] ?? '20251016';
// 배열이다 — 객체를 쓰면 JS 가 숫자 키를 오름차순으로 돌려 7347 이 먼저 온다. 중요한 7709 부터.
const CODES = [['7709', '07709'], ['7747', '07747'], ['7347', '07347']];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 세션 ---------- */
let jar = [];
const absorb = res => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    jar = jar.filter(x => x.split('=')[0] !== kv.split('=')[0]);
    jar.push(kv);
  }
};
let tokens = null;
async function refreshSession() {
  const res = await fetch(URL, { headers: { 'User-Agent': UA } });
  absorb(res);
  const html = await res.text();
  const t = n => (html.match(new RegExp(`id="${n}" value="([^"]*)"`)) ?? [])[1] ?? '';
  tokens = { vs: t('__VIEWSTATE'), vsg: t('__VIEWSTATEGENERATOR') };
  if (!tokens.vs) throw new Error('SDW 폼 토큰을 못 읽었다 — 페이지 구조가 바뀐 듯');
}

/* ---------- 조회 ---------- */
const num = s => {
  const n = Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function query(dateSlash, code) {
  const body = new URLSearchParams({
    __EVENTTARGET: 'btnSearch', __EVENTARGUMENT: '',
    __VIEWSTATE: tokens.vs, __VIEWSTATEGENERATOR: tokens.vsg,
    today: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    sortBy: 'shareholding', sortDirection: 'desc', alertMsg: '',
    txtShareholdingDate: dateSlash, txtStockCode: code,
    txtStockName: '', txtParticipantID: '', txtParticipantName: '', txtSelPartID: '',
  });
  const res = await fetch(URL, {
    method: 'POST', body,
    headers: { 'User-Agent': UA, Cookie: jar.join('; '),
      'Content-Type': 'application/x-www-form-urlencoded', Referer: URL, Origin: 'https://www3.hkexnews.hk' },
  });
  absorb(res);
  const html = await res.text();

  // 서버가 날짜를 조정했으면(휴장일) 요청일과 다르게 돌아온다 — 그 응답은 버린다.
  const shown = (html.match(/name="txtShareholdingDate"[^>]*value="([^"]*)"/) ?? [])[1];
  if (shown !== dateSlash) return { skipped: 'date-adjusted' };

  const issued = num((html.match(/summary-value">([\d,]+)</) ?? [])[1]);
  // 카테고리 행(Market Intermediaries 등)의 보유량 합 = CCASS 보유총량
  let ccass = 0;
  for (const m of html.matchAll(/summary-category">([^<]+)<[\s\S]{0,400}?Shareholding in CCASS\s*<\/div>\s*<div class="value">([\d,]+)</g)) {
    ccass += num(m[2]) ?? 0;
  }
  return { issued, ccass: ccass || null };
}

/* ---------- 날짜 순회 ---------- */
const dailyPath = path.join(DIR, 'csop-daily.json');
const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
// 600 요청짜리 크롤이다. 끝에서 한 번만 쓰면 도중에 죽었을 때 전부 날아간다(실제로 한 번 날렸다).
// 25행마다 저장한다 — 이미 있는 날짜는 건너뛰므로 죽어도 재실행하면 이어서 간다.
const save = () => {
  daily.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(dailyPath, JSON.stringify(daily, null, 1));
};
const today = new Date();
const dates = [];
for (let d = new Date(`${START.slice(0, 4)}-${START.slice(4, 6)}-${START.slice(6, 8)}T00:00:00Z`);
  d < today; d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;          // 주말
  dates.push(d.toISOString().slice(0, 10));
}
console.log(`${START} 부터 평일 ${dates.length}일 × ${Object.keys(CODES).length}종목 조회`);

await refreshSession();
let added = 0, calls = 0;
for (const [ticker, code] of CODES) {
  const entry = daily.products.find(p => p.ticker === ticker);
  if (!entry) { console.log(`${ticker}: csop-daily.json 에 항목이 없다 — fetch-csop.mjs 먼저`); continue; }
  const have = new Set(entry.series.map(r => r.d));
  let got = 0;

  for (const iso of dates) {
    const ymd = iso.replace(/-/g, '');
    if (have.has(ymd)) continue;
    const r = await query(iso.replace(/-/g, '/'), code);
    calls++;
    if (calls % 120 === 0) await refreshSession();   // 토큰 만료 대비
    if (!r.skipped && r.issued) {
      entry.series.push({ d: ymd, units: r.issued, ccassUnits: r.ccass, src: 'hkex-sdw' });
      added++; got++;
      if (got % 25 === 0) {
        entry.series.sort((a, b) => a.d.localeCompare(b.d));
        save();
        console.log(`  ${ticker}: ${got}일 수집·저장 (최근 ${ymd} 발행 ${(r.issued / 1e6).toFixed(0)}M)`);
      }
    }
    await sleep(150);
  }
  entry.series.sort((a, b) => a.d.localeCompare(b.d));
  save();
  console.log(`${ticker}: +${got}일 (총 ${entry.series.length}일)`);
}

const MARK = '상장~20260801 구간은 HKEXnews CCASS(SDW) 발행좌수로 백필(src:hkex-sdw)';
if (!(daily.note ?? '').includes(MARK)) {
  daily.note = (daily.note ?? '') + ` ${MARK} — 등록기관 기준이라 CSOP 딜링일 기준과 T+2 창에서 어긋날 수 있다(§23.6).`;
}
save();
console.log(`\ncsop-daily.json 갱신 — ${added}행 추가, 요청 ${calls}회`);
