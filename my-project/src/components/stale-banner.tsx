import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatDateKo } from '@/lib/format'

export function StaleBanner({ lastDate, days }: { lastDate: string; days: number }) {
  if (days <= 3) return null
  return (
    <Alert>
      <AlertDescription>
        최신 데이터가 {formatDateKo(lastDate)} 기준입니다 ({days}일 전).
        금융투자협회 데이터 갱신이 지연되었거나 연휴 기간일 수 있습니다.
      </AlertDescription>
    </Alert>
  )
}
