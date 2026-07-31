import { getServiceClient, getPublicClient } from '@/lib/supabase'
import type { AnalysisSnapshot, CreditSplitRow, LendingRow } from '@/lib/types'
import type { KofiaRow } from '@/lib/fetch-kofia'
import type { SupabaseClient } from '@supabase/supabase-js'

// PostgREST caps rows per request at the project's max_rows setting (1000 here) regardless
// of .limit() — page through with .range() until a short page signals the end.
async function fetchAllPages<T>(
  sb: SupabaseClient, table: string, columns: string, pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb.from(table).select(columns)
      .order('date', { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`)
    if (!data?.length) break
    out.push(...(data as T[]))
    if (data.length < pageSize) break
  }
  return out
}

export function daysSince(dateYYYYMMDD: string, now: Date): number {
  const y = Number(dateYYYYMMDD.slice(0, 4))
  const m = Number(dateYYYYMMDD.slice(4, 6))
  const d = Number(dateYYYYMMDD.slice(6, 8))
  const then = Date.UTC(y, m - 1, d)
  // KST 기준 날짜로 비교 (한국 장 마감 기준 데이터)
  const kst = new Date(now.getTime() + 9 * 3600 * 1000)
  const today = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate())
  return Math.round((today - then) / 86_400_000)
}

export async function saveDailyMarket(rows: KofiaRow[]): Promise<void> {
  const sb = getServiceClient()
  const payload = rows.map(r => ({
    date: r.date,
    kospi: r.OS0001 ?? null,
    kosdaq: r.OS0002 ?? null,
    credit_loan: r.OS0026 ?? null,
    forced_sell: r.OS0025 ?? null,
    unpaid: r.OS0024 ?? null,
    kospi_market_cap: r.OS0008 ?? null,
    kosdaq_market_cap: r.OS0009 ?? null,
    kospi_turnover: r.OS0011 ?? null,
    kosdaq_turnover: r.OS0012 ?? null,
    updated_at: new Date().toISOString(),
  }))
  // 행이 많으므로 1000개씩 나눠 upsert
  for (let i = 0; i < payload.length; i += 1000) {
    const { error } = await sb.from('daily_market')
      .upsert(payload.slice(i, i + 1000), { onConflict: 'date' })
    if (error) throw new Error(`daily_market upsert 실패: ${error.message}`)
  }
}

export async function getLatestCreditSplit(): Promise<CreditSplitRow[]> {
  try {
    const sb = getPublicClient()
    const data = await fetchAllPages<{ date: string; total: unknown; kospi: unknown; kosdaq: unknown }>(
      sb, 'credit_split_raw', 'date, total, kospi, kosdaq')
    // PostgREST가 numeric 컬럼을 문자열로 내려줄 수 있어(설정에 따라 다름) 명시적으로 숫자로 변환한다.
    // 변환하지 않으면 analyze.ts의 Number.isFinite(r.credit) 필터가 모든 행을 조용히 걸러내
    // 유가증권/코스닥 분리 기능 전체가 "데이터 없음"으로 저하될 수 있다.
    return data.map(r => ({
      date: r.date, total: Number(r.total), kospi: Number(r.kospi), kosdaq: Number(r.kosdaq),
    }))
  } catch (e) {
    // 네트워크 레벨 실패(Supabase 접속 불가 등)는 {error} 응답이 아니라 예외로 던져지므로
    // 여기서 잡지 않으면 페이지 전체가 500이 난다. 데이터 없음과 동일하게 취급해 완만하게 저하시킨다.
    console.error('credit_split_raw 조회 중 예외 발생:', e instanceof Error ? e.message : e)
    return []
  }
}

export async function saveLendingBalance(rows: LendingRow[]): Promise<void> {
  const sb = getServiceClient()
  const payload = rows.map(r => ({
    date: r.date,
    deal_shares: r.dealShares,
    repay_shares: r.repayShares,
    balance_shares: r.balanceShares,
    balance_mil: r.balanceMil,
    updated_at: new Date().toISOString(),
  }))
  // 행이 많으므로 1000개씩 나눠 upsert
  for (let i = 0; i < payload.length; i += 1000) {
    const { error } = await sb.from('lending_balance_raw')
      .upsert(payload.slice(i, i + 1000), { onConflict: 'date' })
    if (error) throw new Error(`lending_balance_raw upsert 실패: ${error.message}`)
  }
}

export async function getLatestLendingBalance(): Promise<LendingRow[]> {
  try {
    const sb = getPublicClient()
    const data = await fetchAllPages<{
      date: string; deal_shares: unknown; repay_shares: unknown
      balance_shares: unknown; balance_mil: unknown
    }>(sb, 'lending_balance_raw', 'date, deal_shares, repay_shares, balance_shares, balance_mil')
    // PostgREST가 numeric 컬럼을 문자열로 내려줄 수 있어(설정에 따라 다름) 명시적으로 숫자로 변환한다.
    // 변환하지 않으면 analyze.ts의 Number.isFinite 필터가 모든 행을 조용히 걸러내
    // 대차잔고 분석 전체가 "데이터 없음"으로 저하될 수 있다.
    return data.map(r => ({
      date: r.date,
      dealShares: r.deal_shares == null ? null : Number(r.deal_shares),
      repayShares: r.repay_shares == null ? null : Number(r.repay_shares),
      balanceShares: Number(r.balance_shares),
      balanceMil: Number(r.balance_mil),
    }))
  } catch (e) {
    // 네트워크 레벨 실패(Supabase 접속 불가 등)는 {error} 응답이 아니라 예외로 던져지므로
    // 여기서 잡지 않으면 페이지 전체가 500이 난다. 데이터 없음과 동일하게 취급해 완만하게 저하시킨다.
    console.error('lending_balance_raw 조회 중 예외 발생:', e instanceof Error ? e.message : e)
    return []
  }
}

export async function saveSnapshot(snap: AnalysisSnapshot): Promise<void> {
  const sb = getServiceClient()
  const { error: e1 } = await sb.from('analysis_snapshot')
    .update({ is_latest: false }).eq('is_latest', true)
  if (e1) throw new Error(`snapshot 플래그 갱신 실패: ${e1.message}`)
  const { error: e2 } = await sb.from('analysis_snapshot')
    .insert({ last_date: snap.meta.lastDate, is_latest: true, data: snap })
  if (e2) throw new Error(`snapshot 저장 실패: ${e2.message}`)
}

export async function saveCommentary(date: string, content: string, model: string): Promise<void> {
  const sb = getServiceClient()
  const { error } = await sb.from('ai_commentary')
    .upsert({ date, content, model }, { onConflict: 'date' })
  if (error) throw new Error(`해설 저장 실패: ${error.message}`)
}

export async function getLatestSnapshot(): Promise<AnalysisSnapshot | null> {
  try {
    const sb = getPublicClient()
    const { data, error } = await sb.from('analysis_snapshot')
      .select('data').eq('is_latest', true)
      .order('computed_at', { ascending: false }).limit(1).maybeSingle()
    if (error) console.error('analysis_snapshot 조회 실패:', error.message)
    if (error || !data) return null
    return data.data as AnalysisSnapshot
  } catch (e) {
    console.error('analysis_snapshot 조회 중 예외 발생:', e instanceof Error ? e.message : e)
    return null
  }
}

export async function getLatestCommentary(): Promise<{ date: string; content: string } | null> {
  try {
    const sb = getPublicClient()
    const { data, error } = await sb.from('ai_commentary')
      .select('date, content')
      .order('date', { ascending: false }).limit(1).maybeSingle()
    if (error) console.error('ai_commentary 조회 실패:', error.message)
    if (error || !data) return null
    return data as { date: string; content: string }
  } catch (e) {
    console.error('ai_commentary 조회 중 예외 발생:', e instanceof Error ? e.message : e)
    return null
  }
}
