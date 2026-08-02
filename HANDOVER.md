# 인수인계서 — 코스피 유동성 분석 프로젝트

최종 갱신 2026-08-02. 계정/PC 를 바꿔 이어서 작업할 때 이 문서 하나로 시작할 수 있게 썼다.

## 0. ★ 중단된 작업 — "이어서해" 하면 여기부터

**홍콩 CSOP 좌수 히스토리 백필이 도중에 끊겼다** (2026-08-02, 계정 전환으로 중단).

```
상태: 7709 = 51/207일 (20251016..20260122 SDW 백필 + 20260731 CSOP)
      7747 = 1일 (20260731 만)   7347 = 1일 (20260731 만)
```

이어서 하는 법 — 클론 후 이 한 줄이면 된다(이미 있는 날짜는 건너뛰고 25행마다 저장하므로
몇 번을 끊고 재실행해도 안전하다). 완주까지 총 10~15분, 10분 타임아웃에 걸리면 그냥 또 실행:

```bash
node scripts/backfill-csop-units.mjs
```

끝나면(출력에 `csop-daily.json 갱신 — N행 추가`) 파이프라인 돌리고 커밋:

```bash
node scripts/analyze.mjs && node scripts/selfcheck.mjs && node scripts/build.mjs && node scripts/build-email.mjs && node scripts/status.mjs
git add -A && git commit -m "Backfill HK CSOP units history from HKEX SDW" && git push
```

리포트의 "7709 좌수 추이" 차트(PART 3 홍콩 절)와 표의 "좌수 5일/고점 대비" 컬럼은
히스토리가 차면 자동으로 나타난다 — 코드는 전부 커밋돼 있고 데이터만 마저 채우면 된다.
배경과 함정(세 가지 좌수 기준, 12개월 창)은 `docs/methodology.md` §23.6.

이미 확인된 데이터 하나: **7347(삼성 인버스) 좌수가 5M(2025-11) → 1,038M(2026-05-29) → 127M(현재)**.
5월 말까지 인버스가 200배 폭증했다가 붕괴했다 — 백필이 끝나면 이 서사가 차트로 나온다.

## 1. 이게 뭔가

증권사 유료 단말(Quantiwise) 기반 리서치를 공개 데이터만으로 재현하고, 반대 방향(숏커버)과
레버리지 ETF 수급까지 확장한 뒤, **완전 자동으로 매일 갱신·배포**되게 만든 프로젝트.

- 웹 리포트: **https://jj-liquidity-analysis.vercel.app**
- 상태 확인: **https://jj-liquidity-analysis.vercel.app/status.json** ← 뭐가 잘 도는지 여기서 먼저 본다
- 저장소: **https://github.com/devbotsender8282/jj-liquidity-analysis** (private)
- 방법론 전문: [`docs/methodology.md`](docs/methodology.md) §1~24 — 역설계 과정, 가정, 한계, 디버깅 기록 전부
- 별도 웹앱: [`my-project/`](my-project/HANDOFF.md) — Next.js + Supabase 대시보드(자체 인수인계서 있음)

리포트는 4개 파트다.

| 파트 | 질문 | 핵심 산출물 |
|---|---|---|
| PART 1 신용잔고 | 얼마나 더 **하락**할 수 있나 | 지수대별 신용매수 누적 → 마진콜 사다리 |
| PART 2 공매도·숏커버 | 얼마나 더 **상승**할 수 있나 | 대차잔고 → 되갚기 잔여, 숏커버 사다리 |
| PART 3 레버리지 ETF | 변동성은 **어디서 왔나** | 상장좌수·AUM 분해, 일별 강제 리밸런싱 |
| PART 4 다음 주 수급 | 지수가 어디로 가면 **뭐가 따라 나오나** | 시나리오별 강제매매·사다리 거리·base rate |

## 2. 새 계정/새 PC에서 시작하기

```bash
git clone https://github.com/devbotsender8282/jj-liquidity-analysis.git
cd jj-liquidity-analysis
node --version    # 18+ 확인. npm install 불필요 (외부 패키지 0)
node scripts/analyze.mjs && node scripts/selfcheck.mjs && node scripts/build.mjs
```

**계정 바뀌면 다시 붙여야 하는 것 4가지.**

| 항목 | 지금 상태 | 새 계정에서 할 일 |
|---|---|---|
| GitHub | 저장소 소유자는 `devbotsender8282`. `jinjo202` 가 collaborator(write)로 초대 수락됨 | 새 계정을 collaborator 로 초대 → `gh api /user/repository_invitations` 로 초대 id 확인 → `gh api --method PATCH /user/repository_invitations/{id}` 로 수락 |
| Vercel(리포트) | GitHub 저장소에 연결돼 **push 하면 자동 배포**. 손댈 것 없음 | 없음. 저장소 접근만 되면 배포는 그대로 돈다 |
| Vercel(my-project) | Git 연동이 **아니다**. CLI 배포 방식(`npx vercel deploy --prod`) | `npx vercel@latest login` → `link --project my-project --scope devbotsender8282-3212s-projects` |
| 카카오톡 알림 | 이 PC 의 스케줄 작업 + 홈 디렉터리 상태 파일 | §9 참고. 새 PC 에서 다시 만들어야 한다 |

## 3. 지금 상태 (2026-08-02)

```
selfcheck OK — 4,326행, 재현 MAE 0.051조, 사이클 2개, 채널 O, 미수금 O, ETF O(24종)
데이터: 지수·대차잔고 20260731 / 신용융자·예탁금 20260730 / 분리신용 20260729
단일종목 레버리지 ETF 좌수 783백만좌 — 판정 building(아직 쌓이는 중)
레버리지 ETF 합계 AUM 20.08조 (고점 37.85조, 20260622 대비 -46.9%)
```

자동 갱신은 완전히 돈다. 손댈 것 없음.

## 4. 자동화가 하는 일 (`.github/workflows/update.yml`)

| 시각(KST) | 트리거 |
|---|---|
| 평일 19:30 | 장 마감 후 EOD 공표분 |
| 다음날 08:30 | 늦게 확정되는 계열 재확인(신용융자는 결제일 기준이라 하루 더 늦다) |
| `scripts/**` 또는 워크플로 파일 push 시 | 즉시 실행 |
| Actions 탭 `Run workflow` | 수동 실행 |

흐름: `fetch(index·kofia·lending·etf) → ingest-split → analyze → selfcheck(게이트) → build → status → 바뀐 게 있으면만 commit&push`

**로컬 PC 와 무관하다.** `runs-on: ubuntu-latest`. PC 를 꺼둬도 계속 갱신된다.
**selfcheck 가 게이트다.** 실패하면 커밋도 push 도 안 한다.
**실패해도 흔적이 남는다.** `status.json` 의 `failedStage` 에 어느 단계에서 멈췄는지 들어간다.

주의: 스케줄은 정시가 아니다. **60일 무활동이면 GitHub 이 cron 을 자동 정지**한다.

## 5. 아직 사람 손이 필요한 것 2개

| 무엇 | 왜 | 어떻게 |
|---|---|---|
| 유가증권/코스닥 분리 신용공여 xlsx | API 경로 없음(§8) | FREESIS > 주식 > 신용공여현황 에서 받아 `data/` 에 넣고 `node scripts/ingest-split.mjs` |
| 외사 리서치 수치 | PDF 는 제3자 저작물이라 저장소에 안 넣는다(`.gitignore` 의 `*.pdf`) | 새 리포트 읽고 `data/street-anchors.json` 갱신(출처·발간일 필수) |

대차거래추이(§16.2.1)와 **홍콩 CSOP(§23.6, 2026-08-02)** 는 수동이었다가 API 를 찾아 자동화됨.
CSOP 조회 키는 **상품 전체 영문명**이라 상품이 개명되면 `scripts/fetch-csop.mjs` 의 `PRODUCTS` 를
고쳐야 한다 — 깨지면 status.json 의 `fetchErrors` 에 `csop` 가 뜬다.

## 6. 저장소 구조

```
scripts/
  fetch-index.mjs      네이버 코스피·코스닥 일별(장중 최신, 교차검증)
  fetch-kofia.mjs      FREESIS 크로스통계 11개 지표
  fetch-lending.mjs    FREESIS 대차거래추이 API
  fetch-etf.mjs        레버리지 ETF 24종 + 삼성전자·SK하이닉스 일별 좌수·종가·거래대금
  fetch-csop.mjs       홍콩 CSOP 3종 좌수·순자산 (매일, 운용사 API)
  backfill-csop-units.mjs  홍콩 좌수 과거분 백필 (HKEX SDW, 갭 패치용 재실행 가능)
  ingest-split.mjs     분리 신용공여 xlsx 파싱 (수동 입력)
  ingest-lending.mjs   대차거래 xlsx 파싱 — API 규격 바뀔 때 폴백
  analyze.mjs          전 계산 → data/analysis.json
  selfcheck.mjs        불변식 검사(assert) — 게이트
  build.mjs            index.html (탭 5개, 스크립트 0줄)
  build-email.mjs      email.html (메일 클라이언트 호환, table 레이아웃)
  status.mjs           status.json (자동화 건강 + 좌수 판정, 공개 배포됨)
  alert-verdict.mjs    좌수 판정이 '바뀐 날'만 ALERT 를 내는 스크립트(§9)
  lib/buckets.mjs      버킷 배분·마진콜 판정·숏커버 사다리
  lib/etf.mjs          PART 3 계산 (AUM 분해, 리밸런싱, 좌수 추이)
  lib/outlook.mjs      PART 4 계산 (시나리오, base rate)
  lib/xlsx.mjs         xlsx/HTML표/CSV 자동판별 리더
data/                  원본 + 정규화 json 전부 커밋됨 (클론 직후 바로 재현)
  street-anchors.json  외사 리서치 수치(수동)
  csop-snapshot.json   홍콩 CSOP 최신 스냅샷(자동 생성 — 손대지 말 것)
  csop-daily.json      홍콩 CSOP 기준일별 히스토리 — 상장~20260801 은 HKEX SDW 백필,
                       이후는 CSOP 신고좌수. SDW 는 12개월 창이라 이 파일을 지우면 복구 불가
docs/methodology.md    §1~24
docs/plan-part3.md     PART 3 착수 전 계획서(기록용, 살아있는 문서는 §23)
```

## 7. 리포트 구조 (index.html)

```
핵심 요약 (탭 밖, 맨 위)
  ├─ ★ 매일 볼 것: 단일종목 레버리지 ETF 좌수 + 판정 + 추이 차트
  ├─ 오늘의 지표 6개 (클릭하면 1년 추세 펼침)
  └─ 한 줄 판정 + PART별 핵심 결론

[PART 1][PART 2][PART 3][PART 4][ALL]   ← 큰 탭
  PART 1 안: [2025–26 사이클][2020–21 사이클] 하위 탭
```

전부 라디오 + CSS 형제 선택자. JS 없음 → `file://` 로 열어도 동작, 인쇄하면 전부 펼쳐짐.

## 8. 데이터 소스와 함정 (다시 겪지 말 것)

- **KRX 정보데이터시스템은 막혀 있다.** `getJsonData.cmd` 는 세션 쿠키를 붙여도 400 `LOGOUT`,
  OTP 경로는 에러 HTML, `download_csv.cmd` 는 403. 봇 차단으로 판단하고 포기했다.
- **네이버 ETF 목록(`etfItemList.nhn`)은 EUC-KR 이다.** `res.json()` 으로 읽으면 한글이 전부 깨져
  이름 규칙이 하나도 안 맞는다. `TextDecoder('euc-kr')` 로 디코딩해야 한다.
- **일별 상장좌수는 다음 금융에서 온다.** `finance.daum.net/api/quote/A{code}/days` 의
  `listedSharesCount` 가 날짜별로 실제로 변한다(46행 중 43일 변동 확인). 이게 PART 3 의 토대다.
- **AUM 은 NAV 가 아니라 종가 × 좌수다.** 일별 NAV 소스가 없다. 괴리율만큼 오차가 있다.
- **PDF 는 커밋하지 않는다**(`.gitignore` 의 `*.pdf`). 필요한 수치만 `street-anchors.json` 으로 옮긴다.
- **BOM 주의.** 파워셸 `Set-Content -Encoding UTF8` 은 BOM 을 붙인다. `JSON.parse` 가 죽는다.
  `alert-verdict.mjs` 는 앞머리를 벗겨 읽는다.
- **gstack `/browse` 는 이 PC 에서 안 돈다** — `browse.exe` 가 Application Control 정책에 막힌다.
  JS 렌더링 페이지를 봐야 하면 인앱 브라우저를 쓴다.
- **`vercel env pull` 은 민감 변수를 `[REDACTED]`(11자)로 내려준다.** 프로젝트에 Sensitive
  Environment Variables 가 켜져 있어 CLI 로는 값을 못 읽는다. `.env.local` 을 그걸로 채우면
  `npm run dev` 가 조용히 실패한다.

## 9. 카카오톡 알림 — 판정이 바뀔 때만

**왜 이 지표 하나인가**: AUM 은 가격이 섞여 있어 수급이 정리됐는지를 못 알려준다.
좌수가 꺾이는 날이 진짜 환매의 시작이다(§23.7).

```
node scripts/alert-verdict.mjs          # 판정 비교 + 상태 갱신
node scripts/alert-verdict.mjs --dry    # 상태 갱신 없이 확인만 (수동 확인은 반드시 이걸로)
```

- 배포된 `status.json` 을 읽어 직전 판정(`~/.jj-liquidity-verdict.json`)과 비교한다.
- 출력 첫 줄이 `ALERT` 면 그 아래 본문(200자 이내)을 그대로 카카오톡으로 보낸다. `NOCHANGE` 면 조용히 끝난다.
- **`--dry` 없이 수동 실행하면 상태가 갱신된다.** 판정이 바뀐 날 수동으로 먼저 돌리면
  그 변화를 먹어버려 스케줄 알림이 안 간다.

스케줄 작업: `leverage-etf-verdict-alert`, **평일 20:30**
(19:30 파이프라인이 배포를 끝낸 뒤라서 그 시각이다). 앱이 켜져 있어야 돌고, 꺼져 있었으면 다음 실행 때 밀려서 돈다.

작업 파일: `~/.claude/scheduled-tasks/leverage-etf-verdict-alert/SKILL.md`
권한: `~/.claude/settings.json` 의 `permissions.allow` 에 `Bash(node:*)`, `PowerShell(node:*)`,
카카오톡 MemoChat 도구를 넣어 뒀다. 승인 창 없이 돌게 하려는 것이다 — 좁히고 싶으면 그 줄을 고친다.

**새 PC/새 계정에서는 스케줄 작업을 다시 만들어야 한다.** 상태 파일도 홈 디렉터리에 있어 따라오지 않는다.

## 10. 이번 세션(2026-08-02)에 한 일

1. 데이터 20260731 까지 갱신, 클라우드 산출물과 바이트 단위 일치 확인(교차검증)
2. my-project 웹앱: 숏커버 사다리 + 코스피 장중 현재가 구현·배포(HANDOFF.md 참조)
3. **PART 3 신설** — 레버리지 ETF 24종 일별 좌수 수집, AUM 분해(유출입 vs 가격), 리밸런싱
   `L(L−1)×AUM×r`, 지수 기여 분해, 상장 전후 변동성 반증, 홍콩 CSOP 스냅샷
4. **PART 4 신설** — 시나리오별 강제매매, 사다리 거리, 숏커버 연료, base rate, 제도 일정,
   외사(JPM·Nomura·GS) 수치 대조
5. 매일 볼 지표(좌수 판정)를 리포트 첫 화면·`status.json`·이메일에 고정
6. 레버리지 ETF 합계 AUM 누적 면적 차트
7. 카카오톡 알림(판정 전환 시에만) + 스케줄 작업

**가장 중요한 발견**: 외사 3사는 레버리지 ETF AUM 반토막을 디레버리징 진척으로 읽지만,
좌수로 보면 오히려 3~4.5배로 늘었다. JPM 도 "자금 유입은 계속 플러스"라고 같은 관찰을 적어 뒀다.
**AUM 으로 보면 끝나가고, 좌수로 보면 시작도 안 했다.**

## 11. 다음에 고려할 만한 것 (지시 아님)

- 홍콩 좌수도 이제 상장일부터 히스토리가 있다(§23.6) — 카톡 알림 판정에 7709 를 합류시킬지 검토
- 러너가 CSOP 수집을 며칠 놓치면 `node scripts/backfill-csop-units.mjs` 한 번으로 갭이 메워진다
- 분리 신용공여도 API 경로가 있을 수 있다(대차거래처럼 브라우저로 요청 캡처)
- my-project 웹앱에 PART 3·4 이식(지금은 정적 리포트에만 있다)
- 워크플로가 며칠 조용하면 `status.json` 의 `ranOn` 확인하는 습관

## 12. 막히면

`docs/methodology.md` §22 에 "로컬에서 되는데 러너에서 안 될 때 진단하는 순서"가 있다.
같은 패턴(진단을 `status.json` 에 심어 원격 추적)을 다시 쓰면 된다.
