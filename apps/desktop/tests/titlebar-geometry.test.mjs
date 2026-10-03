/* Titlebar geometry on the Windows custom frame (items 1, 3, 4, 5): headless
   Chrome against the real page files served statically with a stubbed boot
   object. Asserts, at 826/1100/1600/2400 px: no pairwise overlap between any
   two title-bar controls; a >= 16 px gap between the last tool and the first
   caption button; the search FIELD centred on the window (±2 px) at >= 1100
   px; Open/New immediately left of the search (8 px gap); the toggle and gear
   right of the search; the mark svg fully inside its 36x36 button; the big
   wordmark hidden. A second test asserts the overlay (macOS) frame keeps the
   wordmark and hides the caption strip, menu bar and mark button. Both skip
   with a message when the managed Chrome is absent; the browser always closes
   in a finally block. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO = new URL("../../../", import.meta.url);
const HP = new URL("../src-tauri/src/home_page/", import.meta.url);
const read = (name) => readFileSync(new URL(name, HP), "utf8");
const en = JSON.parse(readFileSync(new URL("locales/en.json", REPO), "utf8"));

/* Managed chrome-headless-shell (the app's own install path): newest cached
   build wins; null when nothing usable is installed. */
function chromeBinary() {
  try {
    const base = join(homedir(), ".cache/hyperframes/chrome/chrome-headless-shell");
    const dirs = readdirSync(base).filter((d) => existsSync(join(base, d)));
    if (dirs.length === 0) return null;
    const dir = dirs.sort().at(-1);
    const leaf = `chrome-headless-shell-${process.platform === "win32" ? "win64" : "linux64"}`;
    const exe = join(
      base,
      dir,
      leaf,
      `chrome-headless-shell${process.platform === "win32" ? ".exe" : ""}`,
    );
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const EXE = chromeBinary();

async function loadPuppeteer() {
  try {
    const mod =
      await import("../../../packages/engine/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
    return mod.default;
  } catch {
    return null;
  }
}

function bootFor(frame) {
  return {
    frame,
    intro: false,
    openOnboarding: false,
    prefs: {
      theme: "dark",
      density: "default",
      language: "en",
      onboarding: { completedAt: 1 },
      newProject: { location: "x", width: 1920, height: 1080, fps: 24 },
    },
    locales: { index: [{ code: "en", name: "English" }], messages: { en } },
    version: "0.0.0-test",
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve(t) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      const frame = url.searchParams.get("frame") === "overlay" ? "overlay" : "custom";
      res.writeHead(200, { "content-type": "text/html" }).end(
        read("index.html")
          .replace("__OPENVids_TOKEN__", "t")
          .replace('"__OV_BOOT__"', () => JSON.stringify(bootFor(frame)).replace(/</g, "\\u003c")),
      );
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      const name = url.pathname.slice("/assets/".length);
      try {
        const body = read(name);
        res
          .writeHead(200, {
            "content-type": MIME[name.slice(name.lastIndexOf("."))] || "text/plain",
          })
          .end(body);
        return;
      } catch {
        /* fall through to the stub */
      }
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve({ server, port: server.address().port });
    });
  });
}

const WIDTHS = [826, 1100, 1600, 2400];

test("custom frame geometry: gap, mark fit, centred search, order, no overlap", async (t) => {
  if (!EXE) t.skip("managed chrome-headless-shell not found under ~/.cache/hyperframes/chrome");
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) t.skip("puppeteer-core unavailable in packages/engine/node_modules");
  const { port } = await serve(t);

  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: EXE, headless: "shell" });
    for (const width of WIDTHS) {
      await t.test(`at ${width}px`, async () => {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
          await page.goto(`http://127.0.0.1:${port}/?frame=custom`, { waitUntil: "networkidle0" });
          await new Promise((r) => setTimeout(r, 900));
          const g = await page.evaluate(() => {
            const q = (s) => document.querySelector(s);
            const r = (sel) => {
              const el = q(sel);
              if (!el || el.hidden) return null;
              if (getComputedStyle(el).display === "none") return null;
              const b = el.getBoundingClientRect();
              return { x: b.x, y: b.y, w: b.width, h: b.height };
            };
            const fb = q("#field").getBoundingClientRect();
            const gearSvg = q("#settingsBtn svg").getBoundingClientRect();
            const markBtn = q("#appMenuBtn").getBoundingClientRect();
            const markSvg = q("#appMenuBtn svg").getBoundingClientRect();
            return {
              win: window.innerWidth,
              mark: r("#appMenuBtn"),
              menu: r("#menuBar"),
              open: r("#openBtn"),
              nb: r("#newBtn"),
              field: r("#field"),
              fieldCenter: fb.x + fb.width / 2,
              seg: r(".seg"),
              gear: r("#settingsBtn"),
              caps: r("#winControls"),
              winMin: r("#winMin"),
              winMax: r("#winMax"),
              winClose: r("#winClose"),
              brandHidden:
                q("#brandWordmark").hidden ||
                getComputedStyle(q("#brandWordmark")).display === "none",
              gearPx: [gearSvg.width, gearSvg.height],
              markBtn: [markBtn.x, markBtn.y, markBtn.width, markBtn.height],
              markSvg: [markSvg.x, markSvg.y, markSvg.width, markSvg.height],
            };
          });
          // 5: the big wordmark is not displayed on the custom frame.
          assert.equal(g.brandHidden, true, "wordmark visible on custom frame");
          // Menu labels collapse into the mark's menu below 1100 px, and also
          // on measured overlap (a wide locale can crowd the centred row);
          // at 1600 px and above there is room, so the bar must be drawn.
          if (width < 1100) assert.equal(g.menu === null, true, `menu shown at ${width}px`);
          if (width >= 1600) assert.notEqual(g.menu, null, `menu hidden at ${width}px`);
          assert.deepEqual([g.markBtn[2], g.markBtn[3]].map(Math.round), [36, 36]);
          assert.ok(g.markSvg[0] >= g.markBtn[0] - 0.5, "mark svg starts left of its button");
          assert.ok(g.markSvg[1] >= g.markBtn[1] - 0.5, "mark svg starts above its button");
          assert.ok(
            g.markSvg[0] + g.markSvg[2] <= g.markBtn[0] + g.markBtn[2] + 0.5,
            "mark svg overflows its button horizontally",
          );
          assert.ok(
            g.markSvg[1] + g.markSvg[3] <= g.markBtn[1] + g.markBtn[3] + 0.5,
            "mark svg overflows its button vertically",
          );
          assert.ok(
            g.markSvg[2] >= 18 && g.markSvg[2] <= 24,
            `mark not ~21px wide: ${g.markSvg[2]}`,
          );
          // 1: the caption strip owns the rightmost 138 px (3 x 46), gap >= 16 px.
          assert.ok(
            Math.abs(g.caps.x + g.caps.w - width) <= 1,
            `caption not flush right: ${g.caps.x + g.caps.w} vs ${width}`,
          );
          assert.ok(Math.abs(g.caps.w - 138) <= 1, `caption strip not 138px: ${g.caps.w}`);
          for (const [id, b] of [
            ["min", g.winMin],
            ["max", g.winMax],
            ["close", g.winClose],
          ]) {
            assert.ok(Math.abs(b.w - 46) <= 1, `${id} button not 46px: ${b.w}`);
          }
          const gap = g.caps.x - (g.gear.x + g.gear.w);
          assert.ok(gap >= 16, `tool-to-caption gap ${gap} < 16px`);
          // 4: Open/New immediately left of the search (8 px), toggle+gear right of it.
          assert.ok(
            g.open.x < g.nb.x && g.nb.x + g.nb.w <= g.field.x + 0.5,
            "Open/New not left of search",
          );
          assert.ok(Math.abs(g.nb.x + g.nb.w + 8 - g.field.x) <= 2, "New-to-search gap not 8px");
          assert.ok(
            g.field.x + g.field.w <= g.seg.x + 0.5 && g.seg.x + g.seg.w <= g.gear.x + 0.5,
            "toggle/gear not right of search",
          );
          if (width >= 1100) {
            assert.ok(
              Math.abs(g.fieldCenter - width / 2) <= 2,
              `search not centred: ${g.fieldCenter} vs ${width / 2}`,
            );
          }
          // No pairwise overlap between any two title-bar controls.
          const boxes = [g.mark, g.menu, g.open, g.nb, g.field, g.seg, g.gear, g.caps].filter(
            Boolean,
          );
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i];
              const b = boxes[j];
              const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
              assert.ok(
                overlap <= 0.5,
                `overlap ${overlap}px between boxes ${i} and ${j} at ${width}px`,
              );
            }
          }
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

test("overlay frame keeps the wordmark and hides the caption strip (macOS unchanged)", async (t) => {
  if (!EXE) t.skip("managed chrome-headless-shell not found under ~/.cache/hyperframes/chrome");
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) t.skip("puppeteer-core unavailable in packages/engine/node_modules");
  const { port } = await serve(t);

  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: EXE, headless: "shell" });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1600, height: 800, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/?frame=overlay`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 900));
      const st = await page.evaluate(() => {
        const visible = (s) => {
          const el = document.querySelector(s);
          if (!el || el.hidden) return false;
          return window.getComputedStyle(el).display !== "none";
        };
        const caps = document.querySelector("#winControls");
        return {
          brand: visible("#brandWordmark"),
          capsHidden: caps.hidden,
          capsW: caps.getBoundingClientRect().width,
          menu: visible("#menuBar"),
          mark: visible("#appMenuBtn"),
        };
      });
      assert.equal(st.brand, true, "wordmark hidden on overlay frame");
      assert.equal(st.capsHidden, true, "caption strip unhidden on overlay frame");
      assert.equal(st.capsW, 0, "caption strip takes space on overlay frame");
      assert.equal(st.menu, false, "menu bar shown on overlay frame");
      assert.equal(st.mark, false, "mark button shown on overlay frame");
    } finally {
      await page.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

test("custom frame: the gear and the New button take real clicks (the row is click-through)", async (t) => {
  if (!EXE) t.skip("managed chrome-headless-shell not found under ~/.cache/hyperframes/chrome");
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) t.skip("puppeteer-core unavailable in packages/engine/node_modules");
  const { port } = await serve(t);

  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: EXE, headless: "shell" });
    for (const width of [826, 1100, 1600]) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
        await page.goto(`http://127.0.0.1:${port}/?frame=custom`, { waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 600));
        const hits = await page.evaluate(() =>
          ["#settingsBtn", "#tb-new"].map((sel) => {
            const el = document.querySelector(sel);
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { sel, hit: top === el || el.contains(top) };
          }),
        );
        for (const h of hits)
          assert.equal(h.hit, true, `${h.sel} is not hit-testable at ${width}px`);
        const centre = await page.evaluate(() => {
          const r = document.getElementById("settingsBtn").getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.mouse.click(centre.x, centre.y);
        await new Promise((r) => setTimeout(r, 500));
        const opened = await page.evaluate(() => ({
          frames: document.querySelectorAll("iframe").length,
          expanded: document.getElementById("settingsBtn").getAttribute("aria-expanded"),
        }));
        assert.equal(opened.frames, 1, `clicking the gear opened no Settings frame at ${width}px`);
        assert.equal(opened.expanded, "true");
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
  }
});
