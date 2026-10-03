import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const home = new URL("../src-tauri/src/home_page/", import.meta.url);
const html = readFileSync(new URL("settings.html", home), "utf8");
const shared = readFileSync(new URL("shared.js", home), "utf8");

function settingsDocument(frame) {
  const host = new Window({ url: "http://localhost/" });
  host.OV_BOOT = { frame };
  const iframe = host.document.createElement("iframe");
  host.document.body.append(iframe);
  const win = iframe.contentWindow;
  win.document.write(html);
  win.document.close();
  win.eval(shared);
  win.OV.applyCaptionFrame(win.document);
  return { host, win };
}

test("Settings caption adapts to the parent frame", () => {
  const custom = settingsDocument("custom");
  assert.equal(custom.win.document.querySelectorAll(".tl.min, .tl.max").length, 0);
  const closeButtons = custom.win.document.querySelectorAll(".st-titlebar button");
  assert.equal(closeButtons.length, 1);
  assert.ok(closeButtons[0].classList.contains("win-btn"));
  assert.equal(closeButtons[0].getAttribute("aria-label"), "Close Settings");
  custom.host.happyDOM.abort();

  const overlay = settingsDocument("overlay");
  assert.equal(overlay.win.document.querySelectorAll(".tl.close").length, 1);
  assert.equal(overlay.win.document.querySelectorAll(".tl.min").length, 1);
  assert.equal(overlay.win.document.querySelectorAll(".tl.max").length, 1);
  assert.equal(
    overlay.win.document.querySelector(".tl.close").classList.contains("win-btn"),
    false,
  );
  overlay.host.happyDOM.abort();
});
