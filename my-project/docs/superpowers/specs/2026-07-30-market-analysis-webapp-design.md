# 코스피 신용잔고·반대매매 분석 웹서비스 — 설계

## 1. 배경 및 목적

`../jj-project2-liquidity analysis` 프로젝트에서 코스피 지수대별 신용융자 누적과
반대매매(마진콜) 진행률을 추정하는 분석을 이미 완료했다 (`docs/methodology.md` 참조).
핵심 결과:

- 2020–21 사이클(완결) vs 2025–26 사이클(진행 중) 비교
- 2025–26 사이클: 코스피 -37.9%, 신용융자 -15.4% 청산, 잔여 청산 추정 범위 0~10.18조원
- 계산 로직은 `scripts/analyze.mjs` + `scripts/lib/buckets.mjs`에 구현되어 있고,
  정적 리포트 `index.html`로 이미 산출되어 있음

이 프로젝트(`my-project`)의 목적은 위 분석을 다음 형태의 **웹서비스**로 재구성하는 것:

1. Shadcn/ui 기반의 인터랙티브 대시보드로 재설계 (기존 정적 리포트보다 보기 좋게)
2. 매일 자동으로 최신 데이터를 받아와 분석을 갱신하는 라이브 서비스
3. 비개발자/일반 방문자를 위해 AI(OpenRouter)가 매일 시장 상황을 쉬운 말로 해설
4. 방문자가 데이터에 대해 질문할 수 있는 챗봇
5. Vercel 배포

## 2. 아키텍처

- **프레임워크**: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- **DB**: Supabase (Postgres) — 이미 연결된 Supabase 프로젝트 사용
- **AI**: OpenRouter API (모델은 구현 단계에서 비용/품질 고려해 확정)
- **배포**: Vercel, Vercel Cron으로 매일 배치 실행
- **기존 자산 재사용**: `scripts/lib/buckets.mjs`의 버킷 배분·마진콜 판정 로직을
  TypeScript로 포팅하여 그대로 사용 (알고리즘 변경 없음, 위치만 이관)

```
[Vercel Cron] --daily--> [/api/cron/daily-update]
                              |
                 1. KOFIA FREESIS + 네이버 금융에서 데이터 fetch
                 2. buckets.ts 로 사이클/버킷/마진콜 계산
                 3. Supabase에 저장 (daily_market, analysis_snapshot)
                 4. OpenRouter로 일일 해설 생성 -> ai_commentary 저장
                              |
                              v
[방문자] --GET--> [/ (대시보드)] --읽기 전용 조회--> [Supabase]
[방문자] --POST--> [/api/chat] --컨텍스트 주입--> [OpenRouter] --답변--> [방문자]
```

## 3. 데이터 모델 (Supabase)

### `daily_market`
날짜별 원 지표. `kofia-daily.json` + `kospi-daily.json` 대체.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| date | date (PK) | 거래일 |
| kospi | numeric | KOSPI 종가 |
| kosdaq | numeric | KOSDAQ 종가 |
| credit_loan | numeric | 신용융자 (백만원) |
| margin_call_amount | numeric | 반대매매금액 (백만원, 참고용) |
| kospi_market_cap | numeric | KOSPI 시가총액 |
| kosdaq_market_cap | numeric | KOSDAQ 시가총액 |

### `analysis_snapshot`
계산된 분석 결과. 기존 `data/analysis.json` 구조를 JSONB 한 컬럼에 통째로 저장
(스키마 변경 부담 없이 기존 로직 출력을 그대로 활용).

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint (PK) | |
| computed_at | timestamptz | 계산 실행 시각 |
| data | jsonb | analyze.mjs 출력과 동일 구조 |
| is_latest | boolean | 최신 스냅샷 여부 (조회 편의) |

### `ai_commentary`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint (PK) | |
| date | date | 대상 거래일 |
| content | text | AI가 생성한 해설 (한국어, 쉬운 말) |
| model | text | 사용한 OpenRouter 모델명 (추적용) |
| created_at | timestamptz | |

## 4. 화면 (페이지/컴포넌트)

### `/` 메인 대시보드
- **요약 카드 영역**: 오늘 코스피, 신용융자 잔고, 청산 진행률(%), 데이터 기준일
- **AI 해설 카드**: 최신 `ai_commentary` 표시, 실패 시 숫자 기반 기본 문구로 대체
- **2021 vs 2026 비교 탭** (shadcn `Tabs`): 지수대별 버킷 막대차트 (recharts),
  두 사이클을 나란히/전환하며 비교
- **잔여 청산 추정 카드**: 4개 벤치마크(2021 청산률 대입 / 탄성 / 마진콜모델 / 신용·시총비율)
  범위(0~10.18조) 시각화 + "왜 범위로 말하는지" 짧은 설명
- **챗봇 위젯**: 화면 우하단 플로팅 버튼 → shadcn `Sheet`로 열리는 대화창
- **하단 고정 문구**: "본 서비스는 투자 조언이 아니며 참고용 통계 분석입니다"

### `/methodology` 방법론 페이지
- 기존 `methodology.md` 내용을 accordion/카드로 재구성 (일반 방문자는 안 봐도 되게 접어둠)

## 5. API 라우트

- `POST /api/cron/daily-update` (Vercel Cron 전용, 인증 헤더로 보호)
  - 데이터 fetch → 계산 → Supabase upsert → AI 해설 생성/저장
  - 실패 시 이전 스냅샷 유지, 에러 로그만 남김 (서비스 중단 없음)
- `POST /api/chat`
  - 요청: 방문자 질문
  - 처리: 최신 `analysis_snapshot` 요약 + system prompt("데이터 기반 설명만, 투자조언/매수매도 추천 금지, 항상 면책 문구 포함")를 OpenRouter에 전달
  - 간단한 IP 기준 rate limit 적용 (과금 폭주 방지)

## 6. 에러 처리 원칙

- 데이터 갱신 실패 → 마지막 성공 스냅샷 유지, 화면에 "n일 전 데이터 기준" 배너
- AI 해설 생성 실패 → 정적 템플릿 문구("코스피 {지수}, 청산 {진행률}% 진행")로 대체
- 챗봇 호출 실패 → 에러 메시지 + 재시도 안내

## 7. 보안 (프로젝트 CLAUDE.md 규칙 준수)

- OpenRouter API 키, Supabase 키 전부 `.env.local` / Vercel 환경변수로만 관리
- 코드/커밋에 비밀키 직접 작성 금지
- 배포 전 비밀키·개인정보 혼입 여부 점검

## 8. 테스트 계획

- 대시보드 로컬 실행 후 브라우저로 확인: 카드 수치, 차트 값이 기존 `index.html`과 일치하는지 대조
- `/api/cron/daily-update`를 수동으로 1회 호출해 Supabase 저장 확인
- 챗봇에 몇 가지 질문 넣어 "투자 조언 아님" 원칙 지키는지 확인
- 데이터/AI 실패 시나리오 강제로 만들어 fallback 동작 확인

## 9. 범위 밖 (Out of scope)

- 사용자 계정/로그인 기능
- 실시간(장중) 갱신 — 일 1회 배치로 충분

## 10. 범위 변경 (2026-07-30, 구현 중 반영)

구현 도중 원본 분석 프로젝트(`../jj-project2-liquidity analysis`)가 갱신되어 두 기능이 추가됨을
확인했고, 사용자 확인을 거쳐 이번 빌드 범위에 포함했다.

### 10.1 거래대금 대비 규모 + 마진콜 사다리 (turnover / ladder)

`buckets.mjs`에 `turnoverStats()`, `buildLadder()`가 추가됨. 청산 금액을 "그 시장이 평소
하루에 사고파는 돈의 며칠치인가"로 환산하고, 남은 마진콜 사다리(지수가 어디까지 내려가면
얼마가 추가로 열리는지)를 계산한다. 데이터는 KOFIA 지표 `OS0011`(KOSPI거래대금),
`OS0012`(KOSDAQ거래대금, 둘 다 억원 단위)로 크로스통계 API에서 자동 수집 가능 — 매일 자동
갱신 대상에 포함된다.

### 10.2 유가증권/코스닥 분리 분석 (market split)

원본 프로젝트에 `data/credit-split.json`이 이제 존재하고 `analyze.mjs`가 `전체` 외에
`유가증권`(코스피 신용융자만) / `코스닥`(코스닥 신용융자만) 두 시장을 추가로 분석한다.
대시보드에 시장 선택(전체/유가증권/코스닥) UI를 추가한다.

**중요한 제약**: 분리 계열은 금투협 API로 자동 수집이 안 된다(원본 methodology.md §8 참조 —
FREESIS 통계 화면에서 사람이 직접 내려받아야 함). 따라서:
- 매일 자동 갱신(cron)은 `전체` 신용융자 + 거래대금만 갱신한다.
- 분리 계열 원본 데이터는 사용자가 가끔(비정기적으로) FREESIS에서 파일을 내려받아
  로컬 스크립트로 한 번 Supabase에 반영해야 한다 (`npm run ingest-split -- <파일경로>`).
  이후 매일 배치가 그 최신 분리 데이터를 자동으로 재사용해 세 시장 분석을 다시 계산한다.
- 이 사실을 README와 방법론 페이지에 명시한다.

## 11. 범위 변경 (2026-07-31): 대차잔고(공매도 프록시) · 숏커버링 분석

원본 프로젝트에 대차잔고(주식 대차거래 잔고, 한국에서 공매도의 표준 프록시) 분석이
추가됨(원본 `docs/methodology.md` §16). 사용자 요청으로 이번 웹서비스에도 포함한다.

- **왜 프록시를 쓰는가**: 한국은 공매도가 거의 전량 '차입 후 매도' 구조라 대차잔고와
  공매도 잔고는 사실상 같은 풀을 가리킨다. KRX는 시장 전체 합계 공매도 잔고를
  공표하지 않으므로(종목별 대량보유자 신고 기준만 공표) 대차잔고를 표준 프록시로 쓴다.
- **숏커버링 판정**: 날짜별 지수 등락률과 대차잔고 등락률을 네 조합(숏커버형/동반청산/
  신규숏추정/리스크온)으로 나누고, '지수↑ 잔고↓'인 날 중 두 등락폭의 곱으로 순위를 매겨
  숏커버링 후보일 상위 8개를 뽑는다.
- **데이터 제약**: 분리 계열과 완전히 같은 사정이다 — FREESIS `대차거래추이`는 API로 자동
  수집이 안 되어 사람이 직접 내려받아야 한다. 매일 자동 갱신은 `전체` 신용융자만 다루고,
  대차잔고는 분리 계열처럼 가끔 수동으로 반영한다(`npm run ingest-lending -- <파일경로>`).
- **한계(방법론 페이지에 명시)**: 대차거래는 공매도 외에 ETF 설정/환매, 차익거래, 배당락
  대비, 의결권 확보 목적으로도 일어난다 — 잔고 변화 전부가 공매도 포지션 변화는 아니다.
