// 네이버 금융에서 코스피 일별 시세를 받아 data/kospi-daily.json 으로 저장한다.
// KRX 정보데이터시스템(getJsonData.cmd)은 폼 필드가 JS 런타임에 생성되어
// 파라미터를 고정하기 어려웠다. 네이버 siseJson 은 날짜 범위를 그대로 받는다.
import fs from 'node:fs';
import path from 'node:path';

const START = '20200101';
// 기본 종료일은 '오늘'이다. 날짜를 상수로 박아두면 다음에 그냥 돌렸을 때
// 이미 받아둔 최근 며칠이 조용히 사라진다(실제로 한 번 사라졌다).
const today = new Date();
const END = process.argv[2]
  ?? `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const OUT = path.join(import.meta.dirname, '..', 'data', 'kospi-daily.json');

const url = 'https://api.finance.naver.com/siseJson.naver'
  + `?symbol=KOSPI&requestType=1&startTime=${START}&endTime=${END}&timeframe=day`;

const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
});
if (!res.ok) throw new Error(`naver ${res.status}`);

// 응답은 JSON이 아니라 작은따옴표를 쓰는 JS 리터럴이다.
const raw = await res.text();
const rows = JSON.parse(raw.replace(/'/g, '"').trim());

const header = rows[0];
const iDate = header.indexOf('날짜');
const iClose = header.indexOf('종가');
if (iDate < 0 || iClose < 0) throw new Error(`unexpected header: ${header}`);

const series = rows.slice(1)
  .filter(r => Array.isArray(r) && r[iDate])
  .map(r => ({ date: String(r[iDate]), close: Number(r[iClose]) }))
  .filter(r => Number.isFinite(r.close) && r.close > 0)
  .sort((a, b) => a.date.localeCompare(b.date));

fs.writeFileSync(OUT, JSON.stringify(series, null, 0));

const lo = series.reduce((m, r) => (r.close < m.close ? r : m));
const hi = series.reduce((m, r) => (r.close > m.close ? r : m));
console.log(`rows=${series.length}  ${series[0].date}..${series.at(-1).date}`);
console.log(`min ${lo.close} (${lo.date})   max ${hi.close} (${hi.date})`);
console.log('last 5:', series.slice(-5).map(r => `${r.date}=${r.close}`).join('  '));
