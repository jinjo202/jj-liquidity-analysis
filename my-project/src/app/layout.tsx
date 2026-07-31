import type { Metadata } from 'next'
import './globals.css'
import Link from 'next/link'
import { Disclaimer } from '@/components/disclaimer'

export const metadata: Metadata = {
  title: '코스피 신용잔고·반대매매 분석',
  description: '코스피 지수대별 신용융자 누적과 반대매매 진행률, 2021년 사이클과의 비교 분석',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
            <Link href="/" className="font-semibold">코스피 신용잔고·반대매매 분석</Link>
            <Link href="/methodology" className="text-sm text-muted-foreground hover:text-foreground">
              계산 방법
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="border-t">
          <div className="mx-auto max-w-6xl space-y-1 px-4 py-6">
            <Disclaimer />
            <p className="text-xs text-muted-foreground">
              자료: 금융투자협회 FREESIS 일별 통계
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
