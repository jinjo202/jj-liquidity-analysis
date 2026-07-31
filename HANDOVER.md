# 인수인계서 — 코스피 유동성 분석 프로젝트

작성일 2026-07-31. 다른 PC에서 이어서 작업할 때 이 문서 하나로 시작할 수 있게 썼다.

## 1. 이게 뭔가

증권사 유료 단말(Quantiwise) 기반 리서치를 공개 데이터(금융투자협회 FREESIS, 네이버 금융)만으로
재현하고, 반대 방향(숏커버 여력)까지 확장한 뒤, **완전 자동으로 매일 갱신·배포**되게 만든 프로젝트.

- 웹 리포트: **https://jj-liquidity-analysis.vercel.app**
- 상태 확인: **https://jj-liquidity-analysis.vercel.app/status.json** ← 뭐가 잘 도는지 여기서 먼저 본다
- 저장소: **https://github.com/devbotsender8282/jj-liquidity-analysis** (private)
- 방법론 전문: [`docs/methodology.md`](docs/methodology.md) §1~22 — 역설계 과정, 가정, 한계, 디버깅 기록 전부
- 프로젝트 개요: [`README.md`](README.md)

## 2. 새 PC에서 시작하기

```bash
git clone https://github.com/devbotsender8282/jj-liquidity-analysis.git
cd jj-liquidity-analysis
node --version    # 18+ 확인. npm install 불필요 (외부 패키지 0)
node scripts/analyze.mjs && node scripts/selfcheck.mjs && node scripts/build.mjs
```

GitHub 로그인은 `devbotsender8282` 계정. 저장소가 private 이라 push 하려면 이 계정으로
Git Credential Manager 인증이 필요하다(첫 push 시 브라우저 로그인 창이 뜬다).

Vercel 은 같은 GitHub 저장소에 연결되어 있어 **push 하면 자동 재배포**된다.
새 PC에서 Vercel CLI 를 쓸 일은 거의 없다 — 대시보드도 안 열어도 된다. 상태는 위 status.json 으로 본다.

## 3. 지금 상태 (2026-07-31 16:xx 기준)

```
selfcheck OK — 4,325행, 재현 MAE 0.051조, 사이클 2개, 채널 O, 미수금 O
status.json: ranBy=github-actions, failedStage=null, fetchErrors=null (전부 정상)
```

자동 갱신은 완전히 돈다. 손댈 것 없음.

## 4. 자동화가 하는 일 (`.github/workflows/update.yml`)

| 시각(KST) | 트리거 |
|---|---|
| 평일 19:30 | 장 마감 후 EOD 공표분 |
| 다음날 08:30 | 늦게 확정되는 계열 재확인 |
| `scripts/**` 또는 워크플로 파일 push 시 | 즉시 실행 (코드 바꾸면 바로 결과 확인 가능) |
| Actions 탭 `Run workflow` | 수동 실행 |

흐름: `fetch(index·kofia·lending) → ingest-split(xlsx 있으면) → analyze → selfcheck(게이트) → build → status → 바뀐 게 있으면만 commit&push`

**로컬 PC 와 완전히 무관하다.** `runs-on: ubuntu-latest` — GitHub 클라우드 서버에서 돈다.
PC 를 꺼둬도, 이 저장소를 아무도 클론 안 해도 계속 갱신된다.

**selfcheck 가 게이트다.** 실패하면 커밋도 push 도 안 한다 — 깨진 계산이 배포되는 일이 없다.

**실패해도 흔적이 남는다.** 저장소가 private 이라 Actions 로그를 URL 로 못 본다.
그래서 각 단계가 자기 이름을 남기고, 실패 시 `failedStage` 를 `status.json` 에 커밋한다.
지금 다음에 뭔가 실패하면 이 파일의 `failedStage` 값만 보면 어느 단계인지 안다.

주의할 것 두 가지(README 에도 적혀 있음):
- 스케줄은 정시가 아니다(GitHub 부하로 밀릴 수 있음)
- **60일 무활동이면 GitHub 이 cron 을 자동 정지한다.** 오래 비워두면 `ranOn` 이 멈춘다 →
  그때는 Actions 탭에서 워크플로 다시 켜면 된다.

## 5. 남은 수동 작업 — 딱 하나

**유가증권/코스닥 분리 신용공여 xlsx**(§8). API 경로가 없어 FREESIS 화면에서 직접 내려받아야 한다.

```
FREESIS > 주식 > 신용공여현황 > 신용공여 잔고 추이 에서 다운로드 → data/ 에 넣고
node scripts/ingest-split.mjs
```

사이클 단위로만 쓰는 계열이라 급하지 않다. 파일을 갱신해 커밋하면 다음 자동 실행부터 반영된다.

대차거래추이는 예전엔 이것도 수동이었으나 API 경로를 찾아 자동화됨(§16.2.1) — 더 이상 손 안 대도 됨.

## 6. 저장소 구조

```
scripts/
  fetch-index.mjs      네이버 코스피·코스닥 일별(장중 최신, 교차검증)
  fetch-kofia.mjs       FREESIS 크로스통계 11개 지표(지수·시총·거래대금·신용융자·
                         반대매매·미수금·예탁금·담보융자)
  fetch-lending.mjs    FREESIS 대차거래추이 API (연 단위 청크, ###### 무해화 처리)
  ingest-split.mjs     분리 신용공여 xlsx 파싱 (유일한 수동 입력)
  ingest-lending.mjs   대차거래 xlsx 파싱 — API 규격 바뀔 때 대비한 폴백, 지금은 안 씀
  analyze.mjs          전 계산: 사이클 분할, 버킷 배분, 마진콜 판정, 전망, 숏커버 여력,
                        전일 대비, 1년 추세 시계열
  selfcheck.mjs        불변식 검사(assert 기반) — 워크플로 YAML 콜론 함정도 여기서 잡는다
  build.mjs            index.html (웹 리포트, 탭 3개 + 사이클 하위탭, 스크립트 0줄)
  build-email.mjs      email.html (메일 클라이언트 호환, table 레이아웃)
  status.mjs           status.json (자동화 건강 확인용, 공개 배포됨)
  lib/buckets.mjs       버킷 배분·마진콜 판정 공통 로직
  lib/xlsx.mjs          xlsx/HTML표/CSV 자동판별 리더
data/                  원본 xlsx + 정규화 json 전부 커밋됨 (클론 직후 바로 재현)
docs/methodology.md    §1~22, 방법론 전문 + 디버깅 기록
.github/workflows/update.yml   자동 갱신 워크플로
.vercelignore          data/scripts/docs 배포 차단 (저장소 private ≠ 사이트 private 대응)
```

## 7. 리포트 구조 (index.html)

```
핵심 요약 (탭 밖, 맨 위)
  ├─ 오늘의 지표 6개 (코스피·코스닥 장중 반영, 나머지는 FREESIS 확정)
  │   → 클릭하면 1년 추세 차트 펼침 (<details>, 스크립트 없음)
  └─ 한 줄 판정 + PART별 핵심 결론

[PART 1 신용잔고] [PART 2 공매도·숏커버링] [ALL 전체]   ← 큰 탭, 선택 시 색으로 채움
  PART 1 안:
    [2025–26 사이클(진행중)] [2020–21 사이클(완결·대조군)]  ← 하위 탭
```

전부 라디오 버튼 + CSS 형제 선택자. JS 없음 → `file://` 로 열어도 그대로 동작, 인쇄하면 전부 펼쳐짐.

## 8. 오늘(2026-07-31) 세션에서 한 일 — 최근 순

1. GitHub private 저장소 생성 + push, Vercel 연결 + 배포
2. `.vercelignore` 로 데이터·스크립트 비공개 유지(사이트는 공개, 저장소는 비공개)
3. 대차거래추이 API 자동화 (수동 xlsx → API, §16.2.1에 전체 과정 기록)
4. GitHub Actions 워크플로 추가 — 스케줄 자동 갱신
5. 워크플로 러너 전용 버그 3개 디버깅 (YAML 콜론 파싱, 응답 크기 초과, `######` 오버플로 마커)
   → `status.json` 에 진단 정보를 배포해 로그 없이 원격 디버깅
6. 실패 지점 자동 기록(`failedStage`) + push 레이스 방어(rebase 재시도)
7. 리포트 핵심 요약에 전일 대비 스트립 + 1년 추세 차트(`<details>`) 추가
8. 코스피·코스닥 지수 장중 반영(네이버 소스, FREESIS 보다 하루 빠름)
9. `scripts/**` push 시 워크플로 즉시 실행되게 트리거 추가(검증 속도 향상)
10. 사이클별 상세를 하위 탭으로 분리(2020–21 vs 2025–26, 지수 레벨이 3,305p vs 9,115p로 달라서)
11. PART 1/PART 2/ALL 탭 스타일 — 선택 시 색 채움 + 흰 글자로 가시성 개선
12. 과제 보고용 PPT 작성(`코스피_유동성분석_과제보고.pptx`, 8절 구조)

전 커밋 메시지가 "왜"를 담고 있다 — `git log` 로 훑으면 각 결정의 배경이 나온다.

## 9. 다음에 고려할 만한 것 (전부 선택사항, 지시 아님)

- 분리 신용공여 xlsx 도 API 경로가 있을 수 있다 — 대차거래처럼 브라우저로 요청 캡처하면 찾을 가능성
- 워크플로가 며칠 조용하면 `status.json` 의 `ranOn` 확인하는 습관
- PPT 는 스크립트(`scratchpad/deck2.js`, 이 세션 임시 디렉터리)로 만들어서 데이터가 바뀌면 재생성 가능 —
  다만 그 스크립트는 저장소에 없다(일회성 산출물). 필요하면 다시 만들어 달라고 하면 됨

## 10. 막히면

`docs/methodology.md` §22 에 "로컬에서 되는데 러너에서 안 될 때 진단하는 순서"가 정리되어 있다.
같은 패턴(진단을 `status.json` 에 심어 원격 추적)을 다시 쓰면 된다.
