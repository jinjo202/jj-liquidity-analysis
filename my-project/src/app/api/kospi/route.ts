import { NextResponse } from 'next/server'
import { fetchKospiLive } from '@/lib/naver-index'

// 장중 지수만 별도로 자주 갱신한다. 네이버 호출 자체는 fetch 캐시(60초)로 막아 두었으므로
// 화면이 1분마다 폴링해도 외부 요청은 분당 1회다.
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await fetchKospiLive()) }, {
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    // 실패해도 화면은 스냅샷 종가를 그대로 보여주면 된다. 조용히 502 만 돌려준다.
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[api/kospi] 시세 조회 실패:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
