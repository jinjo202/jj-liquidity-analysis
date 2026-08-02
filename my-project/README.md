# 코스피 신용잔고·반대매매 분석 웹서비스

## 프로젝트 목적

이 프로젝트는 `../jj-project2-liquidity analysis`에서 정적 리포트(`index.html`)로 만들어졌던
"코스피 지수대별 신용융자 누적과 반대매매(마진콜) 진행률 추정" 분석을, 매일 자동으로 데이터를
갱신하는 라이브 웹서비스로 재구성한 것이다. 2020–21 사이클(완결)과 2025–26 사이클(진행 중)을
지수대별 버킷으로 나눠 비교하고, 유가증권/코스닥 분리, 거래대금 대비 규모, 잔여 마진콜 사다리까지
보여주는 대시보드와, 방문자가 데이터에 대해 질문할 수 있는 챗봇을 제공한다. 원 분석의 버킷 배분·
마진콜 판정 로직(`scripts/lib/buckets.mjs`)을 알고리즘 변경 없이 TypeScript로 그대로 포팅해 사용한다.
자세한 계산 근거와 역설계 과정은 원 분석 프로젝트의 `docs/methodology.md`와, 이 앱의 `/methodology`
페이지에 정리되어 있다.

## 로컬 실행 방법

```bash
npm install
npm run dev
```

`http://localhost:3000`에서 확인한다. 실행 전 아래 "필요한 환경변수"를 `.env.local`에 채워야 한다
(Supabase 프로젝트 연결 및 OpenRouter API 키 필요).

테스트와 빌드:

```bash
npm test          # vitest
npm run build     # next build
```

`npm test`는 `src/lib/__tests__/fixtures/`에 저장소에 내장된 고정 픽스처(KOFIA 일별 통계·신용
분리 스냅샷)만 사용한다. 별도 프로젝트(`../jj-project2-liquidity analysis`)나 외부 데이터가
없어도 클론 직후 바로 실행할 수 있다.

## Supabase 스키마

`daily_market`, `credit_split_raw`, `analysis_snapshot`, `ai_commentary` 네 테이블의 스키마와
RLS(행 수준 보안) 정책은 `supabase/migrations/0001_init.sql`에 있다. 새 Supabase 프로젝트에
반영하려면 아래 중 한 방법을 쓴다.

```bash
supabase db push
```

또는 Supabase 대시보드의 SQL 편집기에 `supabase/migrations/0001_init.sql` 내용을 그대로
붙여넣어 실행해도 된다.

## 필요한 환경변수

`.env.local`에 아래 이름의 환경변수를 설정한다 (값은 본 문서에 포함하지 않음 — 각자 Supabase
대시보드 및 OpenRouter 계정에서 발급받아 채운다).

| 변수명 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL (클라이언트/서버 공통) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 공개(anon/publishable) 키, 읽기 전용 조회용 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서비스 롤 키, 서버 라우트(cron, 데이터 upsert)에서만 사용 |
| `OPENROUTER_API_KEY` | OpenRouter API 키, AI 일일 해설·챗봇 생성용 |
| `OPENROUTER_MODEL` | 사용할 OpenRouter 모델명 |
| `CRON_SECRET` | `/api/cron/daily-update` 인증용 시크릿 (Vercel Cron 및 수동 호출 시 `Authorization: Bearer` 헤더로 전달) |

## 자료 출처

- 금융투자협회(KOFIA) FREESIS 크로스통계: KOSPI/KOSDAQ 지수, 신용융자, 반대매매금액,
  위탁매매미수금, 투자자예탁금, 시가총액, 거래대금 등 일별 통계(2010-01-01~)
- 네이버 금융 일별 시세: 코스피/코스닥 지수 교차검증용, 그리고 화면 상단 코스피 장중 현재가
  (`/api/kospi`, 60초 캐시 · 화면은 1분 폴링). 표시 전용이며 분석 계산에는 쓰지 않는다 —
  FREESIS 는 장 마감 후 공표라 장중에는 전일 종가가 최신이기 때문이다.
- 원 비교 대상: 삼성자산운용 투자리서치센터 House View 점검 자료
  「7.29일 급락 코멘트: 신용매수 반대매매 추정」(2026-07-29)

## 면책 문구

본 서비스는 투자 조언이 아니며 참고용 통계 분석입니다. 대시보드의 수치와 AI 해설, 챗봇 답변은
공개된 통계 데이터를 기반으로 한 추정치이며 매수·매도 등 투자 판단의 근거로 사용해서는 안 됩니다.
투자에 대한 최종 판단과 책임은 이용자 본인에게 있습니다.

## 원 분석 프로젝트 위치

`../jj-project2-liquidity analysis` — 방법론 역설계 과정, 계산 검증, 최초 정적 리포트(`index.html`)가
있는 원본 분석 프로젝트. 이 웹서비스는 그 프로젝트의 `scripts/lib/buckets.mjs` 로직을 이관해 사용한다.

## 유가증권/코스닥 분리 데이터 수동 반영 방법

금투협 크로스통계 API는 신용융자 '전체' 계열만 제공하고, 유가증권/코스닥으로 나뉜 계열은
프로그램으로 자동 수집할 수 없다(원 분석 프로젝트 `docs/methodology.md` §8 참조). 따라서
분리 계열은 아래 절차로 사람이 가끔 수동 반영해야 한다.

1. FREESIS 사이트에서 `주식 > 신용공여현황 > 신용공여 잔고 추이` 화면으로 이동해 자료주기를
   `일`로, 조회 기간을 처음부터 최신까지로 설정한 뒤 파일을 내려받는다.
2. 내려받은 파일을 이 프로젝트의 `data/` 폴더에 넣는다.
3. 아래 명령을 실행해 Supabase에 반영한다.

   ```bash
   npm run ingest-split -- data/<파일명>
   ```

이후에는 매일 자동 배치(cron)가 이 최신 분리 데이터를 자동으로 재사용해 전체/유가증권/코스닥
세 시장의 분석을 매번 다시 계산한다. 분리 계열 파일을 다시 받아 반영하기 전까지는 이전에
반영해둔 분리 데이터가 계속 쓰인다.

## 대차잔고(공매도 프록시) 데이터 수동 반영 방법

대차잔고(주식 대차거래 잔고, 한국에서 공매도의 표준 프록시)도 분리 계열과 같은 사정이다 —
FREESIS `대차거래추이`는 API로 자동 수집이 안 되어 사람이 직접 내려받아야 한다. 아래 절차로
가끔 수동 반영한다.

1. FREESIS 사이트에서 `주식 > 대차거래 > 대차거래추이` 화면으로 이동해 자료주기를 `일`로,
   조회 기간을 2010-01-01부터 최신까지로 설정한 뒤 파일을 내려받는다.
2. 내려받은 파일을 이 프로젝트의 `data/` 폴더에 넣는다.
3. 아래 명령을 실행해 Supabase에 반영한다.

   ```bash
   npm run ingest-lending -- data/<파일명>
   ```

이후에는 매일 자동 배치가 이 최신 반영분을 자동으로 재사용해 대차잔고·숏커버링 분석을 다시
계산한다. 아직 한 번도 반영되지 않았거나, 최근 자료를 새로 내려받아 반영하기 전까지는
대시보드에 대차잔고 카드가 나타나지 않거나(첫 반영 전) 이전 반영분 기준으로 계속 표시된다.
