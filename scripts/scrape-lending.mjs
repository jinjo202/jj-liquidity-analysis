// FREESIS '대차거래추이'(STATSCU0100000140)를 헤드리스 브라우저로 받아온다.
//
// 왜 브라우저가 필요한가 (docs/methodology.md §16.2 에 전부 기록):
//   - 크로스통계 카탈로그 88개에 대차거래가 없다.
//   - 엑셀 다운로드는 서버 파일이 아니라, 이미 렌더된 HTML 표를 클라이언트가
//     excelexport.jsp 로 재직렬화하는 방식이라 때릴 엔드포인트가 없다.
//   - 실제 데이터는 CommSubmit/egovXbuilder.do 로 오는데 서비스별 MAPPER/QRY 값을
//     서버가 런타임에 앱으로 내려준다. 앱 정의 파일(/ui/app/*)은 WAF 가 막는다.
//   - eXBuilder6 SPA 는 document.hidden 이면 부팅하지 않는다. visibilityState 를
//     패치해도 안 되고 실제 페인트 프레임이 필요하다.
//   => 렌더가 유일한 경로다. 대신 렌더된 뒤에는 네트워크를 가로채 원본 응답을 그대로 쓴다.
//      DOM 셀렉터보다 응답 페이로드가 훨씬 덜 깨진다.
//
// 사용법:
//   npm i                                  # playwright 설치
//   npx playwright install chromium
//   node scripts/scrape-lending.mjs        # 헤드리스
//   node scripts/scrape-lending.mjs --headed --keep   # 눈으로 보며 디버그
//
// 실패해도 프로세스만 1로 끝난다. 파이프라인은 기존 data/lending-balance.json 으로 계속 간다.
// 실패 시 scratch/lending-debug/ 에 스크린샷·DOM·네트워크 덤프를 남긴다 — 그걸 보고 고친다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const DEBUG_DIR = path.join(ROOT, 'scratch', 'lending-debug');

const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const SERVICE_ID = 'STATSCU0100000140';
const PARENT_DIV = 'MSIS10040000000000';
const START = '2010-01-01';

const today = new Date();
const yyyymmdd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const END = yyyymmdd(today);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright 가 없다. 이 스크립트만 설치가 필요하다:');
  console.error('  npm i && npx playwright install chromium');
  process.exit(1);
}

fs.mkdirSync(DEBUG_DIR, { recursive: true });
const captures = [];

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
});
const page = await ctx.newPage();

// 데이터는 여기로 온다. 어떤 요청이 그리드를 채우는지 모르므로 전부 모은 뒤 골라낸다.
page.on('response', async res => {
  const url = res.url();
  if (!/egovXbuilder\.do|getMetaDataList\.do|crossStats/.test(url)) return;
  try {
    const body = await res.text();
    captures.push({ url, status: res.status(), len: body.length, body });
  } catch { /* 본문을 못 읽는 응답은 넘긴다 */ }
});

const fail = async (why, err) => {
  console.error(`실패: ${why}${err ? ` — ${err.message}` : ''}`);
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, 'screen.png'), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, 'dom.html'), await page.content());
    for (const f of page.frames()) {
      const name = (f.name() || 'anon').replace(/\W/g, '_');
      try { fs.writeFileSync(path.join(DEBUG_DIR, `frame-${name}.html`), await f.content()); } catch { /* 접근 불가 프레임 */ }
    }
    fs.writeFileSync(path.join(DEBUG_DIR, 'captures.json'),
      JSON.stringify(captures.map(c => ({ ...c, body: c.body.slice(0, 20000) })), null, 1));
    console.error(`디버그 덤프: ${DEBUG_DIR}`);
  } catch (e) { console.error('덤프도 실패:', e.message); }
  if (!KEEP) await browser.close();
  process.exit(1);
};

try {
  await page.goto('https://freesis.kofia.or.kr/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 프레임셋 구조다. 실제 앱은 name="main" 프레임에 있다.
  const main = await page.waitForFunction(() => window.frames.length > 0, null, { timeout: 30000 })
    .then(() => page.frames().find(f => f.name() === 'main') ?? page.frames()[1]);
  if (!main) await fail('main 프레임을 찾지 못했다');

  // 네비게이션은 POST 다. GET 에 쿼리스트링을 붙이면 WAF 가 막는다.
  await main.evaluate(([parent, svc]) => window.goPage(parent, svc), [PARENT_DIV, SERVICE_ID]);
  await page.waitForTimeout(3000);

  // eXBuilder 앱이 실제로 그려졌는지 확인한다. div 가 0 이면 부팅 실패다.
  const app = page.frames().find(f => /FreeSIS\.do/.test(f.url())) ?? main;
  const booted = await app.evaluate(() => ({
    divs: document.querySelectorAll('div').length,
    hidden: document.hidden,
    hasCpr: typeof window.cpr !== 'undefined',
  })).catch(() => null);
  console.log('부팅 상태:', JSON.stringify(booted));
  if (!booted?.divs) await fail('eXBuilder 앱이 렌더되지 않았다 (div 0)');

  // 앱이 뜨면 조회 조건을 세팅한다. 컨트롤 id 를 모르므로 라벨 텍스트로 접근한다.
  // 기본값이 이미 '일별 + 최근 구간'인 화면이 많아, 조회만 눌러도 데이터가 오는 경우가 있다.
  const clicked = await app.evaluate(async ([start, end]) => {
    const log = [];
    const texts = el => (el.textContent || el.value || '').trim();
    const all = [...document.querySelectorAll('button,a,input,select,div[role="button"]')];
    log.push('controls=' + all.length);

    // 날짜 입력이 있으면 채운다.
    const dateInputs = all.filter(el => el.tagName === 'INPUT'
      && /date|일자|기간/i.test(el.className + el.name + (el.getAttribute('aria-label') || '')));
    dateInputs.slice(0, 2).forEach((el, i) => {
      el.value = i === 0 ? start : end;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    log.push('dateInputs=' + dateInputs.length);

    const search = all.find(el => /^(조회|검색)$/.test(texts(el)));
    log.push('searchBtn=' + !!search);
    if (search) search.click();
    return log;
  }, [START, END]).catch(e => ['evaluate 실패: ' + e.message]);
  console.log('조회 시도:', clicked.join(' '));

  await page.waitForTimeout(8000);

  // 캡처한 응답 중 날짜열과 잔고로 보이는 큰 수가 함께 있는 것을 고른다.
  const looksLikeSeries = body => /20\d{6}|20\d{2}-\d{2}-\d{2}/.test(body) && body.length > 2000;
  const hit = captures.filter(c => c.status === 200 && looksLikeSeries(c.body))
    .sort((a, b) => b.len - a.len)[0];

  fs.writeFileSync(path.join(DEBUG_DIR, 'captures.json'),
    JSON.stringify(captures.map(c => ({ url: c.url, status: c.status, len: c.len, head: c.body.slice(0, 400) })), null, 1));

  if (!hit) await fail(`데이터로 보이는 응답을 못 찾았다 (캡처 ${captures.length}건)`);

  // 원본 응답을 그대로 남긴다. 파싱 규칙은 응답을 실제로 본 뒤에 맞춘다.
  const raw = path.join(DATA, 'lending-raw.json');
  fs.writeFileSync(raw, hit.body);
  console.log(`응답 저장: ${raw} (${(hit.len / 1024).toFixed(0)} KB)  from ${hit.url}`);
  console.log(`캡처 ${captures.length}건. 파싱 규칙을 맞추려면 ${DEBUG_DIR}/captures.json 을 볼 것.`);
} catch (e) {
  await fail('예외', e);
}

if (!KEEP) await browser.close();
