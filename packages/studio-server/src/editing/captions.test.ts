// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCaptionsComposition,
  captionSkinPath,
  cuesToGroups,
  listCaptionPresets,
} from "./captions.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");

describe("cuesToGroups", () => {
  it("divides a cue's span evenly among its words and orders cues by start", () => {
    const groups = cuesToGroups([
      { text: "later one", start: 4, end: 6 },
      { text: "  first   cue here ", start: 0, end: 3 },
    ]);
    if (!Array.isArray(groups)) throw new Error("unexpected overlap");
    expect(groups.map((g) => [g.id, g.text, g.start, g.end])).toEqual([
      ["caption-group-0", "first cue here", 0, 3],
      ["caption-group-1", "later one", 4, 6],
    ]);
    expect(groups[0]?.words.map((w) => [w.id, w.start, w.end])).toEqual([
      ["caption-word-0-0", 0, 1],
      ["caption-word-0-1", 1, 2],
      ["caption-word-0-2", 2, 3],
    ]);
  });

  it("stops a cue at the next cue's start, and reports cues that cannot both show", () => {
    const groups = cuesToGroups([
      { text: "a", start: 0, end: 5 },
      { text: "b", start: 2, end: 6 },
    ]);
    expect(Array.isArray(groups) && groups[0]?.end).toBe(2);
    expect(
      cuesToGroups([
        { text: "a", start: 1, end: 5 },
        { text: "b", start: 1, end: 6 },
      ]),
    ).toEqual({ overlap: 0 });
  });
});

describe("buildCaptionsComposition", () => {
  const groups = [{ id: "g", start: 0, end: 1, text: "a </script> b", words: [] }];

  it("fills every real skin's holes and escapes markup in the cue JSON", () => {
    const names = listCaptionPresets(SKINS).map((p) => p.name);
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const skinFile = captionSkinPath(SKINS, name);
      expect(skinFile, name).not.toBeNull();
      const html = buildCaptionsComposition({
        skin: readFileSync(skinFile ?? "", "utf-8"),
        groups,
        duration: 12.5,
        width: 1080,
        height: 1920,
      });
      expect(html, name).toContain("var DURATION = 12.5;");
      expect(html, name).toContain('data-width="1080"');
      expect(html, name).not.toContain("var GROUPS = [];");
      expect(html, name).toContain("a \\u003c/script> b");
      expect(html, name).toContain("<style data-brand-tokens></style>");
      expect(html.startsWith('<template id="captions-template"')).toBe(true);
    }
  });

  it("fails loudly on a skin that lacks a reserved hole", () => {
    expect(() =>
      buildCaptionsComposition({ skin: "<div></div>", groups, duration: 1, width: 1, height: 1 }),
    ).toThrow(/GROUPS/);
  });
});

describe("captionSkinPath", () => {
  it("only resolves folders of the skins directory", () => {
    // Backslash-separated on Windows: accept either separator.
    expect(captionSkinPath(SKINS, "coral")).toMatch(/coral[/\\]caption-skin\.html$/);
    expect(captionSkinPath(SKINS, "../coral")).toBeNull();
    expect(captionSkinPath(SKINS, "coral/../coral")).toBeNull();
    expect(captionSkinPath(SKINS, "missing")).toBeNull();
  });
});
