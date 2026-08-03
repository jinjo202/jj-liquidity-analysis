// SVG 점 라벨 배치. 두 가지가 실제로 깨져서 만들었다(예탁금 커버리지 차트).
//   1) 시간상 붙어 있는 점들('26 고점'과 '현재'는 한 달 차이)의 라벨이 같은 자리에 겹쳐 찍혔다.
//   2) 맨 오른쪽 점은 text-anchor=middle 이라 라벨 절반이 뷰박스 밖으로 잘렸다.
// 폭을 추정해 가로로 안쪽에 밀어 넣고, 이미 놓인 라벨과 겹치면 위로 한 줄씩 띄운다.
//
// ponytail: 브라우저 밖이라 실제 텍스트 폭을 잴 수 없다 — 글자당 상수로 추정한다.
// 한글·CJK 는 폰트 크기와 거의 같은 폭, ASCII 는 그 절반쯤. 라벨이 짧아 이 정도면 충분하고,
// 빗나가도 방향은 안전한 쪽(넉넉히 잡아 덜 겹침)이다. 정확히 재야 하면 렌더 후 getBBox 로 가야 한다.
export const labelWidth = (s, px = 9) =>
  [...s].reduce((a, c) => a + (c.charCodeAt(0) < 128 ? px * 0.52 : px), 0);

/**
 * @param items [{cx, cy, text}] — 점 좌표와 라벨. 배열 순서대로 자리를 잡는다(앞선 것이 우선).
 * @param W     뷰박스 폭
 * @param minY  이 위로는 올리지 않는다(보통 차트 상단 여백)
 * @returns items 에 {x, y, w} 를 더한 배열
 */
export function placeLabels(items, { W, minY, lh = 10, pad = 2 }) {
  const out = [];
  for (const it of items) {
    const w = labelWidth(it.text);
    const x = Math.min(Math.max(it.cx, w / 2 + pad), W - w / 2 - pad);
    let y = it.cy;
    const hits = p => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < lh;
    while (out.some(hits) && y - lh > minY) y -= lh;
    out.push({ ...it, x, y, w });
  }
  return out;
}
