# 코스피 신용잔고·반대매매 분석 웹서비스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 코스피 신용잔고·반대매매 분석(`../jj-project2-liquidity analysis`)을 매일 자동 갱신되는 Next.js 대시보드 + AI 해설 + 챗봇 웹서비스로 재구성하고 Vercel에 배포한다.

**Architecture:** Next.js App Router 단일 앱. Vercel Cron이 매일 `/api/cron/daily-update`를 호출해 KOFIA FREESIS에서 데이터를 받아 계산하고 Supabase에 저장한다. 대시보드는 Supabase에서 최신 스냅샷만 읽어 렌더한다(계산 안 함). AI 해설과 챗봇은 OpenRouter를 호출한다.

**Tech Stack:** Next.js 15 (App Router) / TypeScript / Tailwind CSS v4 / shadcn/ui / recharts / Supabase (Postgres) / OpenRouter / Vitest / Vercel

## Global Constraints

- **모든 UI 텍스트는 한국어.** 파일은 UTF-8로 저장 (CLAUDE.md 규칙 6 — 한글 깨짐 금지).
- **비밀 키를 코드에 직접 쓰지 않는다.** `process.env`로만 읽는다. `.env.local`은 이미 `.gitignore`에 등록되어 있고 `OPENROUTER_API_KEY`가 저장되어 있다.
- **Supabase 프로젝트**: id `jsxhcqnupvvctnjiaric`, name `super-use-project`, region `ap-northeast-2`. 기존 `public.todos` 테이블이 있으나 무관 — 건드리지 않는다.
- **Supabase 접근**: 서버 라우트는 `SUPABASE_SERVICE_ROLE_KEY`, 클라이언트/읽기 전용은 publishable key 사용. 두 키 모두 환경변수로만.
- **면책 문구 원문 (모든 페이지 하단 및 챗봇 답변에 표시, 이 문장 그대로 사용)**:
  `본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.`
- **금액 단위**: 조원(兆). 소수점 둘째 자리까지 표시 (`4.72조원`).
- **지수 표시**: 정수 + 천단위 콤마 (`5,663p`).
- **날짜 포맷**: DB/API는 `YYYYMMDD` 문자열(기존 로직과 동일), 화면 표시는 `2026년 7월 29일`.
- **OpenRouter 모델**: `anthropic/claude-haiku-4.5` (비용 대비 한국어 품질). 환경변수 `OPENROUTER_MODEL`로 덮어쓸 수 있게 한다.
- **테스트**: Vitest. `npm test`로 실행.
- **기존 로직 이관 원칙**: `../jj-project2-liquidity analysis/scripts/lib/buckets.mjs`의 알고리즘은 **변경하지 않는다.** TypeScript 타입만 붙여 포팅한다. 수치가 달라지면 포팅 실패다. **`weightedIndex`는 반드시 구간 중앙값(`low + width / 2`)을 쓴다 — 구간 상단이 아니다.** 원본 파일은 2026-07-30 구현 중 갱신되어 `turnoverStats()`/`buildLadder()`가 추가되고 `analyzeMarket()`이 `turnoverRows`를 받아 `turnover`/`ladder`/`unwind.pctOfTurnover`/`unwind.equivDays`를 반환하도록 바뀌었다 — **이 최신 버전 전체**를 포팅 대상으로 한다 (Task 2 참조).
- **시장 범위 (2026-07-30 확장)**: `전체`(코스피+코스닥 신용융자 합계 × 코스피 지수) / `유가증권`(코스피 신용융자만 × 코스피 지수) / `코스닥`(코스닥 신용융자만 × 코스닥 지수) 세 시장을 모두 분석·표시한다. `전체`+거래대금(OS0011/OS0012)은 KOFIA API로 매일 자동 갱신된다. `유가증권`/`코스닥` 분리 원본 데이터는 API로 자동 수집이 안 되므로 (원본 `docs/methodology.md` §8) 사용자가 가끔 로컬 스크립트로 수동 반영하고, 매일 배치는 Supabase에 저장된 최신 분리 데이터를 그대로 재사용해 세 시장을 다시 계산한다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts` | 프로젝트 설정 |
| `src/lib/buckets.ts` | 버킷 배분·마진콜 판정 순수 함수 (기존 `buckets.mjs` 포팅) |
| `src/lib/analyze.ts` | 사이클 정의 + 재현검증 + 잔여청산 추정. 원 데이터 → 분석 스냅샷 |
| `src/lib/types.ts` | 분석 결과 타입 정의 (스냅샷 구조) |
| `src/lib/fetch-kofia.ts` | KOFIA FREESIS 크로스통계 API 호출 |
| `src/lib/supabase.ts` | Supabase 클라이언트 (server용 / browser용) |
| `src/lib/queries.ts` | Supabase 읽기 쿼리 (최신 스냅샷, 해설) |
| `src/lib/openrouter.ts` | OpenRouter 호출 래퍼 (해설 생성 / 챗 응답) |
| `src/lib/format.ts` | 숫자·날짜 한국어 포맷 헬퍼 |
| `src/app/layout.tsx` | 전역 레이아웃 + 면책 푸터 |
| `src/app/page.tsx` | 메인 대시보드 (서버 컴포넌트, Supabase 읽기) |
| `src/app/methodology/page.tsx` | 방법론 페이지 |
| `src/app/api/cron/daily-update/route.ts` | 일일 배치 (fetch→계산→저장→해설생성) |
| `src/app/api/chat/route.ts` | 챗봇 API |
| `src/components/summary-cards.tsx` | 상단 요약 카드 |
| `src/components/ai-commentary.tsx` | AI 해설 카드 |
| `src/components/cycle-compare.tsx` | 2021 vs 2026 버킷 비교 차트 (탭) |
| `src/components/projection-card.tsx` | 잔여 청산 추정 (4개 벤치마크) |
| `src/components/stale-banner.tsx` | 데이터 오래됨 경고 배너 |
| `src/components/chat-widget.tsx` | 플로팅 챗봇 (클라이언트 컴포넌트) |
| `src/components/disclaimer.tsx` | 면책 문구 |
| `vercel.json` | Cron 스케줄 |
| `src/lib/__tests__/*.test.ts` | 단위 테스트 |

---

### Task 1: 프로젝트 스캐폴딩 + shadcn/ui 초기화

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `components.json`, `vitest.config.ts`, `src/lib/utils.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: 동작하는 Next.js 앱 (`npm run dev`로 뜬다), `cn()` 유틸, Vitest 실행 환경

- [ ] **Step 1: Next.js 앱 생성**

프로젝트 디렉터리에 이미 `CLAUDE.md`, `docs/`, `.gitignore`, `.env.local`, `.git/`이 있으므로 `create-next-app`을 현재 디렉터리에 적용한다.

```bash
cd "C:/Users/user/Desktop/jj-coding-projects/my-project"
npx --yes create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --use-npm --no-turbopack --import-alias "@/*" --yes
```

기존 파일과 충돌하면 `create-next-app`이 중단될 수 있다. 그럴 경우 임시 디렉터리에 생성 후 파일을 옮긴다:

```bash
npx --yes create-next-app@latest /tmp/scaffold --typescript --tailwind --eslint --app --src-dir --use-npm --no-turbopack --import-alias "@/*" --yes
# 그 다음 /tmp/scaffold 의 내용을 프로젝트로 복사 (.git, CLAUDE.md, docs, .env.local, .gitignore 는 보존)
```

- [ ] **Step 2: 개발 서버 뜨는지 확인**

Run: `npm run dev` (백그라운드) 후 `http://localhost:3000` 접속
Expected: Next.js 기본 페이지가 표시된다

- [ ] **Step 3: shadcn/ui 초기화 + 필요한 컴포넌트 설치**

```bash
npx --yes shadcn@latest init --yes --base-color slate
npx --yes shadcn@latest add card tabs button badge accordion sheet input scroll-area skeleton alert separator --yes
```

- [ ] **Step 4: Vitest 설치 및 설정**

```bash
npm install -D vitest
```

`vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
```

`package.json`의 `scripts`에 추가: `"test": "vitest run"`

- [ ] **Step 5: 빈 테스트로 Vitest 동작 확인**

`src/lib/__tests__/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm test`
Expected: PASS 1 test

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with shadcn/ui and Vitest"
```

---

### Task 2: 버킷 계산 로직 포팅 (`buckets.ts`)

기존 `../jj-project2-liquidity analysis/scripts/lib/buckets.mjs`를 TypeScript로 포팅한다. **알고리즘은 한 줄도 바꾸지 않는다.**

**Files:**
- Create: `src/lib/buckets.ts`
- Test: `src/lib/__tests__/buckets.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `MAINTENANCE: 1.40`, `LOAN_RATIO: 0.60`
  - `factorOf(maint?: number, loan?: number): number`
  - `jo(mil: number): number`
  - `sumJo(bs: {jo: number}[]): number`
  - `pickWidth(span: number, maxBuckets?: number): number`
  - `accumulate(rows: DailyRow[], width: number): AccResult`
  - `accumulateOutflow(rows: DailyRow[], width: number): OutflowResult`
  - `classify(acc: {buckets: Map<number,number>, width: number}, evalIdx: number, factor?: number): Bucket[]`
  - `weightedIndex(buckets: Map<number,number>, width: number): number | null` — **구간 중앙값** `low + width/2` 사용 (구간 상단 아님)
  - `turnoverStats(rows: TurnoverRow[], fromDate: string, toDate: string, recentWindow?: number): TurnoverStats | null` (2026-07-30 원본에 추가된 함수, 반드시 포함)
  - `buildLadder(buckets: Bucket[], scaledBuckets: Bucket[], avgDailyTurnoverJo: number | null): LadderRow[]` (2026-07-30 원본에 추가된 함수, 반드시 포함)
  - `TurnoverRow = {date: string, valueJo: number}`, `TurnoverStats`, `LadderRow` 타입 (원본 함수 반환 shape 그대로)
  - `analyzeMarket`은 `turnoverRows?: TurnoverRow[]`를 추가로 받고, 반환값에 `turnover: TurnoverStats | null`, `ladder: LadderRow[]`, `unwind.pctOfTurnover: number | null`, `unwind.equivDays: number | null`을 추가로 포함한다 (2026-07-30 원본 갱신분)
  - `analyzeMarket(o: AnalyzeMarketInput): MarketAnalysis | null`
  - 타입: `DailyRow = {date: string, idx: number, credit: number}`, `IdxRow = {date: string, idx: number}`, `Bucket`, `MarketAnalysis`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/__tests__/buckets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { factorOf, jo, pickWidth, accumulate, classify, accumulateOutflow, weightedIndex } from '@/lib/buckets'

describe('factorOf', () => {
  it('마진콜 계수는 담보유지비율 x 융자비율', () => {
    expect(factorOf()).toBeCloseTo(0.84, 10)
    expect(factorOf(1.3, 0.6)).toBeCloseTo(0.78, 10)
  })
})

describe('jo', () => {
  it('백만원을 조원으로 바꾼다', () => {
    expect(jo(1_000_000)).toBe(1)
    expect(jo(38_630_000)).toBeCloseTo(38.63, 10)
  })
})

describe('pickWidth', () => {
  it('버킷 수가 20을 넘지 않는 가장 촘촘한 폭', () => {
    expect(pickWidth(1847)).toBe(100)
    expect(pickWidth(6821)).toBe(500)
  })
})

describe('accumulate', () => {
  it('증가분만 그날 지수의 버킷에 담는다', () => {
    const rows = [
      { date: '20260101', idx: 5100, credit: 1000 },
      { date: '20260102', idx: 5200, credit: 1500 }, // +500 -> 5000 버킷
      { date: '20260103', idx: 5600, credit: 1200 }, // -300 -> grossDown
      { date: '20260104', idx: 5700, credit: 1900 }, // +700 -> 5500 버킷
    ]
    const acc = accumulate(rows, 500)
    expect(acc.buckets.get(5000)).toBe(500)
    expect(acc.buckets.get(5500)).toBe(700)
    expect(acc.grossUp).toBe(1200)
    expect(acc.grossDown).toBe(300)
  })
})

describe('accumulateOutflow', () => {
  it('감소분만 그날 지수의 버킷에 담는다', () => {
    const rows = [
      { date: '20260101', idx: 7100, credit: 2000 },
      { date: '20260102', idx: 7200, credit: 1400 }, // -600 -> 7000 버킷
      { date: '20260103', idx: 6600, credit: 1500 }, // +100 무시
      { date: '20260104', idx: 6700, credit: 1100 }, // -400 -> 6500 버킷
    ]
    const out = accumulateOutflow(rows, 500)
    expect(out.buckets.get(7000)).toBe(600)
    expect(out.buckets.get(6500)).toBe(400)
    expect(out.total).toBe(1000)
  })
})

describe('classify', () => {
  it('구간 상단/하단에 계수를 곱해 마진콜 레벨을 매기고 판정한다', () => {
    const buckets = new Map([[7000, 1_130_000]])
    const [b] = classify({ buckets, width: 500 }, 5663)
    expect(b.low).toBe(7000)
    expect(b.high).toBe(7500)
    expect(b.marginHigh).toBeCloseTo(6300, 6)   // 7500 x 0.84
    expect(b.marginLow).toBeCloseTo(5880, 6)    // 7000 x 0.84
    expect(b.triggered).toBe(true)              // 5663 < 6300
    expect(b.fullyTriggered).toBe(true)         // 5663 < 5880
    expect(b.jo).toBeCloseTo(1.13, 6)
  })

  it('마진콜 레벨보다 지수가 높으면 미진입', () => {
    const buckets = new Map([[5000, 4_160_000]])
    const [b] = classify({ buckets, width: 500 }, 5663)
    expect(b.marginHigh).toBeCloseTo(4620, 6)   // 5500 x 0.84
    expect(b.triggered).toBe(false)
  })
})

describe('weightedIndex', () => {
  it('버킷 중앙값을 금액으로 가중평균한다', () => {
    const buckets = new Map([[5000, 100], [6000, 300]])
    // (5500*100 + 6500*300) / 400 = 6250
    expect(weightedIndex(buckets, 500)).toBeCloseTo(6250, 6)
  })

  it('금액이 없으면 null', () => {
    expect(weightedIndex(new Map(), 500)).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/buckets"`

- [ ] **Step 3: `src/lib/buckets.ts` 작성**

`../jj-project2-liquidity analysis/scripts/lib/buckets.mjs` 전체를 읽어서 그대로 옮긴다. 주석도 유지한다. 타입만 추가한다:

```typescript
export type DailyRow = { date: string; idx: number; credit: number }
export type IdxRow = { date: string; idx: number }

export type Bucket = {
  low: number; high: number; jo: number
  marginHigh: number; marginLow: number
  triggered: boolean; fullyTriggered: boolean
}

export type BucketRow = { low: number; high: number; jo: number }

export type AccResult = {
  buckets: Map<number, number>
  grossUp: number; grossDown: number; width: number
}

export type OutflowResult = {
  buckets: Map<number, number>; total: number; width: number
}

export const MAINTENANCE = 1.40
export const LOAN_RATIO = 0.60

export const factorOf = (maint = MAINTENANCE, loan = LOAN_RATIO) => maint * loan
export const jo = (mil: number) => mil / 1e6
export const sumJo = (bs: { jo: number }[]) => bs.reduce((s, b) => s + b.jo, 0)
```

`analyzeMarket`의 반환 타입은 다음 형태로 정의한다 (기존 반환 객체와 필드 1:1 대응):

```typescript
export type MarketAnalysis = {
  churnScale: number
  netBuildJo: number
  scaledBuckets: Bucket[]
  scaledExposureJo: number
  scaledRemainingJo: number
  unwind: {
    fromDate: string; toDate: string
    buckets: BucketRow[]
    totalJo: number; netJo: number
    weightedBuildIdx: number | null
    weightedUnwindIdx: number | null
    spreadPct: number | null
  }
  width: number; accBase: string; accEnd: string; evalEnd: string
  headline: {
    idxPeakDate: string; idxPeak: number
    idxTroughDate: string; idxTrough: number
    idxDrawdownPct: number
    idxLast: number; idxLastDate: string
    creditStartJo: number
    creditPeakDate: string; creditPeakJo: number
    creditTroughDate: string; creditTroughJo: number
    creditLastJo: number; creditLastDate: string
    actualDeclineJo: number; unwindPct: number
    buildJo: number; exposureJo: number; remainingJo: number
    exposureOfBuildPct: number
  }
  buckets: Bucket[]
  walk: { date: string; idx: number; minIdx: number; exposureJo: number }[]
  scenarios: { idx: number; exposureJo: number }[]
  sensitivity: { maintenance: number; factor: number; exposureJo: number }[]
  reconciliation: {
    modelExposureJo: number; scaledExposureJo: number
    actualDeclineJo: number; gapJo: number; scaledGapJo: number
    grossUpJo: number; grossDownJo: number
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/lib/buckets.ts src/lib/__tests__/buckets.test.ts
git commit -m "feat: port bucket allocation and margin call logic to TypeScript"
```

---

### Task 3: KOFIA 데이터 수집 (`fetch-kofia.ts`)

**Files:**
- Create: `src/lib/fetch-kofia.ts`
- Test: `src/lib/__tests__/fetch-kofia.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `INDICATORS: Record<string, {name: string, sqlKey: string, unit: string}>` — OS0001/OS0002/OS0008/OS0009/OS0011/OS0012/OS0021/OS0024/OS0025/OS0026/OS0027 (OS0011/OS0012 = KOSPI/KOSDAQ 거래대금, 2026-07-30 원본에 추가된 지표 — 매일 자동 갱신되는 turnover 계산에 쓰인다)
  - `type KofiaRow = { date: string } & Partial<Record<KofiaCode, number>>`
  - `type KofiaCode = 'OS0001'|'OS0002'|'OS0008'|'OS0009'|'OS0011'|'OS0012'|'OS0021'|'OS0024'|'OS0025'|'OS0026'|'OS0027'`
  - `parseKofiaRows(rows: unknown[]): KofiaRow[]` — API 응답 그리드를 정규화. `"null"` 문자열/빈값 제거
  - `fetchKofiaRange(from: string, to: string): Promise<KofiaRow[]>` — 한 구간 조회
  - `fetchKofiaSeries(startYear: number, end: string): Promise<KofiaRow[]>` — 연 단위로 끊어서 전체 조회, 날짜 오름차순 정렬

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/__tests__/fetch-kofia.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseKofiaRows, INDICATORS } from '@/lib/fetch-kofia'

describe('INDICATORS', () => {
  it('신용융자는 OS0026, 백만원 단위', () => {
    expect(INDICATORS.OS0026.name).toBe('신용융자')
    expect(INDICATORS.OS0026.unit).toBe('백만원')
    expect(INDICATORS.OS0026.sqlKey).toBe('STATCRS0600000010VM021')
  })

  it('11개 지표를 다룬다', () => {
    expect(Object.keys(INDICATORS)).toHaveLength(11)
  })

  it('KOSPI/KOSDAQ 거래대금은 OS0011/OS0012, 억원 단위', () => {
    expect(INDICATORS.OS0011.name).toBe('KOSPI거래대금')
    expect(INDICATORS.OS0011.unit).toBe('억원')
    expect(INDICATORS.OS0012.name).toBe('KOSDAQ거래대금')
  })
})

describe('parseKofiaRows', () => {
  it('TMPV1을 date로, 지표 코드를 숫자로 정규화한다', () => {
    const rows = parseKofiaRows([
      { TMPV1: '20260728', OS0001: '6023.66', OS0026: '33194040' },
    ])
    expect(rows).toEqual([{ date: '20260728', OS0001: 6023.66, OS0026: 33194040 }])
  })

  it('"null" 문자열과 빈 값은 버린다', () => {
    const rows = parseKofiaRows([
      { TMPV1: '20260729', OS0001: '5663.24', OS0026: 'null', OS0025: '' },
    ])
    expect(rows).toEqual([{ date: '20260729', OS0001: 5663.24 }])
  })

  it('날짜가 없는 행은 버린다', () => {
    expect(parseKofiaRows([{ OS0001: '100' }])).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/fetch-kofia"`

- [ ] **Step 3: `src/lib/fetch-kofia.ts` 작성**

기존 `fetch-kofia.mjs`의 요청 형식과 동일하게 만든다. 파일 쓰기 로직은 제거하고 값을 반환한다.

```typescript
export const KOFIA_URL = 'https://freesis.kofia.or.kr/crossStatsCustom/STATCRS0600000011BO.do'

export const INDICATORS = {
  OS0001: { name: 'KOSPI지수', sqlKey: 'STATCRS0600000010VM001', unit: 'P' },
  OS0002: { name: 'KOSDAQ지수', sqlKey: 'STATCRS0600000010VM002', unit: 'P' },
  OS0008: { name: 'KOSPI시가총액', sqlKey: 'STATCRS0600000010VM008', unit: '억원' },
  OS0009: { name: 'KOSDAQ시가총액', sqlKey: 'STATCRS0600000010VM009', unit: '억원' },
  OS0011: { name: 'KOSPI거래대금', sqlKey: 'STATCRS0600000010VM010', unit: '억원' },
  OS0012: { name: 'KOSDAQ거래대금', sqlKey: 'STATCRS0600000010VM011', unit: '억원' },
  OS0026: { name: '신용융자', sqlKey: 'STATCRS0600000010VM021', unit: '백만원' },
  OS0025: { name: '반대매매금액', sqlKey: 'STATCRS0600000010VM020', unit: '백만원' },
  OS0024: { name: '위탁매매미수금', sqlKey: 'STATCRS0600000010VM019', unit: '백만원' },
  OS0021: { name: '투자자예탁금', sqlKey: 'STATCRS0600000010VM016', unit: '백만원' },
  OS0027: { name: '예탁증권담보융자', sqlKey: 'STATCRS0600000010VM022', unit: '백만원' },
} as const

export type KofiaCode = keyof typeof INDICATORS
export type KofiaRow = { date: string } & Partial<Record<KofiaCode, number>>

const CODES = Object.keys(INDICATORS) as KofiaCode[]

export function parseKofiaRows(rows: unknown[]): KofiaRow[] {
  const out: KofiaRow[] = []
  for (const raw of rows) {
    const row = raw as Record<string, unknown>
    const date = row.TMPV1
    if (typeof date !== 'string' || !date) continue
    const rec: KofiaRow = { date }
    for (const c of CODES) {
      const v = row[c]
      if (v == null || v === '') continue
      const n = Number(v)
      if (Number.isFinite(n)) rec[c] = n
    }
    out.push(rec)
  }
  return out
}

export async function fetchKofiaRange(from: string, to: string): Promise<KofiaRow[]> {
  const res = await fetch(KOFIA_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/json',
      Referer: 'https://freesis.kofia.or.kr/',
    },
    body: JSON.stringify({
      data: {
        userId: '',
        serviceId: 'STATCRS0600000011',
        tmpV1: 'D',
        tmpV45: from,
        tmpV46: to,
        tmpV108: CODES.join(','),
        sqlKey: CODES.map(c => INDICATORS[c].sqlKey).join(','),
        searchLog: 'N',
        ipAddress: '',
      },
    }),
  })
  if (!res.ok) throw new Error(`kofia ${res.status} for ${from}~${to}`)
  const json = await res.json()
  if (!json.success) throw new Error(`kofia said: ${json.message}`)
  return parseKofiaRows(json.dsDataGrid ?? [])
}

export async function fetchKofiaSeries(startYear: number, end: string): Promise<KofiaRow[]> {
  const byDate = new Map<string, KofiaRow>()
  const endYear = Number(end.slice(0, 4))
  for (let y = startYear; y <= endYear; y++) {
    const rows = await fetchKofiaRange(`${y}0101`, y === endYear ? end : `${y}1231`)
    for (const r of rows) byDate.set(r.date, { ...byDate.get(r.date), ...r })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체

- [ ] **Step 5: 실제 API 한 번 호출해서 동작 확인**

```bash
npx --yes tsx -e "import('./src/lib/fetch-kofia.ts').then(async m => { const r = await m.fetchKofiaRange('20260720','20260729'); console.log(r) })"
```

Expected: 날짜별 행이 출력되고, `20260728`의 `OS0026`이 `33194040`이다 (기존 검증값과 일치).
API가 응답하지 않으면 네트워크 문제로 기록하고 다음 단계로 진행한다 (단위 테스트는 이미 통과).

- [ ] **Step 6: 커밋**

```bash
git add src/lib/fetch-kofia.ts src/lib/__tests__/fetch-kofia.test.ts
git commit -m "feat: add KOFIA FREESIS daily statistics fetcher"
```

---

### Task 4: 분석 파이프라인 (`analyze.ts` + `types.ts`)

기존 `analyze.mjs`를 함수로 만든다. 파일 I/O 제거, 콘솔 출력 제거, 순수 함수로.

**Files:**
- Create: `src/lib/types.ts`, `src/lib/analyze.ts`
- Test: `src/lib/__tests__/analyze.test.ts`

**Interfaces:**
- Consumes: `@/lib/buckets` (Task 2, including `turnoverStats`/`buildLadder`/`TurnoverRow`), `@/lib/fetch-kofia`의 `KofiaRow` (Task 3, including `OS0011`/`OS0012`)
- Produces:
  - `PERIODS_BASE` — 사이클 정의 (`c2021`: accBase `20191231`, accEnd `20211231`, evalEnd `20230131`, closed true / `c2026`: accBase `20241231`, accEnd/evalEnd = 최신일, closed false)
  - `PDF_BARS: Record<number, number>` — 원 자료 재현 검증용 기준값
  - `buildAnalysis(series: KofiaRow[], splitSeries?: CreditSplitRow[]): AnalysisSnapshot` — `splitSeries`가 있으면 `유가증권`/`코스닥` 시장도 함께 분석한다 (2026-07-30 확장, 원본 `analyze.mjs`의 `전체`/`유가증권`/`코스닥` 3-시장 구조를 그대로 포팅)
  - `type AnalysisSnapshot` (in `types.ts`) — `meta`, `periods`, `repro`, `reproMAE`, `stress`, `projection`, `ratio`, `series`
  - `type CreditSplitRow = { date: string; total: number; kospi: number; kosdaq: number }` (in `types.ts`) — 백만원 단위, 원본 `credit-split.json`의 `series` 항목과 동일 shape

**시장 구성 (원본 `analyze.mjs` 그대로 포팅):**
- `전체`: `OS0026`(코스피+코스닥 합계 신용융자) × `OS0001`(코스피 지수), 거래대금은 `(OS0011+OS0012)/1e4`(조원)
- `유가증권`: `splitSeries`의 `kospi` 필드(코스피만 신용융자, 백만원) × `OS0001`, 거래대금은 `OS0011/1e4`
- `코스닥`: `splitSeries`의 `kosdaq` 필드(코스닥만 신용융자, 백만원) × `OS0002`, 거래대금은 `OS0012/1e4`
- `splitSeries`가 없으면(아직 수동 반영 전) `유가증권`/`코스닥`은 건너뛰고 `전체`만 계산한다 (원본의 `if (!split) return null` 동작과 동일)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/__tests__/analyze.test.ts`:

기존 `../jj-project2-liquidity analysis/data/kofia-daily.json`을 픽스처로 읽어서, 기존 `analysis.json`과 동일한 핵심 수치가 나오는지 확인한다. 이게 포팅 검증의 핵심이다.

```typescript
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildAnalysis } from '@/lib/analyze'
import type { KofiaRow } from '@/lib/fetch-kofia'
import type { CreditSplitRow } from '@/lib/types'

const FIXTURE = path.resolve(
  __dirname, '../../../../jj-project2-liquidity analysis/data/kofia-daily.json')
const SPLIT_FIXTURE = path.resolve(
  __dirname, '../../../../jj-project2-liquidity analysis/data/credit-split.json')

const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { series: KofiaRow[] }
const rawSplit = JSON.parse(fs.readFileSync(SPLIT_FIXTURE, 'utf8')) as { series: CreditSplitRow[] }
const snap = buildAnalysis(raw.series, rawSplit.series)

describe('buildAnalysis — 기존 분석 결과 재현', () => {
  it('두 사이클을 만든다', () => {
    expect(snap.periods.map(p => p.key)).toEqual(['c2021', 'c2026'])
  })

  it('마진콜 계수는 0.84', () => {
    expect(snap.meta.marginFactor).toBeCloseTo(0.84, 10)
  })

  it('2026 사이클 지수 고점 9,115p / 저점 5,663p', () => {
    const h = snap.periods[1].markets['전체'].headline
    expect(h.idxPeak).toBeCloseTo(9115, 0)
    expect(h.idxTrough).toBeCloseTo(5663.24, 2)
    expect(h.idxDrawdownPct).toBeCloseTo(-37.9, 1)
  })

  it('2026 사이클 신용 고점 38.63조, 청산률 -15.4%', () => {
    const h = snap.periods[1].markets['전체'].headline
    expect(h.creditPeakJo).toBeCloseTo(38.63, 2)
    expect(h.unwindPct).toBeCloseTo(-15.4, 1)
  })

  it('2026 사이클 churn 보정 마진콜 진입 4.72조', () => {
    expect(snap.periods[1].markets['전체'].scaledExposureJo).toBeCloseTo(4.72, 1)
  })

  it('2021 사이클 보정 모델 8.85조 vs 실측 9.84조', () => {
    const m = snap.periods[0].markets['전체']
    expect(m.scaledExposureJo).toBeCloseTo(8.85, 1)
    expect(m.headline.actualDeclineJo).toBeCloseTo(-9.84, 1)
  })

  it('원 자료 재현 평균절대오차가 0.1조 이내', () => {
    expect(snap.reproMAE).toBeLessThan(0.1)
  })

  it('잔여 청산 추정 벤치마크 4개, 상단 약 10.18조', () => {
    expect(snap.projection!.benches).toHaveLength(4)
    expect(snap.projection!.highJo).toBeCloseTo(10.18, 1)
  })

  it('splitSeries가 있으면 유가증권/코스닥 시장도 계산한다', () => {
    expect(snap.meta.hasSplit).toBe(true)
    expect(snap.meta.markets).toEqual(['전체', '유가증권', '코스닥'])
    expect(snap.periods[1].markets['유가증권']).toBeDefined()
    expect(snap.periods[1].markets['코스닥']).toBeDefined()
  })

  it('코스닥 사이클은 코스피보다 낙폭이 크고 신용융자 청산률도 더 높다', () => {
    const kospiOnly = snap.periods[1].markets['유가증권'].headline
    const kosdaqOnly = snap.periods[1].markets['코스닥'].headline
    expect(kosdaqOnly.idxDrawdownPct).toBeCloseTo(-46.0, 0)
    expect(kospiOnly.idxDrawdownPct).toBeCloseTo(-37.9, 0)
    expect(kosdaqOnly.unwindPct).toBeCloseTo(-38.3, 0)
    expect(kospiOnly.unwindPct).toBeCloseTo(-13.5, 0)
  })

  it('splitSeries가 없으면 전체만 계산하고 나머지는 건너뛴다', () => {
    const snapNoSplit = buildAnalysis(raw.series)
    expect(snapNoSplit.meta.hasSplit).toBe(false)
    expect(snapNoSplit.meta.markets).toEqual(['전체'])
    expect(snapNoSplit.periods[1].markets['유가증권']).toBeUndefined()
  })

  it('전체 시장에 거래대금 대비 규모(turnover)와 마진콜 사다리(ladder)가 붙는다', () => {
    const m = snap.periods[1].markets['전체']
    expect(m.turnover).not.toBeNull()
    expect(m.turnover!.unwindDays).toBeGreaterThan(0)
    expect(m.ladder.length).toBeGreaterThan(0)
    expect(m.unwind.pctOfTurnover).not.toBeNull()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/analyze"`

- [ ] **Step 3: `src/lib/types.ts` 작성**

```typescript
import type { MarketAnalysis } from '@/lib/buckets'

export type PeriodAnalysis = {
  key: string; name: string; note: string
  accBase: string; accEnd: string; evalEnd: string; closed: boolean
  markets: Record<string, MarketAnalysis>
}

export type ReproRow = {
  low: number; high: number; pdf: number; mine: number; diff: number
}

export type RatioPoint = {
  date: string; mcapJo: number; creditJo: number; ratio: number
}

export type StressRow = {
  date: string; idx: number; kosdaq: number | null
  forced: number; unpaid: number; credit: number | null
}

export type Bench = {
  key: string; name: string; basis: string
  totalJo: number; remainJo: number; caveat: string
}

export type Projection = {
  doneJo: number; peakJo: number
  currentRatio: RatioPoint | null
  peakRatio: RatioPoint | null
  prevPeakRatio: RatioPoint | null
  prevTroughRatio: RatioPoint | null
  benches: Bench[]
  lowJo: number; highJo: number
  scenarioRemain: { idx: number; exposureJo: number; extraJo: number }[]
}

export type CreditSplitRow = { date: string; total: number; kospi: number; kosdaq: number }

export type AnalysisSnapshot = {
  meta: {
    maintenance: number; loanRatio: number; marginFactor: number
    markets: string[]
    hasSplit: boolean
    lastDate: string
  }
  periods: PeriodAnalysis[]
  repro: ReproRow[]
  reproMAE: number
  stress: StressRow[]
  projection: Projection | null
  ratio: RatioPoint[]
  series: { d: string; i: number; q: number | null; c: number | null }[]
}
```

- [ ] **Step 4: `src/lib/analyze.ts` 작성**

**원본은 2026-07-30 구현 중 갱신되어 `유가증권`/`코스닥` 분리 시장과 거래대금(turnover) 계산이 추가됐다 (design spec §10 참조, 사용자 승인 완료). 이 최신 버전 전체를 포팅한다 — 더 이상 범위 밖이 아니다.**

`analyze.mjs`의 로직을 그대로 옮긴다 (`../jj-project2-liquidity analysis/scripts/analyze.mjs`를 처음부터 끝까지 다시 읽고 포팅할 것 — 이전에 읽은 버전과 다를 수 있다). 차이점만:
- `fs`/`path` 제거, `series`와 `splitSeries?: CreditSplitRow[]`를 인자로 받는다 (파일에서 읽지 않는다)
- `MARKETS = ['전체', '유가증권', '코스닥']`, `idxKey = {전체:'OS0001', 유가증권:'OS0001', 코스닥:'OS0002'}` 그대로 포팅
- `buildInput(market)`: `전체`는 `OS0026` × `idxKey[market]`; `유가증권`/`코스닥`은 `splitSeries`가 있을 때만 `kospi`/`kosdaq` 필드 사용 (없으면 `null` 반환하고 그 시장은 건너뜀 — 원본의 `if (!split) return null`과 동일)
- `buildTurnover(market)`: `전체`는 `(OS0011+OS0012)/1e4`(조원), `유가증권`은 `OS0011/1e4`, `코스닥`은 `OS0012/1e4` — 이 값을 `analyzeMarket()`의 `turnoverRows`로 넘긴다
- `periods` 계산 시 `inputs`의 각 시장에 대해 `analyzeMarket({...input, turnoverRows: turnoverByMarket[name], accBase, accEnd, evalEnd})` 호출
- 콘솔 리포트 부분(`console.log`로 시작하는 전체 블록) 전체 제거
- `meta.source`/`meta.splitSource` 대신 `meta.lastDate`, `meta.hasSplit: !!splitSeries` 저장

```typescript
import {
  analyzeMarket, accumulate, classify, factorOf,
  MAINTENANCE, LOAN_RATIO,
  type DailyRow, type IdxRow, type MarketAnalysis, type TurnoverRow,
} from '@/lib/buckets'
import type { KofiaRow } from '@/lib/fetch-kofia'
import type {
  AnalysisSnapshot, PeriodAnalysis, ReproRow, RatioPoint, StressRow, Bench, Projection,
  CreditSplitRow,
} from '@/lib/types'

export const PDF_BARS: Record<number, number> = {
  4000: 0.36, 4500: 2.10, 5000: 4.00, 5500: 3.23, 6000: 2.86, 6500: 0.97,
  7000: 1.07, 7500: 1.28, 8000: 2.87, 8500: 0.92, 9000: 0.72,
}

export function buildAnalysis(series: KofiaRow[], splitSeries?: CreditSplitRow[]): AnalysisSnapshot {
  // ... analyze.mjs 의 PERIODS 정의, MARKETS, buildInput, buildTurnover, periods 계산,
  //     repro/reproMAE, ratioSeries, projectRemaining, stress 를 그대로 옮긴다.
  //     splitSeries가 undefined면 유가증권/코스닥은 건너뛴다.
}
```

옮길 때 주의:
- `lastDate`는 `series.at(-1)!.date`
- `projectRemaining`의 4개 벤치마크 `basis`/`caveat` 한국어 문구는 원문 그대로 유지
- `ratio`는 원본처럼 5개 간격 샘플링 + 마지막 항목 포함
- `projectRemaining`/`repro`/`ratio`/`stress`는 항상 `전체` 시장 기준 (원본과 동일, 시장별로 만들지 않는다)

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체. 수치가 어긋나면 포팅 오류이므로 `buckets.ts`/`analyze.ts`를 원본과 한 줄씩 대조한다.

- [ ] **Step 6: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add src/lib/types.ts src/lib/analyze.ts src/lib/__tests__/analyze.test.ts
git commit -m "feat: port analysis pipeline producing cycle comparison snapshot"
```

---

### Task 5: Supabase 스키마 + 클라이언트 + 쿼리

**Files:**
- Create: `src/lib/supabase.ts`, `src/lib/queries.ts`
- Modify: `.env.local` (Supabase 키 추가)
- Test: `src/lib/__tests__/queries.test.ts`

**Interfaces:**
- Consumes: `AnalysisSnapshot`, `CreditSplitRow` (Task 4)
- Produces:
  - `getServiceClient(): SupabaseClient` — service role key 사용, 서버 전용
  - `getPublicClient(): SupabaseClient` — publishable key 사용, 읽기 전용
  - `saveDailyMarket(rows: KofiaRow[]): Promise<void>` — `daily_market` upsert (OS0011/OS0012 거래대금 포함)
  - `saveSnapshot(snap: AnalysisSnapshot): Promise<void>` — 기존 `is_latest`를 false로 내리고 새 행 insert
  - `saveCommentary(date: string, content: string, model: string): Promise<void>`
  - `getLatestSnapshot(): Promise<AnalysisSnapshot | null>`
  - `getLatestCommentary(): Promise<{date: string, content: string} | null>`
  - `getLatestCreditSplit(): Promise<CreditSplitRow[]>` — `credit_split_raw`의 전체 시계열 조회 (2026-07-30 확장, 매일 배치가 시장분리 분석에 재사용)
  - `daysSince(dateYYYYMMDD: string, now: Date): number` — 데이터 신선도 계산 (순수 함수, 테스트 대상)
- 이 태스크에는 Supabase 코드와 별개로 `scripts/ingest-split.mjs` (수동 실행용 플레인 Node 스크립트, Next.js 런타임과 무관, 테스트 대상 아님)도 포함한다 — 사용자가 FREESIS에서 내려받은 분리 계열 파일을 Supabase `credit_split_raw`에 반영하는 일회성 도구.

- [ ] **Step 1: Supabase 테이블 생성**

Supabase MCP `apply_migration`으로 프로젝트 `jsxhcqnupvvctnjiaric`에 적용:

```sql
create table if not exists public.daily_market (
  date text primary key,
  kospi numeric,
  kosdaq numeric,
  credit_loan numeric,
  forced_sell numeric,
  unpaid numeric,
  kospi_market_cap numeric,
  kosdaq_market_cap numeric,
  kospi_turnover numeric,
  kosdaq_turnover numeric,
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_split_raw (
  date text primary key,
  total numeric not null,
  kospi numeric not null,
  kosdaq numeric not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.analysis_snapshot (
  id bigserial primary key,
  computed_at timestamptz not null default now(),
  last_date text not null,
  is_latest boolean not null default true,
  data jsonb not null
);
create index if not exists analysis_snapshot_latest_idx
  on public.analysis_snapshot (is_latest) where is_latest;

create table if not exists public.ai_commentary (
  id bigserial primary key,
  date text not null unique,
  content text not null,
  model text not null,
  created_at timestamptz not null default now()
);

alter table public.daily_market enable row level security;
alter table public.credit_split_raw enable row level security;
alter table public.analysis_snapshot enable row level security;
alter table public.ai_commentary enable row level security;

create policy "public read daily_market" on public.daily_market
  for select using (true);
create policy "public read credit_split_raw" on public.credit_split_raw
  for select using (true);
create policy "public read analysis_snapshot" on public.analysis_snapshot
  for select using (true);
create policy "public read ai_commentary" on public.ai_commentary
  for select using (true);
```

쓰기 정책은 만들지 않는다. 서버 라우트가 service role key로 RLS를 우회한다.

- [ ] **Step 2: 환경변수 등록**

Supabase MCP `get_project_url`, `get_publishable_keys`로 값을 얻어 `.env.local`에 추가한다.
service role key는 MCP로 얻을 수 없으므로 **사용자에게 요청한다** (Supabase 대시보드 > Project Settings > API > service_role).

```
NEXT_PUBLIC_SUPABASE_URL=https://jsxhcqnupvvctnjiaric.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<사용자에게 요청>
CRON_SECRET=<openssl rand -hex 32 로 생성>
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
```

- [ ] **Step 3: 실패하는 테스트 작성**

`src/lib/__tests__/queries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { daysSince } from '@/lib/queries'

describe('daysSince', () => {
  it('같은 날이면 0', () => {
    expect(daysSince('20260729', new Date('2026-07-29T15:00:00+09:00'))).toBe(0)
  })

  it('하루 지나면 1', () => {
    expect(daysSince('20260729', new Date('2026-07-30T09:00:00+09:00'))).toBe(1)
  })

  it('여러 날 지난 경우', () => {
    expect(daysSince('20260720', new Date('2026-07-30T09:00:00+09:00'))).toBe(10)
  })
})
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/queries"`

- [ ] **Step 5: `src/lib/supabase.ts` 작성**

```bash
npm install @supabase/supabase-js
```

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다`)
  return v
}

export function getServiceClient(): SupabaseClient {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
}

export function getPublicClient(): SupabaseClient {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { persistSession: false } },
  )
}
```

- [ ] **Step 6: `src/lib/queries.ts` 작성**

```typescript
import { getServiceClient, getPublicClient } from '@/lib/supabase'
import type { AnalysisSnapshot, CreditSplitRow } from '@/lib/types'
import type { KofiaRow } from '@/lib/fetch-kofia'

export function daysSince(dateYYYYMMDD: string, now: Date): number {
  const y = Number(dateYYYYMMDD.slice(0, 4))
  const m = Number(dateYYYYMMDD.slice(4, 6))
  const d = Number(dateYYYYMMDD.slice(6, 8))
  const then = Date.UTC(y, m - 1, d)
  // KST 기준 날짜로 비교 (한국 장 마감 기준 데이터)
  const kst = new Date(now.getTime() + 9 * 3600 * 1000)
  const today = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate())
  return Math.round((today - then) / 86_400_000)
}

export async function saveDailyMarket(rows: KofiaRow[]): Promise<void> {
  const sb = getServiceClient()
  const payload = rows.map(r => ({
    date: r.date,
    kospi: r.OS0001 ?? null,
    kosdaq: r.OS0002 ?? null,
    credit_loan: r.OS0026 ?? null,
    forced_sell: r.OS0025 ?? null,
    unpaid: r.OS0024 ?? null,
    kospi_market_cap: r.OS0008 ?? null,
    kosdaq_market_cap: r.OS0009 ?? null,
    kospi_turnover: r.OS0011 ?? null,
    kosdaq_turnover: r.OS0012 ?? null,
    updated_at: new Date().toISOString(),
  }))
  // 행이 많으므로 1000개씩 나눠 upsert
  for (let i = 0; i < payload.length; i += 1000) {
    const { error } = await sb.from('daily_market')
      .upsert(payload.slice(i, i + 1000), { onConflict: 'date' })
    if (error) throw new Error(`daily_market upsert 실패: ${error.message}`)
  }
}

export async function getLatestCreditSplit(): Promise<CreditSplitRow[]> {
  const sb = getPublicClient()
  const { data, error } = await sb.from('credit_split_raw')
    .select('date, total, kospi, kosdaq').order('date', { ascending: true })
  if (error || !data) return []
  return data as CreditSplitRow[]
}

export async function saveSnapshot(snap: AnalysisSnapshot): Promise<void> {
  const sb = getServiceClient()
  const { error: e1 } = await sb.from('analysis_snapshot')
    .update({ is_latest: false }).eq('is_latest', true)
  if (e1) throw new Error(`snapshot 플래그 갱신 실패: ${e1.message}`)
  const { error: e2 } = await sb.from('analysis_snapshot')
    .insert({ last_date: snap.meta.lastDate, is_latest: true, data: snap })
  if (e2) throw new Error(`snapshot 저장 실패: ${e2.message}`)
}

export async function saveCommentary(date: string, content: string, model: string): Promise<void> {
  const sb = getServiceClient()
  const { error } = await sb.from('ai_commentary')
    .upsert({ date, content, model }, { onConflict: 'date' })
  if (error) throw new Error(`해설 저장 실패: ${error.message}`)
}

export async function getLatestSnapshot(): Promise<AnalysisSnapshot | null> {
  const sb = getPublicClient()
  const { data, error } = await sb.from('analysis_snapshot')
    .select('data').eq('is_latest', true)
    .order('computed_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  return data.data as AnalysisSnapshot
}

export async function getLatestCommentary(): Promise<{ date: string; content: string } | null> {
  const sb = getPublicClient()
  const { data, error } = await sb.from('ai_commentary')
    .select('date, content')
    .order('date', { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  return data as { date: string; content: string }
}
```

- [ ] **Step 7: 분리 계열 수동 반영 스크립트 (`scripts/ingest-split.mjs`)**

유가증권/코스닥 분리 신용융자는 금투협 API로 자동 수집이 안 된다 (design spec §10.2). 사용자가
FREESIS 화면에서 파일을 내려받아 이 스크립트로 Supabase에 반영한다. 원본
`../jj-project2-liquidity analysis/scripts/ingest-split.mjs`을 그대로 복사해 온 뒤, **파싱 로직
(xlsx/HTML표/CSV 자동판별, 컬럼 위치 투표, 단위 판정)은 한 글자도 바꾸지 않고**, 마지막 출력
단계만 "JSON 파일 쓰기"에서 "Supabase upsert"로 바꾼다. 이 스크립트는 Next.js 런타임과 무관한
1회성 관리 도구이므로 Vitest 테스트 대상이 아니다.

`mkdir -p data`로 프로젝트에 빈 `data/` 디렉터리를 만든다 (사용자가 내려받은 파일을 여기 둠,
`.gitignore`에 `/data/*.xlsx`, `/data/*.xls`, `/data/*.csv` 추가해서 커밋되지 않게 한다).

원본 파일 전체(237줄)를 읽어서 `pickFile`, `fromXlsx`, `fromHtmlTable`, `fromDelimited`,
`splitCsv`, `readMatrix`, `toNum`, `toDate`, `locate`, 컬럼 투표 로직까지 전부 그대로 옮긴다.
바뀌는 부분만 아래에 명시한다 (이 부분 외에는 원본과 동일):

```javascript
// 파일 맨 위 import 추가
import { createClient } from '@supabase/supabase-js';

// ... (원본의 pickFile ~ series 계산까지 전부 동일하게 옮긴 뒤) ...

// 원본의 `fs.writeFileSync(OUT, JSON.stringify({...}))` 블록을 아래로 교체:
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.'
    + ' node --env-file=.env.local scripts/ingest-split.mjs 로 실행하세요.');
  process.exit(1);
}
const sb = createClient(url, key);
const payload = series.map(r => ({ date: r.date, total: r.total, kospi: r.kospi, kosdaq: r.kosdaq }));
for (let i = 0; i < payload.length; i += 1000) {
  const { error } = await sb.from('credit_split_raw')
    .upsert(payload.slice(i, i + 1000), { onConflict: 'date' });
  if (error) throw new Error(`credit_split_raw upsert 실패: ${error.message}`);
}
console.log(`credit_split_raw 갱신 완료: ${series.length}일  ${series[0].date}..${series.at(-1).date}`);
```

원본 스크립트 끝부분의 "이미 확보한 '전체' 계열과 교차 검증" 블록(`kofia-daily.json`을
직접 읽는 부분)은 이 프로젝트엔 로컬 파일이 없으므로 제거한다.

`package.json`의 `"scripts"`에 추가: `"ingest-split": "node --env-file=.env.local scripts/ingest-split.mjs"`

- [ ] **Step 8: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체 (Step 7의 스크립트는 테스트 대상이 아니므로 영향 없음)

- [ ] **Step 9: 커밋**

```bash
git add src/lib/supabase.ts src/lib/queries.ts src/lib/__tests__/queries.test.ts scripts/ingest-split.mjs package.json .gitignore
git commit -m "feat: add Supabase schema, clients, queries and split-data ingestion script"
```

---

### Task 6: OpenRouter 래퍼 + 포맷 헬퍼

**Files:**
- Create: `src/lib/openrouter.ts`, `src/lib/format.ts`
- Test: `src/lib/__tests__/openrouter.test.ts`, `src/lib/__tests__/format.test.ts`

**Interfaces:**
- Consumes: `AnalysisSnapshot` (Task 4)
- Produces:
  - `DISCLAIMER = '본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.'`
  - `CHAT_SYSTEM_PROMPT: string`
  - `summarizeForPrompt(snap: AnalysisSnapshot): string` — 스냅샷을 프롬프트용 요약 텍스트로 (순수 함수)
  - `fallbackCommentary(snap: AnalysisSnapshot): string` — AI 실패 시 대체 문구 (순수 함수)
  - `callOpenRouter(messages: {role: string, content: string}[]): Promise<string>`
  - `generateCommentary(snap: AnalysisSnapshot): Promise<{content: string, model: string}>` — 실패 시 `fallbackCommentary` 반환
  - `formatJo(n: number): string` → `'4.72조원'`
  - `formatIdx(n: number): string` → `'5,663p'`
  - `formatPct(n: number): string` → `'-37.9%'`
  - `formatDateKo(d: string): string` → `'2026년 7월 29일'`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/__tests__/format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

describe('formatJo', () => {
  it('조원 단위 소수 둘째 자리', () => {
    expect(formatJo(4.7169)).toBe('4.72조원')
    expect(formatJo(-9.84)).toBe('-9.84조원')
  })
})

describe('formatIdx', () => {
  it('지수는 정수 + 천단위 콤마 + p', () => {
    expect(formatIdx(5663.24)).toBe('5,663p')
    expect(formatIdx(9115)).toBe('9,115p')
  })
})

describe('formatPct', () => {
  it('퍼센트는 소수 첫째 자리', () => {
    expect(formatPct(-37.94)).toBe('-37.9%')
    expect(formatPct(15.42)).toBe('15.4%')
  })
})

describe('formatDateKo', () => {
  it('YYYYMMDD를 한국어 날짜로', () => {
    expect(formatDateKo('20260729')).toBe('2026년 7월 29일')
    expect(formatDateKo('20260101')).toBe('2026년 1월 1일')
  })
})
```

`src/lib/__tests__/openrouter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { summarizeForPrompt, fallbackCommentary, DISCLAIMER, CHAT_SYSTEM_PROMPT } from '@/lib/openrouter'
import { buildAnalysis } from '@/lib/analyze'
import type { KofiaRow } from '@/lib/fetch-kofia'

const FIXTURE = path.resolve(
  __dirname, '../../../../jj-project2-liquidity analysis/data/kofia-daily.json')
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { series: KofiaRow[] }
const snap = buildAnalysis(raw.series)

describe('DISCLAIMER', () => {
  it('면책 문구가 정확히 일치한다', () => {
    expect(DISCLAIMER).toBe('본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.')
  })
})

describe('CHAT_SYSTEM_PROMPT', () => {
  it('투자 조언 금지 지시를 포함한다', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('투자 조언')
    expect(CHAT_SYSTEM_PROMPT).toContain('종목')
  })
})

describe('summarizeForPrompt', () => {
  it('핵심 수치를 포함한 요약 텍스트를 만든다', () => {
    const s = summarizeForPrompt(snap)
    expect(s).toContain('5,663p')
    expect(s).toContain('38.63조원')
    expect(s.length).toBeGreaterThan(200)
    expect(s.length).toBeLessThan(4000)
  })
})

describe('fallbackCommentary', () => {
  it('AI 없이도 숫자가 담긴 문장을 만든다', () => {
    const s = fallbackCommentary(snap)
    expect(s).toContain('5,663p')
    expect(s).toContain('조원')
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — 모듈 해석 실패

- [ ] **Step 3: `src/lib/format.ts` 작성**

```typescript
export const formatJo = (n: number) => `${n.toFixed(2)}조원`
export const formatIdx = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}p`
export const formatPct = (n: number) => `${n.toFixed(1)}%`

export function formatDateKo(d: string): string {
  const y = d.slice(0, 4)
  const m = Number(d.slice(4, 6))
  const day = Number(d.slice(6, 8))
  return `${y}년 ${m}월 ${day}일`
}
```

- [ ] **Step 4: `src/lib/openrouter.ts` 작성**

```typescript
import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

export const DISCLAIMER =
  '본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.'

export const CHAT_SYSTEM_PROMPT = `당신은 한국 증시의 신용융자·반대매매 통계를 설명하는 도우미입니다.

규칙:
- 제공된 데이터에 있는 내용만 근거로 답하세요. 데이터에 없으면 "제공된 데이터로는 알 수 없습니다"라고 답하세요.
- 개별 종목 추천, 매수·매도 판단, 목표가 제시는 절대 하지 마세요. 그런 질문에는 답할 수 없다고 알리세요.
- 비개발자·비전문가가 이해할 수 있는 쉬운 한국어로 설명하세요. 전문 용어는 짧게 풀어 쓰세요.
- 숫자를 인용할 때는 제공된 데이터의 값을 그대로 쓰세요. 추측한 숫자를 만들지 마세요.
- 답변은 3~5문장으로 간결하게.`

export function summarizeForPrompt(snap: AnalysisSnapshot): string {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  const prev = snap.periods.find(p => p.closed)?.markets['전체']
  const p = snap.projection
  const lines: string[] = []

  if (cur) {
    const h = cur.headline
    lines.push(`[현재 사이클 2025–26, 기준일 ${formatDateKo(h.idxLastDate)}]`)
    lines.push(`코스피: 고점 ${formatIdx(h.idxPeak)} (${formatDateKo(h.idxPeakDate)}) → 저점 ${formatIdx(h.idxTrough)}, 낙폭 ${formatPct(h.idxDrawdownPct)}`)
    lines.push(`신용융자: 고점 ${formatJo(h.creditPeakJo)} (${formatDateKo(h.creditPeakDate)}) → 현재 ${formatJo(h.creditLastJo)}, 청산 ${formatJo(h.actualDeclineJo)} (${formatPct(h.unwindPct)})`)
    lines.push(`마진콜 진입 추정(보정): ${formatJo(cur.scaledExposureJo)} / 미진입 ${formatJo(cur.scaledRemainingJo)}`)
    lines.push(`지수대별 신용매수(보정, 조원): ` +
      cur.scaledBuckets.filter(b => b.jo >= 0.05)
        .map(b => `${b.low}-${b.high}p=${b.jo.toFixed(2)}${b.fullyTriggered ? '(청산완료)' : b.triggered ? '(진행)' : ''}`)
        .join(', '))
  }
  if (prev) {
    const h = prev.headline
    lines.push(`[비교 사이클 2020–21, 이미 끝난 국면]`)
    lines.push(`코스피 낙폭 ${formatPct(h.idxDrawdownPct)}, 신용융자 고점 ${formatJo(h.creditPeakJo)} → 청산 ${formatJo(h.actualDeclineJo)} (${formatPct(h.unwindPct)})`)
    lines.push(`모델 추정 ${formatJo(prev.scaledExposureJo)} vs 실측 ${formatJo(-h.actualDeclineJo)} — 끝난 사이클에서 모델이 검증됨`)
  }
  if (p) {
    lines.push(`[앞으로 남은 청산 규모 추정]`)
    lines.push(`이미 청산 ${formatJo(p.doneJo)}, 잔여 추정 범위 ${formatJo(p.lowJo)} ~ ${formatJo(p.highJo)}`)
    for (const b of p.benches) {
      lines.push(`- ${b.name}: 총 ${formatJo(b.totalJo)} → 잔여 ${formatJo(b.remainJo)} / 근거: ${b.basis} / 단서: ${b.caveat}`)
    }
    lines.push(`추가 하락 시 새로 마진콜에 들어오는 물량: ` +
      p.scenarioRemain.map(s => `${formatIdx(s.idx)}=+${s.extraJo.toFixed(2)}조`).join(', '))
  }
  lines.push(`[방법론 요약] 담보유지비율 ${snap.meta.maintenance}, 융자비율 ${snap.meta.loanRatio}, 마진콜 계수 ${snap.meta.marginFactor.toFixed(2)} (매수 지수 대비 -16%에서 반대매매 발생). 지수대별 배분은 일별 신용융자 증가분을 그날 지수 구간에 누적한 값(gross)이며, 중복 계상을 보정해 실제 순증에 맞춰 스케일했다.`)
  return lines.join('\n')
}

export function fallbackCommentary(snap: AnalysisSnapshot): string {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  if (!cur) return `데이터를 준비하는 중입니다. ${DISCLAIMER}`
  const h = cur.headline
  const p = snap.projection
  const range = p ? ` 남은 청산 규모는 여러 기준으로 볼 때 ${formatJo(Math.max(0, p.lowJo))}에서 ${formatJo(p.highJo)} 사이로 추정됩니다.` : ''
  return `${formatDateKo(h.idxLastDate)} 기준 코스피는 ${formatIdx(h.idxLast)}입니다.`
    + ` 고점 ${formatIdx(h.idxPeak)} 대비 ${formatPct(h.idxDrawdownPct)} 내려왔습니다.`
    + ` 신용융자는 고점 ${formatJo(h.creditPeakJo)}에서 ${formatJo(h.creditLastJo)}로 ${formatJo(Math.abs(h.actualDeclineJo))} 줄었습니다(${formatPct(h.unwindPct)}).`
    + range
}

export async function callOpenRouter(
  messages: { role: string; content: string }[],
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY 가 설정되지 않았습니다')
  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5'

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: 800, temperature: 0.3 }),
  })
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`)
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('openrouter 응답에 내용이 없습니다')
  }
  return content.trim()
}

export async function generateCommentary(
  snap: AnalysisSnapshot,
): Promise<{ content: string; model: string }> {
  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5'
  try {
    const content = await callOpenRouter([
      {
        role: 'system',
        content: `당신은 한국 증시 통계를 일반인에게 설명하는 필자입니다.
아래 데이터만 근거로, 오늘 시장 상황과 앞으로 얼마나 더 하락 여력이 있는지를
비전문가가 이해할 수 있는 쉬운 한국어로 4~6문장으로 써주세요.

규칙:
- 개별 종목 추천, 매수·매도 판단, 목표가 제시 금지.
- 데이터에 없는 숫자를 만들지 마세요.
- "반드시", "확실히" 같은 단정 표현 대신 "추정", "~로 보입니다"를 쓰세요.
- 마지막 문장에 불확실성을 한 번 짚어주세요.`,
      },
      { role: 'user', content: summarizeForPrompt(snap) },
    ])
    return { content, model }
  } catch {
    return { content: fallbackCommentary(snap), model: 'fallback' }
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체

- [ ] **Step 6: OpenRouter 실제 호출 확인**

```bash
npx --yes tsx -e "
require('dotenv').config({ path: '.env.local' });
import('./src/lib/openrouter.ts').then(async m => {
  console.log(await m.callOpenRouter([{ role: 'user', content: '한 문장으로 자기소개해줘' }]))
})"
```

Expected: 한국어 응답 한 문장. 실패하면 키/모델명을 점검한다.

- [ ] **Step 7: 커밋**

```bash
git add src/lib/format.ts src/lib/openrouter.ts src/lib/__tests__/format.test.ts src/lib/__tests__/openrouter.test.ts
git commit -m "feat: add OpenRouter wrapper with commentary generation and Korean formatters"
```

---

### Task 7: 일일 배치 API (`/api/cron/daily-update`)

**Files:**
- Create: `src/app/api/cron/daily-update/route.ts`, `vercel.json`

**Interfaces:**
- Consumes: `fetchKofiaSeries` (Task 3), `buildAnalysis` (Task 4), `saveDailyMarket`/`saveSnapshot`/`saveCommentary`/`getLatestCreditSplit` (Task 5), `generateCommentary` (Task 6)
- Produces: `POST`/`GET` 핸들러. 응답 `{ ok: true, lastDate, rows, model }` 또는 `{ ok: false, error }`
- **분리 계열 연동**: 이 라우트는 분리 계열을 직접 받아오지 않는다 (수동 반영, Task 5 §Step 7). 대신 매번 `getLatestCreditSplit()`으로 Supabase에 저장된 최신 분리 데이터를 읽어 `buildAnalysis(series, splitSeries)`에 넘긴다 — 그래서 사용자가 가끔 분리 파일을 갱신하기만 하면 그 다음 매일 배치부터 자동으로 세 시장 분석에 반영된다.

- [ ] **Step 1: `vercel.json` 작성**

한국 장 마감(15:30 KST) 이후 여유를 두고 18:00 KST = 09:00 UTC에 실행.

```json
{
  "crons": [
    { "path": "/api/cron/daily-update", "schedule": "0 9 * * 1-5" }
  ]
}
```

- [ ] **Step 2: 라우트 작성**

```typescript
import { NextResponse } from 'next/server'
import { fetchKofiaSeries } from '@/lib/fetch-kofia'
import { buildAnalysis } from '@/lib/analyze'
import { saveDailyMarket, saveSnapshot, saveCommentary, getLatestCreditSplit } from '@/lib/queries'
import { generateCommentary } from '@/lib/openrouter'

export const maxDuration = 300

function todayKST(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 10).replace(/-/g, '')
}

async function run() {
  const [series, splitSeries] = await Promise.all([
    fetchKofiaSeries(2010, todayKST()),
    getLatestCreditSplit(),
  ])
  if (!series.length) throw new Error('KOFIA 응답이 비어 있습니다')

  const snap = buildAnalysis(series, splitSeries.length ? splitSeries : undefined)
  await saveDailyMarket(series)
  await saveSnapshot(snap)

  const { content, model } = await generateCommentary(snap)
  await saveCommentary(snap.meta.lastDate, content, model)

  return { lastDate: snap.meta.lastDate, rows: series.length, model }
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: '인증 실패' }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, ...(await run()) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[cron] 갱신 실패:', msg)
    // 실패해도 500 을 던져 Vercel 이 재시도할 수 있게 한다.
    // 기존 스냅샷은 그대로 남아 있으므로 화면은 계속 동작한다.
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export const POST = GET
```

- [ ] **Step 3: 로컬에서 배치 실행**

```bash
npm run dev
```

다른 셸에서 (CRON_SECRET 값을 `.env.local`에서 읽어 사용):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/daily-update
```

Expected: `{"ok":true,"lastDate":"2026...","rows":<4000 이상>,"model":"anthropic/claude-haiku-4.5"}`

- [ ] **Step 4: 인증 없이 호출하면 막히는지 확인**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/cron/daily-update
```

Expected: `401`

- [ ] **Step 5: Supabase에 저장됐는지 확인**

Supabase MCP `execute_sql`로:

```sql
select count(*) as rows from public.daily_market;
select last_date, computed_at, is_latest from public.analysis_snapshot order by id desc limit 3;
select date, model, left(content, 80) as preview from public.ai_commentary order by date desc limit 1;
```

Expected: `daily_market` 수천 행, `analysis_snapshot`에 `is_latest=true` 한 행, `ai_commentary`에 한국어 해설 한 행

- [ ] **Step 6: 커밋**

```bash
git add src/app/api/cron/daily-update/route.ts vercel.json
git commit -m "feat: add daily cron route fetching data, computing analysis and AI commentary"
```

---

### Task 8: 대시보드 화면

**Files:**
- Create: `src/components/disclaimer.tsx`, `src/components/stale-banner.tsx`, `src/components/summary-cards.tsx`, `src/components/ai-commentary.tsx`, `src/components/cycle-compare.tsx`, `src/components/projection-card.tsx`
- Modify: `src/app/layout.tsx`, `src/app/page.tsx`

**Interfaces:**
- Consumes: `getLatestSnapshot`/`getLatestCommentary`/`daysSince` (Task 5), `AnalysisSnapshot` (Task 4), format 헬퍼 (Task 6), shadcn 컴포넌트 (Task 1)
- Produces: 각 컴포넌트는 `{ snap: AnalysisSnapshot }` 또는 필요한 부분만 props로 받는 서버 컴포넌트. `cycle-compare.tsx`만 recharts 때문에 `'use client'`.

- [ ] **Step 1: recharts 설치**

```bash
npm install recharts
```

- [ ] **Step 2: `disclaimer.tsx`**

```tsx
import { DISCLAIMER } from '@/lib/openrouter'

export function Disclaimer() {
  return (
    <p className="text-xs text-muted-foreground">{DISCLAIMER}</p>
  )
}
```

- [ ] **Step 3: `stale-banner.tsx`**

```tsx
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatDateKo } from '@/lib/format'

export function StaleBanner({ lastDate, days }: { lastDate: string; days: number }) {
  if (days <= 3) return null
  return (
    <Alert>
      <AlertDescription>
        최신 데이터가 {formatDateKo(lastDate)} 기준입니다 ({days}일 전).
        금융투자협회 데이터 갱신이 지연되었거나 연휴 기간일 수 있습니다.
      </AlertDescription>
    </Alert>
  )
}
```

- [ ] **Step 4: `summary-cards.tsx`**

카드 4개: 코스피 현재값(+고점 대비 낙폭), 신용융자 잔고(+고점 대비 감소), 청산 진행률, 잔여 청산 추정 범위. 각 카드에 한 줄 설명(비개발자용)을 붙인다.

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

export function SummaryCards({ snap }: { snap: AnalysisSnapshot }) {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  if (!cur) return null
  const h = cur.headline
  const p = snap.projection

  const items = [
    {
      title: '코스피',
      value: formatIdx(h.idxLast),
      sub: `고점 ${formatIdx(h.idxPeak)} 대비 ${formatPct(h.idxDrawdownPct)}`,
      hint: `${formatDateKo(h.idxLastDate)} 종가 기준입니다.`,
    },
    {
      title: '신용융자 잔고',
      value: formatJo(h.creditLastJo),
      sub: `고점 ${formatJo(h.creditPeakJo)} 대비 ${formatJo(h.actualDeclineJo)}`,
      hint: '투자자가 증권사에서 돈을 빌려 주식을 산 금액의 총합입니다.',
    },
    {
      title: '청산 진행률',
      value: formatPct(Math.abs(h.unwindPct)),
      sub: `2021년 사이클은 최종 ${formatPct(Math.abs(snap.periods[0].markets['전체'].headline.unwindPct))}까지 진행`,
      hint: '빌린 돈으로 산 주식이 얼마나 정리됐는지를 나타냅니다.',
    },
    {
      title: '잔여 청산 추정',
      value: p ? `${formatJo(Math.max(0, p.lowJo))} ~ ${formatJo(p.highJo)}` : '-',
      sub: '기준이 다른 4가지 방법으로 계산한 범위',
      hint: '앞으로 추가로 정리될 수 있는 금액의 추정 범위입니다. 하나의 정답은 없습니다.',
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(it => (
        <Card key={it.title}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{it.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold tabular-nums">{it.value}</p>
            <p className="text-xs text-muted-foreground">{it.sub}</p>
            <p className="text-xs text-muted-foreground/80">{it.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: `ai-commentary.tsx`**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDateKo } from '@/lib/format'

export function AiCommentary(
  { commentary }: { commentary: { date: string; content: string } | null },
) {
  if (!commentary) return null
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">오늘의 시장 해설</CardTitle>
        <Badge variant="secondary">{formatDateKo(commentary.date)} 기준</Badge>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{commentary.content}</p>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 6: `cycle-compare.tsx`** (클라이언트 컴포넌트, recharts)

**2026-07-30 확장**: 전체/유가증권/코스닥 세 시장을 볼 수 있어야 한다 (design spec §10.2). shadcn `select`는
아직 설치되어 있지 않으므로 새 컴포넌트를 추가하지 말고, 이미 설치된 `Tabs`를 시장 선택에도 재사용한다
— 시장 탭(바깥) 안에 사이클 탭(안쪽)을 중첩한다.

두 사이클의 `scaledBuckets`를 탭으로 전환하며 막대차트로 보여준다.
막대 색을 상태별로 나눈다: `fullyTriggered`(청산완료), `triggered`(진행 중), 나머지(미진입).
X축은 지수 구간(`5,000-5,500`), Y축은 조원.
차트 아래 표로 구간별 금액·마진콜 레벨·상태를 함께 싣는다.
`m.turnover`가 있으면 거래대금 대비 규모를, `m.ladder.length`가 있으면 남은 마진콜 사다리를 그 아래 덧붙인다.
`유가증권`/`코스닥` 탭은 `snap.meta.hasSplit`이 `false`면(분리 데이터 아직 미반영) 안내 문구만 보여준다.

```tsx
'use client'

import { useState } from 'react'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AnalysisSnapshot } from '@/lib/types'
import type { MarketAnalysis } from '@/lib/buckets'
import { formatIdx, formatPct, formatJo } from '@/lib/format'

const COLORS = {
  full: 'var(--chart-1)',
  partial: 'var(--chart-2)',
  none: 'var(--chart-3)',
}

const MARKETS = ['전체', '유가증권', '코스닥'] as const

function MarketCycleView({ snap, market }: { snap: AnalysisSnapshot; market: string }) {
  const available = snap.periods.filter(p => p.markets[market])
  if (!available.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        아직 {market} 분리 데이터가 반영되지 않았습니다. 반영되면 자동으로 표시됩니다.
      </p>
    )
  }
  return (
    <Tabs defaultValue={available.at(-1)!.key}>
      <TabsList>
        {available.map(p => (
          <TabsTrigger key={p.key} value={p.key}>{p.name}</TabsTrigger>
        ))}
      </TabsList>
      {available.map(p => {
        const m = p.markets[market] as MarketAnalysis
        const data = m.scaledBuckets
          .filter(b => b.jo >= 0.01)
          .map(b => ({
            label: `${b.low.toLocaleString('ko-KR')}-${b.high.toLocaleString('ko-KR')}`,
            jo: Number(b.jo.toFixed(2)),
            state: b.fullyTriggered ? 'full' : b.triggered ? 'partial' : 'none',
            marginHigh: b.marginHigh,
          }))
        return (
          <TabsContent key={p.key} value={p.key} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              지수 고점 {formatIdx(m.headline.idxPeak)} → 저점 {formatIdx(m.headline.idxTrough)}
              {' '}({formatPct(m.headline.idxDrawdownPct)}),
              신용융자 청산 {formatPct(m.headline.unwindPct)}
            </p>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-35} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} unit="조" />
                  <Tooltip
                    formatter={(v: number) => [`${v}조원`, '신용매수']}
                    labelFormatter={(l: string) => `코스피 ${l}p`}
                  />
                  <Bar dataKey="jo" radius={[3, 3, 0, 0]}>
                    {data.map((d, i) => (
                      <Cell key={i} fill={COLORS[d.state as keyof typeof COLORS]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: COLORS.full }} />
                구간 전체가 반대매매 조건에 들어감
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: COLORS.partial }} />
                일부가 반대매매 조건에 들어감
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: COLORS.none }} />
                아직 조건에 안 들어감
              </span>
            </div>

            {m.turnover && (
              <div className="rounded-lg border p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">거래대금 대비 규모</p>
                <p className="mt-1">
                  청산 국면 일평균 거래대금 {formatJo(m.turnover.unwindAvgDailyJo ?? 0)}은
                  그 시기 평소(청산 직전) 일평균 {formatJo(m.turnover.baselineAvgDailyJo ?? 0)}의{' '}
                  {m.turnover.unwindVsBaselinePct != null ? formatPct(m.turnover.unwindVsBaselinePct) : '-'} 수준입니다.
                  {m.unwind.equivDays != null && (
                    <> 지금까지의 총 청산액은 그 시기 평소 하루 거래대금의 약 {m.unwind.equivDays.toFixed(1)}배입니다.</>
                  )}
                </p>
              </div>
            )}

            {m.ladder.length > 0 && (
              <div>
                <p className="text-sm font-medium">코스피가 더 내려가면 열리는 마진콜 사다리</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-4 font-medium">이 지수 밑으로 마감하면</th>
                        <th className="py-1.5 pr-4 font-medium">추가 금액</th>
                        <th className="py-1.5 font-medium">누적</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.ladder.map(r => (
                        <tr key={r.threshold} className="border-t">
                          <td className="py-1.5 pr-4 tabular-nums">{formatIdx(r.threshold)}</td>
                          <td className="py-1.5 pr-4 tabular-nums">+{formatJo(r.incrementalJo)}</td>
                          <td className="py-1.5 tabular-nums">{formatJo(r.cumulativeJo)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

export function CycleCompare({ snap }: { snap: AnalysisSnapshot }) {
  const [market, setMarket] = useState<string>('전체')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">지수대별 신용매수와 반대매매 진행</CardTitle>
        <CardDescription>
          코스피가 어느 구간일 때 빌린 돈으로 주식을 얼마나 샀는지, 그중 얼마가 이미 강제로
          정리됐는지를 보여줍니다. 막대가 오른쪽(높은 지수)일수록 비싸게 산 물량입니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={market} onValueChange={setMarket}>
          <TabsList>
            {MARKETS.map(mkt => (
              <TabsTrigger key={mkt} value={mkt}>{mkt}</TabsTrigger>
            ))}
          </TabsList>
          {MARKETS.map(mkt => (
            <TabsContent key={mkt} value={mkt}>
              <MarketCycleView snap={snap} market={mkt} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 7: `projection-card.tsx`**

4개 벤치마크를 카드/표로 나열. 각각 `name`, `basis`, `totalJo`, `remainJo`, `caveat`.
그 아래 `scenarioRemain`을 표로: "코스피가 여기까지 내려가면 새로 마진콜에 들어오는 금액".
맨 위에 범위(`lowJo ~ highJo`)와 "왜 하나의 숫자로 말하지 않는지" 설명 한 문단.

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatIdx } from '@/lib/format'

export function ProjectionCard({ snap }: { snap: AnalysisSnapshot }) {
  const p = snap.projection
  if (!p) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">앞으로 얼마나 더 정리될 수 있을까</CardTitle>
        <CardDescription>
          기준이 서로 다른 4가지 방법으로 계산했습니다. 결과가 하나로 모이지 않기 때문에
          하나의 숫자가 아니라 범위로 봅니다. 과거 사이클 한 번에 기댄 추정이라는 점도
          함께 감안해야 합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">잔여 청산 추정 범위</p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatJo(Math.max(0, p.lowJo))} ~ {formatJo(p.highJo)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            이미 정리된 금액 {formatJo(p.doneJo)} (신용융자 고점 {formatJo(p.peakJo)} 대비)
          </p>
        </div>

        <div className="space-y-3">
          {p.benches.map(b => (
            <div key={b.key} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{b.name}</p>
                <p className="tabular-nums">
                  총 {formatJo(b.totalJo)} → 잔여{' '}
                  <span className="font-semibold">
                    {b.remainJo <= 0 ? '이미 충족' : formatJo(b.remainJo)}
                  </span>
                </p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">계산 근거: {b.basis}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">주의: {b.caveat}</p>
            </div>
          ))}
        </div>

        <Separator />

        <div>
          <p className="text-sm font-medium">코스피가 더 내려가면 새로 반대매매 대상이 되는 금액</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4 font-medium">코스피</th>
                  <th className="py-1.5 pr-4 font-medium">누적 대상 금액</th>
                  <th className="py-1.5 font-medium">현재 대비 추가</th>
                </tr>
              </thead>
              <tbody>
                {p.scenarioRemain.map(s => (
                  <tr key={s.idx} className="border-t">
                    <td className="py-1.5 pr-4 tabular-nums">{formatIdx(s.idx)}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatJo(s.exposureJo)}</td>
                    <td className="py-1.5 tabular-nums">+{formatJo(s.extraJo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 8: `layout.tsx` 수정**

`lang="ko"`, 한국어 메타데이터, 면책 푸터, `/methodology` 링크를 담는다.

```tsx
import type { Metadata } from 'next'
import './globals.css'
import Link from 'next/link'
import { Disclaimer } from '@/components/disclaimer'

export const metadata: Metadata = {
  title: '코스피 신용잔고·반대매매 분석',
  description: '코스피 지수대별 신용융자 누적과 반대매매 진행률, 2021년 사이클과의 비교 분석',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
            <Link href="/" className="font-semibold">코스피 신용잔고·반대매매 분석</Link>
            <Link href="/methodology" className="text-sm text-muted-foreground hover:text-foreground">
              계산 방법
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="border-t">
          <div className="mx-auto max-w-6xl space-y-1 px-4 py-6">
            <Disclaimer />
            <p className="text-xs text-muted-foreground">
              자료: 금융투자협회 FREESIS 일별 통계
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
```

- [ ] **Step 9: `page.tsx` 작성**

```tsx
import { getLatestSnapshot, getLatestCommentary, daysSince } from '@/lib/queries'
import { StaleBanner } from '@/components/stale-banner'
import { SummaryCards } from '@/components/summary-cards'
import { AiCommentary } from '@/components/ai-commentary'
import { CycleCompare } from '@/components/cycle-compare'
import { ProjectionCard } from '@/components/projection-card'
import { ChatWidget } from '@/components/chat-widget'

export const revalidate = 3600

export default async function Page() {
  const [snap, commentary] = await Promise.all([
    getLatestSnapshot(),
    getLatestCommentary(),
  ])

  if (!snap) {
    return (
      <p className="text-sm text-muted-foreground">
        데이터를 준비하는 중입니다. 잠시 후 다시 확인해 주세요.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <StaleBanner lastDate={snap.meta.lastDate} days={daysSince(snap.meta.lastDate, new Date())} />
      <SummaryCards snap={snap} />
      <AiCommentary commentary={commentary} />
      <CycleCompare snap={snap} />
      <ProjectionCard snap={snap} />
      <ChatWidget />
    </div>
  )
}
```

`ChatWidget`은 Task 9에서 만든다. 이 단계에서는 `page.tsx`에서 `ChatWidget` 줄을 잠시 주석 처리하고 진행한다.

- [ ] **Step 10: 브라우저로 확인**

```bash
npm run dev
```

`http://localhost:3000` 접속 후 확인:
- 요약 카드 4개의 숫자가 `../jj-project2-liquidity analysis/docs/methodology.md` §10의 값과 일치하는지 (코스피 5,663p, 신용융자 고점 38.63조, 청산률 -15.4%, 잔여 범위 0~10.18조)
- 탭 전환 시 두 사이클 차트가 각각 나오는지
- 한글이 깨지지 않는지
- 모바일 폭(375px)에서 레이아웃이 깨지지 않는지

- [ ] **Step 11: 빌드 확인**

Run: `npm run build`
Expected: 성공, 타입/린트 에러 없음

- [ ] **Step 12: 커밋**

```bash
git add src/app src/components
git commit -m "feat: add dashboard with summary cards, cycle comparison chart and projection"
```

---

### Task 9: 챗봇 (`/api/chat` + `chat-widget.tsx`)

**Files:**
- Create: `src/app/api/chat/route.ts`, `src/components/chat-widget.tsx`
- Modify: `src/app/page.tsx` (ChatWidget 주석 해제)
- Test: `src/lib/__tests__/rate-limit.test.ts`, `src/lib/rate-limit.ts`

**Interfaces:**
- Consumes: `getLatestSnapshot` (Task 5), `summarizeForPrompt`/`CHAT_SYSTEM_PROMPT`/`callOpenRouter`/`DISCLAIMER` (Task 6)
- Produces:
  - `checkRateLimit(key: string, now: number, limit?: number, windowMs?: number): boolean` (in `rate-limit.ts`) — 인메모리 슬라이딩 윈도우
  - `POST /api/chat` — 요청 `{ question: string }`, 응답 `{ answer: string }` 또는 `{ error: string }`
  - `<ChatWidget />` 클라이언트 컴포넌트

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/__tests__/rate-limit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { checkRateLimit, resetRateLimit } from '@/lib/rate-limit'

describe('checkRateLimit', () => {
  it('한도 안에서는 통과', () => {
    resetRateLimit()
    expect(checkRateLimit('a', 1000, 3, 60_000)).toBe(true)
    expect(checkRateLimit('a', 1100, 3, 60_000)).toBe(true)
    expect(checkRateLimit('a', 1200, 3, 60_000)).toBe(true)
  })

  it('한도를 넘으면 막는다', () => {
    resetRateLimit()
    checkRateLimit('b', 1000, 2, 60_000)
    checkRateLimit('b', 1100, 2, 60_000)
    expect(checkRateLimit('b', 1200, 2, 60_000)).toBe(false)
  })

  it('윈도우가 지나면 다시 통과', () => {
    resetRateLimit()
    checkRateLimit('c', 1000, 1, 60_000)
    expect(checkRateLimit('c', 2000, 1, 60_000)).toBe(false)
    expect(checkRateLimit('c', 62_000, 1, 60_000)).toBe(true)
  })

  it('키가 다르면 서로 영향 없음', () => {
    resetRateLimit()
    checkRateLimit('d', 1000, 1, 60_000)
    expect(checkRateLimit('e', 1000, 1, 60_000)).toBe(true)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/rate-limit"`

- [ ] **Step 3: `src/lib/rate-limit.ts` 작성**

```typescript
const hits = new Map<string, number[]>()

export function resetRateLimit(): void {
  hits.clear()
}

export function checkRateLimit(
  key: string, now: number, limit = 10, windowMs = 60_000,
): boolean {
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs)
  if (recent.length >= limit) {
    hits.set(key, recent)
    return false
  }
  recent.push(now)
  hits.set(key, recent)
  return true
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS 전체

- [ ] **Step 5: `src/app/api/chat/route.ts` 작성**

```typescript
import { NextResponse } from 'next/server'
import { getLatestSnapshot } from '@/lib/queries'
import { summarizeForPrompt, callOpenRouter, CHAT_SYSTEM_PROMPT, DISCLAIMER } from '@/lib/openrouter'
import { checkRateLimit } from '@/lib/rate-limit'

const MAX_QUESTION_LEN = 500

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!checkRateLimit(ip, Date.now())) {
    return NextResponse.json(
      { error: '질문이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 })
  }

  let question: unknown
  try {
    question = (await req.json())?.question
  } catch {
    return NextResponse.json({ error: '요청 형식이 잘못되었습니다.' }, { status: 400 })
  }
  if (typeof question !== 'string' || !question.trim()) {
    return NextResponse.json({ error: '질문을 입력해 주세요.' }, { status: 400 })
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: `질문은 ${MAX_QUESTION_LEN}자 이내로 입력해 주세요.` }, { status: 400 })
  }

  const snap = await getLatestSnapshot()
  if (!snap) {
    return NextResponse.json({ error: '아직 데이터가 준비되지 않았습니다.' }, { status: 503 })
  }

  try {
    const answer = await callOpenRouter([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'system', content: `다음은 답변에 사용할 수 있는 데이터입니다.\n\n${summarizeForPrompt(snap)}` },
      { role: 'user', content: question.trim() },
    ])
    return NextResponse.json({ answer: `${answer}\n\n${DISCLAIMER}` })
  } catch (e) {
    console.error('[chat] 실패:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: '답변 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 502 })
  }
}
```

- [ ] **Step 6: `src/components/chat-widget.tsx` 작성**

플로팅 버튼 → `Sheet`로 대화창. 메시지 목록, 입력창, 전송 중 상태, 에러 표시.
첫 진입 시 안내 문구와 예시 질문 버튼 3개("지금 신용잔고는 얼마나 남았어?", "2021년과 지금 뭐가 달라?", "코스피가 5,000p까지 가면 어떻게 돼?").

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'

type Msg = { role: 'user' | 'assistant'; content: string }

const EXAMPLES = [
  '지금 신용잔고는 얼마나 남았어?',
  '2021년과 지금 뭐가 달라?',
  '코스피가 5,000p까지 가면 어떻게 돼?',
]

export function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(question: string) {
    const q = question.trim()
    if (!q || busy) return
    setError(null)
    setInput('')
    setMsgs(m => [...m, { role: 'user', content: q }])
    setBusy(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? '답변을 받지 못했습니다.')
      } else {
        setMsgs(m => [...m, { role: 'assistant', content: json.answer }])
      }
    } catch {
      setError('네트워크 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="fixed bottom-6 right-6 shadow-lg" size="lg">
          궁금한 점 물어보기
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>데이터에 대해 물어보세요</SheetTitle>
          <SheetDescription>
            이 페이지에 있는 통계를 근거로만 답합니다. 종목 추천이나 매수·매도 판단은 하지 않습니다.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 pr-3">
          <div className="space-y-3">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">예시 질문:</p>
                {EXAMPLES.map(q => (
                  <Button key={q} variant="outline" size="sm"
                    className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                    onClick={() => send(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i}
                className={m.role === 'user'
                  ? 'ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
                  : 'max-w-[90%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap'}>
                {m.content}
              </div>
            ))}
            {busy && <p className="text-sm text-muted-foreground">답변을 준비하고 있습니다…</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </ScrollArea>

        <form className="flex gap-2"
          onSubmit={e => { e.preventDefault(); send(input) }}>
          <Input value={input} onChange={e => setInput(e.target.value)}
            placeholder="질문을 입력하세요" maxLength={500} disabled={busy} />
          <Button type="submit" disabled={busy || !input.trim()}>전송</Button>
        </form>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 7: `page.tsx`의 ChatWidget 주석 해제**

- [ ] **Step 8: 브라우저로 챗봇 확인**

`npm run dev` 후 `http://localhost:3000`에서:
- 우하단 버튼 클릭 → 패널 열림
- 예시 질문 3개 각각 눌러보고 한국어 답변이 오는지
- **"삼성전자 지금 사도 될까?"** 입력 → 종목 추천을 거절하는지 확인
- 답변 끝에 면책 문구가 붙는지 확인
- 11회 연속 질문해서 429가 뜨는지 확인

- [ ] **Step 9: 빌드 + 테스트**

Run: `npm run build && npm test`
Expected: 모두 성공

- [ ] **Step 10: 커밋**

```bash
git add src/lib/rate-limit.ts src/lib/__tests__/rate-limit.test.ts src/app/api/chat src/components/chat-widget.tsx src/app/page.tsx
git commit -m "feat: add data-grounded chatbot with rate limiting"
```

---

### Task 10: 방법론 페이지

**Files:**
- Create: `src/app/methodology/page.tsx`

**Interfaces:**
- Consumes: `getLatestSnapshot` (Task 5), shadcn `Accordion` (Task 1)
- Produces: `/methodology` 정적 페이지

- [ ] **Step 1: 페이지 작성**

`../jj-project2-liquidity analysis/docs/methodology.md`의 내용을 일반 방문자용으로 압축해 Accordion 섹션으로 만든다. 섹션:

1. **반대매매는 왜 -16%에서 일어나나** — 자기자금 40 + 빌린돈 60 = 100 매수, 담보유지비율 140% → `P/60 >= 1.40` → `P >= 84`. 계수 0.84.
2. **지수대별 금액은 어떻게 나눴나** — 일별 신용융자 증가분을 그날 코스피 구간에 누적(gross). "그 구간에서 일어난 신용매수 규모"이고 "현재 남아 있는 잔고"가 아니다.
3. **중복 계상 보정(churn)** — 같은 자금이 들어왔다 나가면 두 번 세어지므로, 분포는 유지하고 합계만 실제 순증에 맞춰 스케일.
4. **끝난 사이클로 검증** — 2020–21 사이클: 모델 8.85조 vs 실측 9.84조, 오차 1.00조.
5. **원 자료 재현** — 재현 표(`snap.repro`)를 표로 렌더. `reproMAE` 표시.
6. **한계** — 표본이 과거 사이클 하나뿐, 담보유지비율은 증권사별 130~170% 상이(현재 사이클의 `snap.periods.find(p => !p.closed)!.markets['전체'].sensitivity` 표로 표시), 결제일 시차, 신용융자 반대매매는 공표되지 않음, 투자 판단 근거로 부족.
7. **유가증권/코스닥은 왜 갱신 빈도가 다른가** — `전체` 신용융자·거래대금은 금투협 API로 매일 자동 갱신되지만, 시장별 분리 계열은 API로 자동 수집이 안 되어(§8) 운영자가 가끔 수동으로 반영한다. `snap.meta.hasSplit`이 `false`면 분리 탭에 안내 문구만 표시된다.
8. **자료 출처** — 금융투자협회 FREESIS 일별 통계. 지표 코드 목록 (OS0011/OS0012 거래대금 포함).

`snap`이 없으면 데이터 의존 섹션(5, 6)은 생략하고 나머지는 그대로 보여준다.

- [ ] **Step 2: 브라우저로 확인**

`http://localhost:3000/methodology` — 아코디언이 열리고 닫히는지, 한글 깨짐 없는지, 재현 표 숫자가 methodology.md §2.5와 일치하는지

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: 커밋**

```bash
git add src/app/methodology
git commit -m "feat: add methodology page explaining the calculation"
```

---

### Task 11: 배포 전 보안 점검 + Vercel 배포

**Files:**
- Create: `README.md`
- Modify: 없음 (점검 결과에 따라 수정 가능)

**Interfaces:**
- Consumes: 전체 앱
- Produces: 배포된 Vercel URL

- [ ] **Step 1: 비밀키·개인정보 혼입 검사** (CLAUDE.md 보안규칙 10)

```bash
git ls-files -z | xargs -0 grep -nE "sk-or-v1-|eyJhbGciOi|SUPABASE_SERVICE_ROLE|service_role|BEGIN (RSA |EC )?PRIVATE KEY" || echo "clean"
git log --all -p | grep -cE "sk-or-v1-|eyJhbGciOi" || echo "history clean"
```

Expected: 두 명령 모두 `clean`. 하나라도 걸리면 **배포를 멈추고 사용자에게 알린다.**

- [ ] **Step 2: `.gitignore` 확인**

```bash
git check-ignore -v .env.local && git status --porcelain | grep -c "\.env" || echo "env not tracked"
```

Expected: `.env.local`이 무시되고 있고 git status에 나타나지 않는다

- [ ] **Step 3: `README.md` 작성**

내용: 프로젝트 목적 한 문단, 로컬 실행 방법, 필요한 환경변수 목록(**값은 쓰지 않고 이름만**), 자료 출처, 면책 문구, 원 분석 프로젝트 위치, 그리고 유가증권/코스닥 분리 데이터 수동 반영 방법 한 단락 (`FREESIS > 주식 > 신용공여현황 > 신용공여 잔고 추이`에서 파일을 내려받아 `data/`에 넣고 `npm run ingest-split -- data/<파일명>` 실행 — 그 다음 매일 배치부터 자동 반영됨).

- [ ] **Step 4: 최종 테스트 + 빌드**

Run: `npm test && npm run build`
Expected: 모두 성공

- [ ] **Step 5: Vercel CLI 설치**

```bash
npm i -g vercel
vercel --version
```

- [ ] **Step 6: Vercel 로그인 및 프로젝트 연결**

```bash
vercel login
vercel link --yes
```

로그인은 브라우저 인증이 필요하다. **사용자에게 로그인 완료를 확인받고 진행한다.**

- [ ] **Step 7: 환경변수 등록**

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add OPENROUTER_API_KEY production
vercel env add OPENROUTER_MODEL production
vercel env add CRON_SECRET production
```

preview 환경에도 동일하게 등록한다 (`production` → `preview`).

- [ ] **Step 8: 프리뷰 배포 후 확인**

```bash
vercel deploy
```

받은 URL을 브라우저로 열어 확인:
- 대시보드가 렌더되고 숫자가 로컬과 같은지
- 챗봇이 동작하는지
- 방법론 페이지가 열리는지
- 한글 깨짐 없는지

- [ ] **Step 9: 프로덕션 배포**

**사용자 확인을 받은 뒤** 실행한다.

```bash
vercel deploy --prod
```

- [ ] **Step 10: 프로덕션에서 Cron 라우트 수동 실행**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<프로덕션-도메인>/api/cron/daily-update
```

Expected: `{"ok":true,...}`. Vercel 대시보드에서 Cron이 등록됐는지도 확인한다.

- [ ] **Step 11: 커밋**

```bash
git add README.md
git commit -m "docs: add README with setup and deployment notes"
```

---

## 완료 조건

- `npm test` 전체 통과
- `npm run build` 성공
- 대시보드 숫자가 `../jj-project2-liquidity analysis/docs/methodology.md` §10의 값과 일치
- 챗봇이 종목 추천 질문을 거절하고 면책 문구를 붙인다
- 비밀키 검사가 clean
- Vercel 프로덕션 URL이 동작하고 Cron이 등록되어 있다

---

## Task 12 (2026-07-31 확장): 대차잔고(공매도 프록시) · 숏커버링 분석

design spec §11 참조. 원본 `../jj-project2-liquidity analysis`의 `scripts/analyze.mjs` L243-294,
`scripts/ingest-lending.mjs`, `docs/methodology.md` §16을 그대로 포팅한다. 시장 분리(Task 5/7)와
완전히 같은 패턴: API로 자동 수집 안 됨 → 수동 반영 스크립트 + Supabase 저장 → 매일 배치가
최신 반영분을 재사용.

**Files:**
- Modify: `src/lib/types.ts` (`LendingRow`, `LendingAnalysis` 타입 + `AnalysisSnapshot.lending`)
- Modify: `src/lib/analyze.ts` (`buildAnalysis`에 `lendingSeries?` 인자 추가, lending 계산 포팅)
- Create: `src/lib/queries.ts`에 `saveLendingBalance`/`getLatestLendingBalance` 추가
- Create: `scripts/lib/xlsx.mjs` (기존 `scripts/ingest-split.mjs`의 xlsx/HTML표/CSV 파서를 공용 모듈로 추출 — 원본 프로젝트가 이미 이렇게 리팩터했다)
- Modify: `scripts/ingest-split.mjs` (새 `scripts/lib/xlsx.mjs` 사용하도록 변경, 동작은 동일하게 유지)
- Create: `scripts/ingest-lending.mjs` (원본 `ingest-lending.mjs` 포팅, 출력은 파일 대신 Supabase upsert)
- Modify: `src/app/api/cron/daily-update/route.ts` (`getLatestLendingBalance()` 조회 후 `buildAnalysis`에 전달)
- Create: `src/components/lending-card.tsx` (대차잔고 카드: 역대최고/사이클고점 대비 하락률, 4-조합 카운트, 숏커버링 후보일 표, 한계 문구)
- Modify: `src/app/page.tsx` (LendingCard 추가, `snap.lending`이 없으면 렌더 안 함)
- Modify: `src/lib/openrouter.ts` (`summarizeForPrompt`에 lending 요약 한 단락 추가 — 챗봇이 공매도 질문에도 답할 수 있게)
- Modify: `src/app/methodology/page.tsx` (원본 §16을 요약한 아코디언 섹션 추가)
- Modify: `README.md` (대차잔고 수동 반영 방법 한 단락, `npm run ingest-lending` 사용법)
- Test: `src/lib/__tests__/analyze.test.ts`에 lending 관련 케이스 추가 (frozen fixture 활용 — lending 원본 데이터도 `src/lib/__tests__/fixtures/lending-balance.json`으로 얼려서 커밋)

**Supabase 테이블(이미 컨트롤러가 적용함, 마이그레이션 파일만 추가하면 됨):**

```sql
create table if not exists public.lending_balance_raw (
  date text primary key,
  deal_shares numeric,
  repay_shares numeric,
  balance_shares numeric not null,
  balance_mil numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.lending_balance_raw enable row level security;
create policy "public read lending_balance_raw" on public.lending_balance_raw
  for select using (true);
```

이 SQL을 `supabase/migrations/0002_lending_balance.sql`에 추가한다 (이미 라이브 DB에 적용됨 — 마이그레이션 재실행 아님, 버전관리 목적).

**타입 (원본 `analyze.mjs` L243-294 반환 shape 그대로):**

```typescript
export type LendingRow = {
  date: string; dealShares: number | null; repayShares: number | null
  balanceShares: number; balanceMil: number
}

export type LendingDayPoint = {
  date: string; balJo: number; idx: number
  dIdxPct?: number; dBalPct?: number
}

export type LendingAnalysis = {
  meta: { source: string; unit: string; note: string }
  allTimePeak: LendingDayPoint
  last: LendingDayPoint
  cyclePeak: LendingDayPoint
  cycleDeclinePct: number
  dayClass: { coverType: number; jointUnwind: number; newShort: number; riskOn: number }
  candidates: (LendingDayPoint & { score: number })[]
  series: { d: string; bal: number; idx: number }[]
}
```

`AnalysisSnapshot`에 `lending: LendingAnalysis | null` 추가.

**`buildAnalysis` 포팅 규칙**: 원본 그대로 — `lendingSeries`가 없으면 `lending: null`, 있으면
진행 중인 사이클(`accBase`~`evalEnd`) 창 안에서 잔고 지역 고점부터 판정, `dIdxPct`/`dBalPct`는
전일 대비, `candidates`는 `dIdxPct>0 && dBalPct<0`인 날 중 `score = dIdxPct * -dBalPct` 상위 8개.
`allTimePeak`은 전체 시계열 기준(사이클 무관), `cyclePeak`은 진행 중 사이클 창 안에서만.

**`ingest-lending.mjs` 파싱 규칙**: 원본 그대로 포팅 — 헤더 4줄+데이터, 컬럼 `일자|체결(주수)|
상환(주수)|잔고 주수|잔고 금액`, `구분` 컬럼 없이 이미 '전체' 1행/일. 잔고주수+잔고금액이
연속으로 오는 위치를 60행 투표로 찾는다(원본 `locate()` 로직 그대로). 파일 못 찾으면
`FREESIS > 주식 > 대차거래 > 대차거래추이`에서 받으라는 안내 메시지.

**cron 라우트 변경**: `fetchKofiaSeries`, `getLatestCreditSplit`, `getLatestLendingBalance`를
병렬로 가져온 뒤 `buildAnalysis(series, splitSeries, lendingSeries)`로 세 번째 인자 추가.

**UI**: `LendingCard`는 4가지를 보여준다 — (1) 역대 최고 잔고 대비 현재 하락률, (2) 이번 사이클
고점 대비 하락률, (3) 고점 이후 지수-잔고 동행 조합 4종 카운트(숏커버형/동반청산/신규숏추정/
동반상승) 막대 또는 뱃지, (4) 숏커버링 후보일 표(날짜, 지수 등락률, 잔고 등락률). 아래에
"대차잔고는 공매도 전용이 아니다 — ETF 설정/환매, 차익거래 등 다른 목적으로도 변한다"는
한계 문구를 항상 붙인다(design spec §11 한계 참조). `snap.lending`이 `null`이면 카드 자체를
숨긴다(분리 계열과 같은 패턴 — 아직 반영 안 됐다고 안내하는 대신, 아직 없는 섹션은 그냥 생략).

**완료 조건**: `npm test`/`tsc`/`build` 클린. `lending-balance.json`(원본 프로젝트)을 Supabase에
반영한 뒤 배치를 돌리면 대시보드에 숏커버링 카드가 실제 숫자로 뜬다. 챗봇이 "공매도 얼마나
남았어?" 류 질문에 대차잔고 데이터를 근거로 답한다.
