/* OV.matchesKey (src-tauri/src/home_page/shared.js): layout-independent chord
   matching for the Projects page and Settings window. Runs in happy-dom with
   the real shared.js evaluated, so the tests pin the shipped helper. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const home = new URL("../src-tauri/src/home_page/", import.meta.url);
const shared = readFileSync(new URL("shared.js", home), "utf8");

const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function matchesKey() {
  const win = new Window({ url: "http://127.0.0.1:57035/" });
  win.eval(shared);
  const fn = win.OV.matchesKey;
  win.happyDOM.abort();
  return fn;
}

const match = matchesKey();
assert.equal(typeof match, "function");

const ev = (key, code) => ({ key, code });

test("Latin chords match on every platform", () => {
  for (const ua of [WIN_UA, MAC_UA]) {
    assert.equal(match(ev("o", "KeyO"), "o", ua), true);
    assert.equal(match(ev("O", "KeyO"), "o", ua), true);
    assert.equal(match(ev(",", "Comma"), ",", ua), true);
    assert.equal(match(ev("1", "Digit1"), "1", ua), true);
    assert.equal(match(ev("o", "KeyO"), "r", ua), false);
  }
});

test("a Cyrillic key matches by physical code on Windows only", () => {
  // Russian layout: the O position types щ.
  assert.equal(match(ev("щ", "KeyO"), "o", WIN_UA), true);
  assert.equal(match(ev("Щ", "KeyO"), "o", WIN_UA), true);
  assert.equal(match(ev("б", "Comma"), ",", WIN_UA), true);
  assert.equal(match(ev("щ", "KeyO"), "o", MAC_UA), false);
  assert.equal(match(ev("б", "Comma"), ",", MAC_UA), false);
});

test("the visible Latin letter stays authoritative on Windows (Dvorak/AZERTY)", () => {
  assert.equal(match(ev("s", "KeyO"), "o", WIN_UA), false);
  assert.equal(match(ev("s", "KeyO"), "s", WIN_UA), true);
  assert.equal(match(ev("o", "KeyS"), "o", WIN_UA), true);
});

test("shifted symbols keep the old behavior on Windows", () => {
  // Ctrl+Shift+1 on an English layout is "!", which never matched "1".
  assert.equal(match(ev("!", "Digit1"), "1", WIN_UA), false);
});

test("Dead/Process keys resolve by code on Windows", () => {
  assert.equal(match(ev("Dead", "KeyO"), "o", WIN_UA), true);
  assert.equal(match(ev("щ", "Unknown"), "o", WIN_UA), false);
});
