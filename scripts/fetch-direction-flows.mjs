// 시장 전체 투자자별 순매수 — 코스피/코스닥 현물(억원) + KOSPI200 선물(계약).
//
// 왜 필요한가: 지금까지의 리포트는 전부 '잔고'(신용·대차·좌수)를 본다. 잔고는 부담의
// 크기를 재지만 **방향**은 못 잰다. 외국인이 현물과 선물을 같은 쪽으로 밀고 있는지가
// 단기 방향의 가장 고전적인 수급 신호다 — 그 조각이 이 파일이다.
//
// 소스 선정 기록(2026-08-14):
//   ★ 원래 목표는 옵션이었다 — 풋/콜 비율·VKOSPI. 그런데:
//     KRX 정보데이터시스템(data.krx.co.kr) — 익명 POST 가 전부 LOGOUT. 세션 쿠키를 받아도 같다.
//     KRX Open API — 무료지만 키 발급(로그인)이 필요하다. 자동 파이프라인에 남의 계정을
//       넣지 않는다는 원칙(§27 의 KRX 항목과 같은 이유)으로 제외.
//     네이버 옵션 투자자별(sosok=04/05) — 표 구조만 있고 행이 비어 있다. 중단된 것으로 보인다.
//   ★ 대신 같은 질문("방향에 누가 베팅하나")을 주는 살아 있는 소스:
//     네이버 investorDealTrendDay.naver — 코스피(01)/코스닥(02)/K200선물(03) 투자자별
//     일자별 순매수. 페이지당 10영업일, page 파라미터로 과거 백필이 된다(p5 에서 두 달 전 확인).
//
// 검증: 매 행이 zero-sum 이다 — 개인+외국인+기관계+기타법인 = 0 (누군가 사면 누군가 판다).
//   파싱이 어긋나면 이 합이 깨지므로 그대로 불변식으로 쓴다.
//
// 사용법: node scripts/fetch-direction-flows.mjs [페이지수]   (기본 3 = 최근 30영업일)
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'data');
const OUT = path.join(DIR, 'direction-flows.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGES = Number(process.argv[2] ?? 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARKETS = [
  { key: 'kospi', sosok: '01', name: '코스피 현물', unit: '억원' },
  { key: 'kosdaq', sosok: '02', name: '코스닥 현물', unit: '억원' },
  { key: 'futures', sosok: '03', name: 'KOSPI200 선물', unit: '계약' },
];

const num = s => {
  const n = Number(String(s ?? '').replace(/[+,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ---------- 한 페이지 파싱 ---------- */
// EUC-KR HTML. 태그를 걷어내면 '26.08.13' 뒤에 숫자 10개가 순서대로 나온다:
// 개인, 외국인, 기관계, (금융투자, 보험, 투신, 은행, 기타금융, 연기금), 기타법인.
// 기관 세부 6개는 쓰지 않는다 — 방향 신호에 필요한 건 4주체 합계 구도다.
async function fetchPage(sosok, bizdate, page) {
  const url = `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=${sosok}&page=${page}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
  const tokens = html.replace(/<[^>]*>/g, '|').split('|').map(t => t.trim()).filter(Boolean);

  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    if (!m) continue;
    const nums = tokens.slice(i + 1, i + 11).map(num);
    if (nums.length < 10 || nums.some(v => v == null)) continue;
    const [indiv, foreign, inst] = nums;
    const corp = nums[9];
    // zero-sum 불변식. 어긋나면 파싱이 밀린 것이므로 그 행은 버린다.
    if (Math.abs(indiv + foreign + inst + corp) > 2) continue;
    rows.push({ d: `20${m[1]}${m[2]}${m[3]}`, indiv, foreign, inst, corp });
    i += 10;
  }
  return rows;
}

/* ---------- 실행 ---------- */
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

const out = {
  meta: {
    what: '시장 전체 투자자별 일자별 순매수. 방향 수급(외국인 현·선물 동조)의 원천이다(§44).',
    source: '네이버 금융 investorDealTrendDay (코스피 01 / 코스닥 02 / K200선물 03)',
    units: { kospi: '억원', kosdaq: '억원', futures: '계약' },
    invariant: '매 행 개인+외국인+기관계+기타법인 = 0 (파싱 검증에도 쓴다)',
    fetchedAt: new Date().toISOString().slice(0, 10),
  },
};

let failed = [];
for (const mk of MARKETS) {
  const byDate = new Map((prev?.[mk.key] ?? []).map(r => [r.d, r]));
  const before = byDate.size;
  try {
    for (let p = 1; p <= PAGES; p++) {
      const rows = await fetchPage(mk.sosok, today, p);
      if (!rows.length) break;
      for (const r of rows) byDate.set(r.d, r);
      await sleep(150);
    }
  } catch (e) {
    failed.push(`${mk.name}(${e.message})`);
  }
  out[mk.key] = [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d));
  console.log(`  ${mk.name.padEnd(10)} ${out[mk.key].length}행 (신규 ${byDate.size - before})`
    + (out[mk.key].length ? `  ${out[mk.key][0].d}~${out[mk.key].at(-1).d}` : ''));
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`direction-flows.json 저장`);
if (failed.length) {
  console.log(`실패: ${failed.join(', ')}`);
  process.exitCode = 1;
}
