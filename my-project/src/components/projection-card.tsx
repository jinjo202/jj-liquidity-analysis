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
            {formatJo(p.lowJo)} ~ {formatJo(p.highJo)}
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
