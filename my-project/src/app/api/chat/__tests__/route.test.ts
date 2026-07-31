import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildAnalysis } from '@/lib/analyze'
import { DISCLAIMER } from '@/lib/openrouter'
import { resetRateLimit, resetGlobalDailyLimit } from '@/lib/rate-limit'
import type { KofiaRow } from '@/lib/fetch-kofia'
import { POST } from '@/app/api/chat/route'

// vi.mock 팩토리는 파일 맨 위로 끌어올려져(hoist) 아래의 일반 import보다 먼저 실행되므로,
// 팩토리 안에서 곧바로 실제 스냅샷을 만들 수 없다(TDZ). 대신 vi.hoisted로 만든 mock 함수를
// 팩토리에 연결해두고, 실제 반환값은 일반 import가 끝난 뒤 아래에서 채운다.
const mocks = vi.hoisted(() => ({ getLatestSnapshot: vi.fn() }))
vi.mock('@/lib/queries', () => ({ getLatestSnapshot: mocks.getLatestSnapshot }))

const FIXTURE = path.resolve(__dirname, '../../../../lib/__tests__/fixtures/kofia-daily.json')
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { series: KofiaRow[] }
const snap = buildAnalysis(raw.series)
mocks.getLatestSnapshot.mockResolvedValue(snap)

describe('POST /api/chat', () => {
  beforeEach(() => {
    resetRateLimit()
    resetGlobalDailyLimit()
  })

  it('시스템 메시지를 하나만 합쳐서 보내고, 답변 끝에 면책 문구를 그대로 붙인다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '삼성전자에 대한 개별 종목 판단은 답변드릴 수 없습니다.' } }] }),
    } as Response)
    const originalFetch = global.fetch
    global.fetch = fetchMock
    const originalKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'test-key'

    try {
      const req = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '삼성전자 사도 될까?' }),
      })
      const res = await POST(req)
      const json = await res.json()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      const systemMessages = body.messages.filter((m: { role: string }) => m.role === 'system')
      expect(systemMessages).toHaveLength(1)

      expect(json.answer.endsWith(DISCLAIMER)).toBe(true)
    } finally {
      global.fetch = originalFetch
      process.env.OPENROUTER_API_KEY = originalKey
    }
  })
})
