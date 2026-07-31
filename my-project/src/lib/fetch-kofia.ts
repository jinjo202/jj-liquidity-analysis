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
