export const formatJo = (n: number) => `${n.toFixed(2)}조원`
export const formatIdx = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}p`
export const formatPct = (n: number) => `${n.toFixed(1)}%`

export function formatDateKo(d: string): string {
  const y = d.slice(0, 4)
  const m = Number(d.slice(4, 6))
  const day = Number(d.slice(6, 8))
  return `${y}년 ${m}월 ${day}일`
}
