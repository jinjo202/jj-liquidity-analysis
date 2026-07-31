import { getLatestSnapshot, getLatestCommentary, daysSince } from '@/lib/queries'
import { StaleBanner } from '@/components/stale-banner'
import { SummaryCards } from '@/components/summary-cards'
import { AiCommentary } from '@/components/ai-commentary'
import { CycleCompare } from '@/components/cycle-compare'
import { ProjectionCard } from '@/components/projection-card'
import { LendingCard } from '@/components/lending-card'
import { ChatWidget } from '@/components/chat-widget'

export const revalidate = 3600

export default async function Page() {
  const [snap, commentary] = await Promise.all([
    getLatestSnapshot(),
    getLatestCommentary(),
  ])

  if (!snap) {
    return (
      <p className="text-sm text-muted-foreground">
        데이터를 준비하는 중입니다. 잠시 후 다시 확인해 주세요.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <StaleBanner lastDate={snap.meta.lastDate} days={daysSince(snap.meta.lastDate, new Date())} />
      <SummaryCards snap={snap} />
      <AiCommentary commentary={commentary} />
      <CycleCompare snap={snap} />
      <ProjectionCard snap={snap} />
      <LendingCard snap={snap} />
      <ChatWidget />
    </div>
  )
}
