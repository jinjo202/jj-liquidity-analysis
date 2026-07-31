# 인수인계서 (2026-07-31 기준)

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

## 아직 안 된 것 (사용자 요청, 다음 작업)

1. **숏커버링 지수대별 사다리** — 마진콜 사다리처럼 "지수가 이 구간까지 올라오면 대차잔고
   얼마가 손실권에 들어가는지"를 보여주는 것. 원 프로젝트에 없는 신규 분석 — 방식은 합의됨
   (마진콜 사다리와 순서만 반대, 정확한 강제청산 비율은 없다고 방법론에 명시하기로 함).
   `src/lib/buckets.ts`의 `accumulate()`를 그대로 재사용 가능(지수/금액 제네릭 함수).
2. **코스피 실시간 현재가** — 지금은 배치가 하루 한 번 돌 때의 종가만 보여줌. 사용자가
   장중 급등락 시 더 최신 지수를 보고 싶어함. 대차잔고/신용융자 분석 자체는 하루 한 번이면
   충분하다고 확인받음 — 화면 상단 "코스피 현재가"만 별도로 더 자주(예: 페이지 로드 시마다,
   또는 클라이언트에서 주기적 polling) 갱신하도록 분리해서 붙이면 됨. 네이버 실시간 시세
   API 등 별도 소스 필요(`scripts/fetch-kospi.mjs`는 일별 종가만 됨, 실시간 아님).

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
