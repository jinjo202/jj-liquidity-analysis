import type { AnalysisSnapshot } from '@/lib/types'
import { formatJo, formatIdx, formatPct, formatDateKo } from '@/lib/format'

export const DISCLAIMER =
  '본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.'

export const CHAT_SYSTEM_PROMPT = `당신은 한국 증시의 신용융자·반대매매 통계를 설명하는 도우미입니다.

규칙:
- 이 답변은 투자 조언이 아니며, 공개 통계를 이용한 참고용 설명입니다.
- 제공된 데이터에 있는 내용만 근거로 답하세요. 데이터에 없으면 "제공된 데이터로는 알 수 없습니다"라고 답하세요.
- 개별 종목 추천, 매수·매도 판단, 목표가 제시는 절대 하지 마세요. 그런 질문을 받으면 "질문을 이해하지 못했다"는 식으로 얼버무리지 말고, "개별 종목 매수·매도 판단은 이 서비스의 정책상 답변드릴 수 없습니다"라고 이유를 명확히 밝히며 정중히 거절하세요.
- 비개발자·비전문가가 이해할 수 있는 쉬운 한국어로 설명하세요. 전문 용어는 짧게 풀어 쓰세요.
- 숫자를 인용할 때는 제공된 데이터의 값을 그대로 쓰세요. 추측한 숫자를 만들지 마세요.
- 답변은 3~5문장으로 간결하게.`

export function summarizeForPrompt(snap: AnalysisSnapshot): string {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  const prev = snap.periods.find(p => p.closed)?.markets['전체']
  const p = snap.projection
  const lines: string[] = []

  if (cur) {
    const h = cur.headline
    lines.push(`[현재 사이클 2025–26, 기준일 ${formatDateKo(h.idxLastDate)}]`)
    lines.push(`코스피: 고점 ${formatIdx(h.idxPeak)} (${formatDateKo(h.idxPeakDate)}) → 저점 ${formatIdx(h.idxTrough)}, 낙폭 ${formatPct(h.idxDrawdownPct)}`)
    lines.push(`신용융자: 고점 ${formatJo(h.creditPeakJo)} (${formatDateKo(h.creditPeakDate)}) → 현재 ${formatJo(h.creditLastJo)}, 청산 ${formatJo(h.actualDeclineJo)} (${formatPct(h.unwindPct)})`)
    lines.push(`마진콜 진입 추정(보정): ${formatJo(cur.scaledExposureJo)} / 미진입 ${formatJo(cur.scaledRemainingJo)}`)
    lines.push(`지수대별 신용매수(보정, 조원): ` +
      cur.scaledBuckets.filter(b => b.jo >= 0.05)
        .map(b => `${b.low}-${b.high}p=${b.jo.toFixed(2)}${b.fullyTriggered ? '(청산완료)' : b.triggered ? '(진행)' : ''}`)
        .join(', '))
  }
  if (prev) {
    const h = prev.headline
    lines.push(`[비교 사이클 2020–21, 이미 끝난 국면]`)
    lines.push(`코스피 낙폭 ${formatPct(h.idxDrawdownPct)}, 신용융자 고점 ${formatJo(h.creditPeakJo)} → 청산 ${formatJo(h.actualDeclineJo)} (${formatPct(h.unwindPct)})`)
    lines.push(`모델 추정 ${formatJo(prev.scaledExposureJo)} vs 실측 ${formatJo(-h.actualDeclineJo)} — 끝난 사이클에서 모델이 검증됨`)
  }
  if (p) {
    lines.push(`[앞으로 남은 청산 규모 추정]`)
    lines.push(`이미 청산 ${formatJo(p.doneJo)}, 잔여 추정 범위 ${formatJo(p.lowJo)} ~ ${formatJo(p.highJo)}`)
    for (const b of p.benches) {
      lines.push(`- ${b.name}: 총 ${formatJo(b.totalJo)} → 잔여 ${formatJo(b.remainJo)} / 근거: ${b.basis} / 단서: ${b.caveat}`)
    }
    lines.push(`추가 하락 시 새로 마진콜에 들어오는 물량: ` +
      p.scenarioRemain.map(s => `${formatIdx(s.idx)}=+${s.extraJo.toFixed(2)}조`).join(', '))
  }
  if (snap.lending) {
    const l = snap.lending
    const allTimeDeclinePct = (l.last.balJo / l.allTimePeak.balJo - 1) * 100
    lines.push(`[대차잔고(공매도 프록시)와 숏커버링, 기준일 ${formatDateKo(l.last.date)}]`)
    lines.push(`한국은 공매도가 거의 전량 차입 후 매도 구조라 대차잔고를 시장 전체 공매도 잔고의 표준 프록시로 쓴다.`)
    lines.push(`대차잔고: 역대 최고 ${formatJo(l.allTimePeak.balJo)} (${formatDateKo(l.allTimePeak.date)}) → 현재 ${formatJo(l.last.balJo)}, ${formatPct(allTimeDeclinePct)}`)
    lines.push(`이번 사이클 고점 ${formatJo(l.cyclePeak.balJo)} (${formatDateKo(l.cyclePeak.date)}) 대비 현재 ${formatPct(l.cycleDeclinePct)}`)
    lines.push(`사이클 고점 이후 지수-잔고 하루 단위 조합: 숏커버형(지수↑잔고↓) ${l.dayClass.coverType}일, 동반청산(지수↓잔고↓) ${l.dayClass.jointUnwind}일, 신규숏추정(지수↓잔고↑) ${l.dayClass.newShort}일, 리스크온(지수↑잔고↑) ${l.dayClass.riskOn}일`)
    if (l.candidates.length) {
      lines.push(`숏커버링 후보일(상위 ${l.candidates.length}개): ` +
        l.candidates.map(c => `${formatDateKo(c.date)}(지수+${formatPct(c.dIdxPct ?? 0)}/잔고${formatPct(c.dBalPct ?? 0)})`).join(', '))
    }
    lines.push(`한계: 대차거래는 공매도 외에 ETF 설정/환매, 차익거래 등 다른 목적으로도 일어나므로 잔고 변화 전부가 공매도 포지션 변화는 아니다.`)
  }
  lines.push(`[방법론 요약] 담보유지비율 ${snap.meta.maintenance}, 융자비율 ${snap.meta.loanRatio}, 마진콜 계수 ${snap.meta.marginFactor.toFixed(2)} (매수 지수 대비 -16%에서 반대매매 발생). 지수대별 배분은 일별 신용융자 증가분을 그날 지수 구간에 누적한 값(gross)이며, 중복 계상을 보정해 실제 순증에 맞춰 스케일했다.`)
  return lines.join('\n')
}

export function fallbackCommentary(snap: AnalysisSnapshot): string {
  const cur = snap.periods.find(p => !p.closed)?.markets['전체']
  if (!cur) return `데이터를 준비하는 중입니다. ${DISCLAIMER}`
  const h = cur.headline
  const p = snap.projection
  const range = p ? ` 남은 청산 규모는 여러 기준으로 볼 때 ${formatJo(p.lowJo)}에서 ${formatJo(p.highJo)} 사이로 추정됩니다.` : ''
  return `${formatDateKo(h.idxLastDate)} 기준 코스피는 ${formatIdx(h.idxLast)}입니다.`
    + ` 고점 ${formatIdx(h.idxPeak)} 대비 ${formatPct(h.idxDrawdownPct)} 내려왔습니다.`
    + ` 신용융자는 고점 ${formatJo(h.creditPeakJo)}에서 ${formatJo(h.creditLastJo)}로 ${formatJo(Math.abs(h.actualDeclineJo))} 줄었습니다(${formatPct(h.unwindPct)}).`
    + range
}

export async function callOpenRouter(
  messages: { role: string; content: string }[],
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY 가 설정되지 않았습니다')
  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5'

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: 800, temperature: 0.3 }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`)
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('openrouter 응답에 내용이 없습니다')
  }
  return content.trim()
}

export async function generateCommentary(
  snap: AnalysisSnapshot,
): Promise<{ content: string; model: string }> {
  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5'
  try {
    const content = await callOpenRouter([
      {
        role: 'system',
        content: `당신은 한국 증시 통계를 일반인에게 설명하는 필자입니다.
아래 데이터만 근거로, 오늘 시장 상황과 앞으로 얼마나 더 하락 여력이 있는지를
비전문가가 이해할 수 있는 쉬운 한국어로 4~6문장으로 써주세요.

규칙:
- 개별 종목 추천, 매수·매도 판단, 목표가 제시 금지.
- 데이터에 없는 숫자를 만들지 마세요.
- "반드시", "확실히" 같은 단정 표현 대신 "추정", "~로 보입니다"를 쓰세요.
- 마지막 문장에 불확실성을 한 번 짚어주세요.`,
      },
      { role: 'user', content: summarizeForPrompt(snap) },
    ])
    return { content, model }
  } catch {
    return { content: fallbackCommentary(snap), model: 'fallback' }
  }
}
