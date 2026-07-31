import { NextResponse } from 'next/server'
import { fetchKofiaSeries } from '@/lib/fetch-kofia'
import { buildAnalysis } from '@/lib/analyze'
import {
  saveDailyMarket, saveSnapshot, saveCommentary, getLatestCreditSplit, getLatestLendingBalance,
} from '@/lib/queries'
import { generateCommentary } from '@/lib/openrouter'

export const maxDuration = 300

function todayKST(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 10).replace(/-/g, '')
}

async function run() {
  const [series, splitSeries, lendingSeries] = await Promise.all([
    fetchKofiaSeries(2010, todayKST()),
    getLatestCreditSplit(),
    getLatestLendingBalance(),
  ])
  if (!series.length) throw new Error('KOFIA 응답이 비어 있습니다')

  const snap = buildAnalysis(
    series,
    splitSeries.length ? splitSeries : undefined,
    lendingSeries.length ? lendingSeries : undefined,
  )
  await saveDailyMarket(series)
  await saveSnapshot(snap)

  const { content, model } = await generateCommentary(snap)
  await saveCommentary(snap.meta.lastDate, content, model)

  return { lastDate: snap.meta.lastDate, rows: series.length, model }
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: '인증 실패' }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, ...(await run()) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[cron] 갱신 실패:', msg)
    // 실패해도 500 을 던져 Vercel 이 재시도할 수 있게 한다.
    // 기존 스냅샷은 그대로 남아 있으므로 화면은 계속 동작한다.
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export const POST = GET
