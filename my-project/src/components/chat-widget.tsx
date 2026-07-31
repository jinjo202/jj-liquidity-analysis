'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'

type Msg = { role: 'user' | 'assistant'; content: string }

const EXAMPLES = [
  '지금 신용잔고는 얼마나 남았어?',
  '2021년과 지금 뭐가 달라?',
  '코스피가 5,000p까지 가면 어떻게 돼?',
]

export function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(question: string) {
    const q = question.trim()
    if (!q || busy) return
    setError(null)
    setInput('')
    setMsgs(m => [...m, { role: 'user', content: q }])
    setBusy(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? '답변을 받지 못했습니다.')
      } else {
        setMsgs(m => [...m, { role: 'assistant', content: json.answer }])
      }
    } catch {
      setError('네트워크 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button className="fixed bottom-6 right-6 shadow-lg" size="lg" />}>
        궁금한 점 물어보기
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>데이터에 대해 물어보세요</SheetTitle>
          <SheetDescription>
            이 페이지에 있는 통계를 근거로만 답합니다. 종목 추천이나 매수·매도 판단은 하지 않습니다.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 pr-3">
          <div className="space-y-3">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">예시 질문:</p>
                {EXAMPLES.map(q => (
                  <Button key={q} variant="outline" size="sm"
                    className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                    onClick={() => send(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i}
                className={m.role === 'user'
                  ? 'ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
                  : 'max-w-[90%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap'}>
                {m.content}
              </div>
            ))}
            {busy && <p className="text-sm text-muted-foreground">답변을 준비하고 있습니다…</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </ScrollArea>

        <form className="flex gap-2"
          onSubmit={e => { e.preventDefault(); send(input) }}>
          <Input value={input} onChange={e => setInput(e.target.value)}
            placeholder="질문을 입력하세요" maxLength={500} disabled={busy} />
          <Button type="submit" disabled={busy || !input.trim()}>전송</Button>
        </form>
      </SheetContent>
    </Sheet>
  )
}
