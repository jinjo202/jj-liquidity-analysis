# 지수대별 신용융자 누적과 반대매매 / 숏커버 여력 추정

공개 소스(금융투자협회 FREESIS, 네이버 금융)만으로 두 가지를 수치로 답한다.

| 파트 | 질문 |
|---|---|
| **PART 1 — 신용잔고** | 얼마나 더 **하락**할 수 있나 (지수대별 신용매수 누적 → 반대매매 잔여) |
| **PART 2 — 공매도·숏커버링** | 얼마나 더 **상승**할 수 있나 (대차잔고 → 되갚기 잔여) |

비교 대상은 삼성자산운용 투자리서치센터 House View「7.29일 급락 코멘트: 신용매수 반대매매 추정」(2026-07-29).
그 자료는 Quantiwise(유료 단말)를 썼으나 여기서는 공개 소스만 쓴다. 원 자료 막대 11개를
평균 절대오차 **0.051조원**으로 재현했다(`docs/methodology.md` §2.5).

방법론 전문은 [`docs/methodology.md`](docs/methodology.md) — §1~20, 가정·한계·역설계 과정 전부 기록.

## 요구사항

Node.js 18+ (외부 패키지 없음, `npm install` 불필요). `fetch`·`zlib` 등 내장 모듈만 쓴다.

## 실행

```bash
node scripts/fetch-kospi.mjs    # 네이버 금융 코스피 일별(교차검증용) -> data/kospi-daily.json
node scripts/fetch-kofia.mjs    # 금투협 FREESIS 일별 11개 지표      -> data/kofia-daily.json
node scripts/analyze.mjs        # 사이클 x 시장 배분 + 마진콜 판정    -> data/analysis.json
node scripts/selfcheck.mjs      # analysis.json 불변식 검사
node scripts/build.mjs          # 웹 리포트                          -> index.html
node scripts/build-email.mjs    # 메일 클라이언트용 리포트           -> email.html
```

두 `fetch-*` 의 조회 종료일 기본값은 **실행 시점의 오늘**이다. 특정 시점을 재현하려면 인자로 넘긴다:
`node scripts/fetch-kofia.mjs 20260729`.

### xlsx 인제스트 (선택, 이미 커밋되어 있음)

FREESIS 의 일부 계열은 크로스통계 API 에 없어 화면에서 xlsx 를 내려받아야 한다
(`docs/methodology.md` §8, §16.2 에 시도한 경로와 실패 이유 전부 기록).
받아둔 파일이 `data/` 에 커밋되어 있으므로 **새 PC에서 다시 받을 필요는 없다.**
더 최신 데이터가 필요할 때만 다시 내려받아 `data/` 에 넣고 실행한다.

```bash
node scripts/ingest-split.mjs    # 신용공여 잔고 추이.xlsx -> data/credit-split.json  (유가증권/코스닥 분리)
node scripts/ingest-lending.mjs  # 대차거래추이.xlsx       -> data/lending-balance.json (대차잔고)
```

`pickFile()` 이 파일명에 '신용'/'대차'가 들어간 가장 최근 파일을 `data/` 와 프로젝트 루트에서 자동으로 집는다.

## 산출물

- **`index.html`** — 웹 리포트. 데이터와 SVG 차트를 전부 품고 있어 외부 의존성이 없다.
  `file://` 로 열어도 그대로 보인다. 탭 3개(PART 1 / PART 2 / 전체), 스크립트 0줄(라디오 + CSS 형제 선택자).
- **`email.html`** — 같은 데이터를 메일 렌더러가 견디는 방식으로 다시 구운 것.
  전부 inline style, table 레이아웃, SVG·grid·flex·media query 없음. 빌드 끝에 비호환 패턴을 자동 검사한다.
- **`data/analysis.json`** — 두 리포트의 공통 입력. 계산은 전부 여기서 끝나 있다.

## 구조

```
scripts/
  fetch-kospi.mjs      네이버 금융 일별 시세(교차검증 + 장중 최신 지수)
  fetch-kofia.mjs      FREESIS 크로스통계 11개 지표
  ingest-split.mjs     신용공여 분리 계열 xlsx 파싱
  ingest-lending.mjs   대차거래추이 xlsx 파싱
  analyze.mjs          전 계산 (사이클 분할, 버킷 배분, 마진콜 판정, 전망, 숏커버 여력)
  selfcheck.mjs        analysis.json 불변식 검사 (assert 기반, 프레임워크 없음)
  build.mjs            index.html
  build-email.mjs      email.html
  lib/
    buckets.mjs        지수대 배분·마진콜 판정 (사이클·시장 무관 공통 로직)
    xlsx.mjs           xlsx/HTML표/CSV 자동판별 리더
data/                  원본 xlsx + 정규화된 json (전부 커밋됨)
docs/methodology.md    방법론 §1~20
```

## 자동 갱신

`.github/workflows/update.yml` 이 알아서 돈다. 손댈 게 없다.

| 시각(KST) | 목적 |
|---|---|
| 평일 19:30 | 장 마감 후 EOD 공표분 |
| 다음날 08:30 | 늦게 확정되는 계열 재확인 |

fetch → analyze → **selfcheck** → build 순으로 돌고, **실제로 바뀐 게 있을 때만** 커밋한다.
새 데이터가 아직 공표되지 않은 날은 커밋하지 않아 히스토리가 지저분해지지 않는다.
push 되면 Vercel 이 자동으로 재배포한다.

`selfcheck.mjs` 가 실패하면 커밋도 push 도 하지 않는다 — 계산이 조용히 깨진 채 배포되는 일이 없다.
Actions 탭에서 `Run workflow` 로 수동 실행도 된다.

### 잘 돌고 있는지 확인

저장소가 private 이라 Actions 로그를 URL 로 열 수 없다. 대신 배포된 사이트에 상태를 내보낸다.

```
https://jj-liquidity-analysis.vercel.app/status.json
```

`ranOn` 이 며칠째 그대로면 워크플로가 멈춘 것이다. `dataThrough` 로 계열별 반영 날짜를,
`selfcheck` 로 그날 계산이 불변식을 통과했는지 본다(워크플로 순서상 selfcheck 를 통과해야
이 파일이 갱신된다).

한 가지 예외: **대차거래추이는 API 경로가 없어 자동화 밖이다**(§16.2).
FREESIS 화면에서 xlsx 를 내려받아 `data/` 에 넣고 커밋하면, 그 다음 실행부터 워크플로가 자동으로 반영한다.

## 다른 PC에서 이어서 작업

```bash
git clone <저장소 URL>
cd <폴더>
node scripts/analyze.mjs && node scripts/selfcheck.mjs && node scripts/build.mjs && node scripts/build-email.mjs
```

`data/` 의 원본 xlsx 와 정규화 json 이 전부 커밋되어 있어 **클론 직후 바로 재현된다.**
`npm install` 없음, Node 18+ 만 있으면 된다. 최신 데이터가 필요하면 `fetch-*` 부터 돌린다.

## 배포 (Vercel)

리포트는 정적 HTML 한 장이라 빌드 설정이 필요 없다. Vercel 대시보드에서
이 저장소를 Import 하고 아래대로 두면 끝이다.

| 항목 | 값 |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | 비움 (override 끄기) |
| Output Directory | 비움 |
| Install Command | 비움 |

`package.json` 이 없으므로 Vercel 은 빌드를 시도하지 않고 정적 파일만 배포한다.

**`.vercelignore` 를 반드시 유지할 것.** 저장소는 private 이어도 **배포된 사이트는 공개**다.
아무것도 막지 않으면 `https://<사이트>/data/kofia-daily.json` 으로 원본 데이터가 그대로 노출된다.
현재 설정은 `index.html` / `email.html` 만 올린다.

`.vercel/` 은 `.gitignore` 에 들어 있다 — PC마다 다시 link 하면 되고, 커밋하면 다른 PC에서
엉뚱한 Vercel 프로젝트에 연결될 수 있다.

## 데이터 출처

- 신용융자·반대매매금액·위탁매매미수금·투자자예탁금·예탁증권담보융자, 코스피/코스닥 지수·시가총액·거래대금:
  금융투자협회 FREESIS 크로스통계 (일별, 2010-01-01~)
- 유가증권/코스닥 분리 신용거래융자, 대차거래추이: FREESIS 통계 화면 xlsx
- 코스피 종가 교차검증 및 장중 최신 지수: 네이버 금융

## 주의

- **신용융자 반대매매는 공표되지 않는다.** 금투협의 반대매매금액(OS0025)은 위탁매매 미수금에 대한
  것이라 이 추정치의 검증값이 아니다(§7.4, §18).
- 마진콜 사다리는 **신용융자 채널만** 센다. 예탁증권담보융자(약 25조)는 청산 트리거가 공표되지 않아
  같은 계수를 적용할 근거가 없다 — 사다리는 하한이다(§17).
- 숏커버 여력을 지수 상승폭으로 환산하지 않는다. 매수 물량과 지수 변화의 매핑 근거가 이 데이터에 없다(§20.4).
- 비교 대상 PDF 는 제3자 저작물이라 저장소에 넣지 않았다(`.gitignore`). 필요한 값은 방법론 문서에 표로 옮겨 두었다.
