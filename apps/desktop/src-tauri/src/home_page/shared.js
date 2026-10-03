/* OpenVids home: shared helpers for the Projects page and the Settings window —
   icon sprite (from the prototype's openvids-shared.js), theme, API, formatting. */
(function () {
  "use strict";

  /* ---- Icons: one style — 24 grid, 1.6 stroke, round caps ---- */
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    chat: '<path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4V6Z"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    agents:
      '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 15a5 5 0 0 1 3.5 4.8"/>',
    paperclip: '<path d="m8 12.5 6.1-6.1a3.5 3.5 0 0 1 5 5l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.5-8.5"/>',
    sliders:
      '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    settings:
      '<g fill="currentColor" stroke="none"><path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5A4.5 4.5 0 0 0 12 7.5Zm0 7.5a3 3 0 1 1 3 -3A3 3 0 0 1 12 15Zm8.25 -2.8q0.01 -0.2 0 -0.4l1.4 -1.75a0.75 0.75 0 0 0 0.14 -0.66a10.05 10.05 0 0 0 -1.02 -2.46a0.75 0.75 0 0 0 -0.56 -0.37l-2.22 -0.25q-0.14 -0.15 -0.28 -0.28L17.44 3.8a0.75 0.75 0 0 0 -0.37 -0.56a10.1 10.1 0 0 0 -2.46 -1.02a0.75 0.75 0 0 0 -0.66 0.14L12.2 3.75Q12 3.75 11.8 3.75L10.05 2.35a0.75 0.75 0 0 0 -0.66 -0.14A10.09 10.09 0 0 0 6.93 3.24a0.75 0.75 0 0 0 -0.37 0.56L6.31 6.03q-0.15 0.14 -0.28 0.28L3.8 6.56a0.75 0.75 0 0 0 -0.56 0.37a10.1 10.1 0 0 0 -1.02 2.46a0.75 0.75 0 0 0 0.14 0.66L3.75 11.8Q3.75 12 3.75 12.2L2.35 13.95a0.75 0.75 0 0 0 -0.14 0.66a10.05 10.05 0 0 0 1.02 2.46a0.75 0.75 0 0 0 0.56 0.37l2.22 0.25q0.14 0.15 0.28 0.28L6.56 20.2a0.75 0.75 0 0 0 0.37 0.56a10.1 10.1 0 0 0 2.46 1.02a0.75 0.75 0 0 0 0.66 -0.14L11.8 20.25q0.2 0.01 0.41 0l1.75 1.4a0.75 0.75 0 0 0 0.66 0.14a10.05 10.05 0 0 0 2.46 -1.02a0.75 0.75 0 0 0 0.37 -0.56l0.25 -2.22q0.15 -0.14 0.28 -0.28L20.2 17.44a0.75 0.75 0 0 0 0.56 -0.37a10.1 10.1 0 0 0 1.02 -2.46a0.75 0.75 0 0 0 -0.14 -0.66Zm-1.51 -0.61a6.93 6.93 0 0 1 0 0.81a0.75 0.75 0 0 0 0.16 0.51l1.33 1.66a8.58 8.58 0 0 1 -0.58 1.41L17.53 16.23a0.75 0.75 0 0 0 -0.48 0.25a6.95 6.95 0 0 1 -0.58 0.58a0.75 0.75 0 0 0 -0.25 0.48l-0.24 2.12a8.56 8.56 0 0 1 -1.41 0.58l-1.66 -1.33a0.75 0.75 0 0 0 -0.47 -0.16h-0.04a6.93 6.93 0 0 1 -0.81 0a0.75 0.75 0 0 0 -0.51 0.16L9.42 20.23a8.58 8.58 0 0 1 -1.41 -0.58L7.77 17.53a0.75 0.75 0 0 0 -0.25 -0.48a6.95 6.95 0 0 1 -0.58 -0.58a0.75 0.75 0 0 0 -0.48 -0.25L4.35 15.99a8.56 8.56 0 0 1 -0.58 -1.41l1.33 -1.66a0.75 0.75 0 0 0 0.16 -0.51a6.93 6.93 0 0 1 0 -0.81a0.75 0.75 0 0 0 -0.16 -0.51L3.77 9.42a8.58 8.58 0 0 1 0.58 -1.41L6.47 7.77a0.75 0.75 0 0 0 0.48 -0.25a6.95 6.95 0 0 1 0.58 -0.58A0.75 0.75 0 0 0 7.77 6.47L8.01 4.35a8.56 8.56 0 0 1 1.41 -0.58l1.66 1.33a0.75 0.75 0 0 0 0.51 0.16a6.93 6.93 0 0 1 0.81 0a0.75 0.75 0 0 0 0.51 -0.16L14.58 3.77a8.58 8.58 0 0 1 1.41 0.58L16.23 6.47a0.75 0.75 0 0 0 0.25 0.48a6.95 6.95 0 0 1 0.58 0.58a0.75 0.75 0 0 0 0.48 0.25l2.12 0.24a8.56 8.56 0 0 1 0.58 1.41l-1.33 1.66A0.75 0.75 0 0 0 18.74 11.59Z"/></g>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    circle: '<circle cx="12" cy="12" r="8.5"/>',
    thinking: '<path d="M5 8.5h14M5 12h9M5 15.5h5"/><circle cx="18" cy="15.5" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "folder-open":
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    ellipsis:
      '<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert:
      '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    locate: '<circle cx="12" cy="12" r="9"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
    "arrow-up-down": '<path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16"/>',
    return: '<path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    minus: '<path d="M5 12h14"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
    pause:
      '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
    "skip-back": '<path d="M19 19 9 12l10-7z" fill="currentColor"/><path d="M5 5v14"/>',
    "skip-fwd": '<path d="m5 5 10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
    loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    pointer:
      '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
    scissors:
      '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    magnet:
      '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    "zoom-in": '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
    "zoom-out": '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3M8 11h6"/>',
    maximize:
      '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    "safe-area":
      '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7" y="8.5" width="10" height="7" rx="1"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":
      '<path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c4.5 0 8.3 2.9 9.94 7a10.7 10.7 0 0 1-1.67 2.68"/><path d="M6.61 6.61A10.7 10.7 0 0 0 2.06 12c1.64 4.1 5.44 7 9.94 7a10.4 10.4 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>',
    image:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    audio: '<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>',
    shapes:
      '<path d="M8.3 10a.7.7 0 0 1-.63-1.08L11.4 3a.7.7 0 0 1 1.2-.04L16.3 8.9a.7.7 0 0 1-.57 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    "panel-left": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    "panel-right": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    "panel-bottom": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>',
    grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="5.5" r="1.4"/><circle cx="15" cy="5.5" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18.5" r="1.4"/><circle cx="15" cy="18.5" r="1.4"/></g>',
    import: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    flag: '<path d="M5 22V4M5 4h12l-2.5 4L17 12H5"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    unlock:
      '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>',
    review:
      '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    build:
      '<rect x="3" y="4" width="7" height="5" rx="1.2"/><rect x="14" y="4" width="7" height="5" rx="1.2"/><path d="M6.5 9v3.5h11V9M12 12.5V15"/><path d="M3 19h18M3 16v6"/>',
    arrange:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="8.5" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v2h11v-2M12 12v2"/>',
    refresh:
      '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    contrast:
      '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
    plug: '<path d="M9 2.5v5M15 2.5v5M6 7.5h12v3.5a6 6 0 0 1-12 0zM12 17v4.5"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
    gauge: '<path d="m12 14 4.5-4.5"/><path d="M3.5 17.5a9 9 0 1 1 17 0"/>',
    trash: '<path d="M3.5 6h17M9 6V3.5h6V6M5.5 6l1 14.5h11l1-14.5"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M13.5 9.5l2 2"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    shield:
      '<path d="M12 21.5s7.5-3.5 7.5-9.5V5.5L12 2.5 4.5 5.5V12c0 6 7.5 9.5 7.5 9.5z"/><path d="m9 12 2 2 4-4"/>',
    file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    subtitle:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h3M13 11h4M7 15h6M16 15h1"/>',
    aspect:
      '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M7 12.5v-3h3M17 11.5v3h-3"/>',
    font: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    bug: '<path d="m8 2 1.9 1.9M14.1 3.9 16 2M9 7.1v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M21 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  };
  function ic(name, size) {
    return (
      '<svg class="ic"' +
      (size ? ' style="--s:' + size + 'px"' : "") +
      ' aria-hidden="true"><use href="#i-' +
      name +
      '"/></svg>'
    );
  }
  function mountSprite() {
    const sym = Object.keys(ICONS)
      .map(function (k) {
        return '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + "</symbol>";
      })
      .join("");
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
        sym +
        "</defs></svg>",
    );
  }

  /* ---- Thumbnail placeholder for projects without a captured first frame (prototype "blank") ---- */
  function blankThumb() {
    return (
      '<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="320" height="180" fill="var(--surface-1)"/>' +
      '<g transform="translate(148 78)" fill="none" stroke="var(--fg-disabled)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="0" y="0" width="24" height="24" rx="6"/><path d="M6.5 7 12 17l5.5-10"/></g></svg>'
    );
  }

  /* ---- Formatting (prototype openvids-shared.js) ---- */
  const D = 24 * 3600e3;
  const pad = function (n) {
    return String(n).padStart(2, "0");
  };
  function fmtDur(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h ? h + ":" + pad(m) + ":" + pad(sec) : pad(m) + ":" + pad(sec);
  }
  function dayDiff(ts) {
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(ts);
    b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / D);
  }
  /* Formatters read the language at call time (OVI18N.language()), so they follow a language switch on the next render. */
  const fmtNumber = function (n) {
    return new Intl.NumberFormat(OVI18N.language()).format(n);
  };
  const upperFirst = function (s, lang) {
    return s ? s.charAt(0).toLocaleUpperCase(lang) + s.slice(1) : s;
  };
  function fmtOpened(ts) {
    const n = dayDiff(ts),
      lang = OVI18N.language(),
      t = new Date(ts),
      time = t.toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
    if (n <= 0) {
      const m = Math.max(1, Math.round((Date.now() - ts) / 60e3));
      if (m < 2) return OVI18N.t("home.time.justNow");
      return m < 60
        ? OVI18N.t("home.time.minutesAgo", { count: m })
        : OVI18N.t("home.time.hoursAgo", { count: Math.round(m / 60) });
    }
    if (n === 1) return OVI18N.t("home.time.yesterdayAt", { time });
    if (n < 7)
      return OVI18N.t("home.time.weekdayAt", {
        weekday: upperFirst(t.toLocaleDateString(lang, { weekday: "long" }), lang),
        time,
      });
    return t.toLocaleDateString(lang, {
      month: "short",
      day: "numeric",
      year: t.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  }
  function fmtMedia(n) {
    return OVI18N.t("home.media.clips", { count: n });
  }
  /* Finder units (1000), as the prototype's composer shows sizes. The unit is a message (Intl's "kB" is not the
     prototype's "KB"); the number is Intl, one decimal under 100. */
  const SIZE_UNITS = [
    "home.size.bytes",
    "home.size.kb",
    "home.size.mb",
    "home.size.gb",
    "home.size.tb",
  ];
  function formatBytes(bytes) {
    let value = Math.max(0, Number(bytes) || 0),
      unit = 0;
    while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
      value /= 1000;
      unit += 1;
    }
    if (unit === 0) return OVI18N.t(SIZE_UNITS[0], { count: value });
    const num = new Intl.NumberFormat(OVI18N.language(), {
      maximumFractionDigits: value < 100 ? 1 : 0,
    }).format(value);
    return OVI18N.t(SIZE_UNITS[unit], { value: num });
  }
  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60),
      s = pad(total % 60);
    return h ? h + ":" + pad(m) + ":" + s : m + ":" + s;
  }
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  /* ---- API: every /api call carries the per-launch token ---- */
  /* A 2xx answer whose body has a string `error` is a refusal unless `opts.plainBody` says the body is data
     (an OAuthLoginState carries its own `error` text). */
  function api(path, body, method, opts) {
    const m = method || (body === undefined ? "GET" : "POST");
    return fetch(path, {
      method: m,
      headers: Object.assign(
        { "X-OpenVids-Token": window.OV_TOKEN },
        body === undefined ? {} : { "Content-Type": "application/json" },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (
            !res.ok ||
            (!(opts && opts.plainBody) && data && data.error && typeof data.error === "string")
          ) {
            const err = new Error(
              (data && data.error && (data.error.message || data.error)) ||
                OVI18N.t("home.error.requestFailed", { status: res.status }),
            );
            err.status = res.status;
            err.data = data;
            /* The server's stable id of this failure and the values its sentence mentions (see describeError). */
            if (data && typeof data.code === "string") {
              err.code = data.code;
              err.params = data.params;
            }
            throw err;
          }
          return data;
        });
    });
  }

  /* The text to show for a failure from the local server: the translation of its code (home.error.<code>, with
     the params the server sent), or its own English sentence when it has no code or the catalog has no key for
     it. Takes an Error from api(), or any {code, params, error|message} object (the open-state and install
     states carry the same fields). Call it when the text is shown, so it follows the language. */
  function describeError(err) {
    if (!err) return "";
    const message =
      typeof err.message === "string"
        ? err.message
        : typeof err.error === "string"
          ? err.error
          : "";
    if (typeof err.code !== "string" || !err.code) return message;
    const key = "home.error." + err.code;
    const params = err.params && typeof err.params === "object" ? err.params : undefined;
    const text = OVI18N.t(key, params);
    return text === key ? message : text;
  }

  /* ---- Theme: Settings → Appearance (Match system / Dark / Light), applied before first paint ---- */
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  let themePref = "system";
  function applyTheme(pref) {
    if (pref === "system" || pref === "dark" || pref === "light") themePref = pref;
    const root = document.documentElement;
    root.dataset.themePref = themePref;
    root.dataset.theme = themePref === "system" ? (mq && mq.matches ? "light" : "dark") : themePref;
  }
  if (mq)
    mq.addEventListener("change", function () {
      if (themePref === "system") applyTheme(themePref);
    });

  /* ---- Density: Settings → Appearance → Density (Compact / Default). Set on :root so the Projects page and the
     Settings window share the token rules in ov.css; the Settings window also mirrors it on its own #win. ---- */
  let densityPref = "default";
  function applyDensity(pref) {
    if (pref === "compact" || pref === "default") densityPref = pref;
    document.documentElement.dataset.density = densityPref;
    const win = document.getElementById("win");
    if (win && win.hasAttribute("data-density")) win.dataset.density = densityPref;
  }

  window.OV = {
    ic: ic,
    mountSprite: mountSprite,
    blankThumb: blankThumb,
    ICONS: ICONS,
    fmtDur: fmtDur,
    fmtOpened: fmtOpened,
    fmtMedia: fmtMedia,
    fmtNumber: fmtNumber,
    dayDiff: dayDiff,
    formatBytes: formatBytes,
    formatClock: formatClock,
    esc: esc,
    api: api,
    describeError: describeError,
    applyTheme: applyTheme,
    themePref: function () {
      return themePref;
    },
    applyDensity: applyDensity,
    densityPref: function () {
      return densityPref;
    },
  };
})();
