import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { KospiLive } from '@/components/kospi-live'
import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatPct } from '@/lib/format'

export function SummaryCards({ snap }: { snap: AnalysisSnapshot }) {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  if (!cur) return null
  const h = cur.headline
  const p = snap.projection
  const closed = snap.periods.find(period => period.closed)?.markets['전체']

  const items: { title: string; body?: ReactNode; value?: string; sub?: string; hint?: string }[] = [
    {
      title: '코스피',
      // 지수만 장중에도 갱신한다(클라이언트에서 폴링). 나머지 카드는 배치 기준 그대로다.
      body: <KospiLive fallbackIdx={h.idxLast} fallbackDate={h.idxLastDate} peakIdx={h.idxPeak} />,
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
      sub: closed ? `2021년 사이클은 최종 ${formatPct(Math.abs(closed.headline.unwindPct))}까지 진행` : undefined,
      hint: '빌린 돈으로 산 주식이 얼마나 정리됐는지를 나타냅니다.',
    },
    {
      title: '잔여 청산 추정',
      value: p ? `${formatJo(p.lowJo)} ~ ${formatJo(p.highJo)}` : '-',
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
            {it.body ?? (
              <>
                <p className="text-2xl font-semibold tabular-nums">{it.value}</p>
                <p className="text-xs text-muted-foreground">{it.sub}</p>
                <p className="text-xs text-muted-foreground/80">{it.hint}</p>
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
