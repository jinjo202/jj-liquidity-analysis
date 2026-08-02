'use client'

import { useEffect, useState } from 'react'
import type { LiveIndex } from '@/lib/naver-index'
import { formatIdx, formatPct, formatDateKo } from '@/lib/format'

const POLL_MS = 60_000

/**
 * 요약 카드의 '코스피' 칸. 서버가 그린 스냅샷 종가로 먼저 렌더하고, 장중 시세가 오면 바꿔 단다.
 * 실패하거나 JS 가 안 돌면 종가가 그대로 남는다 — 값이 사라지지 않는다.
 */
export function KospiLive({ fallbackIdx, fallbackDate, peakIdx }: {
  fallbackIdx: number; fallbackDate: string; peakIdx: number
}) {
  const [live, setLive] = useState<LiveIndex | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      // 백그라운드 탭에서까지 1분마다 때릴 이유가 없다.
      if (document.visibilityState !== 'visible') return
      try {
        const res = await fetch('/api/kospi')
        if (!res.ok) return
        const d = await res.json()
        if (alive && d?.ok && Number.isFinite(d.close)) setLive(d as LiveIndex)
      } catch {
        // 네트워크 실패는 무시한다. 스냅샷 종가가 남아 있다.
      }
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // 스냅샷보다 날짜가 앞서면 아직 확정 공표되지 않은 값 = 장중이다.
  const intraday = !!live && live.date > fallbackDate
  const idx = live?.close ?? fallbackIdx
  const date = live?.date ?? fallbackDate

  return (
    <>
      <p className="text-2xl font-semibold tabular-nums">
        {formatIdx(idx)}
        {intraday && (
          <span className="ml-1.5 align-middle text-xs font-normal text-muted-foreground">장중</span>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        고점 {formatIdx(peakIdx)} 대비 {formatPct((idx / peakIdx - 1) * 100)}
      </p>
      <p className="text-xs text-muted-foreground/80">
        {intraday
          ? `${formatDateKo(date)} 장중 시세입니다. 1분마다 갱신되며, 아래 분석은 ${formatDateKo(fallbackDate)} 확정치 기준입니다.`
          : `${formatDateKo(date)} 종가 기준입니다.`}
        {intraday && live?.changePct != null && ` 전일 대비 ${live.changePct >= 0 ? '+' : ''}${formatPct(live.changePct)}.`}
      </p>
    </>
  )
}
