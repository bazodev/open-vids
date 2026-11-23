import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Outcome {
  read?: unknown;
  refusedBy?: "sdk" | "parser";
  message?: string;
}

function travel(operations: unknown[]): Outcome[] {
  const script = fileURLToPath(new URL("./blank-arguments.probe.ts", import.meta.url));
  return JSON.parse(
    execFileSync("bun", [script, JSON.stringify(operations)], {
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
}

describe("blank optional fields on their way through OMP's validator (real SDK under Bun)", () => {
  const remove = (fields: Record<string, unknown>) => ({ op: "remove_clip", ...fields });
  const accepted: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["clip null", remove({ clip: null, clips: ["a", "b"] }), remove({ clips: ["a", "b"] })],
    ['clip ""', remove({ clip: "", clips: ["a", "b"] }), remove({ clips: ["a", "b"] })],
    ["clips null", remove({ clip: "a", clips: null }), remove({ clip: "a" })],
    ["clips []", remove({ clip: "a", clips: [] }), remove({ clip: "a" })],
    [
      "duck_audio under []",
      { op: "duck_audio", clip: "m", under: [], underTrack: 2 },
      { op: "duck_audio", clip: "m", underTrack: 2 },
    ],
    [
      "set_volume_automation points []",
      { op: "set_volume_automation", clip: "m", points: [], clear: true },
      { op: "set_volume_automation", clip: "m", clear: true },
    ],
    [
      "captions_from_transcript clips []",
      { op: "captions_from_transcript", preset: "basic", clips: [] },
      { op: "captions_from_transcript", preset: "basic" },
    ],
    [
      "captions_from_voiceover lines []",
      { op: "captions_from_voiceover", preset: "", lines: [] },
      { op: "captions_from_voiceover" },
    ],
  ];
  const outcomes = travel(accepted.map(([, operation]) => operation));

  it.each(accepted.map(([label, , expected], index) => [label, expected, index] as const))(
    "reads %s as not given",
    (_label, expected, index) => {
      expect(outcomes[index]).toEqual({ read: expected });
    },
  );

  it("still refuses what is really wrong, and says so in OpenVids' words", () => {
    const [both, neither, required] = travel([
      remove({ clip: "a", clips: ["b"] }),
      remove({ clip: "", clips: [] }),
      { op: "arrange_track", track: 0, clips: [] },
    ]);
    expect(both).toMatchObject({ refusedBy: "parser" });
    expect(both?.message).toContain("remove_clip needs exactly one of clip or clips");
    expect(neither).toMatchObject({ refusedBy: "parser" });
    expect(neither?.message).toContain("remove_clip needs exactly one of clip or clips");
    // A required list keeps its schema minimum, so the model hears about it either way.
    expect(required?.refusedBy).toBeDefined();
  });
});
