/* 대화형 차트 런타임. build.mjs 가 이 파일을 통째로 <script> 안에 넣는다.
 *
 * 설계 원칙 두 가지.
 *   1) 점진적 개선. 서버가 그린 <svg> 가 이미 자리에 있고, JS 가 있을 때만 그걸 교체한다.
 *      스크립트가 막힌 환경·인쇄·메일에서는 지금까지와 똑같이 정적 SVG 가 보인다.
 *   2) 외부 패키지 0. 이 프로젝트의 원칙이라 차트 라이브러리를 쓰지 않는다.
 *
 * 차트는 두 종류다.
 *   1) 시계열(draw) — window.__CHARTS__[id] = {unit, dg, zeroBase, dates[], series[{name,color,vals[],axis2?}]}
 *      날짜를 한 번만 저장하고 값 배열을 나란히 두는 형태다 — 날짜 문자열이 계열마다
 *      반복되면 파일이 그만큼 커진다.
 *   2) 범주형(drawBars) — {kind:'cat', categories[], bars:[{name,color,vals[]}], line?, net?, divergeStack?}
 *      지수대·월·국가처럼 날짜가 아닌 축이다. 구간 선택 바(ic-bar)의 영향을 받지 않는다.
 */
(function () {
  'use strict';
  var DATA = window.__CHARTS__ || {};
  var state = { from: null, to: null };          // 전역 구간. null 이면 전체. 시계열에만 적용된다.
  var hidden = {};                               // { chartId: { seriesIdx: true } } — 계열 토글.

  var fmt = function (v, d) {
    if (v == null || !isFinite(v)) return '-';
    // 0 에 아주 가까운 음수는 '-0' 으로 찍힌다. 눈금에 마이너스 0 은 없다.
    return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })
      .replace(/^-(0(?:[.,]0+)?)$/, '$1');
  };
  var dLabel = function (s) { return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8); };
  var dShort = function (s) { return s.slice(2, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8); };
  var el = function (tag, attrs, kids) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  };

  // 눈금은 사람이 읽는 수라야 한다 — 1/2/2.5/5 × 10^n 만 쓴다.
  function ticks(min, max, count) {
    var step0 = (max - min) / (count || 4);
    if (!(step0 > 0)) return [min];
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
      .filter(function (s) { return s >= step0; })[0] || mag * 10;
    var out = [];
    for (var t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(t);
    return out;
  }

  // 눈금 자리수 — 눈금끼리 구분되는 최소 소수점만 쓴다. dg 를 그대로 쓰면
  // 5,632.398 처럼 안 읽히는 수가 축에 박힌다(build.mjs 의 tickFmt 와 같은 규칙).
  function tickDigits(tv, dg) {
    var td = 0;
    for (; td < (dg || 0); td++) {
      var seen = {}, dup = false;
      for (var ti = 0; ti < tv.length; ti++) {
        var key = tv[ti].toFixed(td);
        if (seen[key]) { dup = true; break; }
        seen[key] = 1;
      }
      if (!dup) break;
    }
    return td;
  }

  // lib/labels.mjs 의 빌드타임 추정과 같은 공식(글자당 상수) — getBBox 가 못 잴 때만 쓴다.
  function estWidth(s, px) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += (s.charCodeAt(i) < 128 ? px * 0.52 : px);
    return w;
  }

  /**
   * 값 라벨을 실제 DOM 에 넣고 getBBox 로 재서 겹치면 밀어낸다. 빌드타임 추정
   * (lib/labels.mjs) 과 같은 문제를 풀지만, 브라우저에서는 실제 텍스트 폭을 잴 수 있어
   * 더 정확하다 — 단, **숨은 탭(display:none) 안에서는 getBBox 가 0을 준다**(실측 확인).
   * 처음엔 기본 탭이 아닌 파트가 전부 숨겨진 채로 그려지므로, 0 이 나오면 같은 글자당
   * 상수 추정으로 떨어진다 — 안 그러면 라벨이 전부 같은 자리에 찍혀 겹친다(실측 버그).
   *
   * 밀어내는 방향은 위(고점 라벨의 기본 방향)로 고정하지 않는다 — 여러 계열이 같은 날
   * 같이 고점을 찍으면(흔하다) 첫 라벨이 이미 차트 맨 위 여백을 다 써버려, 위로만 밀면
   * 더 밀 자리가 없어 겹친 채로 멈춘다(실측 버그: 두 '고' 라벨이 정확히 같은 줄에 찍혔다).
   * 위가 막히면 아래로, 아래도 막히면 다시 위로 — 막힌 쪽은 건너뛰고 열린 쪽으로 민다.
   */
  function placeMarks(svg, marks, W, minY, maxY) {
    var placed = [];
    marks.forEach(function (m) {
      if (m.dotColor != null) {
        svg.appendChild(el('circle', {
          cx: m.cx.toFixed(1), cy: m.dotY.toFixed(1), r: 2.8, class: 'mk-dot',
          fill: 'none', stroke: m.dotColor, 'stroke-width': 1.6,
        }));
      }
      var t = el('text', { class: 'ax sm mk-lab', x: m.cx.toFixed(1), y: m.cy.toFixed(1), 'text-anchor': 'middle' });
      t.textContent = m.text;
      svg.appendChild(t);
      var w = 0;
      try { w = t.getBBox().width; } catch (e) { /* 실패 — 아래에서 추정으로 대체 */ }
      if (!w) w = estWidth(m.text, 8.5);
      var x = Math.min(Math.max(m.cx, w / 2 + 2), W - w / 2 - 2);
      var y = m.cy;
      // 세로 간격 13 은 눈대중이 아니다 — lib/labels.mjs 가 이미 실측해 둔 값이다: 이
      // 라벨과 같은 9px 한글 텍스트의 실제 상자 높이가 12.27 이다. 11 로 뒀다가(이번에
      // 새로 만들면서 반복한 실수) 0.7~1px 씩 겹친 채로 "충돌 아님" 판정이 났었다.
      var LH = 13;
      var hits = function (p) { return Math.abs(p.x - x) < (p.w + w) / 2 + 3 && Math.abs(p.y - y) < LH; };
      var dir = -LH, guard = 0;
      while (placed.some(hits) && guard++ < 24) {
        var ny = y + dir;
        if (ny < minY || ny > maxY) { dir = -dir; ny = y + dir; if (ny < minY || ny > maxY) break; }
        y = ny;
      }
      t.setAttribute('x', x.toFixed(1));
      t.setAttribute('y', y.toFixed(1));
      placed.push({ x: x, y: y, w: w });
      // 라벨 뒤에 배경판을 깐다. 다른 라벨과는 안 겹치게 밀어냈지만, 데이터가 조밀한
      // 구간(여러 계열이 같은 날 같이 바닥을 찍는 등)에서는 선 자체와 여전히 겹친다 —
      // 위/아래로 아무리 밀어도 그 옆 계열도 같은 자리에서 바닥을 찍으면 못 피한다.
      // 그래서 선을 피해 다니는 대신, 배경색 판을 깔아 무엇이 뒤에 있어도 글자가 읽히게
      // 한다 — 차트 라이브러리들이 흔히 쓰는 방법이다. text 보다 먼저 그려야 뒤에 깔린다.
      var h = 10.5;
      var bg = el('rect', {
        x: (x - w / 2 - 2).toFixed(1), y: (y - h / 2 - 1).toFixed(1),
        width: (w + 4).toFixed(1), height: (h + 2).toFixed(1),
        class: 'mk-bg', rx: 2,
      });
      svg.insertBefore(bg, t);
    });
  }

  /** null 을 건너뛰고 계열 하나의 최댓값·최솟값 인덱스를 찾는다. */
  function seriesExtent(vals) {
    var hi = null, hiI = -1, lo = null, loI = -1;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v == null || !isFinite(v)) continue;
      if (hi == null || v > hi) { hi = v; hiI = i; }
      if (lo == null || v < lo) { lo = v; loI = i; }
    }
    return hi == null ? null : { hi: hi, hiI: hiI, lo: lo, loI: loI };
  }

  /* ============================== 시계열 ============================== */

  function sliceByRange(spec) {
    var from = state.from, to = state.to;
    if (!from && !to) return { dates: spec.dates, series: spec.series };
    var idx = [];
    spec.dates.forEach(function (d, i) {
      if ((!from || d >= from) && (!to || d <= to)) idx.push(i);
    });
    if (idx.length < 2) return null;                 // 구간에 점이 2개 미만이면 그릴 수 없다
    return {
      dates: idx.map(function (i) { return spec.dates[i]; }),
      series: spec.series.map(function (s) {
        // line·opacity 를 안 옮기면 구간을 좁히는 순간 stack 차트의 합계선이 면적으로
        // 바뀌고 면적 투명도도 기본값으로 돌아간다 — 필드를 통째로 승계한다.
        return { name: s.name, color: s.color, axis2: s.axis2, line: s.line, opacity: s.opacity,
          vals: idx.map(function (i) { return s.vals[i]; }) };
      }),
    };
  }

  function draw(box, spec, id) {
    var cut = sliceByRange(spec);
    box.innerHTML = '';
    if (!cut) {
      var warn = document.createElement('div');
      warn.className = 'ic-empty';
      warn.textContent = '이 구간에는 데이터가 없다.';
      box.appendChild(warn);
      return;
    }
    // 계열 토글로 꺼진 것은 그리기 전에 걷어낸다 — 그러면 아래 눈금 범위 계산·선 그리기·
    // 툴팁·구간요약·고점저점이 전부 자연히 켜진 계열만으로 동작한다(따로 손댈 곳이 없다).
    if (id && hidden[id]) {
      cut = {
        dates: cut.dates,
        series: cut.series.filter(function (_, i) { return !hidden[id][i]; }),
      };
    }
    var hasAxis2 = cut.series.some(function (s) { return s.axis2; });
    // 사이클 대(帶) 라벨은 x축 날짜 라벨(y=ih+15) 아래 한 줄 더(y=ih+32) 그린다 —
    // 아래 여백이 30px 뿐이면 그 라벨이 뷰박스 밖으로 잘린다.
    var W = 660, H = spec.h || 230;
    var M = { t: 22, r: hasAxis2 ? 42 : 14, b: (spec.bands && spec.bands.length) ? 46 : 30, l: 56 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;
    var vals = [], vals2 = [];
    cut.series.forEach(function (s) {
      var bucket = s.axis2 ? vals2 : vals;
      s.vals.forEach(function (v) { if (v != null && isFinite(v)) bucket.push(v); });
    });
    // 쌓아 그리면 눈에 보이는 최댓값은 계열 합이다 — 그걸 안 세면 그래프가 위로 잘린다.
    var stackSums = null;
    if (spec.stack) {
      stackSums = [];
      for (var si = 0; si < cut.dates.length; si++) {
        var sum = 0, any = false;
        cut.series.forEach(function (s) {
          if (s.line) return;
          var v = s.vals[si];
          if (v != null && isFinite(v)) { sum += v; any = true; }
        });
        stackSums.push(any ? sum : null);
        if (any) vals.push(sum);
      }
    }
    if (!vals.length && !vals2.length) return;

    function domainOf(list) {
      if (!list.length) return null;
      var hi = Math.max.apply(null, list), lo = Math.min.apply(null, list);
      var pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
      var vMin = spec.zeroBase ? Math.min(0, lo) : lo - pad;
      var vMax = spec.zeroBase ? hi * 1.08 : hi + pad;
      if (vMax === vMin) vMax = vMin + 1;
      return [vMin, vMax];
    }
    var dom = domainOf(vals) || domainOf(vals2);
    var dom2 = hasAxis2 ? (domainOf(vals2) || dom) : null;

    var n = cut.dates.length;
    var xAt = function (i) { return M.l + (n < 2 ? iw / 2 : (i / (n - 1)) * iw); };
    var yAt = function (v) { return M.t + ih - ((v - dom[0]) / (dom[1] - dom[0])) * ih; };
    var yAt2 = dom2 ? function (v) { return M.t + ih - ((v - dom2[0]) / (dom2[1] - dom2[0])) * ih; } : yAt;
    var yFor = function (s) { return s.axis2 ? yAt2 : yAt; };

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'ic-svg', role: 'img' });

    // 사이클 적립 구간 음영(정적 SVG 가 늘 그리던 것) — 그리드·선보다 먼저 그려서 뒤에 깔린다.
    // 구간 선택으로 좁혀 보면 대(帶)가 화면 밖으로 나갈 수도 있는데, 인덱스를 0..n-1 로
    // 자동 clamp 하는 idxOfDate 특성상 자연히 가장자리에 얇게 남거나 사라진다 — 문제없다.
    if (spec.bands && spec.bands.length) {
      var idxOfDate = function (d) {
        for (var bi = 0; bi < cut.dates.length; bi++) if (cut.dates[bi] >= d) return bi;
        return cut.dates.length - 1;
      };
      spec.bands.forEach(function (bd) {
        var x0 = xAt(idxOfDate(bd.from)), x1 = xAt(idxOfDate(bd.to));
        svg.appendChild(el('rect', {
          class: 'cyc ' + (bd.cls || ''), x: x0.toFixed(1), y: M.t,
          width: Math.max(1, x1 - x0).toFixed(1), height: ih,
        }));
        var lab = el('text', { class: 'cyclab', x: ((x0 + x1) / 2).toFixed(1), y: M.t + ih + 32, 'text-anchor': 'middle' });
        lab.textContent = bd.label || '';
        svg.appendChild(lab);
      });
    }

    var tv = ticks(dom[0], dom[1], 4);
    var td = tickDigits(tv, spec.dg);
    tv.forEach(function (v) {
      svg.appendChild(el('line', { class: 'grid', x1: M.l, y1: yAt(v).toFixed(1), x2: M.l + iw, y2: yAt(v).toFixed(1) }));
      var t = el('text', { class: 'ax', x: M.l - 8, y: (yAt(v) + 3.5).toFixed(1), 'text-anchor': 'end' });
      t.textContent = fmt(v, td);
      svg.appendChild(t);
    });
    if (dom2) {
      var tv2 = ticks(dom2[0], dom2[1], 4), td2 = tickDigits(tv2, spec.dg2 == null ? 0 : spec.dg2);
      tv2.forEach(function (v) {
        var t = el('text', { class: 'ax', x: M.l + iw + 8, y: (yAt2(v) + 3.5).toFixed(1) });
        t.textContent = fmt(v, td2);
        svg.appendChild(t);
      });
    }

    // 축 단위. 정적 SVG 를 걷어내고 다시 그리기 때문에, 여기서 안 찍으면 대화형 차트에는
    // 단위가 아예 없다 — 눈금 숫자만 남아 무엇을 재는 그림인지 알 수 없게 된다.
    //
    // 눈금 열에 우측 정렬하면 '% / 조원' 처럼 긴 단위가 뷰박스 왼쪽으로 잘린다. 그래서
    // 왼쪽 끝에 붙인다. 제목은 안 찍는다 — 차트마다 바깥 HTML(h4·범례·설명)이 이미 이름을
    // 달고 있고, 기간과 점 개수는 아래 구간 요약(ic-sum)이 보여준다.
    if (spec.axis) {
      var au = el('text', { class: 'axu', x: 2, y: M.t - 6 });
      au.textContent = spec.axis;
      svg.appendChild(au);
    }
    if (spec.axis2Unit && dom2) {
      var au2 = el('text', { class: 'axu', x: M.l + iw + 8, y: M.t - 6 });
      au2.textContent = spec.axis2Unit;
      svg.appendChild(au2);
    }

    // x 눈금: 분기 시작. 라벨 폭보다 좁으면 건너뛴다(연말·연초가 붙는 경우).
    var lastQ = null, lastX = -99;
    cut.dates.forEach(function (d, i) {
      var q = d.slice(0, 4) + 'Q' + Math.floor((+d.slice(4, 6) - 1) / 3);
      if (q === lastQ) return;
      lastQ = q;
      if (xAt(i) - lastX < 40) return;
      lastX = xAt(i);
      var t = el('text', { class: 'ax', x: xAt(i).toFixed(1), y: M.t + ih + 15, 'text-anchor': 'middle' });
      t.textContent = d.slice(2, 4) + '.' + d.slice(4, 6);
      svg.appendChild(t);
    });

    // stack 모드: line:true 가 아닌 계열을 아래에서부터 쌓아 면적으로 그린다.
    // 구성비(무엇이 얼마를 차지하나)는 선 여러 개보다 쌓은 면적이 한눈에 들어온다.
    if (spec.stack) {
      var base = new Array(n).fill(0);
      cut.series.forEach(function (s) {
        if (s.line) return;
        var top = [], bot = [];
        for (var i = 0; i < n; i++) {
          var v = s.vals[i];
          if (v == null || !isFinite(v)) { top.push(null); bot.push(null); continue; }
          bot.push(base[i]); base[i] += v; top.push(base[i]);
        }
        var dTop = '', dBot = [], pen = false;
        for (var j = 0; j < n; j++) {
          if (top[j] == null) { pen = false; continue; }
          dTop += (pen ? 'L' : 'M') + xAt(j).toFixed(1) + ',' + yAt(top[j]).toFixed(1);
          dBot.push(xAt(j).toFixed(1) + ',' + yAt(bot[j]).toFixed(1));
          pen = true;
        }
        if (!dTop) return;
        dBot.reverse();
        svg.appendChild(el('path', {
          d: dTop + 'L' + dBot.join('L') + 'Z',
          fill: s.color, 'fill-opacity': s.opacity == null ? 0.55 : s.opacity, stroke: 'none',
        }));
      });
    }

    cut.series.forEach(function (s) {
      if (spec.stack && !s.line) return;              // 면적으로 이미 그렸다
      var yFn = yFor(s);
      var d = '', pen = false;
      s.vals.forEach(function (v, i) {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yFn(v).toFixed(1);
        pen = true;
      });
      if (d) svg.appendChild(el('path', {
        d: d, fill: 'none', stroke: s.color, 'stroke-width': s.line ? 2 : 1.6,
        'stroke-dasharray': s.axis2 ? '4 3' : null,
      }));
    });

    var guide = el('line', { class: 'ic-guide', x1: 0, y1: M.t, x2: 0, y2: M.t + ih, opacity: 0 });
    svg.appendChild(guide);
    var dots = cut.series.map(function (s) {
      var c = el('circle', { r: 3.2, fill: s.color, opacity: 0 });
      svg.appendChild(c); return c;
    });
    box.appendChild(svg);

    // 고점/저점 + 날짜. 지금 보이는 구간(구간 선택·계열 토글 반영) 기준으로 다시 잰다 —
    // getBBox 로 실측해야 해서 svg 가 DOM 에 붙은 다음에 그린다.
    var marks = [];
    if (spec.stack) {
      var ext = seriesExtent(stackSums);
      if (ext && ext.hiI !== ext.loI) {
        marks.push({ cx: xAt(ext.hiI), cy: yAt(ext.hi) - 11, dotY: yAt(ext.hi), dotColor: 'var(--fg)',
          text: '고 ' + fmt(ext.hi, spec.dg || 0) + (spec.suffix || '') + ' ' + dShort(cut.dates[ext.hiI]) });
        marks.push({ cx: xAt(ext.loI), cy: yAt(ext.lo) + 19, dotY: yAt(ext.lo), dotColor: 'var(--fg)',
          text: '저 ' + fmt(ext.lo, spec.dg || 0) + (spec.suffix || '') + ' ' + dShort(cut.dates[ext.loI]) });
      }
    } else {
      // 계열마다 고점/저점을 다 찍으면 안 겹쳐도 지저분해진다(실측 피드백 — 4~5계열 차트에서
      // 라벨 8~10개). 계열이 셋 이상이면 첫 번째(그 차트의 headline 지표, 보통 '전체'처럼
      // 대표값)만 찍는다. 나머지 계열의 정확한 값은 마우스오버로 언제든 볼 수 있다 — 차트에
      // 늘 박아 둘 필요가 없다. 2계열 이하(단일 지표 + 지수 보조축 등)는 그대로 다 찍는다.
      var toMark = cut.series.length > 2 ? cut.series.slice(0, 1) : cut.series;
      toMark.forEach(function (s) {
        var ext = seriesExtent(s.vals);
        // 평균·±1σ 같은 참조선은 값이 완전히 평평하다(모든 점이 같은 수) — "고점"이
        // 첫 점일 뿐 아무 의미가 없고, 그 자리에 라벨 여러 개가 겹쳐 찍힌다(실측).
        if (!ext || ext.hi === ext.lo) return;
        var yFn = yFor(s);
        // 보조축 계열은 단위가 다르다(예: 조원 축 옆의 코스피 p) — 주축 접미사를
        // 그대로 붙이면 '코스피 9,114조원' 처럼 틀린 라벨이 나온다.
        var dg = s.axis2 ? (spec.dg2 == null ? 0 : spec.dg2) : (spec.dg || 0);
        var sfx = s.axis2 ? '' : (spec.suffix || '');
        marks.push({ cx: xAt(ext.hiI), cy: yFn(ext.hi) - 11, dotY: yFn(ext.hi), dotColor: s.color,
          text: (s.name ? s.name + ' ' : '') + '고 ' + fmt(ext.hi, dg) + sfx + ' ' + dShort(cut.dates[ext.hiI]) });
        if (ext.loI !== ext.hiI) {
          marks.push({ cx: xAt(ext.loI), cy: yFn(ext.lo) + 19, dotY: yFn(ext.lo), dotColor: s.color,
            text: (s.name ? s.name + ' ' : '') + '저 ' + fmt(ext.lo, dg) + sfx + ' ' + dShort(cut.dates[ext.loI]) });
        }
      });
    }
    // maxY 는 플롯 바닥(M.t+ih)보다 조금 더 내려가도 된다 — zeroBase 차트의 '저' 라벨은
    // 원래도 그 점보다 13px 아래(dotY+13)에서 시작해 플롯 경계를 살짝 넘어간다. 여기를
    // 플롯 안쪽으로만 제한했더니(M.t+ih-4) 그 시작점 자체가 이미 상한을 넘어 있어
    // 위로도 아래로도 못 밀고 그 자리에 여러 개가 그대로 겹쳐 쌓였다(실측 버그) — 아래쪽은
    // x축 날짜 라벨(M.t+ih+15) 바로 위까지만 열어 준다.
    placeMarks(svg, marks, W, M.t + 2, M.t + ih + 11);

    var tip = document.createElement('div');
    tip.className = 'ic-tip'; tip.hidden = true;
    box.appendChild(tip);

    function at(i) {
      guide.setAttribute('x1', xAt(i)); guide.setAttribute('x2', xAt(i)); guide.setAttribute('opacity', 1);
      var rows = '<b>' + dLabel(cut.dates[i]) + '</b>';
      cut.series.forEach(function (s, k) {
        var v = s.vals[i];
        if (v == null || !isFinite(v)) { dots[k].setAttribute('opacity', 0); return; }
        var yFn = yFor(s);
        dots[k].setAttribute('cx', xAt(i)); dots[k].setAttribute('cy', yFn(v)); dots[k].setAttribute('opacity', 1);
        var dg = s.axis2 ? (spec.dg2 == null ? 0 : spec.dg2) : (spec.dg || 0);
        rows += '<span><i style="background:' + s.color + '"></i>'
          + (s.name ? s.name + ' ' : '') + '<b>' + fmt(v, dg) + '</b>'
          + (s.axis2 ? '' : (spec.suffix || '')) + '</span>';
      });
      tip.innerHTML = rows;
      tip.hidden = false;
      var rect = box.getBoundingClientRect();
      var px = (xAt(i) / W) * rect.width;
      tip.style.left = Math.min(Math.max(px + 10, 4), Math.max(rect.width - tip.offsetWidth - 4, 4)) + 'px';
    }
    function hide() { guide.setAttribute('opacity', 0); dots.forEach(function (c) { c.setAttribute('opacity', 0); }); tip.hidden = true; }
    function fromEvent(e) {
      var rect = svg.getBoundingClientRect();
      // 숨은 탭 안의 차트는 폭이 0이라 x 가 NaN 이 된다 — 그대로 두면 dates[NaN] 로 터진다.
      if (!rect.width) return;
      var x = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / rect.width * W;
      var i = Math.round(((x - M.l) / iw) * (n - 1));
      if (!isFinite(i)) return;
      i = Math.max(0, Math.min(n - 1, i));
      at(i);
    }
    svg.addEventListener('mousemove', fromEvent);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchmove', function (e) { fromEvent(e); e.preventDefault(); }, { passive: false });

    // 구간 요약 — 시작/끝/변화. "구간별 수치" 가 여기서 나온다.
    var sum = document.createElement('div');
    sum.className = 'ic-sum';
    // stack 차트의 계열별 %는 대부분 "상장 이후 +2138%" 같은 상장 시점 잡음이라(값이 0 근처에서
    // 시작하는 계열이 늘 있다) 오해만 부른다 — 구성 차트의 결론은 합계이므로 합계에만 %를 달고
    // 계열별로는 시작→끝 값만 보여준다. 일반(선) 차트는 기존 그대로 계열별 %를 단다.
    var sumHead = '<span class="ic-range">' + dLabel(cut.dates[0]) + ' ~ ' + dLabel(cut.dates[n - 1])
      + ' · ' + n + '개 점</span>';
    var pct = function (f, l) {
      if (f == null || l == null || f === 0) return '';
      var chg = (l / f - 1) * 100;
      return ' <em class="' + (chg >= 0 ? 'up' : 'dn') + '">'
        + (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%</em>';
    };
    var ends = function (vals) {
      var f = null, l = null;
      for (var i = 0; i < vals.length; i++) if (vals[i] != null && isFinite(vals[i])) { f = vals[i]; break; }
      for (var j = vals.length - 1; j >= 0; j--) if (vals[j] != null && isFinite(vals[j])) { l = vals[j]; break; }
      return [f, l];
    };
    if (spec.stack && stackSums) {
      var te = ends(stackSums);
      if (te[0] != null) {
        sumHead += '<span><i style="background:var(--fg)"></i>합계 ' + fmt(te[0], spec.dg || 0)
          + ' → <b>' + fmt(te[1], spec.dg || 0) + (spec.suffix || '') + '</b>' + pct(te[0], te[1]) + '</span>';
      }
    }
    sum.innerHTML = sumHead
      + cut.series.map(function (s) {
        var e = ends(s.vals);
        if (e[0] == null) return '';
        var dg = s.axis2 ? (spec.dg2 == null ? 0 : spec.dg2) : (spec.dg || 0);
        var sfx = s.axis2 ? '' : (spec.suffix || '');
        return '<span><i style="background:' + s.color + '"></i>' + (s.name ? s.name + ' ' : '')
          + fmt(e[0], dg) + ' → <b>' + fmt(e[1], dg) + sfx + '</b>'
          + (spec.stack ? '' : pct(e[0], e[1])) + '</span>';
      }).join('');
    box.appendChild(sum);
  }

  /* ============================== 범주형(막대) ============================== */

  /**
   * 지수대·월·국가처럼 날짜가 아닌 축. 구간 선택 바(ic-bar)의 영향을 받지 않는다 —
   * 시계열이 아니므로 "1개월 전"이 의미가 없다.
   *
   *   bars: [{name,color,vals[],colors?[]}]  — colors 는 카테고리별 색 override(마진콜 상태 등)
   *   divergeStack: true 면 bars 를 옆으로가 아니라 부호대로 쌓는다(양수 위/음수 아래) — 국가별 포지션.
   *   line: {name,color,vals[],axis2?}       — 막대 위에 겹치는 선(마진콜 레벨 등)
   *   net: {name,color,vals[]}               — 카테고리마다 다이아몬드로 찍는 합계(국가별 Net)
   *   markExtent: false 면 최고/최저 카테고리 표시를 건너뛴다(국가차트처럼 이미 다 라벨돼 있을 때).
   */
  function drawBars(box, spec) {
    box.innerHTML = '';
    var cats = spec.categories || [];
    var n = cats.length;
    if (!n) return;
    var bars = spec.bars || [];
    var hasAxis2 = !!(spec.line && spec.line.axis2);
    var W = spec.w || 660, H = spec.h || 300, M = { t: 26, r: hasAxis2 ? 46 : 16, b: spec.rotate ? 64 : 40, l: 52 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;
    var slot = iw / n;
    var cx = function (i) { return M.l + slot * (i + 0.5); };

    var vals = [], vals2 = [];
    if (spec.divergeStack) {
      for (var i = 0; i < n; i++) {
        var up = 0, dn = 0;
        bars.forEach(function (b) { var v = b.vals[i]; if (v != null && isFinite(v)) { if (v > 0) up += v; else dn += v; } });
        vals.push(up, dn);
      }
    } else {
      bars.forEach(function (b) { b.vals.forEach(function (v) { if (v != null && isFinite(v)) vals.push(v); }); });
    }
    if (spec.net) spec.net.vals.forEach(function (v) { if (v != null && isFinite(v)) vals.push(v); });
    if (spec.line) (spec.line.axis2 ? vals2 : vals).push.apply(spec.line.axis2 ? vals2 : vals,
      spec.line.vals.filter(function (v) { return v != null && isFinite(v); }));
    if (!vals.length && !vals2.length) return;

    var hasNeg = vals.some(function (v) { return v < 0; });
    var hi = vals.length ? Math.max.apply(null, vals.concat(0)) : 1;
    var lo = vals.length ? Math.min.apply(null, vals.concat(hasNeg ? [] : [0])) : 0;
    var pad = (hi - lo) * 0.14 || Math.abs(hi) * 0.08 || 1;
    var vMin = spec.zeroBase === false ? lo - pad : Math.min(0, lo);
    var vMax = hi + pad;
    if (vMax === vMin) vMax = vMin + 1;
    var yAt = function (v) { return M.t + ih - ((v - vMin) / (vMax - vMin)) * ih; };
    var yAt2 = null;
    if (vals2.length) {
      var hi2 = Math.max.apply(null, vals2), lo2 = Math.min.apply(null, vals2.concat(0));
      var pad2 = (hi2 - lo2) * 0.14 || 1;
      var vMin2 = Math.min(0, lo2) - 0, vMax2 = hi2 + pad2;
      yAt2 = function (v) { return M.t + ih - ((v - vMin2) / (vMax2 - vMin2)) * ih; };
    }

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'ic-svg', role: 'img' });
    var tv = ticks(vMin, vMax, 4), td = tickDigits(tv, spec.dg);
    tv.forEach(function (v) {
      svg.appendChild(el('line', { class: 'grid', x1: M.l, y1: yAt(v).toFixed(1), x2: M.l + iw, y2: yAt(v).toFixed(1) }));
      var t = el('text', { class: 'ax', x: M.l - 8, y: (yAt(v) + 3.5).toFixed(1), 'text-anchor': 'end' });
      t.textContent = fmt(v, td);
      svg.appendChild(t);
    });
    if (yAt2) {
      var tv2b = ticks(vMin2, vMax2, 4);
      tv2b.forEach(function (v) {
        var t = el('text', { class: 'ax', x: M.l + iw + 8, y: (yAt2(v) + 3.5).toFixed(1) });
        t.textContent = fmt(v, 0);
        svg.appendChild(t);
      });
    }
    if (spec.axis) {
      var au = el('text', { class: 'axu', x: 2, y: M.t - 6 });
      au.textContent = spec.axis;
      svg.appendChild(au);
    }
    if (vMin < 0) svg.appendChild(el('line', { class: 'zero', x1: M.l, y1: yAt(0).toFixed(1), x2: M.l + iw, y2: yAt(0).toFixed(1) }));

    cats.forEach(function (c, i) {
      var lab = spec.rotate
        ? el('text', { class: 'ax sm', x: cx(i).toFixed(1), y: M.t + ih + 14, 'text-anchor': 'end', transform: 'rotate(-52 ' + cx(i).toFixed(1) + ' ' + (M.t + ih + 14) + ')' })
        : el('text', { class: 'ax sm', x: cx(i).toFixed(1), y: M.t + ih + 16, 'text-anchor': 'middle' });
      lab.textContent = c;
      svg.appendChild(lab);
    });

    // 막대. 옆으로 나란히(그룹) 또는 부호대로 쌓기(divergeStack) 둘 중 하나.
    var barBoxes = [];                       // 히트존 저장 — 마우스오버로 값을 알아야 한다.
    if (spec.divergeStack) {
      for (var i2 = 0; i2 < n; i2++) {
        var upAcc = 0, dnAcc = 0;
        var w = slot * 0.62;
        bars.forEach(function (b) {
          var v = b.vals[i2];
          if (v == null || !isFinite(v) || v === 0) return;
          var y0, y1;
          if (v > 0) { y0 = yAt(upAcc + v); y1 = yAt(upAcc); upAcc += v; }
          else { y0 = yAt(dnAcc); y1 = yAt(dnAcc + v); dnAcc += v; }
          var x = cx(i2) - w / 2;
          svg.appendChild(el('rect', { class: 'catbar', x: x.toFixed(1), y: y0.toFixed(1), width: w.toFixed(1), height: Math.max(0.5, y1 - y0).toFixed(1), fill: b.color, opacity: b.opacity == null ? 0.85 : b.opacity }));
        });
        barBoxes.push({ x0: cx(i2) - slot / 2, x1: cx(i2) + slot / 2 });
      }
      if (spec.net) {
        spec.net.vals.forEach(function (v, i) {
          if (v == null || !isFinite(v)) return;
          var y = yAt(v);
          svg.appendChild(el('path', {
            class: 'catnet',
            d: 'M' + cx(i).toFixed(1) + ',' + (y - 5.5).toFixed(1)
              + ' L' + (cx(i) + 5.5).toFixed(1) + ',' + y.toFixed(1)
              + ' L' + cx(i).toFixed(1) + ',' + (y + 5.5).toFixed(1)
              + ' L' + (cx(i) - 5.5).toFixed(1) + ',' + y.toFixed(1) + 'Z',
            fill: spec.net.color,
          }));
        });
      }
    } else {
      var nb = bars.length || 1;
      var gw = slot * 0.72, bw = gw / nb;
      bars.forEach(function (b, bi) {
        b.vals.forEach(function (v, i) {
          if (v == null || !isFinite(v)) return;
          var x = cx(i) - gw / 2 + bw * bi;
          var y0 = yAt(Math.max(0, v)), y1 = yAt(Math.min(0, v));
          var fill = (b.colors && b.colors[i]) || b.color;
          svg.appendChild(el('rect', { class: 'catbar', x: (x + 1).toFixed(1), y: y0.toFixed(1), width: Math.max(0, bw - 2).toFixed(1), height: Math.max(0.5, y1 - y0).toFixed(1), fill: fill }));
        });
        barBoxes.push(null);
      });
    }
    // 선 오버레이(마진콜 레벨 등).
    if (spec.line) {
      var yFn = spec.line.axis2 && yAt2 ? yAt2 : yAt;
      var d = '', pen = false;
      spec.line.vals.forEach(function (v, i) {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + cx(i).toFixed(1) + ',' + yFn(v).toFixed(1);
        pen = true;
      });
      if (d) svg.appendChild(el('path', { d: d, fill: 'none', stroke: spec.line.color, 'stroke-width': 2 }));
      spec.line.vals.forEach(function (v, i) {
        if (v == null || !isFinite(v)) return;
        svg.appendChild(el('circle', { cx: cx(i).toFixed(1), cy: yFn(v).toFixed(1), r: 2.4, fill: spec.line.color }));
      });
    }

    box.appendChild(svg);

    // 최고/최저 카테고리. divergeStack + net 처럼 이미 막대마다 숫자가 늘 보이는 차트는
    // markExtent:false 로 끄게 해 뒀다 — 안 그러면 라벨이 두 번 겹친다.
    if (spec.markExtent !== false) {
      var totals = cats.map(function (c, i) {
        if (spec.net) return spec.net.vals[i];
        var t = 0, any = false;
        bars.forEach(function (b) { var v = b.vals[i]; if (v != null && isFinite(v)) { t += v; any = true; } });
        return any ? t : null;
      });
      var ext = seriesExtent(totals);
      if (ext && ext.hiI !== ext.loI) {
        placeMarks(svg, [
          { cx: cx(ext.hiI), cy: yAt(ext.hi) - 11, dotY: yAt(ext.hi), dotColor: 'var(--fg)',
            text: '최고 ' + fmt(ext.hi, spec.dg || 0) + (spec.suffix || '') + ' (' + cats[ext.hiI] + ')' },
          { cx: cx(ext.loI), cy: yAt(ext.lo) + 19, dotY: yAt(ext.lo), dotColor: 'var(--fg)',
            text: '최저 ' + fmt(ext.lo, spec.dg || 0) + (spec.suffix || '') + ' (' + cats[ext.loI] + ')' },
        ], W, M.t + 2, M.t + ih + 11);
      }
    }

    var tip = document.createElement('div');
    tip.className = 'ic-tip'; tip.hidden = true;
    box.appendChild(tip);

    function at(i) {
      var sub = spec.subLabels && spec.subLabels[i];
      var rows = '<b>' + cats[i] + (sub ? ' · ' + sub : '') + '</b>';
      if (spec.divergeStack) {
        bars.forEach(function (b) {
          var v = b.vals[i];
          if (v == null || !isFinite(v) || v === 0) return;
          rows += '<span><i style="background:' + b.color + '"></i>' + (b.name || '') + ' <b>' + fmt(v, spec.dg || 0) + '</b>' + (spec.suffix || '') + '</span>';
        });
        if (spec.net) rows += '<span><i style="background:' + spec.net.color + '"></i>Net <b>' + fmt(spec.net.vals[i], spec.dg || 0) + '</b>' + (spec.suffix || '') + '</span>';
      } else {
        bars.forEach(function (b) {
          var v = b.vals[i];
          if (v == null || !isFinite(v)) return;
          rows += '<span><i style="background:' + ((b.colors && b.colors[i]) || b.color) + '"></i>' + (b.name || '') + ' <b>' + fmt(v, spec.dg || 0) + '</b>' + (spec.suffix || '') + '</span>';
        });
      }
      if (spec.line) {
        var v2 = spec.line.vals[i];
        if (v2 != null && isFinite(v2)) rows += '<span><i style="background:' + spec.line.color + '"></i>' + (spec.line.name || '') + ' <b>' + fmt(v2, spec.dg2 == null ? 0 : spec.dg2) + '</b></span>';
      }
      tip.innerHTML = rows;
      tip.hidden = false;
      var rect = box.getBoundingClientRect();
      var px = (cx(i) / W) * rect.width;
      tip.style.left = Math.min(Math.max(px + 10, 4), Math.max(rect.width - tip.offsetWidth - 4, 4)) + 'px';
    }
    function hide() { tip.hidden = true; }
    function fromEvent(e) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      var x = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / rect.width * W;
      var i = Math.max(0, Math.min(n - 1, Math.floor((x - M.l) / slot)));
      at(i);
    }
    svg.addEventListener('mousemove', fromEvent);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', function (e) { fromEvent(e); e.preventDefault(); }, { passive: false });
  }

  /* ============================== 공통 ============================== */

  function drawAny(box, spec, id) {
    if (spec.kind === 'cat') drawBars(box, spec);
    else draw(box, spec, id);
  }

  function renderAll() {
    Object.keys(DATA).forEach(function (id) {
      var box = document.querySelector('[data-chart="' + id + '"]');
      if (box) drawAny(box, DATA[id], id);
    });
  }

  // 체크박스로 계열을 켜고 끈다. 마크업은 build.mjs 의 seriesToggle() 이 만든다 —
  // <div class="ictoggle" data-for="차트id"><input data-idx="N">... 순서다.
  function wireToggles() {
    document.querySelectorAll('.ictoggle[data-for]').forEach(function (box) {
      box.hidden = false;                        // 정적 폴백 전용 hidden — JS 가 돌면 보여준다.
      var id = box.getAttribute('data-for');
      var checks = box.querySelectorAll('input[type=checkbox]');
      checks.forEach(function (cb) {
        cb.addEventListener('change', function () {
          // 마지막 하나까지 끄면 빈 차트가 된다 — 최소 하나는 남긴다.
          var anyChecked = false;
          checks.forEach(function (c) { if (c.checked) anyChecked = true; });
          if (!anyChecked) { cb.checked = true; return; }
          var idx = +cb.getAttribute('data-idx');
          var set = hidden[id] || (hidden[id] = {});
          if (cb.checked) delete set[idx]; else set[idx] = true;
          var target = document.querySelector('[data-chart="' + id + '"]');
          if (target) draw(target, DATA[id], id);
        });
      });
    });
  }

  function boot() {
    if (!Object.keys(DATA).length) return;
    // 정적 SVG 를 감춘다 — JS 가 살아 있을 때만 실행되므로 폴백은 그대로 남는다.
    document.documentElement.classList.add('ic-on');

    // 구간 선택 바는 시계열에만 의미가 있다 — 범주형(kind:'cat') 차트의 날짜 아닌
    // 카테고리를 날짜로 취급해 범위를 잡으면 min/max 가 깨진다.
    var all = [];
    Object.keys(DATA).forEach(function (id) {
      if (DATA[id].kind === 'cat') return;
      all = all.concat(DATA[id].dates);
    });
    all.sort();
    var minD = all[0], maxD = all[all.length - 1];
    var iso = function (s) { return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); };
    var plain = function (s) { return s.replace(/-/g, ''); };

    var bar = document.getElementById('ic-bar');
    if (bar && minD) {
      bar.hidden = false;
      bar.innerHTML = '<label>구간 <input type="date" id="ic-from" min="' + iso(minD) + '" max="' + iso(maxD) + '"></label>'
        + '<label>~ <input type="date" id="ic-to" min="' + iso(minD) + '" max="' + iso(maxD) + '"></label>'
        + '<span class="ic-presets">'
        + [['1M', 30], ['3M', 90], ['6M', 180], ['1Y', 365], ['전체', 0]].map(function (p) {
          return '<button type="button" data-days="' + p[1] + '">' + p[0] + '</button>';
        }).join('') + '</span>';

      var fromEl = bar.querySelector('#ic-from'), toEl = bar.querySelector('#ic-to');
      var apply = function () {
        state.from = fromEl.value ? plain(fromEl.value) : null;
        state.to = toEl.value ? plain(toEl.value) : null;
        renderAll();
      };
      fromEl.addEventListener('change', apply);
      toEl.addEventListener('change', apply);
      bar.querySelectorAll('button[data-days]').forEach(function (b) {
        b.addEventListener('click', function () {
          var days = +b.getAttribute('data-days');
          if (!days) { fromEl.value = ''; toEl.value = ''; }
          else {
            var end = new Date(iso(maxD));
            var start = new Date(end.getTime() - days * 86400000);
            fromEl.value = start.toISOString().slice(0, 10);
            toEl.value = end.toISOString().slice(0, 10);
          }
          apply();
        });
      });
    }
    wireToggles();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
