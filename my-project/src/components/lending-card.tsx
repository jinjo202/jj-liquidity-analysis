import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

const DAY_CLASS_LABELS: { key: 'coverType' | 'jointUnwind' | 'newShort' | 'riskOn'; label: string; hint: string }[] = [
  { key: 'coverType', label: '숏커버형', hint: '지수↑ 잔고↓ — 숏이 밀리며 사서 갚는 압력이 지수를 밀었을 수 있습니다' },
  { key: 'jointUnwind', label: '동반 청산', hint: '지수↓ 잔고↓ — 위험자산 전반이 함께 줄어드는 국면입니다' },
  { key: 'newShort', label: '신규 숏 추정', hint: '지수↓ 잔고↑ — 하락에 베팅하는 물량이 늘고 있다는 뜻입니다' },
  { key: 'riskOn', label: '리스크온', hint: '지수↑ 잔고↑ — 잔고 증가가 반드시 약세 베팅은 아닙니다(차익거래 등)' },
]

export function LendingCard({ snap }: { snap: AnalysisSnapshot }) {
  const l = snap.lending
  if (!l) return null

  const sc = l.shortCoverLadder
  const allTimeDeclinePct = (l.last.balJo / l.allTimePeak.balJo - 1) * 100
  const dayClassTotal = l.dayClass.coverType + l.dayClass.jointUnwind + l.dayClass.newShort + l.dayClass.riskOn

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">대차잔고(공매도 프록시)와 숏커버링</CardTitle>
        <CardDescription>
          한국은 공매도가 거의 전량 &apos;차입 후 매도&apos; 구조라, 대차잔고(주식 대차거래 잔고)를
          시장 전체 공매도 잔고의 표준 프록시로 봅니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">역대 최고 잔고 대비 현재</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPct(allTimeDeclinePct)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              역대 최고 {formatJo(l.allTimePeak.balJo)} ({formatDateKo(l.allTimePeak.date)}) → 현재{' '}
              {formatJo(l.last.balJo)} ({formatDateKo(l.last.date)})
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">이번 사이클 고점 대비 현재</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPct(l.cycleDeclinePct)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              사이클 고점 {formatJo(l.cyclePeak.balJo)} ({formatDateKo(l.cyclePeak.date)}, 코스피{' '}
              {formatIdx(l.cyclePeak.idx)}) 이후 변화입니다.
            </p>
          </div>
        </div>

        <Separator />

        <div>
          <p className="text-sm font-medium">사이클 고점 이후 지수-잔고 하루 단위 조합</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            총 {dayClassTotal}거래일 기준입니다.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {DAY_CLASS_LABELS.map(d => (
              <Badge key={d.key} variant="outline" title={d.hint} className="h-auto px-2.5 py-1">
                {d.label} {l.dayClass[d.key]}일
              </Badge>
            ))}
          </div>
        </div>

        {sc && sc.rows.length > 0 && (
          <>
            <Separator />

            <div>
              <p className="text-sm font-medium">숏커버 사다리 — 지수가 오르면 손실권에 드는 대차잔고</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                대차잔고가 늘어난 날의 지수를 그 물량의 진입 지수로 보고 지수대별로 쌓았습니다.
                지수가 그 구간 위로 올라오면 그 물량은 손실 구간에 들어갑니다 — 마진콜 사다리와
                방향만 반대입니다. 현재 {formatIdx(sc.currentIdx)} 기준 이미 손실권{' '}
                {formatJo(sc.underwaterJo)}, 위쪽에 남은 물량 {formatJo(sc.aboveJo)}입니다.
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium">지수</th>
                      <th className="py-1.5 pr-4 font-medium">손실권 진입</th>
                      <th className="py-1.5 pr-4 font-medium">누적</th>
                      <th className="py-1.5 font-medium">누적 / 하루 거래대금</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sc.rows.map(r => (
                      <tr key={r.threshold} className="border-t">
                        <td className="py-1.5 pr-4 tabular-nums">{formatIdx(r.threshold)} 위</td>
                        <td className="py-1.5 pr-4 tabular-nums">+{formatJo(r.incrementalJo)}</td>
                        <td className="py-1.5 pr-4 tabular-nums">{formatJo(r.cumulativeJo)}</td>
                        <td className="py-1.5 tabular-nums">
                          {r.cumulativePctOfDay == null ? '-' : formatPct(r.cumulativePctOfDay)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                신용융자와 달리 대차거래에는 공표된 강제 청산 규칙(담보유지비율)이 없습니다.
                그래서 이 표는 &apos;얼마가 청산된다&apos;가 아니라 &apos;얼마가 손실권에
                든다&apos;를 셉니다 — 커버 압력의 상한으로 읽어 주세요.
              </p>
            </div>
          </>
        )}

        <Separator />

        <div>
          <p className="text-sm font-medium">숏커버링 후보일</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            지수는 오르고 잔고는 줄어든 날 중, 두 변화 폭이 클수록 상위에 놓입니다.
          </p>
          {l.candidates.length ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium">날짜</th>
                    <th className="py-1.5 pr-4 font-medium">지수 등락률</th>
                    <th className="py-1.5 font-medium">잔고 등락률</th>
                  </tr>
                </thead>
                <tbody>
                  {l.candidates.map(c => (
                    <tr key={c.date} className="border-t">
                      <td className="py-1.5 pr-4 tabular-nums">{formatDateKo(c.date)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">+{formatPct(c.dIdxPct ?? 0)}</td>
                      <td className="py-1.5 tabular-nums">{formatPct(c.dBalPct ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              사이클 고점 이후 아직 뚜렷한 숏커버링 후보일이 없습니다.
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          한계: 대차잔고는 공매도 전용이 아닙니다 — ETF 설정/환매, 차익거래, 배당락 대비, 의결권
          확보 등 다른 목적으로도 변합니다. 잔고 변화 전부를 공매도 포지션 변화로 읽으면
          과대해석입니다.
        </p>
      </CardContent>
    </Card>
  )
}
