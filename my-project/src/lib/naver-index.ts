// 네이버 금융 코스피 시세. 화면 상단 '현재가' 표시 전용이다.
//
// 왜 따로 받는가: 배치(cron)는 하루 한 번 돌고, 금투협 FREESIS 는 EOD 공표라 장중에는
// 전일 종가가 최신이다. 분석 계산 자체는 하루 한 번이면 충분하지만 지수 숫자만은
// 지금 값을 보여주는 게 맞다. 계산에는 절대 쓰지 않는다 — 표시 전용이다.
//
// KRX 정보데이터시스템은 폼 필드가 JS 런타임에 생성되어 파라미터를 고정하기 어렵다.
// 네이버 siseJson 은 날짜 범위를 그대로 받는다(원본 프로젝트 scripts/fetch-index.mjs 와 같은 경로).

const URL = 'https://api.finance.naver.com/siseJson.naver'
const REVALIDATE_SEC = 60

export type IndexPoint = { date: string; close: number }

export type LiveIndex = {
  date: string; close: number
  prevDate: string | null; prevClose: number | null
  changePct: number | null
}

/** 응답은 JSON 이 아니라 작은따옴표를 쓰는 JS 리터럴이다. */
export function parseSiseJson(raw: string): IndexPoint[] {
  const rows = JSON.parse(raw.replace(/'/g, '"').trim()) as unknown[][]
  const header = (rows[0] ?? []) as string[]
  const iDate = header.indexOf('날짜')
  const iClose = header.indexOf('종가')
  if (iDate < 0 || iClose < 0) throw new Error(`네이버 응답 헤더가 예상과 다릅니다: ${header.join(',')}`)

  return rows.slice(1)
    .filter(r => Array.isArray(r) && r[iDate])
    .map(r => ({ date: String(r[iDate]), close: Number(r[iClose]) }))
    .filter(r => Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 마지막 두 점으로 현재가와 전일 대비를 만든다. */
export function toLive(points: IndexPoint[]): LiveIndex {
  const last = points.at(-1)
  if (!last) throw new Error('네이버 응답에 시세가 없습니다')
  const prev = points.at(-2) ?? null
  return {
    date: last.date, close: last.close,
    prevDate: prev?.date ?? null, prevClose: prev?.close ?? null,
    changePct: prev ? (last.close / prev.close - 1) * 100 : null,
  }
}

/** YYYYMMDD (KST). 서버가 어느 타임존이든 한국 장 날짜로 조회해야 한다. */
export function ymdKST(now: Date, addDays = 0): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000 + addDays * 86_400_000)
  return kst.toISOString().slice(0, 10).replace(/-/g, '')
}

export async function fetchKospiLive(now = new Date()): Promise<LiveIndex> {
  // 연휴가 길어도 직전 거래일이 잡히도록 열흘을 요청한다(전일 대비 계산에 두 점이 필요).
  const url = `${URL}?symbol=KOSPI&requestType=1`
    + `&startTime=${ymdKST(now, -10)}&endTime=${ymdKST(now)}&timeframe=day`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
    next: { revalidate: REVALIDATE_SEC },
  })
  if (!res.ok) throw new Error(`네이버 시세 조회 실패: ${res.status}`)
  return toLive(parseSiseJson(await res.text()))
}
