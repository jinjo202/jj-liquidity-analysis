# 인수인계서 (2026-08-01 기준)

## 프로젝트

코스피 신용잔고·반대매매(마진콜) 분석 + 유가증권/코스닥 분리 + 대차잔고(공매도 프록시)·숏커버링
분석 웹서비스. 원본 분석은 `../jj-project2-liquidity analysis` (별도 프로젝트, 참고용 소스).

- **배포 URL**: https://my-project-sable-beta-90.vercel.app
- **Vercel 프로젝트**: `devbotsender8282-3212s-projects/my-project`
- **Supabase 프로젝트**: `jsxhcqnupvvctnjiaric`
- **매일 자동 갱신**: Vercel Cron, 평일 09:00 UTC(18:00 KST), `/api/cron/daily-update`

## 다 된 것

1. 신용융자 지수대별 누적 + 마진콜 판정 (전체 시장)
2. 유가증권/코스닥 분리 분석 (탭으로 전환)
3. 대차잔고(공매도 프록시) + 숏커버링 4분류(숏커버형/동반청산/신규숏추정/리스크온)
4. AI 일일 시장 해설 (OpenRouter, `anthropic/claude-haiku-4.5`)
5. 데이터 기반 챗봇 (종목 추천 거절, 면책 문구 항상 표시, IP당/일일 전체 요청 한도)
6. 방법론 페이지, README, Supabase 스키마 파일(`supabase/migrations/`)
7. **숏커버링 지수대별 사다리** (2026-08-01) — `buildShortCoverLadder()`(`src/lib/buckets.ts`).
   대차잔고 증가분을 그날 지수대에 쌓아 진입 지수 분포를 만들고, 지수가 그 구간 위로 올라오면
   손실권에 든다고 본다. 대표 진입 지수는 구간 하단(마진콜이 상단을 쓰는 것과 같은 "먼저 걸리는
   쪽" 기준), 합계는 신용융자와 같은 churn 보정. 강제 청산 비율은 공표되지 않으므로 계수를
   곱하지 않고 손실권 진입만 센다 — 방법론 §9에 한계로 명시했다. 대차잔고 카드 안에 표로 나온다.
8. **코스피 장중 현재가** (2026-08-01) — `/api/kospi`(네이버 `siseJson`, fetch 캐시 60초) +
   `KospiLive`(클라이언트, 1분 폴링, 백그라운드 탭에서는 쉼). 요약 카드의 코스피 칸만 갱신하고
   나머지 분석은 배치 확정치 그대로다. 스냅샷보다 날짜가 앞서면 "장중" 배지와 전일 대비를 붙인다.
   실패하거나 JS가 안 돌면 서버가 그린 종가가 그대로 남는다.

## 아직 안 된 것

지금은 없다. 아래 "다음에 하면 좋을 것" 참고.

## 데이터 상태 (2026-08-01)

- `daily_market` 지수 ~20260731 / 신용융자 ~20260730, `lending_balance_raw` ~20260731,
  `credit_split_raw` ~20260729 (수동 xlsx라 늦다).
- 20260731 대차잔고(155.86조, 전일 +16.8%)는 원본 프로젝트가 API로 받은 값을 SQL로 직접
  upsert 했다. 다음 배치(평일 18:00 KST)가 이 행을 읽어 스냅샷에 반영한다.
- **이번 변경(숏커버 사다리·장중 지수)은 아직 배포 전이다.** 배포하고 배치를 한 번 돌려야
  스냅샷에 `shortCoverLadder` 가 생기고 카드에 표가 나타난다(그전까지는 그 구역만 숨는다).

## 원본 프로젝트가 앞서 있는 부분 (2026-08-02)

원본 정적 리포트에 **PART 3(레버리지 ETF 수급)**, **PART 4(다음 주 수급 전망)** 가 생겼는데
이 웹앱에는 아직 없다. 이식하려면 원본의 `scripts/lib/etf.mjs`·`lib/outlook.mjs` 와
`data/etf-daily.json` 수집 경로(`scripts/fetch-etf.mjs`, 다음 금융의 `listedSharesCount`)를 옮겨야 한다.
자세한 내용은 원본 `../docs/methodology.md` §23~24, `../HANDOVER.md` 참조.

## 다음에 하면 좋을 것 (선택)

- **대차잔고 자동 수집**: 원본 프로젝트가 FREESIS 대차거래추이 API 경로를 찾아 자동화했다
  (`../scripts/fetch-lending.mjs`, 방법론 §16.2.1). 이걸 `src/lib/` 로 옮겨 cron 에서 부르면
  수동 ingest 자체가 없어진다. 실패해도 배치 전체가 죽지 않게 try/catch 로 DB 기존 행에
  폴백할 것.
- 유가증권/코스닥 분리 신용공여도 같은 식의 API 경로가 있을 수 있다 — 아직 못 찾았다.

## 중요한 함정 (다시 겪지 않게)

- **Supabase PostgREST 1000행 캡**: `.select()`에 `.limit(N)`을 아무리 크게 줘도 프로젝트
  기본 max_rows(1000)를 못 넘음. `credit_split_raw`/`lending_balance_raw`처럼 1000행
  넘는 전체 시계열을 읽을 땐 반드시 `src/lib/queries.ts`의 `fetchAllPages()`(range 페이징)
  같은 방식을 써야 함. 이거 놓쳐서 최근 2년치 데이터가 통째로 안 잡히는 버그를 한 번 냈었음
  (겉으로는 에러 없이 그냥 "오래된 데이터만 있음"으로 보여서 알아채기 어려움 — 새 테이블
  읽기 함수 만들 때마다 행 개수 직접 확인해볼 것).
- **base-ui Tabs**: `@base-ui/react`의 `Tabs.Panel`은 비활성 탭에 `inert` 속성만 붙이고
  CSS는 안 줌(헤드리스라서). `globals.css`에 `[inert]{display:none}` 규칙이 있어야
  탭 전환이 실제로 화면을 바꿈. 이 규칙 지우면 탭 전환 안 되는 버그 재발함.
- **분리 계열 데이터(유가증권/코스닥, 대차잔고)**: 금투협 API로 자동 수집 안 됨. 사람이
  FREESIS에서 파일 내려받아 `npm run ingest-split -- <파일>` / `npm run ingest-lending -- <파일>`
  로 반영해야 함. README에 방법 있음.

## 로컬 실행

```bash
npm install
npm test          # 프로젝트 안에 얼린 fixture 씀, 외부 프로젝트 의존 없음
npm run dev
```

`.env.local`에 필요한 값(이미 채워져 있음, 이 파일은 git에 안 올라감): `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. **PC 옮기면 이 파일을 직접 복사해서 옮기거나
새로 채워야 함 — git에 없음.**

## 배포

```bash
npx vercel@latest deploy --prod   # 프로덕션 배포
# 배포 후 매번, 새 코드가 실제로 계산에 반영되려면 배치를 한 번 수동 실행해야 함:
curl -H "Authorization: Bearer $CRON_SECRET" https://my-project-sable-beta-90.vercel.app/api/cron/daily-update
```
