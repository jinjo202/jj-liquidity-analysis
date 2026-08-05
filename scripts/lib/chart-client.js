/* 대화형 차트 런타임. build.mjs 가 이 파일을 통째로 <script> 안에 넣는다.
 *
 * 설계 원칙 두 가지.
 *   1) 점진적 개선. 서버가 그린 <svg> 가 이미 자리에 있고, JS 가 있을 때만 그걸 교체한다.
 *      스크립트가 막힌 환경·인쇄·메일에서는 지금까지와 똑같이 정적 SVG 가 보인다.
 *   2) 외부 패키지 0. 이 프로젝트의 원칙이라 차트 라이브러리를 쓰지 않는다.
 *
 * 데이터는 window.__CHARTS__ 에 { id: {unit, dg, zeroBase, dates[], series[{name,color,vals[]}]} }
 * 로 들어온다. 날짜를 한 번만 저장하고 값 배열을 나란히 두는 형태다 — 날짜 문자열이
 * 계열마다 반복되면 파일이 그만큼 커진다.
 */
(function () {
  'use strict';
  var DATA = window.__CHARTS__ || {};
  var state = { from: null, to: null };          // 전역 구간. null 이면 전체.

  var fmt = function (v, d) {
    if (v == null || !isFinite(v)) return '-';
    return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  var dLabel = function (s) { return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8); };
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
        return { name: s.name, color: s.color, vals: idx.map(function (i) { return s.vals[i]; }) };
      }),
    };
  }

  function draw(box, spec) {
    var cut = sliceByRange(spec);
    box.innerHTML = '';
    if (!cut) {
      var warn = document.createElement('div');
      warn.className = 'ic-empty';
      warn.textContent = '이 구간에는 데이터가 없다.';
      box.appendChild(warn);
      return;
    }
    var W = 660, H = spec.h || 230, M = { t: 22, r: 14, b: 30, l: 56 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;
    var vals = [];
    cut.series.forEach(function (s) {
      s.vals.forEach(function (v) { if (v != null && isFinite(v)) vals.push(v); });
    });
    if (!vals.length) return;
    var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
    var pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
    var vMin = spec.zeroBase ? Math.min(0, lo) : lo - pad;
    var vMax = spec.zeroBase ? hi * 1.08 : hi + pad;
    if (vMax === vMin) { vMax = vMin + 1; }
    var n = cut.dates.length;
    var xAt = function (i) { return M.l + (n < 2 ? iw / 2 : (i / (n - 1)) * iw); };
    var yAt = function (v) { return M.t + ih - ((v - vMin) / (vMax - vMin)) * ih; };

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'ic-svg', role: 'img' });

    ticks(vMin, vMax, 4).forEach(function (v) {
      svg.appendChild(el('line', { class: 'grid', x1: M.l, y1: yAt(v).toFixed(1), x2: M.l + iw, y2: yAt(v).toFixed(1) }));
      var t = el('text', { class: 'ax', x: M.l - 8, y: (yAt(v) + 3.5).toFixed(1), 'text-anchor': 'end' });
      t.textContent = fmt(v, spec.dg || 0);
      svg.appendChild(t);
    });

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

    cut.series.forEach(function (s) {
      var d = '', pen = false;
      s.vals.forEach(function (v, i) {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1);
        pen = true;
      });
      if (d) svg.appendChild(el('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 1.6 }));
    });

    var guide = el('line', { class: 'ic-guide', x1: 0, y1: M.t, x2: 0, y2: M.t + ih, opacity: 0 });
    svg.appendChild(guide);
    var dots = cut.series.map(function (s) {
      var c = el('circle', { r: 3.2, fill: s.color, opacity: 0 });
      svg.appendChild(c); return c;
    });
    box.appendChild(svg);

    var tip = document.createElement('div');
    tip.className = 'ic-tip'; tip.hidden = true;
    box.appendChild(tip);

    function at(i) {
      guide.setAttribute('x1', xAt(i)); guide.setAttribute('x2', xAt(i)); guide.setAttribute('opacity', 1);
      var rows = '<b>' + dLabel(cut.dates[i]) + '</b>';
      cut.series.forEach(function (s, k) {
        var v = s.vals[i];
        if (v == null || !isFinite(v)) { dots[k].setAttribute('opacity', 0); return; }
        dots[k].setAttribute('cx', xAt(i)); dots[k].setAttribute('cy', yAt(v)); dots[k].setAttribute('opacity', 1);
        rows += '<span><i style="background:' + s.color + '"></i>'
          + (s.name ? s.name + ' ' : '') + '<b>' + fmt(v, spec.dg || 0) + '</b>'
          + (spec.suffix || '') + '</span>';
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
    sum.innerHTML = '<span class="ic-range">' + dLabel(cut.dates[0]) + ' ~ ' + dLabel(cut.dates[n - 1])
      + ' · ' + n + '개 점</span>'
      + cut.series.map(function (s) {
        var f = null, l = null;
        for (var i = 0; i < s.vals.length; i++) if (s.vals[i] != null && isFinite(s.vals[i])) { f = s.vals[i]; break; }
        for (var j = s.vals.length - 1; j >= 0; j--) if (s.vals[j] != null && isFinite(s.vals[j])) { l = s.vals[j]; break; }
        if (f == null || l == null) return '';
        var chg = f !== 0 ? ((l / f - 1) * 100) : null;
        return '<span><i style="background:' + s.color + '"></i>' + (s.name ? s.name + ' ' : '')
          + fmt(f, spec.dg || 0) + ' → <b>' + fmt(l, spec.dg || 0) + '</b>'
          + (chg == null ? '' : ' <em class="' + (chg >= 0 ? 'up' : 'dn') + '">'
            + (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%</em>') + '</span>';
      }).join('');
    box.appendChild(sum);
  }

  function renderAll() {
    Object.keys(DATA).forEach(function (id) {
      var box = document.querySelector('[data-chart="' + id + '"]');
      if (box) draw(box, DATA[id]);
    });
  }

  function boot() {
    if (!Object.keys(DATA).length) return;
    // 정적 SVG 를 감춘다 — JS 가 살아 있을 때만 실행되므로 폴백은 그대로 남는다.
    document.documentElement.classList.add('ic-on');

    var all = [];
    Object.keys(DATA).forEach(function (id) { all = all.concat(DATA[id].dates); });
    all.sort();
    var minD = all[0], maxD = all[all.length - 1];
    var iso = function (s) { return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); };
    var plain = function (s) { return s.replace(/-/g, ''); };

    var bar = document.getElementById('ic-bar');
    if (bar) {
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
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
