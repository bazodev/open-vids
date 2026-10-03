/* The Projects titlebar on the Windows custom frame (index.html + home.js + home.css):
   the three caption buttons must be unhidden and hit-testable, the menu bar
   must follow the frame, the big wordmark must leave the layout, the mark
   must fit its button, the centred row must keep its DOM order, and the
   Runs the real page scripts in happy-dom with the boot object Rust injects
   (serve_page in home_routes.rs); /api is stubbed. Geometry (centring, gaps,
   pairwise non-overlap at 826/1100/1600/2400 px) is asserted headless-Chrome
   side in titlebar-geometry.test.mjs; this file asserts DOM/computed facts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const home = new URL("../src-tauri/src/home_page/", import.meta.url);
const read = (name) => readFileSync(new URL(name, home), "utf8");
const sources = {
  html: read("index.html"),
  shared: read("shared.js"),
  i18n: read("i18n.js"),
  sheets: read("sheets.js"),
  composer: read("composer.js"),
  home: read("home.js"),
};

/* Minimal page: the real header markup + the real stylesheets, scripts run in
   order. fetch answers the boot-time calls home.js makes (recents, agents,
   update status, locales); anything else resolves empty. */
function loadDocument({ frame, width }) {
  const win = new Window({
    url: "http://127.0.0.1:1/",
    settings: { viewport: { width, height: 800 } },
  });
  const doc = win.document;
  const boot = {
    frame,
    intro: false,
    openOnboarding: false,
    prefs: {
      theme: "dark",
      density: "default",
      language: "en",
      newProject: { location: "~/Videos/OpenVids", width: 1920, height: 1080, fps: 24 },
    },
    locales: { index: [], messages: { en: {} } },
    version: "0.0.0-test",
  };
  doc.write(
    sources.html
      .replace("__OPENVids_TOKEN__", "test-token")
      .replace('"__OV_BOOT__"', () => JSON.stringify(boot).replace(/</g, "\\u003c")),
  );
  doc.close();
  win.fetch = (url) => {
    const path = String(url);
    // Behavioural responses the real routes would give an empty workspace:
    // an empty recents list, an empty model catalog, no pending open, and
    // the default locations (so initStartLocation resolves synchronously).
    const bodies = {
      "/api/recents": { recents: [] },
      "/api/agent/models": { models: [] },
      "/api/agent/settings": { director: {} },
      "/api/update/status": {},
      "/api/open-state": { phase: "idle" },
      "/api/locations": { default: "/tmp", locations: [] },
    };
    const body = bodies[path] !== undefined ? bodies[path] : {};
    return Promise.resolve(
      new win.Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  win.OV_BOOT = boot;
  try {
    Object.defineProperty(win.document, "visibilityState", { value: "hidden", configurable: true });
  } catch {}
  const realSetTimeout = win.setTimeout.bind(win);
  /* happy-dom has no layout and the page polls on timers; neutralize only the
     long re-polls (badge refresh, late maximize poll) by dropping them, never
     delaying zero-delay work (a far-future stub would keep node --test alive). */
  win.setTimeout = (fn, ms, ...rest) => (Number(ms) > 100 ? 0 : realSetTimeout(fn, ms, ...rest));
  win.OV_TOKEN = "test-token";
  win.eval(sources.shared);
  win.eval(sources.i18n);
  win.eval(sources.sheets);
  win.eval(sources.composer);
  win.eval(sources.home);
  win.dispatchEvent(new win.Event("DOMContentLoaded"));
  win.innerWidth = width;
  win.dispatchEvent(new win.Event("resize"));
  return { win, doc };
}

function captionState(doc, id) {
  const el = doc.querySelector(`#${id}`);
  assert.ok(el, `#${id} exists`);
  // Behaviour, not source text: the real cascade ([hidden] -> display:none
  // from home.css/ov.css), not a reimplementation of the rule.
  const displayed = doc.defaultView
    ? doc.defaultView.getComputedStyle(el).display !== "none"
    : !el.hidden;
  return { unhidden: !el.hidden, displayed };
}

for (const width of [826, 1100, 1600, 2400]) {
  test(`custom frame at ${width}px: caption strip, wordmark, mark, row order, gear`, () => {
    const { win, doc } = loadDocument({ frame: "custom", width });
    try {
      const view = doc.defaultView;
      const shown = (el) => !!el && !el.hidden && view.getComputedStyle(el).display !== "none";
      for (const id of ["winMin", "winMax", "winClose"]) {
        const el = doc.querySelector(`#${id}`);
        assert.equal(!el.hidden, true, `#${id} keeps [hidden]`);
        assert.equal(shown(el), true, `#${id} is display:none in the cascade`);
      }
      assert.equal(doc.querySelector("#winControls").hidden, false);
      const brand = doc.querySelector("#brandWordmark");
      assert.ok(brand, "#brandWordmark exists");
      assert.equal(brand.hidden, true, "wordmark not hidden on custom frame");
      assert.equal(shown(brand), false, "wordmark still displayed on custom frame");
      const mark = doc.querySelector("#appMenuBtn svg");
      assert.ok(mark, "mark svg missing");
      assert.equal(mark.classList.contains("app-mark"), true, "mark svg lacks .app-mark");
      const mid = [...doc.querySelector("#tb-mid").children].map((el) => el.id || el.className);
      assert.deepEqual(mid, ["tb-new", "tb-search-center", "tb-tools"]);
      assert.ok(doc.querySelector("#tb-new #openBtn"), "openBtn not in #tb-new");
      assert.ok(doc.querySelector("#tb-new #newBtn"), "newBtn not in #tb-new");
      assert.ok(doc.querySelector("#tb-tools .seg"), "view toggle not in #tb-tools");
      assert.ok(doc.querySelector("#tb-tools #settingsBtn"), "gear not in #tb-tools");
      assert.equal(doc.querySelector("#tb-mid #winControls"), null, "caption inside #tb-mid");
      assert.ok(doc.querySelector(".titlebar > #winControls"), "caption not a header child");
      const use = doc.querySelector("#settingsBtn svg use");
      assert.ok(use, "gear <use> missing");
      assert.equal(use.getAttribute("href"), "#i-settings");
    } finally {
      win.happyDOM.abort();
    }
  });
}
for (const width of [826, 1100, 1600]) {
  test(`custom frame at ${width}px: min/max/close are unhidden and the menu bar follows the frame`, () => {
    const { win, doc } = loadDocument({ frame: "custom", width });
    try {
      assert.equal(doc.documentElement.classList.contains("custom-frame"), true);
      for (const id of ["winMin", "winMax", "winClose"]) {
        const st = captionState(doc, id);
        assert.equal(st.unhidden, true, `#${id} keeps [hidden] (the regression)`);
        assert.equal(st.displayed, true, `#${id} is display:none in the cascade`);
      }
      const group = doc.querySelector("#winControls");
      assert.equal(group.hidden, false);
      const bar = doc.querySelector("#menuBar");
      assert.ok(bar, "#menuBar exists");
      // Behaviour, not source text: the five labels are real buttons with
      // menu semantics, and opening File shows its dropdown in #layer.
      const labels = [...bar.querySelectorAll(".menubar-item")];
      assert.deepEqual(
        labels.map((el) => el.dataset.menu),
        ["file", "edit", "view", "window", "help"],
      );
      for (const el of labels) assert.equal(el.getAttribute("aria-haspopup"), "menu");
      // Behaviour, not source text: clicking File really opens its dropdown
      // in #layer through the shared .menu component (evaluated in-page, so
      // happy-dom's synthetic-click limits do not apply). Below 1100px the
      // labels hide into the mark's compact menu, so only assert there.
      if (!bar.hidden) {
        const opened = win.eval(
          "(() => { document.querySelector('#menuBar .menubar-item[data-menu=file]').click(); return !!document.querySelector('#layer .menu'); })()",
        );
        assert.equal(opened, true, "File dropdown opens in #layer");
      }
    } finally {
      win.happyDOM.abort();
    }
  });
}

test("overlay frame: caption buttons and menu bar stay hidden (macOS unchanged)", () => {
  const { win, doc } = loadDocument({ frame: "overlay", width: 1600 });
  try {
    assert.equal(doc.documentElement.classList.contains("custom-frame"), false);
    assert.equal(doc.querySelector("#winControls").hidden, true, "group shown on macOS");
    assert.equal(doc.querySelector("#menuBar").hidden, true);
    assert.equal(doc.querySelector("#appMenuBtn").hidden, true);
  } finally {
    win.happyDOM.abort();
  }
});
