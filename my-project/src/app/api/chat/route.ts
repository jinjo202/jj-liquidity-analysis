import { NextResponse } from 'next/server'
import { getLatestSnapshot } from '@/lib/queries'
import { summarizeForPrompt, callOpenRouter, CHAT_SYSTEM_PROMPT, DISCLAIMER } from '@/lib/openrouter'
import { checkRateLimit, checkGlobalDailyLimit } from '@/lib/rate-limit'

const MAX_QUESTION_LEN = 500

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!checkRateLimit(ip, Date.now())) {
    return NextResponse.json(
      { error: '질문이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 })
  }
  if (!checkGlobalDailyLimit(Date.now())) {
    return NextResponse.json(
      { error: '오늘의 질문 한도에 도달했습니다. 내일 다시 시도해 주세요.' }, { status: 503 })
  }

  let question: unknown
  try {
    question = (await req.json())?.question
  } catch {
    return NextResponse.json({ error: '요청 형식이 잘못되었습니다.' }, { status: 400 })
  }
  if (typeof question !== 'string' || !question.trim()) {
    return NextResponse.json({ error: '질문을 입력해 주세요.' }, { status: 400 })
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: `질문은 ${MAX_QUESTION_LEN}자 이내로 입력해 주세요.` }, { status: 400 })
  }

  const snap = await getLatestSnapshot()
  if (!snap) {
    return NextResponse.json({ error: '아직 데이터가 준비되지 않았습니다.' }, { status: 503 })
  }

  try {
    const answer = await callOpenRouter([
      {
        role: 'system',
        content: `${CHAT_SYSTEM_PROMPT}\n\n다음은 답변에 사용할 수 있는 데이터입니다.\n\n${summarizeForPrompt(snap)}`,
      },
      { role: 'user', content: question.trim() },
    ])
    return NextResponse.json({ answer: `${answer}\n\n${DISCLAIMER}` })
  } catch (e) {
    console.error('[chat] 실패:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: '답변 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 502 })
  }
}
