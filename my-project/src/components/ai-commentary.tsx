import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDateKo } from '@/lib/format'

export function AiCommentary(
  { commentary }: { commentary: { date: string; content: string } | null },
) {
  if (!commentary) return null
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">오늘의 시장 해설</CardTitle>
        <Badge variant="secondary">{formatDateKo(commentary.date)} 기준</Badge>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{commentary.content}</p>
      </CardContent>
    </Card>
  )
}
