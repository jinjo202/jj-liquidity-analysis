'use client'

import { useState } from 'react'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AnalysisSnapshot } from '@/lib/types'
import type { MarketAnalysis } from '@/lib/buckets'
import { formatIdx, formatPct, formatJo } from '@/lib/format'

// 심각도(반대매매 진행 정도)와 시각적 무게를 맞춘다: 가장 주목해야 할 '전체 청산 완료'
// 구간이 가장 진하게(chart-5) 보이고, 아직 안 터진 구간이 가장 옅게(chart-1) 보인다.
const COLORS = {
  full: 'var(--chart-5)',
  partial: 'var(--chart-3)',
  none: 'var(--chart-1)',
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
                    formatter={(v) => [`${v}조원`, '신용매수']}
                    labelFormatter={(l) => `코스피 ${l}p`}
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
