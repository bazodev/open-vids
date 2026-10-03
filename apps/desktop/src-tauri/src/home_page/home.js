/* Projects page — the prototype's openvids-projects.html scenario on real data: recents from the home
   server, actions through its token-guarded API, the start composer creating real projects. */
(function () {
  "use strict";
  const {
    ic,
    esc,
    api,
    describeError,
    fmtDur,
    fmtOpened,
    fmtMedia,
    fmtNumber,
    dayDiff,
    formatBytes,
    blankThumb,
  } = OV;
  const { toast, showMenu, closeMenu, sheet } = OVH;
  const tr = (key, params) => OVI18N.t(key, params);
  /* The same, HTML-escaped: for markup built as a string (menus, toasts, templates). */
  const th = (key, params) => esc(OVI18N.t(key, params));
  const $ = (s) => document.querySelector(s);
  const win = $("#win"),
    main = $("#main"),
    body = $("#body"),
    strip = $("#loStrip");
  const loSect = $("#lastOpened"),
    chatSect = $("#startChat"),
    recentSect = $("#recent"),
    chatHost = $("#chatHost");
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage unavailable */
      }
    },
  };
  let prefs = (window.OV_BOOT && window.OV_BOOT.prefs) || {};

  /* renameAt: where the inline rename field is shown — 'list' (Recent) or 'strip' (Last Opened). */
  const S = {
    items: [],
    q: "",
    sort: "opened",
    view: store.get("ov-view") === "list" ? "list" : "grid",
    sel: null,
    renaming: null,
    renameAt: "list",
    loading: true,
    loFocus: null,
    opening: null,
  };
  const byId = (id) => S.items.find((p) => p.id === id);
  const itemEl = (id) => body.querySelector('[data-item][data-id="' + CSS.escape(id) + '"]');
  const SORTS = { opened: "home.sort.opened", name: "home.sort.name", dur: "home.sort.duration" };
  const monoWrap = (inner) => '<span class="mono" style="font-size:11px">' + inner + "</span>";
  /* The version the Settings button announces while an update waits (paintUpdate); null otherwise. */
  let updateVersion = null;

  /* ---------- static chrome ---------- */
  $("#fieldIcon").innerHTML = ic("search", 14);
  $("#clearSearch").innerHTML = ic("x", 10);
  $("#viewGrid").innerHTML = ic("grid", 14);
  $("#viewList").innerHTML = ic("list", 14);
  paintChrome();
  $("#settingsBtn").innerHTML = ic("settings", 16);
  $("#settingsBtn").setAttribute("aria-haspopup", "dialog");
  $("#settingsBtn").setAttribute("aria-expanded", "false");
  $("#reportBtn").innerHTML = ic("bug");
  /* The texts drawn from script, at load and again when the language changes. The tooltips (data-tip) are read
     by the tooltip layer, so they are set here from data-tip-i18n. */
  function paintChrome() {
    $("#openBtn").innerHTML = ic("folder-open", 14) + th("home.toolbar.open");
    $("#newBtn").innerHTML = ic("plus", 14) + th("home.toolbar.new");
    document.querySelectorAll("[data-tip-i18n]").forEach((el) => {
      el.dataset.tip = tr(el.dataset.tipI18n);
    });
    paintUpdate();
  }

  /* ---------- update badge: an accent dot on Settings while a newer version waits (GET /api/update/status) ---------- */
  function paintUpdate() {
    const btn = $("#settingsBtn");
    const label = updateVersion
      ? tr("home.update.settingsTip", { version: updateVersion })
      : tr("home.toolbar.settings");
    btn.classList.toggle("has-update", !!updateVersion);
    btn.setAttribute("aria-label", label);
    btn.dataset.tip = label;
  }
  function loadUpdateBadge() {
    return api("/api/update/status", undefined, undefined, { plainBody: true })
      .then((st) => {
        const waiting =
          st.phase === "available" || st.phase === "downloading" || st.phase === "ready";
        const next = waiting && typeof st.version === "string" ? st.version : null;
        if (next !== updateVersion) {
          updateVersion = next;
          paintUpdate();
        }
      })
      .catch(() => {
        /* no updater in this build, or the server is busy: keep the badge as it is */
      });
  }
  loadUpdateBadge();
  setInterval(() => {
    if (document.visibilityState === "visible") loadUpdateBadge();
  }, 30000);
  /* Settings opens on General while the badge shows, so the update is one click away. */
  const settingsSection = () => (updateVersion ? "general" : undefined);

  /* ---------- data ---------- */
  const toItem = (r) => ({
    id: r.id,
    name: r.name || r.id,
    dir: r.dir,
    path: r.path || r.dir,
    ts: (r.last_opened || 0) * 1000,
    dur: r.duration || 0,
    media: r.clips || 0,
    missing: !!r.missing,
    thumb: r.thumb || null,
  });
  function load(then) {
    return api("/api/recents")
      .then((res) => {
        S.items = (res.recents || []).map(toItem);
        S.loading = false;
        render();
        if (then) then();
      })
      .catch((err) => {
        S.loading = false;
        render();
        toast(th("home.error.load", { message: describeError(err) }), null, "error");
      });
  }

  /* ---------- data views ---------- */
  function visible() {
    const q = S.q.trim().toLowerCase();
    const a = S.items.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
    const cmp = {
      opened: (x, y) => y.ts - x.ts,
      name: (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }),
      dur: (x, y) => y.dur - x.dur,
    }[S.sort];
    return a.sort(cmp);
  }
  function groups(a) {
    if (S.sort !== "opened") return [{ label: tr("home.group.all"), items: a }];
    const defs = [
      [tr("home.group.today"), (n) => n <= 0],
      [tr("home.group.yesterday"), (n) => n === 1],
      [tr("home.group.previous7"), (n) => n >= 2 && n <= 7],
      [tr("home.group.earlier"), (n) => n > 7],
    ];
    return defs
      .map(([label, f]) => ({ label, items: a.filter((p) => f(dayDiff(p.ts))) }))
      .filter((g) => g.items.length);
  }

  /* ---------- markup ---------- */
  function nameHtml(p, at) {
    return S.renaming === p.id && S.renameAt === (at || "list")
      ? '<input class="rename-input" data-rename value="' +
          esc(p.name) +
          '" aria-label="' +
          th("home.item.renameLabel") +
          '" spellcheck="false" />'
      : esc(p.name);
  }
  function thumbHtml(p, more, row) {
    const inner = p.missing
      ? '<span class="thumb-missing">' + ic("alert") + "</span>"
      : p.thumb
        ? '<img src="/thumb/' +
          encodeURIComponent(p.thumb) +
          '" alt="" loading="lazy" draggable="false" />'
        : blankThumb();
    return (
      '<div class="thumb">' +
      inner +
      (row ? "" : '<span class="thumb-check">' + ic("check", 10) + "</span>") +
      (p.missing || row ? "" : '<span class="thumb-dur">' + fmtDur(p.dur) + "</span>") +
      (more
        ? '<button class="thumb-more" type="button" tabindex="-1" data-more aria-label="' +
          th("home.item.moreActions", { name: p.name }) +
          '" aria-haspopup="menu">' +
          ic("ellipsis", 14) +
          "</button>"
        : "") +
      "</div>"
    );
  }
  function metaHtml(p) {
    return p.missing
      ? '<span class="status warning">' +
          ic("alert", 12) +
          th("home.item.notFound") +
          '</span><span class="mid">·</span><button class="link" type="button" tabindex="-1" data-locate>' +
          th("home.item.locate") +
          "</button>"
      : "<span>" +
          esc(fmtOpened(p.ts)) +
          '</span><span class="mid">·</span><span>' +
          esc(fmtMedia(p.media)) +
          "</span>";
  }
  function attrs(p, cls, tab) {
    const on = p.id === S.sel;
    return (
      'class="' +
      cls +
      " sel-item" +
      (on ? " is-selected" : "") +
      (p.missing ? " is-missing" : "") +
      '" role="option" aria-selected="' +
      on +
      '" tabindex="' +
      tab +
      '" data-item data-id="' +
      esc(p.id) +
      '" aria-label="' +
      (p.missing ? th("home.item.aria.notFound", { name: p.name }) : esc(p.name)) +
      '"'
    );
  }
  function cardHtml(p, tab) {
    return (
      "<div " +
      attrs(p, "card", tab) +
      ">" +
      thumbHtml(p, true) +
      '<div class="card-text"><div class="name" title="' +
      esc(p.name) +
      '">' +
      nameHtml(p) +
      '</div><div class="meta">' +
      metaHtml(p) +
      "</div></div></div>"
    );
  }
  /* Last Opened: shortcuts, not selectable — no [data-item], so Recent selection and arrow navigation ignore them. */
  function loCardHtml(p, tab) {
    return (
      '<div class="card sel-item lo-card' +
      (p.missing ? " is-missing" : "") +
      '" role="listitem" tabindex="' +
      tab +
      '" data-lo data-id="' +
      esc(p.id) +
      '" aria-label="' +
      (p.missing
        ? th("home.item.aria.notFound", { name: p.name })
        : th("home.item.aria.opened", { name: p.name, when: fmtOpened(p.ts) })) +
      '">' +
      thumbHtml(p, true) +
      '<div class="card-text"><div class="name" title="' +
      esc(p.name) +
      '">' +
      nameHtml(p, "strip") +
      '</div><div class="meta">' +
      metaHtml(p) +
      "</div></div></div>"
    );
  }
  function skCard(i) {
    return (
      '<div class="card sel-item is-loading"><div class="thumb"><span class="sk" style="width:100%;height:100%;animation-delay:' +
      i * 90 +
      'ms"></span></div><div class="card-text" style="gap:5px;padding-top:2px"><span class="sk" style="height:10px;width:' +
      (48 + ((i * 17) % 40)) +
      '%"></span><span class="sk" style="height:8px;width:' +
      (30 + ((i * 11) % 22)) +
      '%"></span></div></div>'
    );
  }
  function rowHtml(p, tab) {
    const st = p.missing
      ? '<span class="status warning">' +
        ic("alert", 12) +
        th("home.item.notFound") +
        '</span> <button class="link" type="button" tabindex="-1" data-locate>' +
        th("home.item.locate") +
        "</button>"
      : "";
    return (
      "<div " +
      attrs(p, "row", tab) +
      '><span class="row-check">' +
      ic("check", 10) +
      "</span>" +
      '<div class="row-name">' +
      thumbHtml(p, false, true) +
      '<div class="name" title="' +
      esc(p.name) +
      '">' +
      nameHtml(p) +
      "</div>" +
      st +
      "</div>" +
      '<span class="cell">' +
      esc(fmtOpened(p.ts)) +
      '</span><span class="cell r">' +
      (p.missing ? "—" : fmtDur(p.dur)) +
      '</span><span class="cell r">' +
      (p.missing ? "—" : fmtNumber(p.media)) +
      "</span>" +
      '<span class="cell path" title="' +
      esc(p.dir) +
      '">' +
      esc(p.path) +
      "</span>" +
      '<button class="icon-btn sm more" type="button" tabindex="-1" data-more aria-label="' +
      th("home.item.moreActions", { name: p.name }) +
      '" aria-haspopup="menu">' +
      ic("ellipsis", 14) +
      "</button></div>"
    );
  }
  function listHead() {
    const s = (k, label, cls) =>
      '<button type="button" data-sort="' +
      k +
      '" class="' +
      (cls || "") +
      '"' +
      (S.sort === k ? ' aria-sort="descending"' : "") +
      ">" +
      label +
      (S.sort === k ? ic("chevron", 10) : "") +
      "</button>";
    return (
      '<div class="row-head list-head" role="presentation"><span></span>' +
      s("name", th("home.list.name")) +
      s("opened", th("home.list.opened")) +
      s("dur", th("home.list.duration"), "num-col") +
      '<span class="num-col">' +
      th("home.list.clips") +
      "</span><span>" +
      th("home.list.location") +
      "</span><span></span></div>"
    );
  }
  function skeleton() {
    const g = (n) =>
      '<div class="group-head sect-label" aria-hidden="true"><span class="sk" style="width:64px;height:9px"></span></div>' +
      (S.view === "grid"
        ? '<div class="grid" aria-hidden="true">' +
          Array.from({ length: n }, (_, i) => skCard(i)).join("") +
          "</div>"
        : '<div class="list" aria-hidden="true">' +
          Array.from(
            { length: n },
            (_, i) =>
              '<div class="row sel-item is-loading"><span></span><div class="row-name"><div class="thumb"><span class="sk" style="width:100%;height:100%"></span></div><span class="sk" style="height:10px;width:' +
              (120 + ((i * 37) % 120)) +
              'px"></span></div><span class="sk" style="height:8px;width:70px"></span><span class="sk" style="height:8px;width:36px;justify-self:end"></span><span class="sk" style="height:8px;width:24px;justify-self:end"></span><span class="sk" style="height:8px;width:' +
              (90 + ((i * 23) % 80)) +
              'px"></span><span></span></div>',
          ).join("") +
          "</div>");
    return (
      '<div role="status" class="sr-only">' +
      th("home.status.loading") +
      "</div>" +
      (S.view === "list"
        ? '<div class="row-head list-head" aria-hidden="true"><span></span><span>' +
          th("home.list.name") +
          "</span><span>" +
          th("home.list.opened") +
          '</span><span class="num-col">' +
          th("home.list.duration") +
          '</span><span class="num-col">' +
          th("home.list.clips") +
          "</span><span>" +
          th("home.list.location") +
          "</span><span></span></div>"
        : "") +
      g(S.view === "grid" ? 5 : 3) +
      g(S.view === "grid" ? 6 : 5)
    );
  }
  /* The Start composer above is the empty page's call to action; Recent keeps only a quiet note. */
  const emptyHtml = () =>
    '<div class="recent-note"><h2>' +
    esc(OVI18N.t("home.recent.empty.title")) +
    "</h2><p>" +
    esc(OVI18N.t("home.recent.empty.description")) +
    "</p></div>";
  const noResults = () =>
    '<div class="empty inline"><h2>' +
    th("home.search.empty.title") +
    "</h2><p>" +
    th("home.search.empty.description", { query: S.q.trim() }) +
    '</p><div class="empty-actions"><button class="btn btn-sm" type="button" data-act="clear">' +
    th("home.search.empty.clear") +
    "</button></div></div>";

  /* ---------- render ---------- */
  function render() {
    const empty = !S.loading && S.items.length === 0,
      list = visible(),
      searching = !!S.q.trim();
    win.classList.toggle("is-list", S.view === "list");
    win.classList.toggle("is-empty", empty);
    loSect.hidden = empty || searching;
    chatSect.hidden = searching;
    chatSect.classList.toggle("is-hero", empty);
    if (!loSect.hidden) renderStrip();
    const dis = S.loading || empty;
    $("#field").classList.toggle("is-disabled", dis);
    $("#search").disabled = dis;
    $("#sortBtn").disabled = dis;
    $("#viewGrid").disabled = dis;
    $("#viewList").disabled = dis;
    $("#viewGrid").setAttribute("aria-pressed", S.view === "grid");
    $("#viewList").setAttribute("aria-pressed", S.view === "list");
    refreshFoot();
    $("#sortBtn").innerHTML =
      '<span class="lbl">' +
      th("home.sort.label") +
      "</span> " +
      th(SORTS[S.sort]) +
      ic("chevron", 12);
    $("#count").textContent =
      S.loading || empty
        ? ""
        : searching
          ? tr("home.count.filtered", {
              shown: fmtNumber(list.length),
              total: fmtNumber(S.items.length),
            })
          : fmtNumber(S.items.length);
    if (S.sel && !list.some((p) => p.id === S.sel)) S.sel = null;
    const tabId = S.sel || (list[0] && list[0].id);
    if (S.loading) body.innerHTML = skeleton();
    else if (empty) body.innerHTML = emptyHtml();
    else if (!list.length) body.innerHTML = noResults();
    else {
      body.innerHTML =
        (S.view === "list" ? listHead() : "") +
        groups(list)
          .map(
            (g) =>
              '<div class="group-head sect-label" role="presentation">' +
              esc(g.label) +
              '<span class="count">' +
              fmtNumber(g.items.length) +
              "</span></div>" +
              '<div class="' +
              (S.view === "grid" ? "grid" : "list") +
              '" role="group" aria-label="' +
              esc(g.label) +
              '">' +
              g.items
                .map((p) => (S.view === "grid" ? cardHtml : rowHtml)(p, p.id === tabId ? 0 : -1))
                .join("") +
              "</div>",
          )
          .join("");
    }
    status();
  }
  /* 5 most recently opened, independent of search / sort / view. */
  function renderStrip() {
    if (S.loading) {
      strip.setAttribute("aria-busy", "true");
      strip.innerHTML = Array.from({ length: 5 }, (_, i) =>
        skCard(i).replace(
          'class="card sel-item is-loading"',
          'class="card sel-item is-loading" aria-hidden="true"',
        ),
      ).join("");
      return;
    }
    strip.removeAttribute("aria-busy");
    const top = S.items
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5);
    if (!top.some((p) => p.id === S.loFocus)) S.loFocus = top[0] ? top[0].id : null;
    strip.innerHTML = top.map((p) => loCardHtml(p, p.id === S.loFocus ? 0 : -1)).join("");
  }
  function status() {
    const sel = S.sel && byId(S.sel),
      miss = S.items.filter((p) => p.missing).length;
    const hint = (kbd, key) =>
      '<span class="hint"><span class="kbd">' + kbd + "</span>" + th(key) + "</span>";
    const hints = [
      hint("↑↓←→", "home.hint.select"),
      hint("↵", "home.hint.open"),
      hint("F2", "home.hint.rename"),
      hint("⌘F", "home.hint.search"),
    ];
    let left;
    if (S.loading) left = esc(OVI18N.t("home.status.loading"));
    else if (sel)
      left =
        ic("folder", 12) +
        '<span class="mono">' +
        esc(sel.path) +
        "</span>" +
        (sel.missing
          ? '<span class="status warning" style="margin-left:6px">' +
            ic("alert", 12) +
            th("home.item.notFound") +
            "</span>"
          : "");
    else
      left = esc(
        [OVI18N.t("home.status.projects", { count: S.items.length })]
          .concat(miss ? [OVI18N.t("home.status.missing", { count: miss })] : [])
          .join(" · "),
      );
    $("#statusbar").innerHTML =
      '<div class="sb-left">' +
      left +
      '</div><div class="sb-right">' +
      (S.items.length && !S.loading ? hints.join("") : "") +
      "</div>";
  }

  /* ---------- selection & keyboard ---------- */
  function select(id, opt) {
    S.sel = id;
    body.querySelectorAll("[data-item]").forEach((el) => {
      const on = el.dataset.id === id;
      el.classList.toggle("is-selected", on);
      el.setAttribute("aria-selected", on);
      el.tabIndex = on ? 0 : -1;
    });
    status();
    if (id && opt && opt.focus) {
      const el = itemEl(id);
      if (el) el.focus();
    }
  }
  function move(dir) {
    const els = [...body.querySelectorAll("[data-item]")];
    if (!els.length) return;
    const cur = S.sel && itemEl(S.sel);
    if (!cur) return select(els[0].dataset.id, { focus: true });
    const r = cur.getBoundingClientRect(),
      cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    let best = null,
      bd = 1e9;
    for (const el of els) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect(),
        x = b.left + b.width / 2,
        y = b.top + b.height / 2;
      let ok, d;
      if (dir === "right") {
        ok = Math.abs(y - cy) < r.height / 2 && x > cx + 2;
        d = x - cx;
      } else if (dir === "left") {
        ok = Math.abs(y - cy) < r.height / 2 && x < cx - 2;
        d = cx - x;
      } else if (dir === "down") {
        ok = y > cy + r.height / 2;
        d = y - cy + Math.abs(x - cx) * 2;
      } else {
        ok = y < cy - r.height / 2;
        d = cy - y + Math.abs(x - cx) * 2;
      }
      if (ok && d < bd) {
        bd = d;
        best = el;
      }
    }
    if (!best) {
      const i = els.indexOf(cur);
      best = dir === "right" ? els[i + 1] : dir === "left" ? els[i - 1] : null;
    }
    if (best) select(best.dataset.id, { focus: true });
  }
  const stripCards = () =>
    [...strip.querySelectorAll("[data-lo]")].filter(
      (el) => getComputedStyle(el).display !== "none",
    );
  function focusStrip(id, idx) {
    const cards = stripCards(),
      el =
        (id && cards.find((c) => c.dataset.id === id)) ||
        cards[Math.min(idx || 0, cards.length - 1)];
    if (!el) return;
    S.loFocus = el.dataset.id;
    strip.querySelectorAll("[data-lo]").forEach((c) => {
      c.tabIndex = c === el ? 0 : -1;
    });
    el.focus();
  }
  /* After an action, keep focus where it was invoked: the strip card, or the Recent selection. */
  function land(at, id, idx) {
    if (at === "strip" && !loSect.hidden) focusStrip(id, idx);
    else if (id) select(id, { focus: true });
  }
  const stripIndex = (id) => stripCards().findIndex((c) => c.dataset.id === id);

  /* ---------- menus ---------- */
  function itemMenu(p, at) {
    if (p.missing)
      return [
        { label: th("home.item.locate"), icon: "locate", act: () => locate(p, at) },
        { sep: 1 },
        {
          label: th("home.item.removeFromRecent"),
          icon: "x",
          kbd: "⌘⌫",
          act: () => remove(p, at),
        },
      ];
    return [
      { label: th("home.item.open"), icon: "folder-open", kbd: "↵", act: () => openProject(p, at) },
      { label: th("home.item.rename"), icon: "pencil", kbd: "F2", act: () => startRename(p, at) },
      { label: th("home.item.reveal"), icon: "folder", kbd: "⇧⌘R", act: () => reveal(p) },
      { label: th("home.item.duplicate"), icon: "copy", kbd: "⌘D", act: () => duplicate(p, at) },
      { sep: 1 },
      {
        label: th("home.item.removeFromRecent"),
        icon: "x",
        kbd: "⌘⌫",
        act: () => remove(p, at),
      },
      {
        label: th(prefs.confirmTrash === false ? "home.item.trash" : "home.item.trashConfirm"),
        icon: "trash",
        danger: 1,
        act: () => trash(p, at),
      },
    ];
  }
  function menuFor(p, x, y, btn) {
    select(p.id);
    showMenu(itemMenu(p), x, y, itemEl(p.id), btn);
  }
  function stripMenu(p, x, y, btn) {
    showMenu(
      itemMenu(p, "strip"),
      x,
      y,
      strip.querySelector('[data-lo][data-id="' + CSS.escape(p.id) + '"]'),
      btn,
    );
  }
  main.addEventListener("scroll", () => closeMenu(false), { passive: true });

  /* ---------- actions ---------- */
  /* A toast for a failed action: the message is the backend's error text, passed as {message}. */
  function fail(key, params) {
    return (err) =>
      toast(th(key, Object.assign({ message: describeError(err) }, params)), null, "error");
  }
  function reveal(p) {
    api("/api/reveal", { id: p.id }).catch(fail("home.error.reveal"));
  }
  function duplicate(p, at) {
    api("/api/duplicate", { id: p.id })
      .then((res) =>
        load(() => {
          const c = res.project && byId(res.project.id);
          if (c) land(at, c.id);
          toast(th("home.toast.duplicated", { name: p.name, copy: c ? c.name : "" }));
        }),
      )
      .catch(fail("home.error.duplicate", { name: p.name }));
  }
  /* Removes from Recent only; Undo puts the same entry back. */
  function remove(p, at) {
    const list = visible(),
      i = list.indexOf(p),
      next = list[i + 1] || list[i - 1],
      si = stripIndex(p.id);
    api("/api/remove", { id: p.id })
      .then((res) => {
        S.items = S.items.filter((x) => x.id !== p.id);
        render();
        if (at === "strip") land(at, null, si);
        else if (next) select(next.id, { focus: true });
        toast(th("home.toast.removed", { name: p.name }), {
          label: tr("common.undo"),
          act: () =>
            api("/api/recents/restore", { entry: res.entry })
              .then(() => load(() => land(at, p.id)))
              .catch(fail("home.error.undo")),
        });
      })
      .catch(fail("home.error.remove", { name: p.name }));
  }
  function locate(p, at) {
    api("/api/locate", { id: p.id })
      .then((res) => {
        if (res.cancelled) return;
        load(() => {
          const q = res.project && byId(res.project.id);
          if (q) land(at, q.id);
          toast(
            OVI18N.rich(
              "home.toast.relinked",
              { name: p.name, path: res.project ? res.project.path : "" },
              { path: monoWrap },
            ),
          );
        });
      })
      .catch(fail("home.error.relink", { name: p.name }));
  }
  /* Rename edits the name where it was invoked: in the Last Opened card or in the Recent list. Renames the folder. */
  function startRename(p, at) {
    if (p.missing) return;
    S.renaming = p.id;
    S.renameAt = at === "strip" ? "strip" : "list";
    render();
    const inp = main.querySelector("[data-rename]");
    if (inp) {
      inp.focus();
      inp.select();
    }
  }
  let renameBusy = false;
  function commitRename(save) {
    if (!S.renaming || renameBusy) return;
    const p = byId(S.renaming),
      inp = main.querySelector("[data-rename]"),
      at = S.renameAt;
    const next = inp ? inp.value.trim() : "";
    S.renaming = null;
    S.renameAt = "list";
    if (!p || save === false || !next || next === p.name) {
      render();
      if (p) land(at, p.id);
      return;
    }
    renameBusy = true;
    const old = p.name;
    p.name = next;
    render();
    land(at, p.id);
    api("/api/rename", { id: p.id, new_name: next })
      .then(() => load(() => land(at, next)))
      .catch((err) => {
        p.name = old;
        render();
        land(at, p.id);
        toast(th("home.error.rename", { name: old, message: describeError(err) }), null, "error");
      })
      .finally(() => {
        renameBusy = false;
      });
  }
  function trash(p, at) {
    if (prefs.confirmTrash === false) return doTrash(p, at);
    const { sh, close } = sheet(
      "<h3>" +
        th("home.trash.title", { name: p.name }) +
        "</h3><p>" +
        th("home.trash.body") +
        '</p><p class="np-path">' +
        esc(p.dir) +
        "</p><p>" +
        th("home.trash.hint") +
        '</p><div class="sheet-actions"><button class="btn" type="button" data-cancel>' +
        th("common.cancel") +
        '</button><button class="btn btn-danger" type="button" id="trOk">' +
        th("home.item.trash") +
        "</button></div>",
      { role: "alertdialog" },
    );
    sh.querySelector("#trOk").onclick = () => {
      close();
      doTrash(p, at);
    };
    sh.querySelector("[data-cancel]").focus();
  }
  function doTrash(p, at) {
    const list = visible(),
      i = list.indexOf(p),
      next = list[i + 1] || list[i - 1],
      si = stripIndex(p.id);
    api("/api/trash", { id: p.id })
      .then(() => {
        S.items = S.items.filter((x) => x.id !== p.id);
        render();
        if (at === "strip") land(at, null, si);
        else if (next) select(next.id, { focus: true });
        toast(th("home.toast.trashed", { name: p.name }));
      })
      .catch(fail("home.error.trash", { name: p.name }));
  }

  /* ---------- opening: the window stays here until Studio is up, then navigates ---------- */
  let pollTimer = null,
    overlay = null;
  /* `label` is the project's name; without one, `fallback` (a message key) stands in ("project", "last project"). */
  function showOpening(label, fallback) {
    S.opening = true;
    S.openingLabel = label || "";
    S.openingFallback = fallback || "home.opening.project";
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "opening";
      overlay.setAttribute("role", "status");
      win.appendChild(overlay);
    }
    paintOpening();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      api("/api/open-state")
        .then((st) => {
          if (st.phase === "failed") {
            hideOpening();
            toast(
              th("home.error.open", {
                name: st.label || openingName(),
                message: describeError(st) || tr("home.error.unknown"),
              }),
              null,
              "error",
            );
            composer.setBusy(null);
            load();
          } else if (st.phase === "idle") {
            hideOpening();
            composer.setBusy(null);
          }
        })
        .catch(() => clearInterval(pollTimer));
    }, 500);
  }
  const openingName = () => S.openingLabel || tr(S.openingFallback);
  function paintOpening() {
    if (!overlay) return;
    overlay.innerHTML =
      '<div class="opening-card"><i class="spinner"></i><span>' +
      OVI18N.rich(
        "home.opening.text",
        { name: openingName() },
        { name: (inner) => '<span class="name">' + inner + "</span>" },
      ) +
      "</span></div>";
  }
  function hideOpening() {
    clearInterval(pollTimer);
    pollTimer = null;
    S.opening = null;
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }
  /* A project with no clips yet (new, or an empty folder) opens in Media: importing is the first step. */
  function openProject(p, at) {
    if (S.opening) return;
    if (p.missing)
      return toast(
        OVI18N.rich("home.toast.missing", { name: p.name, path: p.path }, { path: monoWrap }),
        { label: tr("home.item.locate"), act: () => locate(p, at) },
      );
    closeMenu(false);
    showOpening(p.name);
    api("/api/open", p.media === 0 ? { id: p.id, workspace: "media" } : { id: p.id }).catch(
      (err) => {
        hideOpening();
        toast(th("home.error.open", { name: p.name, message: describeError(err) }), null, "error");
        load();
      },
    );
  }
  /* The folder name in an error message, emphasised like the prototype's sheet ("… missing in <b>Footage Dump</b>."). */
  function boldName(msg, name) {
    const at = name ? msg.lastIndexOf(name) : -1;
    return at < 0
      ? esc(msg)
      : esc(msg.slice(0, at)) + "<b>" + esc(name) + "</b>" + esc(msg.slice(at + name.length));
  }
  /* Open Project…: the macOS folder picker; a folder that is not a project gets the error sheet. */
  function openPicker() {
    if (S.opening) return;
    closeMenu(false);
    api("/api/pick-open", {})
      .then((res) => {
        if (!res.cancelled) showOpening(null, "home.opening.project");
      })
      .catch((err) => {
        if (!err.data || !err.data.invalid)
          return toast(th("home.error.openFolder", { message: describeError(err) }), null, "error");
        const { sh, close } = sheet(
          "<h3>" +
            th("home.openSheet.title") +
            "</h3><p>" +
            th("home.openSheet.body") +
            "</p>" +
            '<span class="np-err" role="alert">' +
            ic("alert", 12) +
            "<span>" +
            boldName(
              describeError(err),
              String(err.data.path || "")
                .split("/")
                .pop(),
            ) +
            '</span></span><p class="np-path">' +
            esc(err.data.path || "") +
            "</p>" +
            '<div class="sheet-actions"><button class="btn" type="button" data-cancel>' +
            th("common.cancel") +
            '</button><button class="btn btn-primary" type="button" id="opAgain">' +
            th("home.openSheet.again") +
            "</button></div>",
        );
        sh.querySelector("#opAgain").onclick = () => {
          close();
          openPicker();
        };
        sh.querySelector("#opAgain").focus();
      });
  }

  /* ---------- New Project sheet: name, location, aspect + resolution or custom size, fps, duration ---------- */
  const RES = {
    "16:9": [
      ["720p · 1280×720", 1280, 720],
      ["1080p · 1920×1080", 1920, 1080],
      ["4K · 3840×2160", 3840, 2160],
    ],
    "9:16": [
      ["720p · 720×1280", 720, 1280],
      ["1080p · 1080×1920", 1080, 1920],
      ["4K · 2160×3840", 2160, 3840],
    ],
    "1:1": [
      ["720p · 720×720", 720, 720],
      ["1080p · 1080×1080", 1080, 1080],
      ["4K · 2160×2160", 2160, 2160],
    ],
    "4:5": [
      ["864×1080", 864, 1080],
      ["1080×1350", 1080, 1350],
      ["4K · 2160×2700", 2160, 2700],
    ],
  };
  const ASPECTS = [
    ["16:9", "home.new.aspect.landscape"],
    ["9:16", "home.new.aspect.portrait"],
    ["1:1", "home.new.aspect.square"],
    ["4:5", "home.new.aspect.portrait"],
    ["custom", "home.new.aspect.custom"],
  ];
  const badName = (n) =>
    n === "." || n === ".." || /[:/\\]/.test(n) || [...n].some((c) => c.charCodeAt(0) < 0x20);
  const opt = (v, l, on) =>
    '<option value="' + v + '"' + (on ? " selected" : "") + ">" + l + "</option>";
  const np = () =>
    prefs.newProject || {
      location: "~/Movies/OpenVids",
      width: 1920,
      height: 1080,
      fps: 24,
      openIn: "media",
    };
  /* Candidate parents: the default location, Desktop, Documents, parents of recent projects (Rust lists them). */
  function locationMenu(anchor, current, onPick) {
    const r = anchor.getBoundingClientRect();
    api("/api/locations")
      .then((res) => {
        const items = (res.locations || []).map((l) => ({
          label: esc(l.path),
          radio: true,
          checked: l.dir === current.dir || l.path === current.path,
          act: () => onPick({ dir: l.dir, path: l.path }),
        }));
        showMenu(
          items.concat([
            { sep: 1 },
            {
              label: th("home.new.otherFolder"),
              icon: "folder-open",
              act: () =>
                api("/api/pick-parent", {})
                  .then((p) => {
                    if (!p.cancelled) onPick({ dir: p.parent, path: p.path });
                  })
                  .catch(fail("home.error.chooseFolder")),
            },
          ]),
          r.right - 224,
          r.bottom + 4,
          anchor,
          anchor,
        );
      })
      .catch(fail("home.error.listLocations"));
  }
  function newSheet() {
    if (S.opening) return;
    const d = np();
    let loc = { dir: d.location, path: d.location },
      exists = false,
      existsKey = "";
    const match = Object.keys(RES)
      .flatMap((a) => RES[a].map((r, i) => ({ a, i, w: r[1], h: r[2] })))
      .find((x) => x.w === d.width && x.h === d.height);
    const { sh, close } = sheet(
      "<h3>" +
        th("home.new.title") +
        "</h3>" +
        "<label>" +
        th("home.new.name") +
        '<input class="input" id="npName" value="my-video" spellcheck="false" autocomplete="off" aria-describedby="npNameErr" /><span class="np-err" id="npNameErr" role="alert"></span></label>' +
        '<div class="np-f" role="group" aria-labelledby="npLocL"><span id="npLocL">' +
        th("home.new.location") +
        '</span><div class="loc"><div class="path" id="npLoc">' +
        ic("folder", 12) +
        '<span></span></div><button class="btn" type="button" id="npChoose" aria-haspopup="menu" aria-expanded="false">' +
        th("home.new.choose") +
        "</button></div></div>" +
        '<div class="np-row"><label>' +
        th("home.new.aspectRatio") +
        '<select class="sel" id="npAspect">' +
        ASPECTS.map(([v, l]) =>
          opt(v, th(l, { ratio: v }), v === (match ? match.a : "custom")),
        ).join("") +
        "</select></label>" +
        "<label>" +
        th("home.new.resolution") +
        '<select class="sel" id="npRes"></select></label></div>' +
        '<div class="np-row" id="npCustom" hidden><label>' +
        th("home.new.width") +
        '<input class="input" id="npW" type="number" min="1" max="8192" step="1" value="' +
        d.width +
        '" inputmode="numeric" aria-describedby="npSizeErr" /></label>' +
        "<label>" +
        th("home.new.height") +
        '<input class="input" id="npH" type="number" min="1" max="8192" step="1" value="' +
        d.height +
        '" inputmode="numeric" aria-describedby="npSizeErr" /></label><span class="np-err np-span" id="npSizeErr" role="alert"></span></div>' +
        '<div class="np-row"><label>' +
        th("home.new.frameRate") +
        '<select class="sel" id="npFps">' +
        [24, 25, 30, 60]
          .map((v) => opt(v, th("home.new.fps", { fps: String(v) }), v === d.fps))
          .join("") +
        "</select></label>" +
        "<label>" +
        th("home.new.duration") +
        '<input class="input" id="npDur" type="number" min="1" max="3600" step="1" value="10" inputmode="numeric" aria-describedby="npDurErr" /><span class="np-err" id="npDurErr" role="alert"></span></label></div>' +
        '<p class="np-sum" id="npSum" aria-live="polite"></p>' +
        '<div class="sheet-actions"><button class="btn" type="button" data-cancel>' +
        th("common.cancel") +
        '</button><button class="btn btn-primary" type="button" id="npOk">' +
        th("home.new.create") +
        "</button></div>",
    );
    const q = (id) => sh.querySelector("#" + id),
      inp = q("npName");
    const setErr = (id, els, msg) => {
      q(id).innerHTML = msg ? ic("alert", 12) + "<span>" + msg + "</span>" : "";
      els.forEach((el) => el.setAttribute("aria-invalid", msg ? "true" : "false"));
      return !msg;
    };
    const custom = () => q("npAspect").value === "custom";
    function size() {
      if (custom()) return [Number(q("npW").value), Number(q("npH").value)];
      const r = RES[q("npAspect").value][+q("npRes").value];
      return [r[1], r[2]];
    }
    function paintLoc() {
      q("npLoc").title = loc.dir;
      q("npLoc").lastChild.textContent = loc.path;
    }
    function fillRes(first) {
      const on = custom(),
        sel = q("npRes");
      sel.innerHTML = on
        ? "<option>" + th("home.new.customSize") + "</option>"
        : RES[q("npAspect").value].map((r, i) => opt(i, r[0], i === 1)).join("");
      if (!on) sel.value = first && match ? String(match.i) : "1";
      sel.disabled = on;
      q("npCustom").hidden = !on;
      check();
    }
    /* Whether <location>/<name> already has content: asked from Rust, debounced, cached per key. */
    let existsTimer;
    function probeExists(name) {
      const key = loc.dir + "\u0000" + name;
      if (key === existsKey) return;
      clearTimeout(existsTimer);
      existsTimer = setTimeout(
        () =>
          api("/api/name-status", { parent: loc.dir, name })
            .then((r) => {
              existsKey = key;
              exists = !!r.exists;
              check();
            })
            .catch(() => {}),
        120,
      );
    }
    function check() {
      const name = inp.value.trim(),
        [w, h] = size(),
        dur = Number(q("npDur").value),
        px = (v) => Number.isInteger(v) && v >= 1 && v <= 8192;
      if (name && !badName(name)) probeExists(name);
      const key = loc.dir + "\u0000" + name,
        taken = key === existsKey && exists;
      const okName = setErr(
        "npNameErr",
        [inp],
        !name
          ? th("home.new.error.name")
          : badName(name)
            ? th("home.new.error.badName")
            : taken
              ? th("home.new.error.exists", { name, path: loc.path })
              : "",
      );
      const okSize =
        !custom() ||
        setErr("npSizeErr", [q("npW"), q("npH")], px(w) && px(h) ? "" : th("home.new.error.size"));
      if (!custom()) setErr("npSizeErr", [q("npW"), q("npH")], "");
      const okDur = setErr(
        "npDurErr",
        [q("npDur")],
        Number.isFinite(dur) && dur >= 1 && dur <= 3600 ? "" : th("home.new.error.duration"),
      );
      q("npSum").innerHTML =
        "<span>" +
        esc(loc.path.replace(/\/$/, "") + "/" + (name || "…")) +
        "</span><span>" +
        th("home.new.summary", {
          size: okSize ? w + "×" + h : "—",
          fps: q("npFps").value,
          duration: okDur ? String(dur) : "—",
        }) +
        "</span>";
      return okName && okSize && okDur;
    }
    let busy = false;
    function go() {
      if (busy) return;
      if (!check()) {
        const bad = sh.querySelector('[aria-invalid="true"]');
        if (bad) bad.focus();
        return;
      }
      const name = inp.value.trim(),
        [w, h] = size();
      busy = true;
      q("npOk").disabled = true;
      sh.classList.add("is-busy");
      api("/api/create", {
        parent: loc.dir,
        name,
        fps: q("npFps").value,
        width: w,
        height: h,
        duration: Number(q("npDur").value),
        workspace: np().openIn,
      })
        .then(() => {
          close();
          clearSearch(false);
          showOpening(name);
        })
        .catch((err) => {
          busy = false;
          q("npOk").disabled = false;
          sh.classList.remove("is-busy");
          setErr("npNameErr", [inp], esc(describeError(err)));
          inp.focus();
        });
    }
    const choose = q("npChoose");
    choose.onclick = () =>
      locationMenu(choose, loc, (l) => {
        loc = l;
        paintLoc();
        check();
      });
    q("npAspect").addEventListener("change", () => fillRes(false));
    sh.addEventListener("input", check);
    sh.addEventListener("change", check);
    sh.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input")) {
        e.preventDefault();
        go();
      }
    });
    q("npOk").onclick = go;
    paintLoc();
    fillRes(true);
    inp.focus();
    inp.select();
    /* Show the default location as ~/… and resolve it to a real path for the request. */
    api("/api/locations")
      .then((res) => {
        if (res.default && loc.dir === d.location) {
          loc = { dir: res.default, path: d.location };
          existsKey = "";
          paintLoc();
          check();
        }
      })
      .catch(() => {});
  }

  /* ---------- Settings window: framed over the page (a separate window in the prototype's native shell) ---------- */
  let settingsFrame = null,
    settingsReturn = null;
  function openSettings(trigger, section) {
    if (settingsFrame) {
      settingsFrame.contentWindow.focus();
      return;
    }
    closeMenu(false);
    settingsReturn = trigger || document.activeElement;
    const f = document.createElement("iframe");
    f.className = "ov-settings-frame";
    f.title = tr("home.settings.title");
    f.src =
      "/settings?embed=1&theme=" +
      encodeURIComponent(OV.themePref()) +
      "&density=" +
      encodeURIComponent(OV.densityPref()) +
      "&language=" +
      encodeURIComponent(OVI18N.preference()) +
      (section ? "&section=" + section : "");
    /* Hidden until its document has loaded: a frame whose page has no styles yet paints an opaque white
       canvas over the dark window (its colour scheme differs from ours), which flashed on every open. */
    f.style.visibility = "hidden";
    f.addEventListener("load", () => {
      f.style.visibility = "";
      f.contentWindow.focus();
    });
    document.body.appendChild(f);
    settingsFrame = f;
    $("#settingsBtn").setAttribute("aria-expanded", "true");
  }
  function closeSettings() {
    if (!settingsFrame) return;
    settingsFrame.remove();
    settingsFrame = null;
    $("#settingsBtn").setAttribute("aria-expanded", "false");
    if (settingsReturn && settingsReturn.focus) settingsReturn.focus();
    settingsReturn = null;
    loadUpdateBadge();
  }
  window.addEventListener("message", (e) => {
    if (!settingsFrame || e.source !== settingsFrame.contentWindow || !e.data) return;
    if (e.data.type === "ov-settings-close") closeSettings();
    else if (e.data.type === "ov-theme") OV.applyTheme(e.data.pref);
    else if (e.data.type === "ov-language") OVI18N.setLanguage(e.data.pref);
    else if (e.data.type === "ov-density") OV.applyDensity(e.data.pref);
    else if (e.data.type === "ov-prefs") applyPrefs(e.data.prefs);
    else if (e.data.type === "ov-agents") composer.reloadAgents();
  });
  /* New preferences (from Settings or the onboarding): theme, density and the start composer's folder follow. */
  function applyPrefs(next) {
    prefs = next || prefs;
    OV.applyTheme(prefs.theme);
    OV.applyDensity(prefs.density);
    if (prefs.language && prefs.language !== OVI18N.preference())
      OVI18N.setLanguage(prefs.language);
    if (!composer.isBusy()) {
      start.loc = null;
      initStartLocation();
    }
  }
  $("#settingsBtn").addEventListener("click", () =>
    openSettings($("#settingsBtn"), settingsSection()),
  );
  /* Report a problem: a window of its own (the shell opens or focuses it), so the page stays usable beside it. */
  $("#reportBtn").addEventListener("click", () =>
    api("/api/report/open", { context: "projects" }).catch(fail("home.error.reportOpen")),
  );

  /* ---------- events ---------- */
  /* Shortcuts shared by a Recent item and a Last Opened card; `at` says where focus lands afterwards. */
  function itemKey(e, p, at, el) {
    const mod = e.metaKey || e.ctrlKey,
      k = e.key.toLowerCase();
    if (e.key === "Enter" && !e.target.closest("button")) openProject(p, at);
    else if (e.key === "F2" && !p.missing) startRename(p, at);
    else if ((mod && e.key === "Backspace") || e.key === "Delete") remove(p, at);
    else if (mod && k === "d" && !p.missing) duplicate(p, at);
    else if (mod && e.shiftKey && k === "r" && !p.missing) reveal(p);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = el.getBoundingClientRect();
      (at === "strip" ? stripMenu : menuFor)(p, r.left + 24, r.top + 48);
    } else return false;
    e.preventDefault();
    return true;
  }

  /* Inline rename lives in either section: commit on any click elsewhere in #main (capture, before the click acts). */
  let skipOpen = null;
  main.addEventListener(
    "click",
    (e) => {
      skipOpen = null;
      if (S.renaming && !e.target.closest("[data-rename]")) {
        if (S.renameAt === "strip") skipOpen = S.renaming;
        commitRename();
      }
    },
    true,
  );
  main.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-rename]")) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        commitRename(false);
      }
      e.stopPropagation();
    }
  });
  main.addEventListener("focusout", (e) => {
    if (e.target.matches && e.target.matches("[data-rename]")) setTimeout(() => commitRename(), 0);
  });

  body.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "clear") clearSearch(true);
      return;
    }
    const hs = e.target.closest("[data-sort]");
    if (hs) {
      S.sort = hs.dataset.sort;
      render();
      return;
    }
    const it = e.target.closest("[data-item]");
    if (!it || e.target.closest("[data-rename]")) return;
    const p = byId(it.dataset.id),
      more = e.target.closest("[data-more]");
    if (more) {
      const r = more.getBoundingClientRect();
      menuFor(p, r.left, r.bottom + 4, more);
      return;
    }
    if (e.target.closest("[data-locate]")) return locate(p);
    select(p.id, { focus: true });
  });
  body.addEventListener("dblclick", (e) => {
    const it = e.target.closest("[data-item]");
    if (it && !e.target.closest("[data-more],[data-locate],[data-rename]"))
      openProject(byId(it.dataset.id));
  });
  body.addEventListener("contextmenu", (e) => {
    const it = e.target.closest("[data-item]");
    if (!it) return;
    e.preventDefault();
    menuFor(byId(it.dataset.id), e.clientX, e.clientY);
  });

  /* Last Opened: single click / Enter opens; ⋯ and right-click open the item menu; ←/→ Home/End rove inside the strip. */
  strip.addEventListener("click", (e) => {
    const el = e.target.closest("[data-lo]");
    if (!el || e.target.closest("[data-rename]")) return;
    const p = byId(el.dataset.id),
      skip = skipOpen;
    skipOpen = null;
    if (!p) return;
    const more = e.target.closest("[data-more]");
    if (more) {
      const r = more.getBoundingClientRect();
      stripMenu(p, r.left, r.bottom + 4, more);
      return;
    }
    if (e.target.closest("[data-locate]")) return locate(p, "strip");
    if (skip !== p.id) openProject(p, "strip");
  });
  strip.addEventListener("contextmenu", (e) => {
    const el = e.target.closest("[data-lo]");
    if (!el || e.target.closest("[data-rename]")) return;
    e.preventDefault();
    stripMenu(byId(el.dataset.id), e.clientX, e.clientY);
  });
  strip.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-lo]");
    if (!el) return;
    S.loFocus = el.dataset.id;
    strip.querySelectorAll("[data-lo]").forEach((c) => {
      c.tabIndex = c === el ? 0 : -1;
    });
  });
  strip.addEventListener("keydown", (e) => {
    const el = e.target.closest("[data-lo]");
    if (!el || e.target.matches("[data-rename]")) return;
    const cards = stripCards(),
      i = cards.indexOf(el),
      nav = {
        ArrowRight: cards[i + 1],
        ArrowLeft: cards[i - 1],
        Home: cards[0],
        End: cards[cards.length - 1],
      };
    if (e.key in nav) {
      e.preventDefault();
      e.stopPropagation();
      if (nav[e.key]) focusStrip(nav[e.key].dataset.id);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
      return;
    }
    if (itemKey(e, byId(el.dataset.id), "strip", el)) e.stopPropagation();
  });
  const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  $("#showAll").onclick = () => {
    const r = recentSect.getBoundingClientRect(),
      m = main.getBoundingClientRect();
    main.scrollTo({ top: main.scrollTop + r.top - m.top, behavior: motion() });
    const el = body.querySelector('[data-item][tabindex="0"]');
    if (el) el.focus({ preventScroll: true });
  };

  const search = $("#search"),
    field = $("#field");
  /* While searching, only Recent results show: Last Opened and Start hide (the composer keeps its draft). */
  search.addEventListener("input", () => {
    S.q = search.value;
    field.classList.toggle("has-value", !!search.value);
    render();
    if (S.q.trim()) main.scrollTo({ top: 0 });
  });
  function clearSearch(focus) {
    search.value = "";
    S.q = "";
    field.classList.remove("has-value");
    render();
    if (focus) search.focus();
  }
  $("#clearSearch").onclick = () => clearSearch(true);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (search.value) clearSearch(true);
      else search.blur();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const f = body.querySelector("[data-item]");
      if (f) select(f.dataset.id, { focus: true });
    }
  });
  /* Double-clicking the titlebar zooms the window; without this WebKit also word-selects into the search field. */
  $(".titlebar").addEventListener("mousedown", (e) => {
    if (
      e.detail > 1 &&
      e.target.closest("[data-tauri-drag-region]") &&
      !e.target.closest("input, button")
    )
      e.preventDefault();
  });
  const setView = (v) => {
    S.view = v;
    store.set("ov-view", v);
    render();
    if (S.sel) {
      const el = itemEl(S.sel);
      if (el) el.tabIndex = 0;
    }
  };
  $("#viewGrid").onclick = () => setView("grid");
  $("#viewList").onclick = () => setView("list");
  $("#newBtn").onclick = newSheet;
  $("#openBtn").onclick = openPicker;
  $("#sortBtn").onclick = () => {
    const b = $("#sortBtn"),
      r = b.getBoundingClientRect();
    showMenu(
      Object.keys(SORTS).map((k) => ({
        label: SORTS[k],
        radio: true,
        checked: S.sort === k,
        act: () => {
          S.sort = k;
          render();
        },
      })),
      r.right - 224,
      r.bottom + 4,
      b,
      b,
    );
  };

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey,
      k = e.key.toLowerCase();
    if (mod && e.key === ",") {
      e.preventDefault();
      return openSettings($("#settingsBtn"), settingsSection());
    }
    if (
      settingsFrame ||
      S.opening ||
      e.target.closest(".menu, .sheet, .ov-chat, textarea, [contenteditable]")
    )
      return;
    if (mod && k === "n") {
      e.preventDefault();
      return newSheet();
    }
    if (mod && k === "o") {
      e.preventDefault();
      return openPicker();
    }
    if (mod && k === "f") {
      e.preventDefault();
      if (!search.disabled) {
        search.focus();
        search.select();
      }
      return;
    }
    if (mod && (k === "1" || k === "2")) {
      e.preventDefault();
      return setView(k === "1" ? "grid" : "list");
    }
    if (e.target.matches("input") || e.target.closest("#lastOpened")) return;
    const p = S.sel && byId(S.sel);
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      return move(e.key.slice(5).toLowerCase());
    }
    if (p) itemKey(e, p, "list", itemEl(p.id));
  });

  /* ---------- Start: prompt + files → a new project that opens in Media with the conversation running ---------- */
  const FORMATS = [
    ["16:9", "home.start.format.landscape", 1920, 1080],
    ["9:16", "home.start.format.portrait", 1080, 1920],
    ["1:1", "home.start.format.square", 1080, 1080],
    ["4:5", "home.start.format.portrait", 1080, 1350],
  ];
  const AUTO_FORMAT = "auto";
  const ratioOf = (w, h) => {
    const g = (a, b) => (b ? g(b, a % b) : a);
    const d = g(w, h);
    return w / d + ":" + h / d;
  };
  /* "Auto" is first and the default: the agent picks the format from the brief and the footage; the preferred size
     is only the canvas the project starts from. Further down, the preferred size takes its aspect's slot (e.g. 4K
     16:9), so the other defaults follow Settings. */
  function formats() {
    const d = np(),
      ratio = ratioOf(d.width, d.height);
    return [
      [AUTO_FORMAT, "home.start.format.auto", d.width, d.height],
      ...FORMATS.map((f) => (f[0] === ratio ? [f[0], f[1], d.width, d.height] : f)),
    ];
  }
  const start = { loc: null, fmt: null, busy: false };
  function initStartLocation() {
    start.loc = { dir: np().location, path: np().location };
    start.fmt = formats()[0];
    paintAspect();
    refreshFoot();
  }

  const aspectBtn = document.createElement("button");
  aspectBtn.type = "button";
  aspectBtn.className = "tool-btn ov-chat-chip start-aspect";
  aspectBtn.setAttribute("aria-haspopup", "menu");
  aspectBtn.setAttribute("aria-expanded", "false");
  function paintAspect() {
    if (!start.fmt) return;
    const [r, l, w, h] = start.fmt,
      fps = np().fps,
      auto = r === AUTO_FORMAT,
      size = w + "×" + h;
    aspectBtn.innerHTML =
      ic("aspect") +
      '<span class="ov-chat-chip-label">' +
      (auto ? tr(l) : r) +
      "</span>" +
      ic("chevron-down").replace('class="ic"', 'class="ic ov-chat-chip-caret"');
    aspectBtn.dataset.tip = auto
      ? tr("home.start.aspect.auto.tip", { size, fps: String(fps) })
      : tr("home.start.aspect.tip", { size, fps: String(fps) });
    aspectBtn.setAttribute(
      "aria-label",
      auto
        ? tr("home.start.aspect.auto.aria", { size, fps: String(fps) })
        : tr("home.start.aspect.aria", { ratio: r, name: tr(l), size, fps: String(fps) }),
    );
  }
  aspectBtn.addEventListener("click", () => {
    if (start.busy || aspectBtn.disabled) return;
    const r = aspectBtn.getBoundingClientRect();
    showMenu(
      formats().map((f) => ({
        label:
          f[0] === AUTO_FORMAT
            ? th("home.start.format.auto.item", { size: f[2] + "×" + f[3] })
            : th("home.start.format.item", {
                ratio: f[0],
                name: tr(f[1]),
                size: f[2] + "×" + f[3],
              }),
        radio: true,
        checked: f[0] === start.fmt[0],
        act: () => {
          start.fmt = f;
          paintAspect();
        },
      })),
      r.left,
      r.bottom + 4,
      aspectBtn,
      aspectBtn,
    );
  });

  const foot = document.createElement("div");
  foot.className = "start-foot";
  foot.innerHTML =
    ic("folder") +
    '<span></span><span class="start-path"></span><span class="start-note" hidden></span>' +
    '<button class="link" type="button" aria-haspopup="menu" aria-expanded="false"></button><span class="start-files" hidden></span>';
  const locBtn = foot.querySelector(".link"),
    pathEl = foot.querySelector(".start-path"),
    noteEl = foot.querySelector(".start-note"),
    filesEl = foot.querySelector(".start-files");
  const footLabel = foot.querySelector("span");
  function paintFoot() {
    footLabel.textContent = tr("home.start.foot.label");
    locBtn.textContent = tr("home.start.foot.change");
  }
  paintFoot();
  locBtn.onclick = () => {
    if (!start.busy)
      locationMenu(locBtn, start.loc, (l) => {
        start.loc = l;
        refreshFoot();
      });
  };

  /* The footer follows the composer: with a prompt the model names the project, so only the location and that fact
     are shown; a files-only start keeps the folder Rust would create (derived + made unique). */
  let composer = null,
    footTimer = null,
    footSeq = 0;
  function refreshFoot(st) {
    if (!composer || start.busy || !start.loc) return;
    st = st || composer.getState();
    const files = st.files || [];
    filesEl.hidden = !files.length;
    filesEl.textContent = files.length
      ? tr("home.start.files", {
          count: files.length,
          size: formatBytes(files.reduce((s, f) => s + (f.size || 0), 0)),
        })
      : "";
    clearTimeout(footTimer);
    const seq = ++footSeq;
    const prompt = (st.prompt || "").trim();
    noteEl.hidden = !prompt;
    noteEl.textContent = prompt ? tr("home.start.foot.naming") : "";
    if (prompt) {
      const where = start.loc.path.replace(/\/+$/, "");
      pathEl.textContent = where + "/…";
      pathEl.title = tr("home.start.foot.naming.tip", { location: start.loc.path });
      return;
    }
    footTimer = setTimeout(
      () =>
        api("/api/start/name", {
          prompt: st.prompt,
          files: files.map((f) => f.name),
          location: start.loc.dir,
        })
          .then((res) => {
            if (seq !== footSeq || start.busy) return;
            pathEl.textContent = res.path;
            pathEl.title = res.dir;
          })
          .catch(() => {}),
      120,
    );
  }
  /* The model names the project from the prompt (the composer's chosen model, in the UI language) while Start shows
     busy; a failure, timeout or empty answer falls back to the Rust derivation the footer previews. */
  function askProjectName(payload) {
    const prompt = (payload.prompt || "").trim();
    if (!prompt) return Promise.resolve(null);
    const files = (composer.getState().files || []).map((f) => f.name);
    const ask = api("/api/agent/project-title", {
      prompt,
      files,
      model: payload.model || null,
      language: OVI18N.language() || null,
    })
      .then((res) => (res && typeof res.title === "string" && res.title ? res.title : null))
      .catch(() => null);
    // The runtime gives up after 8 s; this covers a wedged proxy or a lost answer.
    return Promise.race([ask, new Promise((resolve) => setTimeout(() => resolve(null), 11000))]);
  }
  function startProject(payload) {
    if (start.busy) return;
    start.busy = true;
    const prompt = (payload.prompt || "").trim();
    composer.setBusy(prompt ? "home.start.naming" : "home.start.creating");
    askProjectName(payload)
      .then((name) => {
        composer.setBusy("home.start.creating");
        return api(
          "/api/start",
          Object.assign({}, payload, {
            name: name || null,
            width: start.fmt[2],
            height: start.fmt[3],
            ...(start.fmt[0] === AUTO_FORMAT && { format: AUTO_FORMAT }),
            location: start.loc.dir,
          }),
        );
      })
      .then((res) => {
        pathEl.textContent = res.path;
        showOpening(res.name);
      })
      .catch((err) => {
        start.busy = false;
        composer.setBusy(null);
        toast(th("home.error.create", { message: describeError(err) }), null, "error");
      });
  }
  composer = OVComposer.mount(chatHost, {
    placeholder: "home.start.placeholder",
    suggestions: [
      "home.start.suggestion.highlights",
      "home.start.suggestion.captions",
      "home.start.suggestion.teaser",
    ],
    footer: foot,
    controls: [aspectBtn],
    onChange: refreshFoot,
    onSubmit: startProject,
    onAgentDefaults: (btn) => openSettings(btn, "agents"),
    onConnectModel: (btn) => openSettings(btn, "providers"),
  });
  const busyComposer = composer.setBusy;
  composer.setBusy = (text) => {
    if (!text) start.busy = false;
    busyComposer(text);
  };

  /* Files dragged anywhere over the window light up the composer; a drop anywhere in #main adds them. The
     composer handles drops on itself; the webview never navigates to a dropped file. */
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  const inMain = (e) => !!(e.target && e.target.closest && e.target.closest("#main"));
  function revealComposer() {
    const r = chatHost.getBoundingClientRect(),
      m = main.getBoundingClientRect();
    if (r.top >= m.top && r.bottom <= m.bottom) return;
    main.scrollTo({ top: Math.max(0, main.scrollTop + r.top - m.top - 48), behavior: motion() });
  }
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ || start.busy || S.opening) return;
    if (S.q) clearSearch(false);
    revealComposer();
    composer.setDropActive(true);
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = !start.busy && inMain(e) ? "copy" : "none";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e) || --dragDepth > 0) return;
    dragDepth = 0;
    composer.setDropActive(false);
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    const taken = e.defaultPrevented || !!(e.target.closest && e.target.closest(".ov-chat"));
    e.preventDefault();
    dragDepth = 0;
    composer.setDropActive(false);
    if (!taken && !start.busy && inMain(e))
      composer.dropNames([...e.dataTransfer.files].map((f) => f.name));
  });

  /* ---------- init ---------- */
  initStartLocation();
  render();
  load();
  /* The catalog finished loading, or the language changed: redraw everything built from script (static markup is
     re-applied by OVI18N). */
  window.addEventListener("ov-language", () => {
    paintChrome();
    paintAspect();
    paintFoot();
    refreshFoot();
    composer.relocalize();
    paintOpening();
    if (settingsFrame) settingsFrame.title = tr("home.settings.title");
    render();
  });
  /* Opening at launch (Reopen last project / a project named on the command line): show it until Studio is up. */
  api("/api/open-state")
    .then((st) => {
      if (st.phase === "opening") showOpening(st.label, "home.opening.lastProject");
      else if (st.phase === "failed")
        toast(
          th("home.error.open", {
            name: st.label,
            message: describeError(st) || tr("home.error.unknown"),
          }),
          null,
          "error",
        );
    })
    .catch(() => {});
  /* ---------- First-run onboarding (onboarding*.js, loaded when it opens; the overlay markup is in index.html) ---------- */
  const OB_SCRIPTS = [
    "settings-core",
    "settings-providers",
    "settings-signin",
    "onboarding",
    "onboarding-welcome",
    "onboarding-appearance",
    "onboarding-models",
    "onboarding-system",
    "onboarding-project",
  ];
  const loadScript = (name) =>
    new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "/assets/" + name + ".js";
      el.onload = resolve;
      el.onerror = () => reject(new Error(tr("home.error.scriptLoad", { name })));
      document.head.appendChild(el);
    });
  let obLoad = null,
    obReturn = null;
  const onboardingOpen = () =>
    document.documentElement.classList.contains("is-onboarding") ||
    !!(window.OVOB && window.OVOB.isOpen());
  function lockPage(on) {
    for (const el of win.children)
      if (el.id !== "ob" && el.id !== "launch" && el.tagName !== "SCRIPT") el.inert = on;
  }
  function openOnboarding(manual) {
    if (window.OVOB && window.OVOB.isOpen()) return Promise.resolve();
    if (settingsFrame) closeSettings();
    closeMenu(false);
    obReturn = document.activeElement;
    document.documentElement.classList.add("is-onboarding");
    lockPage(true);
    obLoad =
      obLoad ||
      OB_SCRIPTS.reduce((p, name) => p.then(() => loadScript(name)), Promise.resolve()).catch(
        (err) => {
          obLoad = null;
          throw err;
        },
      );
    return obLoad
      .then(() =>
        window.OVOB.open({
          manual,
          host: {
            prefs: () => prefs,
            setPrefs: applyPrefs,
            reloadAgents: () => composer.reloadAgents(),
            closed(finished) {
              if (finished || !obReturn || !obReturn.isConnected) composer.focus();
              else obReturn.focus();
              obReturn = null;
            },
          },
        }),
      )
      .catch((err) => {
        /* The setup can't be shown: don't trap the user behind a blank overlay. */
        document.documentElement.classList.remove("is-onboarding");
        lockPage(false);
        toast(th("home.error.setup", { message: describeError(err) }), null, "error");
      });
  }
  /* Decided by index.html before first paint: unfinished setup, or Help › Welcome asked for it. */
  if (document.documentElement.classList.contains("is-onboarding"))
    openOnboarding(!!(window.OV_BOOT && window.OV_BOOT.openOnboarding));

  /* ⌘O from the app menu lands here (the menu accelerator consumes the key). */
  window.ovHome = {
    openProject: () => !onboardingOpen() && openPicker(),
    newProject: () => !onboardingOpen() && newSheet(),
    openSettings: () => !onboardingOpen() && openSettings($("#settingsBtn"), settingsSection()),
    /* App menu › Check for Updates…: the General section shows the result (the check itself runs in Rust). */
    checkForUpdates: () => {
      if (onboardingOpen()) return;
      if (settingsFrame) {
        settingsFrame.contentWindow.postMessage(
          { type: "ov-settings-go", section: "general" },
          location.origin,
        );
        settingsFrame.contentWindow.focus();
      } else openSettings($("#settingsBtn"), "general");
    },
    openOnboarding: () => openOnboarding(true),
  };
})();
