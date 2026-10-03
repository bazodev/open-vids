/* First-run onboarding — the shell: five skippable steps (Welcome, Language & theme, Model, System, Project), a step indicator,
   Back / Continue, "Skip setup", focus per step, and the page underneath made inert. The steps live in
   onboarding-<step>.js and register on window.OVOB.steps; the Models step reuses the Models & Providers
   modules (settings-core / -providers / -signin) mounted into the overlay with OVS.useHost.
   Loaded on demand by home.js (see openOnboarding there); nothing here runs on a machine that finished setup. */
(function () {
  "use strict";
  const { ic, esc, api, PAGES, CLICK, tr } = OVS;
  const root = document.documentElement;
  const overlay = document.getElementById("ob");
  const hostEl = document.getElementById("obMain");
  const STEP_KEY = "ov-onboarding-step";
  const ORDER = ["welcome", "appearance", "models", "system", "project"];

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
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* unavailable */
      }
    },
  };

  /* step: the current one · history: where Back goes · seen: steps the user has been on · completed: setup was
     finished before (a reopened one) · host: what home.js lends (prefs, composer, …). */
  const OB = {
    step: "welcome",
    history: [],
    seen: {},
    open: false,
    completed: false,
    manual: false,
    busy: false,
    fresh: false,
    note: "",
    host: null,
  };
  const steps = {};

  /* The title is the step's focus target: screen readers announce it when the step changes. text and lede are
     translated by the caller. */
  const title = (text, lede) =>
    `<h1 id="obTitle" data-fk="ob-title" tabindex="-1">${esc(text)}</h1>${
      lede ? `<p class="st-lede">${esc(lede)}</p>` : ""
    }`;

  /* ---------- step order: satisfied steps are skipped going forward ("two clicks" on a set-up machine) ---------- */
  function nextStep(from) {
    let i = ORDER.indexOf(from) + 1;
    while (i < ORDER.length - 1 && steps[ORDER[i]].skipWhenDone && steps[ORDER[i]].done() === true)
      i++;
    return ORDER[Math.min(i, ORDER.length - 1)];
  }
  function show(id, back) {
    const prev = steps[OB.step];
    if (prev && prev.leave) prev.leave();
    if (!back && OB.step !== id) OB.history.push(OB.step);
    OB.step = id;
    OB.fresh = true;
    OB.seen[id] = true;
    OB.note = "";
    if (!OB.completed) store.set(STEP_KEY, id);
    if (steps[id].enter) steps[id].enter();
    OVS.ui.pendingFk = "ob-title";
    OVS.render(false);
    hostEl.scrollTop = 0;
  }

  /* ---------- drawing ---------- */
  const mark =
    '<svg class="ob-mark" viewBox="0 0 45 45" role="img" aria-label="OpenVids"><circle cx="22.5" cy="22.5" r="19.3" fill="none" stroke="currentColor" stroke-width="6.2"/><circle cx="22.5" cy="22.5" r="6.5" fill="currentColor"/></svg>';
  function stepNav() {
    return `<nav class="ob-steps" aria-label="${esc(tr("onboarding.steps.aria"))}"><ol>${ORDER.map(
      (id, i) => {
        const s = steps[id];
        const cur = id === OB.step;
        const done = !cur && s.done() === true;
        return `<li><button type="button" class="ob-step${cur ? " is-current" : ""}${done ? " is-done" : ""}" data-act="ob-goto" data-v="${id}" data-fk="ob-step:${id}"${
          cur ? ' aria-current="step"' : ""
        }><span class="ob-num">${done ? ic("check") : i + 1}</span>${esc(tr(s.label))}${
          done ? `<span class="sr-only"> ${esc(tr("onboarding.step.done"))}</span>` : ""
        }</button></li>`;
      },
    ).join("")}</ol></nav>`;
  }
  PAGES.onboarding = function () {
    const id = OB.step,
      s = steps[id],
      i = ORDER.indexOf(id);
    const p = s.primary();
    /* The fade is for a new step, not for each redraw of the same one. */
    const animate = OB.fresh;
    OB.fresh = false;
    return (
      `<div class="ob-page${animate ? " is-enter" : ""}"><header class="ob-head">${stepNav()}</header>` +
      `<div class="ob-scroll"><div class="ob-col" role="group" aria-labelledby="obTitle">${s.view()}${OVS.noteHtml(OB.note)}</div></div>` +
      `<footer class="ob-foot"><div class="ob-foot-in"><button type="button" class="link" data-act="ob-skip" data-fk="ob-skip"${
        OB.busy ? " disabled" : ""
      }>${esc(tr(OB.completed ? "common.close" : "onboarding.skip"))}</button><span class="push"></span>${
        i > 0
          ? `<button type="button" class="btn" data-act="ob-back" data-fk="ob-back">${esc(tr("common.back"))}</button>`
          : ""
      }<button type="button" class="btn${p.kind === "primary" ? " btn-primary" : ""}" data-act="ob-next" data-fk="ob-primary"${
        OB.busy || p.disabled ? " disabled" : ""
      }>${esc(tr(p.label))}</button></div></footer></div>`
    );
  };

  /* ---------- leaving: Finish and Skip both complete the setup; closing the window mid-way does not ---------- */
  function complete() {
    if (OB.busy) return;
    if (OB.completed) return close(false);
    OB.busy = true;
    OB.note = "";
    OVS.render(true);
    api("/api/preferences", { onboarding: { completedAt: Date.now() } }, "PUT")
      .then((next) => {
        OB.host.setPrefs(next);
        store.set(STEP_KEY, null);
        OB.busy = false;
        close(true);
      })
      .catch((err) => {
        OB.busy = false;
        OB.note = OVS.failMsg("onboarding.note.finishFailed", { message: OV.describeError(err) });
        OVS.render(true);
      });
  }
  function lock(on) {
    const win = document.getElementById("win");
    for (const el of win.children) {
      if (el === overlay || el.id === "launch" || el.tagName === "SCRIPT") continue;
      // The custom frame's window buttons stay usable under the lock.
      if (el.classList.contains("titlebar")) {
        for (const part of el.children) if (part.id !== "winControls") part.inert = on;
        continue;
      }
      el.inert = on;
    }
  }
  function close(finished) {
    if (!OB.open) return;
    const cur = steps[OB.step];
    if (cur && cur.leave) cur.leave();
    Object.keys(steps).forEach((id) => steps[id].stop && steps[id].stop());
    OB.open = false;
    root.classList.remove("is-onboarding");
    lock(false);
    overlay.dispatchEvent(new Event("ob-closed"));
    OB.host.closed(finished);
  }
  /* While the launch splash plays, the setup under it can't be reached by keyboard either. */
  function holdForSplash() {
    if (!root.classList.contains("is-launching")) return;
    overlay.inert = true;
    document.addEventListener(
      "ov-launch-done",
      () => {
        overlay.inert = false;
      },
      { once: true },
    );
  }
  function focusStart() {
    const go = () => {
      if (!OB.open) return;
      const t = hostEl.querySelector('[data-fk="ob-title"]');
      if (t) t.focus({ preventScroll: true });
    };
    if (root.classList.contains("is-launching"))
      document.addEventListener("ov-launch-done", go, { once: true });
    else go();
  }

  /* ---------- keys: Enter is the primary action, Esc only closes a setup that was already finished ---------- */
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      if (OV.matchesKey(e, "w") || OV.matchesKey(e, ",")) e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (OB.completed && !e.defaultPrevented) close(false);
    } else if (
      e.key === "Enter" &&
      !e.isComposing &&
      !e.defaultPrevented &&
      !e.target.closest("input, textarea, select, button, a, [role=switch]")
    ) {
      const b = hostEl.querySelector('[data-fk="ob-primary"]');
      if (b && !b.disabled) {
        e.preventDefault();
        b.click();
      }
    }
  });

  CLICK["ob-next"] = () => {
    if (OB.step === "project") return complete();
    show(nextStep(OB.step));
    return false;
  };
  CLICK["ob-back"] = () => {
    const prev = OB.history.pop() || ORDER[ORDER.indexOf(OB.step) - 1];
    if (prev) show(prev, true);
    return false;
  };
  CLICK["ob-goto"] = (t) => {
    if (t.dataset.v !== OB.step) show(t.dataset.v);
    return false;
  };
  CLICK["ob-skip"] = () => {
    complete();
    return false;
  };

  /* ---------- opening ---------- */
  let wired = false;
  function open(o) {
    if (OB.open) {
      focusStart();
      return;
    }
    OB.host = o.host;
    OB.manual = !!o.manual;
    const prefs = OB.host.prefs();
    OB.completed = !!(prefs.onboarding && prefs.onboarding.completedAt);
    const saved = store.get(STEP_KEY);
    OB.history = [];
    OB.seen = {};
    OB.note = "";
    OB.busy = false;
    OB.open = true;
    root.classList.add("is-onboarding");
    lock(true);
    holdForSplash();
    OVS.useHost({
      main: hostEl,
      nav: null,
      title: null,
      pageClass: "ob-root",
      section: "onboarding",
    });
    OVS.post = (msg) => {
      if (msg && msg.type === "ov-agents") OB.host.reloadAgents();
    };
    OVS.providersVisible = () => OB.open && OB.step === "models";
    if (!wired) {
      OVS.wire(hostEl);
      wired = true;
    }
    Object.keys(steps).forEach((id) => steps[id].load && steps[id].load());
    const first = !OB.completed && !OB.manual && ORDER.includes(saved) ? saved : "welcome";
    OB.step = first;
    OB.fresh = true;
    OB.seen[first] = true;
    if (steps[first].enter) steps[first].enter();
    OVS.ui.pendingFk = null;
    OVS.render(false);
    hostEl.scrollTop = 0;
    focusStart();
  }

  /* The language changed while the setup is open: every step is drawn again in it. */
  window.addEventListener("ov-language", () => {
    if (OB.open) OVS.render(true);
  });

  window.OVOB = {
    steps,
    OB,
    title,
    mark,
    open,
    close,
    isOpen: () => OB.open,
    isStep: (id) => OB.open && OB.step === id,
    store,
  };
})();
