// @vitest-environment happy-dom

/**
 * StudioGear is the app's one Settings gear (Phosphor "Gear" regular, an
 * 8-tooth filled cog): same path data as the Projects page `ic("settings")`
 * and a whole-pixel default size — asserted against the rendered DOM (shape),
 * not the source text. The choice was made on a headless-Chrome contact sheet
 * (apps/desktop/tests/fixtures/gear-contact-sheet-1x.png, also at 1.75x/4x):
 * the filled cog stays crisp at 16 px on the dark titlebar where the old
 * 1.6-stroke outline drew hairlines.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { STUDIO_GEAR_SIZE, StudioGear } from "./StudioGear";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sharedJs = readFileSync(
  path.resolve(__dirname, "../../../../../apps/desktop/src-tauri/src/home_page/shared.js"),
  "utf8",
);

function projectsGearPathData(): string[] {
  const match = sharedJs.match(/settings:\s*'([^']*)'/);
  if (!match) throw new Error("settings icon missing in home_page/shared.js");
  return [...match[1].matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
}

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(() => {
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

function renderGear(size?: number): SVGSVGElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(size === undefined ? <StudioGear /> : <StudioGear size={size} />));
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("StudioGear rendered no svg");
  return svg;
}

describe("StudioGear", () => {
  it("carries the Projects gear path data verbatim", () => {
    const svg = renderGear();
    const rendered = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(rendered).toEqual(projectsGearPathData());
  });

  it("renders filled at a whole-pixel default size", () => {
    const svg = renderGear();
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("stroke")).toBe(null);
    // home.js paints the Projects gear with ic("settings", 16); the Studio
    // header uses the same default, so neither side scales the 24-grid.
    expect(svg.getAttribute("width")).toBe(String(STUDIO_GEAR_SIZE));
    expect(svg.getAttribute("height")).toBe(String(STUDIO_GEAR_SIZE));
    expect(Number.isInteger(STUDIO_GEAR_SIZE)).toBe(true);
  });
});
