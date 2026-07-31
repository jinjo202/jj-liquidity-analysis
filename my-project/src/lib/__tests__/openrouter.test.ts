import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { summarizeForPrompt, fallbackCommentary, DISCLAIMER, CHAT_SYSTEM_PROMPT, generateCommentary } from '@/lib/openrouter'
import { buildAnalysis } from '@/lib/analyze'
import type { KofiaRow } from '@/lib/fetch-kofia'

const FIXTURE = path.resolve(__dirname, './fixtures/kofia-daily.json')
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { series: KofiaRow[] }
const snap = buildAnalysis(raw.series)

describe('DISCLAIMER', () => {
  it('면책 문구가 정확히 일치한다', () => {
    expect(DISCLAIMER).toBe('본 서비스는 투자 조언이 아니며, 공개 통계를 이용한 참고용 분석입니다.')
  })
})

describe('CHAT_SYSTEM_PROMPT', () => {
  it('투자 조언 금지 지시를 포함한다', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('투자 조언')
    expect(CHAT_SYSTEM_PROMPT).toContain('종목')
  })

  it('종목 추천 거절 시 애매하게 얼버무리지 않고 정책상 이유를 명시한다', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('정책상')
  })
})

describe('summarizeForPrompt', () => {
  it('핵심 수치를 포함한 요약 텍스트를 만든다', () => {
    const s = summarizeForPrompt(snap)
    expect(s).toContain('5,594p')
    expect(s).toContain('38.63조원')
    expect(s.length).toBeGreaterThan(200)
    expect(s.length).toBeLessThan(4000)
  })
})

describe('fallbackCommentary', () => {
  it('AI 없이도 숫자가 담긴 문장을 만든다', () => {
    const s = fallbackCommentary(snap)
    expect(s).toContain('5,594p')
    expect(s).toContain('조원')
  })
})

describe('generateCommentary', () => {
  it('OpenRouter 호출이 실패하면 fallbackCommentary로 대체하고 model은 fallback', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' } as Response)
    try {
      const result = await generateCommentary(snap)
      expect(result.model).toBe('fallback')
      expect(result.content).toContain('5,594p')
    } finally {
      global.fetch = originalFetch
    }
  })
})
