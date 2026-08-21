/* 공통 좌측 고정 사이드바 — 모든 대시보드 페이지가 <body> 바로 뒤에서 동기 로드한다.
 * 마크업·CSS를 여기서만 관리해 12개 페이지에 중복을 만들지 않는다.
 * 동기 실행이라 첫 페인트 전에 접힘 상태(localStorage pf_nav_collapsed)가 적용된다.
 * 테마 토글은 각 페이지의 기존 #themeToggle 을 숨기고 이 버튼이 click() 을 위임한다
 * (페이지별 테마 로직을 그대로 재사용 — 중복 구현 없음).
 */
(function () {
  // stock.html·agent.html 은 위원회 화면을 iframe 으로 품는다. 그 안에서 또 그리면
  // 사이드바가 이중으로 뜨고 폭을 갉아먹는다.
  if (window.top !== window.self) return;

  var script = document.currentScript;
  // data-base 를 주면 그 절대주소를 기준으로 링크를 건다. 다른 도메인에 있는 화면
  // (jj-liquidity)이 이 파일을 그대로 복사해 쓰기 위한 것 — 파일 내용은 동일하게 유지한다.
  var base = (script && script.getAttribute('data-base')) ||
             (script && script.getAttribute('src') || 'nav.js').replace(/[^/]*$/, '');

  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V21h14V9.8"/><path d="M10 21v-6h4v6"/>',
    briefcase: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7"/><path d="M2 12h20"/>',
    landmark: '<path d="M3 21h18"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8"/><path d="M12 3l9 5H3z"/>',
    scale: '<path d="M12 4v17"/><path d="M7 21h10"/><path d="M5 7.5 12 5.5l7 2"/><path d="M5 8l-3 6h6z"/><path d="M19 8l-3 6h6z"/>',
    bars: '<path d="M3 20h18"/><path d="M6 20v-7M11 20V6M16 20v-10"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4 13.6 13.6 8.4 15.6 10.4 10.4z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    droplet: '<path d="M12 3s6.5 6.8 6.5 10.8a6.5 6.5 0 0 1-13 0C5.5 9.8 12 3 12 3z"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    dollar: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 .5c0 2.5 5 1.5 5 4a2.5 2.5 0 0 1-5 .5"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 4v4"/><circle cx="9" cy="13" r=".8"/><circle cx="15" cy="13" r=".8"/><path d="M9.5 16.8h5"/>',
    trending: '<path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    // 아래는 각 페이지 본문 패널 제목용(이모지 대체). .pf-ico 로 쓴다.
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/>',
    message: '<path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.7A8 8 0 1 1 21 12z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h4"/>',
    traffic: '<rect x="8" y="2" width="8" height="20" rx="4"/><circle cx="12" cy="7" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="17" r="1.3"/>',
    building: '<path d="M3 21h18"/><rect x="5" y="7" width="6" height="14"/><rect x="13" y="3" width="6" height="18"/><path d="M7 11h2M7 15h2M15 7h2M15 11h2M15 15h2"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M10.3 4.3 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8-4.9"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8 4.9"/><path d="M20 3v5h-5M4 21v-5h5"/>',
    shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 3.6 10.8c-.6.5-.9 1.1-1 1.7H9.4c-.1-.6-.4-1.2-1-1.7A6 6 0 0 1 12 3z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h3.4l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    puzzle: '<path d="M10 4a2 2 0 1 1 4 0v1.5h2.5a1 1 0 0 1 1 1V9H19a2 2 0 1 1 0 4h-1.5v2.5a1 1 0 0 1-1 1H14V18a2 2 0 1 1-4 0v-1.5H7.5a1 1 0 0 1-1-1V13H5a2 2 0 1 1 0-4h1.5V6.5a1 1 0 0 1 1-1H10z"/>',
    microscope: '<path d="M6 21h12"/><path d="M9.5 21a6 6 0 0 0 6-9"/><path d="m11 3.5 3.2 2-4.2 6.5-3.2-2z"/><path d="m8.3 11.7 3.2 2"/>',
    factory: '<path d="M3 21h18"/><path d="M4 21V10l5 3V10l5 3V7l5 3v11"/><path d="M8 17h.01M13 17h.01M18 17h.01"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    ruler: '<path d="M3 15 15 3l6 6L9 21z"/><path d="m7 11 2 2M10 8l2 2M13 5l2 2"/>',
    download: '<path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/>',
    sunrise: '<path d="M12 3v5"/><path d="M5.6 10.6 4.2 9.2M18.4 10.6l1.4-1.4"/><path d="M3 17h18M4 21h16"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/>',
    news: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6M7 13h6M17 9v6"/>',
    trendDown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M17 17h4v-4"/>',
    star: '<path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/>',
    sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15.5 18.8 18l2.2.8-2.2.8L18 22l-.8-2.4-2.2-.8 2.2-.8z"/>',
    wrench: '<path d="M15.5 3a5.5 5.5 0 0 0-5 7.8L3 18.3 5.7 21l7.5-7.5A5.5 5.5 0 0 0 20 8.5l-3 3-2.5-2.5 3-3A5.5 5.5 0 0 0 15.5 3z"/>',
    lockOpen: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
    pin: '<path d="M12 21v-7"/><path d="M9 3h6l-1 5 3 3v2H7v-2l3-3z"/>',
    brain: '<path d="M9.5 3A3 3 0 0 0 7 7.5 3 3 0 0 0 5.5 13 3 3 0 0 0 8 17.5 3 3 0 0 0 12 20V4a2 2 0 0 0-2.5-1z"/><path d="M14.5 3A3 3 0 0 1 17 7.5a3 3 0 0 1 1.5 5.5 3 3 0 0 1-2.5 4.5A3 3 0 0 1 12 20"/>',
    link: '<path d="M10 13a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7L11 7"/><path d="M14 11a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 18L13 17"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.4-3 7.7-7 9.5-4-1.8-7-5.1-7-9.5V6z"/>',
    stop: '<path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z"/><path d="M9 15 15 9M9 9l6 6"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    pencil: '<path d="m4 20 .8-3.4L16 5.4a2 2 0 0 1 2.8 0l1.8 1.8a2 2 0 0 1 0 2.8L9.4 21.2z"/><path d="m14.5 7 2.5 2.5"/>',
    car: '<path d="M5 17h14"/><path d="M5 17v2M19 17v2"/><path d="m4 13 1.7-4.3A2 2 0 0 1 7.6 7.4h8.8a2 2 0 0 1 1.9 1.3L20 13v4H4z"/><circle cx="7.5" cy="14.5" r="1"/><circle cx="16.5" cy="14.5" r="1"/>',
    dna: '<path d="M6 3c0 6 12 6 12 12M18 3c0 6-12 6-12 12M6 21h12M6 3h12"/><path d="M8.5 7.5h7M8.5 16.5h7"/>',
    ship: '<path d="M3 17.5 4.5 12h15L21 17.5"/><path d="M4 21c1.5 0 2-1 3.5-1s2 1 3.5 1 2-1 3.5-1 2 1 3.5 1"/><path d="M12 12V5M8 8h8"/>',
    oil: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V5h6v3"/><path d="M10 13h4"/>',
    pill: '<rect x="3.5" y="8.5" width="17" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="m9.5 9.5 5 5"/>',
    construction: '<path d="M3 21h18"/><path d="M6 21V9l9-4v16"/><path d="M15 12h4v9"/><path d="M9 12h2M9 16h2"/>',
    antenna: '<path d="M12 13v8"/><path d="M8 21h8"/><circle cx="12" cy="10" r="2"/><path d="M7.8 5.8a6 6 0 0 0 0 8.4M16.2 5.8a6 6 0 0 1 0 8.4"/>',
    cart: '<circle cx="9.5" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/><path d="M3 4h2.2l2.3 11h10L20 7H6.5"/>',
    flag: '<path d="M5 21V4"/><path d="M5 5h11l-1.5 3L16 11H5z"/>',
    flame: '<path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-1.6.7-3 1.5-4 .3 1.2 1 2 2 2 .8 0 1.5-.7 1.5-2 0-2-.5-3.5 0-5z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17.3 10 3.9 3.9 0 0 1 17 18z"/>',
    pointer: '<path d="M6 3 18 12l-5 1.2L15.4 19 13 20l-2.4-5.8L6.5 18z"/>',
    mapPin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    plug: '<path d="M9 3v6M15 3v6"/><path d="M7 9h10v3a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
    flask: '<path d="M10 3h4"/><path d="M11 3v6.5L5.6 18A2 2 0 0 0 7.3 21h9.4a2 2 0 0 0 1.7-3L13 9.5V3"/><path d="M8.2 14h7.6"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
    gamepad: '<path d="M7 8h10a5 5 0 0 1 4.5 7.2l-.8 1.6A2.4 2.4 0 0 1 16.4 17L15 15H9l-1.4 2a2.4 2.4 0 0 1-4.3-.2l-.8-1.6A5 5 0 0 1 7 8z"/><path d="M8 11v2M7 12h2M16 11.5h.01M17.5 13h.01"/>',
    atom: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="4"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h3"/>',
    battery: '<rect x="2" y="8" width="16" height="9" rx="2"/><path d="M20 11v3"/><path d="M5 11v3M8.5 11v3"/>',
    bowl: '<path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M4 20h16"/><path d="M9 7c0-1.5 1.5-1.5 1.5-3M14 7c0-1.5 1.5-1.5 1.5-3"/>',
    lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.7 5.7 3.5 3.5M14.8 14.8l3.5 3.5M18.3 5.7l-3.5 3.5M9.2 14.8l-3.5 3.5"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    files: '<rect x="8" y="3" width="12" height="15" rx="2"/><path d="M16 21H6a2 2 0 0 1-2-2V7"/><path d="M11.5 8h5M11.5 12h5"/>',
    megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2l9 4V5L7 9H5a1 1 0 0 0-1 1z"/><path d="M19 9.5a3.5 3.5 0 0 1 0 5"/>',
    crystal: '<circle cx="12" cy="10.5" r="6.5"/><path d="M7 20h10"/><path d="M9.2 8.8a3.2 3.2 0 0 1 2.6-2.2"/>'
  };

  // 본문 패널 제목 아이콘: <span class="pf-ico" data-ico="target"></span>
  // mask-image 라서 JS 로 나중에 삽입되는 마크업에도 자동 적용된다(런타임 채우기 불필요).
  function iconMaskCss() {
    return Object.keys(ICON).map(function (k) {
      var uri = encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000"' +
        ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[k] + '</svg>');
      return '.pf-ico[data-ico="' + k + '"],.pf-icoc[data-ico="' + k + '"]' +
        '{-webkit-mask-image:url("data:image/svg+xml,' + uri +
        '");mask-image:url("data:image/svg+xml,' + uri + '")}';
    }).join('');
  }

  // 순서·문구는 design_handoff_hub_sidebar/README.md 의 표와 1:1로 고정한다.
  var GROUPS = [
    { label: null, items: [
      { href: 'index.html', label: '홈', icon: 'home' },
      { href: 'portfolio.html', label: '포트폴리오', icon: 'briefcase' },
      { href: 'fm.html', label: '펀드매니저', icon: 'landmark' },
      { href: 'longshort/index.html', label: '롱숏포트폴리오', icon: 'scale' }
    ]},
    { label: '시장', items: [
      { href: 'daily.html', label: '데일리', icon: 'bars' },
      { href: 'macro.html', label: '매크로', icon: 'compass' },
      { href: 'calendar.html', label: '캘린더', icon: 'calendar' },
      { href: 'https://jj-liquidity.vercel.app/', label: '수급분석', icon: 'droplet', ext: true }
    ]},
    { label: '리서치·에이전트', items: [
      { href: 'sectors.html', label: '섹터분석', icon: 'layers' },
      { href: 'dividends.html', label: '배당주', icon: 'dollar' },
      { href: 'agent.html', label: '펀드매니저agent', icon: 'bot' },
      { href: 'stock.html', label: '종목분석agent', icon: 'trending' },
      { href: 'aihedgefund.html', label: 'AI헤지펀드', icon: 'cpu' }
    ]}
  ];

  var CSS = [
    ':root{--pf-nav-w:232px;--pf-nav-pad:232px;--pf-nav-bg:#0f172a;--pf-nav-border:#1e293b;',
    '--pf-nav-fg:#e2e8f0;--pf-nav-hover:#1e293b;--pf-nav-active-bg:#1e3a8a;--pf-nav-active-bar:#60a5fa;--pf-nav-muted:#94a3b8}',
    'html[data-nav="collapsed"]{--pf-nav-w:72px;--pf-nav-pad:72px}',
    'body{padding-left:var(--pf-nav-pad)}',
    // 전환은 첫 페인트 이후에만 켠다(data-nav-anim). 아니면 로드마다 폭이 스르륵 움직인다.
    'html[data-nav-anim] body{transition:padding-left .16s ease}',
    'html[data-nav-anim] .pf-nav{transition:width .16s ease}',
    '@media (max-width:760px){html[data-nav-anim] .pf-nav{transition:transform .16s ease}}',
    '.pf-nav,.pf-nav *{box-sizing:border-box}',
    '.pf-nav{position:fixed;top:0;left:0;z-index:30;width:var(--pf-nav-w);height:100vh;',
    'background:var(--pf-nav-bg);border-right:1px solid var(--pf-nav-border);padding:16px 12px;',
    'display:flex;flex-direction:column;align-items:stretch;overflow-y:auto;overflow-x:hidden;',
    // scrollbar-gutter 없으면 접힘 상태에서 스크롤바가 폭을 갉아 아이콘이 좌측으로 밀린다.
    'scrollbar-width:thin;scrollbar-gutter:stable both-edges;white-space:nowrap;',
    'font-size:12.5px;line-height:1.5}',
    '.pf-nav-brand{display:flex;width:100%;align-items:center;gap:8px;padding:0 0 14px}',
    '.pf-nav-toggle{flex:0 0 auto;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;',
    'background:transparent;border:1px solid #334155;border-radius:6px;color:var(--pf-nav-fg);font-size:14px;cursor:pointer;font-family:inherit}',
    '.pf-nav-toggle:hover{background:var(--pf-nav-hover);color:#fff;border-color:#475569}',
    '.pf-nav-word{font-size:14px;font-weight:800;letter-spacing:-.01em;color:#f8fafc}',
    '.pf-nav-group{display:flex;flex-direction:column;align-items:stretch;width:100%;gap:2px}',
    '.pf-nav-glabel{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;',
    'color:var(--pf-nav-muted);padding:0 10px;margin:14px 0 4px}',
    '.pf-nav-item{display:flex;width:100%;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;',
    'font-size:12.5px;font-weight:600;border-left:3px solid transparent;color:var(--pf-nav-fg);text-decoration:none}',
    '.pf-nav-item:hover{background:var(--pf-nav-hover);color:#fff;text-decoration:none}',
    '.pf-nav-item.is-active{color:#fff;background:var(--pf-nav-active-bg);border-left-color:var(--pf-nav-active-bar)}',
    '.pf-nav-ico{flex:0 0 16px;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}',
    '.pf-nav-ext{margin-left:auto;font-size:10px;color:var(--pf-nav-muted)}',
    '.pf-nav-theme{margin-top:auto;display:flex;width:100%;align-items:center;gap:6px;padding:8px 10px;',
    'background:transparent;color:var(--pf-nav-fg);border:1px solid #334155;border-radius:6px;cursor:pointer;',
    'font-size:12px;font-weight:600;font-family:inherit}',
    '.pf-nav-theme:hover{background:var(--pf-nav-hover);color:#fff;border-color:#475569}',
    '.pf-nav-burger{display:none;flex:0 0 auto;width:34px;height:34px;align-items:center;justify-content:center;',
    'background:transparent;border:1px solid var(--border,#e6e8eb);border-radius:6px;color:inherit;cursor:pointer;margin-right:10px}',
    '.pf-nav-scrim{display:none;position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:29}',
    // 데스크톱: 접힘 레일
    '@media (min-width:761px){',
    'html[data-nav="collapsed"] .pf-nav-brand,html[data-nav="collapsed"] .pf-nav-item,',
    'html[data-nav="collapsed"] .pf-nav-theme{justify-content:center}',
    'html[data-nav="collapsed"] .pf-nav-word,html[data-nav="collapsed"] .pf-nav-label,',
    'html[data-nav="collapsed"] .pf-nav-glabel,html[data-nav="collapsed"] .pf-nav-ext{display:none}',
    'html[data-nav="collapsed"] .pf-nav-group{margin-top:10px}',
    '}',
    // 모바일: 오프캔버스 드로어 + 헤더 햄버거
    '@media (max-width:760px){',
    'html[data-nav="expanded"],html[data-nav="collapsed"]{--pf-nav-w:232px;--pf-nav-pad:0px}',
    '.pf-nav{transform:translateX(-100%)}',
    'html[data-nav-open] .pf-nav{transform:none}',
    'html[data-nav-open] .pf-nav-scrim{display:block}',
    '.pf-nav-burger{display:inline-flex}',
    '.pf-nav-toggle{display:none}',
    '}',
    // 본문 패널 제목 아이콘(이모지 대체). 제목 글자 크기에 따라 붙는다.
    '.pf-ico,.pf-icoc{display:inline-block;flex:0 0 auto;width:1.15em;height:1.15em;vertical-align:-.18em;',
    'margin-right:7px;background:currentColor;color:var(--accent);',
    '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;',
    '-webkit-mask-size:contain;mask-size:contain}',
    // 목차·버튼·라벨용: 활성 상태(흰 글씨 등)를 따라가야 하므로 글자색을 그대로 쓴다.
    '.pf-ico.cur,.pf-icoc{color:currentColor}',
    // 색 자체가 의미인 신호(±σ 구간 등)는 아이콘 대신 색점으로 옮긴다.
    '.pf-dot{display:inline-block;width:.62em;height:.62em;border-radius:50%;vertical-align:.02em;margin-right:.15em;background:currentColor}',
    '.pf-dot[data-dot="red"]{color:#dc2626}.pf-dot[data-dot="orange"]{color:#ea580c}.pf-dot[data-dot="yellow"]{color:#ca8a04}',
    '.pf-dot[data-dot="green"]{color:#16a34a}.pf-dot[data-dot="blue"]{color:#2563eb}.pf-dot[data-dot="gray"]{color:#94a3b8}',
    iconMaskCss(),
    // 사이드바가 생겼으니 본문 중앙정렬 폭 제한을 푼다(홈과 동일하게 전폭).
    'main{max-width:none}',
    // fm/agent 의 섹션 목차는 좌측하단 고정이라 사이드바와 겹친다 → macro 목차와 같은 우측으로.
    '.fm-nav{left:auto;right:16px}',
    '@media (max-width:1080px){.fm-nav{left:auto;right:10px}}',
    '@media print{.pf-nav,.pf-nav-scrim,.pf-nav-burger{display:none!important}body{padding-left:0!important}}'
  ].join('');

  function svg(name, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>';
  }
  window.PF_NAV = { icon: svg };  // index.html 카드가 같은 아이콘 세트를 재사용

  // 현재 페이지 판정: longshort/ 하위는 디렉터리까지 비교, 그 외는 파일명.
  var path = location.pathname.toLowerCase();
  var current = /\/longshort\/([^/]*\.html?)?$/.test(path)
    ? 'longshort/index.html'
    : (function () {
        var f = path.split('/').pop();
        return /\.html?$/.test(f) ? f : 'index.html';
      })();

  // 다른 도메인에 얹을 때는 data-active 로 활성 항목을 직접 지정한다.
  // (Vercel 프리뷰는 도메인이 매번 달라 origin 비교만으로는 부족하다.)
  var forced = script && script.getAttribute('data-active');
  function isHere(it) {
    if (forced) return it.label === forced;
    if (!it.ext) return it.href === current;
    try { return new URL(it.href).origin === location.origin; } catch (e) { return false; }
  }

  var html = '<aside class="pf-nav" id="pfNav">' +
    '<div class="pf-nav-brand">' +
      '<button type="button" class="pf-nav-toggle" id="pfNavToggle" title="사이드바 접기/펼치기"></button>' +
      '<span class="pf-nav-word">PF Dashboard</span>' +
    '</div>';

  GROUPS.forEach(function (g) {
    if (g.label) html += '<div class="pf-nav-glabel">' + g.label + '</div>';
    html += '<div class="pf-nav-group">';
    g.items.forEach(function (it) {
      var href = it.ext ? it.href : base + it.href;
      var here = isHere(it);
      html += '<a class="pf-nav-item' + (here ? ' is-active' : '') + '" href="' + href + '"' +
        ' title="' + it.label + '"' + (it.ext && !here ? ' target="_blank" rel="noopener"' : '') + '>' +
        '<span class="pf-nav-ico">' + svg(it.icon, 16) + '</span>' +
        '<span class="pf-nav-label">' + it.label + '</span>' +
        (it.ext && !here ? '<span class="pf-nav-ext">↗</span>' : '') +
      '</a>';
    });
    html += '</div>';
  });

  html += '<button type="button" class="pf-nav-theme" id="pfNavTheme" title="다크/라이트 전환">' +
      '<span class="pf-nav-ico">' + svg('moon', 16) + '</span>' +
      '<span class="pf-nav-label" id="pfNavThemeLabel">다크</span>' +
    '</button></aside>' +
    '<div class="pf-nav-scrim" id="pfNavScrim"></div>';

  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('pf_nav_collapsed'); } catch (e) {}
  // 저장값이 없으면 좁은 화면(≤1080px)에서는 접힘으로 시작한다.
  var collapsed = saved != null ? saved === '1' : window.innerWidth <= 1080;
  // 스타일 삽입 '전에' 상태를 정해야 232→72 전환이 로드마다 재생되지 않는다.
  root.setAttribute('data-nav', collapsed ? 'collapsed' : 'expanded');

  document.head.insertAdjacentHTML('beforeend', '<style id="pfNavStyle">' + CSS + '</style>');

  function closeDrawer() { root.removeAttribute('data-nav-open'); }

  function mount() {
    document.body.insertAdjacentHTML('afterbegin', html);
    requestAnimationFrame(function () { root.setAttribute('data-nav-anim', ''); });

    var toggle = document.getElementById('pfNavToggle');
    function paintToggle() {
      toggle.textContent = root.getAttribute('data-nav') === 'collapsed' ? '»' : '«';
    }
    paintToggle();
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-nav') === 'collapsed' ? 'expanded' : 'collapsed';
      root.setAttribute('data-nav', next);
      try { localStorage.setItem('pf_nav_collapsed', next === 'collapsed' ? '1' : '0'); } catch (e) {}
      paintToggle();
    });

    document.getElementById('pfNavScrim').addEventListener('click', closeDrawer);
  }

  // <body> 태그를 생략한 문서(jj-liquidity 리포트)에서는 이 스크립트가 head 에 남아
  // document.body 가 아직 없다. 그럴 때만 파싱 완료 후로 미룬다.
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // 헤더·테마 연결은 DOM 이 다 만들어진 뒤에.
  function wire() {
    var themeBtn = document.getElementById('pfNavTheme');
    var themeLabel = document.getElementById('pfNavThemeLabel');
    // 위원회 화면(portfolio_agent/stock_agent)은 id 가 themeBtn 이고 body[data-th] 를 쓴다.
    var pageBtn = document.getElementById('themeToggle') || document.getElementById('themeBtn');
    function isDark() {
      return (root.getAttribute('data-theme') || document.body.getAttribute('data-th')) === 'dark';
    }
    function paintTheme() {
      themeLabel.textContent = isDark() ? '라이트' : '다크';
    }
    paintTheme();
    if (pageBtn) {
      pageBtn.style.display = 'none';
      themeBtn.addEventListener('click', function () { pageBtn.click(); paintTheme(); });
    } else {
      // 페이지에 자체 토글이 없으면(신규 index.html) 직접 처리.
      themeBtn.addEventListener('click', function () {
        var next = isDark() ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('pf_theme', next); } catch (e) {}
        paintTheme();
      });
    }

    var header = document.querySelector('header');
    if (header) {
      var burger = document.createElement('button');
      burger.type = 'button';
      burger.className = 'pf-nav-burger';
      burger.title = '메뉴';
      burger.innerHTML = svg('menu', 18);
      burger.addEventListener('click', function () {
        if (root.hasAttribute('data-nav-open')) closeDrawer();
        else root.setAttribute('data-nav-open', '');
      });
      header.insertBefore(burger, header.firstChild);
    }

  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
