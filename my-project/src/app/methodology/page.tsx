import { getLatestSnapshot } from '@/lib/queries'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { formatIdx, formatJo, formatPct } from '@/lib/format'

export const revalidate = 3600

export const metadata = {
  title: '계산 방법 - 코스피 신용잔고·반대매매 분석',
  description: '지수대별 신용융자 누적과 반대매매 진행률을 어떻게 계산했는지 설명합니다.',
}

export default async function MethodologyPage() {
  const snap = await getLatestSnapshot()
  const current = snap?.periods.find(p => !p.closed)?.markets['전체']

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">계산 방법</h1>
        <p className="text-sm text-muted-foreground">
          이 페이지의 숫자가 어떤 가정과 규칙으로 나왔는지 설명합니다. 전문 용어는 최대한 풀어
          썼습니다.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">여덟 가지 질문</CardTitle>
          <CardDescription>
            각 항목을 눌러 펼쳐 보세요. 원문(방법론 문서)을 일반 방문자용으로 압축한 내용입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion>
            <AccordionItem value="1">
              <AccordionTrigger>1. 반대매매는 왜 -16%에서 일어나나</AccordionTrigger>
              <AccordionContent>
                <p>
                  신용융자로 주식을 살 때 내 돈 40 + 증권사에서 빌린 돈 60을 더해 100을 산다고
                  하자. 이때 증권사는 산 주식 전체를 담보로 잡는다.
                </p>
                <p>
                  증권사는 담보 가치가 빌려준 돈의 140%(담보유지비율) 밑으로 떨어지면 반대매매,
                  즉 강제로 주식을 팔아 대출금을 회수한다. 평가액을 P라 하면 조건은{' '}
                  <code>P / 60 ≥ 1.40</code>이고, 이를 풀면 <code>P ≥ 84</code>다. 100에 산 주식이
                  84, 즉 <strong>-16%</strong> 아래로 내려가는 순간 반대매매 조건에 들어간다는
                  뜻이다.
                </p>
                <p>
                  이 -16%(정확히는 담보유지비율 1.40 × 융자비율 0.60 = 0.84라는 계수)로 원 자료의
                  세 날짜(7/27, 7/28, 7/29) 코멘트를 모두 설명할 수 있었다. 이 페이지의 마진콜
                  계산은 전부 이 계수를 기준으로 한다.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="2">
              <AccordionTrigger>2. 지수대별 금액은 어떻게 나눴나</AccordionTrigger>
              <AccordionContent>
                <p>
                  매일 신용융자 잔고가 전날보다 늘어난 만큼(증가분)을, 그날 코스피가 있던 500p
                  구간에 쌓아 나간다. 예를 들어 오늘 코스피가 6,200p이고 신용융자가 1,000억원
                  늘었다면 &quot;6,000-6,500 구간&quot;에 1,000억원을 더하는 식이다.
                </p>
                <p>
                  잔고가 줄어든 날은 계산에서 뺀다(증가분만 누적). 여러 방식을 실측과 대조해 봤을
                  때 이 방식만 원 자료의 구간별 숫자와 맞아떨어졌다.
                </p>
                <p>
                  그래서 이 막대그래프의 값은 <strong>&quot;그 지수대에서 새로 일어난 신용매수
                  규모&quot;</strong>이지, &quot;지금 그 지수대에 남아 있는 잔고&quot;가 아니다.
                  이미 청산된 물량도 그 지수대의 막대에는 그대로 남아 있다.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="3">
              <AccordionTrigger>3. 중복 계상 보정(churn)</AccordionTrigger>
              <AccordionContent>
                <p>
                  문제: 같은 돈을 빌렸다 갚았다 다시 빌리면, 2번의 방식은 그 돈을 여러 번
                  센다(중복 계상). 살펴보는 기간이 길수록 이 중복이 커진다.
                </p>
                <p>
                  해결: 지수대별 <strong>분포 모양</strong>은 그대로 두고, 전체 합계만 실제
                  순증가분(신용융자 최고점 − 시작 시점 잔고)에 맞도록 모든 구간에 같은 비율을
                  곱해 줄인다. 예를 들어 쌓은 합계가 39.16조원인데 실제 순증가가 22.82조원이면,
                  모든 구간에 약 0.58을 곱한다.
                </p>
                <p>이 페이지의 막대그래프는 이렇게 보정된 값을 보여준다.</p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="4">
              <AccordionTrigger>4. 끝난 사이클로 검증</AccordionTrigger>
              <AccordionContent>
                <p>
                  2020-2021년 사이클은 청산까지 이미 끝나서, 이 모델이 맞는지 실제 결과와 비교해
                  볼 수 있는 유일한 사례다.
                </p>
                <p>
                  보정된 모델은 반대매매 대상 규모를 <strong>8.85조원</strong>으로 추정했고, 그
                  기간 실제 신용융자 잔고는 <strong>9.84조원</strong> 줄었다. 오차는
                  1.00조원(실측의 약 10%)이다.
                </p>
                <p>
                  이 정도면 모델이 실제 청산 규모의 대부분을 설명한다고 볼 수 있지만, 표본이
                  이 사이클 하나뿐이라는 한계는 남는다(6번 항목 참고).
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="5">
              <AccordionTrigger>5. 원 자료 재현</AccordionTrigger>
              <AccordionContent>
                <p>
                  비교 대상인 삼성자산운용 리포트의 코스피 구간별 신용매수 막대 11개를, 공개
                  자료만으로 이 페이지와 같은 방식으로 다시 계산해 얼마나 맞아떨어지는지
                  검증했다.
                </p>
                {snap ? (
                  <>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th className="py-1.5 pr-4 font-medium">코스피 구간</th>
                            <th className="py-1.5 pr-4 font-medium">원 자료</th>
                            <th className="py-1.5 pr-4 font-medium">재현</th>
                            <th className="py-1.5 font-medium">차이</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snap.repro.map(r => (
                            <tr key={`${r.low}-${r.high}`} className="border-t">
                              <td className="py-1.5 pr-4 tabular-nums">
                                {formatIdx(r.low)}-{formatIdx(r.high)}
                              </td>
                              <td className="py-1.5 pr-4 tabular-nums">{formatJo(r.pdf)}</td>
                              <td className="py-1.5 pr-4 tabular-nums">{formatJo(r.mine)}</td>
                              <td className="py-1.5 tabular-nums">
                                {r.diff >= 0 ? '+' : ''}
                                {formatJo(r.diff)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2">
                      11개 구간 평균 절대오차는 <strong>{formatJo(snap.reproMAE)}</strong>다. 남은
                      차이는 원 리포트의 차트 판독 정밀도와 데이터 확정 시점 차이로 보인다.
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    데이터가 아직 연결되지 않아 재현 표를 표시할 수 없습니다. 데이터가 준비되면
                    이 자리에 자동으로 채워집니다.
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="6">
              <AccordionTrigger>6. 한계</AccordionTrigger>
              <AccordionContent>
                <p>이 계산에는 다음과 같은 한계가 있다.</p>
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>모델을 실측과 비교해 본 사례가 2020-2021년 사이클 하나뿐이다.</li>
                  <li>
                    담보유지비율은 증권사·계좌·종목마다 130~170%로 다른데, 이 페이지는 140%를
                    기준으로 계산했다. 아래 표는 비율이 다를 때 반대매매 대상 규모가 어떻게
                    달라지는지 보여준다.
                  </li>
                  <li>
                    신용융자는 결제일 기준으로 잡혀서, 급락 당일의 청산이 잔고에 바로 반영되지
                    않는다.
                  </li>
                  <li>
                    신용융자 반대매매 금액 자체는 공표되지 않는다. 이 페이지의 추정치와 실제
                    청산 규모를 직접 대조할 공식 통계가 없다는 뜻이다.
                  </li>
                  <li>
                    이런 한계 때문에 이 페이지의 숫자만으로 투자 판단을 내리기에는 근거가
                    부족하다. 규모의 자릿수를 가늠하는 참고 자료로만 활용해야 한다.
                  </li>
                </ul>
                {current ? (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-foreground">
                      담보유지비율별 반대매매 대상 규모 (현재 사이클 · 전체)
                    </p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th className="py-1.5 pr-4 font-medium">담보유지비율</th>
                            <th className="py-1.5 font-medium">반대매매 대상 규모</th>
                          </tr>
                        </thead>
                        <tbody>
                          {current.sensitivity.map(s => (
                            <tr key={s.maintenance} className="border-t">
                              <td className="py-1.5 pr-4 tabular-nums">
                                {formatPct(s.maintenance * 100)}
                              </td>
                              <td className="py-1.5 tabular-nums">{formatJo(s.exposureJo)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    데이터가 아직 연결되지 않아 담보유지비율별 민감도 표를 표시할 수 없습니다.
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="7">
              <AccordionTrigger>7. 유가증권/코스닥은 왜 갱신 빈도가 다른가</AccordionTrigger>
              <AccordionContent>
                <p>
                  &quot;전체&quot; 신용융자·거래대금은 금융투자협회가 제공하는 API로 매일 자동
                  수집된다.
                </p>
                <p>
                  하지만 유가증권/코스닥으로 나눈 자료는 이 API로는 받을 수 없다. 그래서
                  운영자가 통계 화면에서 파일을 직접 내려받아 가끔 수동으로 반영한다. 이 때문에
                  분리 자료는 전체 자료보다 갱신이 늦거나 뜸할 수 있다.
                </p>
                <p>
                  분리 자료가 아직 한 번도 반영되지 않았다면, 해당 탭에는 데이터를 기다리는
                  중이라는 안내 문구만 표시된다.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="8">
              <AccordionTrigger>8. 자료 출처</AccordionTrigger>
              <AccordionContent>
                <p>
                  이 페이지의 모든 숫자는 금융투자협회(금투협) FREESIS 일별 통계에서 가져온다.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-4 font-medium">코드</th>
                        <th className="py-1.5 font-medium">지표</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['OS0001', 'KOSPI 지수'],
                        ['OS0026', '신용융자 잔고'],
                        ['OS0025', '반대매매금액(위탁매매 미수금 기준)'],
                        ['OS0024', '위탁매매 미수금'],
                        ['OS0021', '투자자 예탁금'],
                        ['OS0027', '예탁증권담보융자'],
                        ['OS0011 / OS0012', '코스피 / 코스닥 거래대금'],
                      ].map(([code, name]) => (
                        <tr key={code} className="border-t">
                          <td className="py-1.5 pr-4 tabular-nums">{code}</td>
                          <td className="py-1.5">{name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="9">
              <AccordionTrigger>9. 대차잔고(공매도 프록시)와 숏커버링</AccordionTrigger>
              <AccordionContent>
                <p>
                  한국은 공매도가 거의 전량 &apos;차입 후 매도&apos; 구조라(무차입 공매도는
                  원칙적으로 금지), 공매도 잔고와 대차잔고(주식 대차거래 잔고)는 사실상 같은
                  풀을 가리킨다. 그런데 거래소는 종목별 순보유잔고(대량보유자 신고 의무 기준,
                  지분 0.5% 이상만 공표)만 공표하고, 시장 전체 합계 공매도 잔고는 공표하지
                  않는다. 그래서 대차잔고를 표준 프록시로 쓴다.
                </p>
                <p>
                  날짜별로 지수 등락률과 대차잔고 등락률을 계산해 네 조합으로 나눈다.
                </p>
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>지수↑ 잔고↓ — 숏커버형: 숏이 밀리며 사서 갚는 압력이 지수를 밀었을 수 있다</li>
                  <li>지수↓ 잔고↓ — 동반 청산: 신용융자처럼 위험자산 전반이 축소되는 국면</li>
                  <li>지수↓ 잔고↑ — 신규 숏 추정: 하락에 베팅하는 물량이 늘고 있다</li>
                  <li>지수↑ 잔고↑ — 리스크온: 대차잔고 증가가 반드시 약세 베팅은 아니다(차익거래 등)</li>
                </ul>
                <p>
                  숏커버링 후보일은 &apos;지수↑ 잔고↓&apos; 날짜 중 두 등락폭의 곱으로 순위를
                  매겨 상위 8개를 뽑는다. 판정 구간은 신용융자 분석과 같은 사이클 창을 쓰되,
                  잔고 자체의 지역 고점부터 시작한다 — 잔고가 실제로 꺾이기 시작한 지점이라야
                  &apos;거기서부터 풀렸다&apos;는 서술이 맞는다.
                </p>
                <p className="font-medium text-foreground">한계</p>
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>
                    대차잔고는 공매도 전용이 아니다. 대차거래는 공매도 외에 ETF 설정/환매,
                    차익거래, 배당락 대비, 의결권 확보 목적으로도 일어난다. 잔고 변화 전부를
                    숏 포지션 변화로 읽으면 과대해석이다.
                  </li>
                  <li>
                    &apos;전체&apos; 신용융자와 달리 대차잔고는 API로 자동 수집이 안 되어
                    사람이 통계 화면에서 직접 내려받아야 한다. 그래서 유가증권/코스닥 분리
                    자료와 같은 사정으로, 대차잔고는 매일이 아니라 가끔 수동으로 반영된다.
                    반영 전까지는 이 카드 자체가 대시보드에 나타나지 않는다.
                  </li>
                  <li>
                    대차잔고와 신용융자는 서로 다른 시장 참여자(기관/외국인 vs 개인 신용거래)가
                    주로 쓰는 통로라, 두 지표의 디레버리징 속도 차이를 곧바로 &apos;누가 더
                    급했는가&apos;로 해석하기는 이르다.
                  </li>
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  )
}
