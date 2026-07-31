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

// IP별 한도와 별개로, 인증 없는 /api/chat 전체에 걸리는 하루 총 호출 한도.
// OpenRouter 비용은 요청마다 실제로 발생하므로, IP를 바꿔가며 우회해도
// 하루 전체 지출은 이 한도를 넘지 않게 한다.
let globalDay = ''
let globalCount = 0

export function resetGlobalDailyLimit(): void {
  globalDay = ''
  globalCount = 0
}

export function checkGlobalDailyLimit(now: number, limit = 500): boolean {
  const day = new Date(now).toISOString().slice(0, 10) // UTC 날짜(YYYY-MM-DD)
  if (day !== globalDay) {
    globalDay = day
    globalCount = 0
  }
  globalCount += 1
  return globalCount <= limit
}
