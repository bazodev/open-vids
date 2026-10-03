/* Settings window — the prototype's openvids-settings.html. This file wires the events and boots; the shell,
   helpers and shared data are in settings-core.js and each section in settings-<section>.js. Framed over the
   Projects page; posts ov-theme / ov-density / ov-prefs / ov-agents / ov-settings-close to it. */
(function () {
  "use strict";
  const { ic, nav, main, SECTIONS } = OVS;

  /* ---------- navigation ---------- */
  nav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-section]");
    if (b) OVS.go(b.dataset.section);
  });
  nav.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = SECTIONS.findIndex((s) => s.id === OVS.section()),
      n = SECTIONS[(i + (e.key === "ArrowDown" ? 1 : SECTIONS.length - 1)) % SECTIONS.length].id;
    OVS.go(n);
    nav.querySelector(`[data-section="${n}"]`).focus();
  });

  /* ---------- actions: handlers registered by the sections ---------- */
  OVS.wire(main);

  /* Framed over Projects: the close button, Esc, ⌘W and a click outside return to it. */
  document.documentElement.classList.add("st-embed");
  const close = () => OVS.post({ type: "ov-settings-close" });
  const closeBtn = document.querySelector("button.tl.close");
  closeBtn.innerHTML = ic("x");
  closeBtn.onclick = close;
  OV.applyCaptionFrame(document);
  document.body.addEventListener("mousedown", (e) => {
    if (e.target === document.body) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    } else if ((e.metaKey || e.ctrlKey) && (OV.matchesKey(e, "w") || OV.matchesKey(e, ","))) {
      e.preventDefault();
      close();
    }
  });
  /* The Projects page switches the section (menu › Check for Updates… while Settings is already open). */
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const m = e.data;
    if (m && m.type === "ov-settings-go" && SECTIONS.some((s) => s.id === m.section))
      OVS.go(m.section);
  });

  /* ---------- boot: draw what is known, then load every data source (each shows its own loading, error and retry) ---------- */
  OVS.render(false);
  OVS.enter(OVS.section());
  OVS.loadPrefs();
  OVS.loadProviders();
  OVS.loadAgents().then(() => OVS.enter(OVS.section()));
})();
