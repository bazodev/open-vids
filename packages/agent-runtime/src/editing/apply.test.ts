import { describe, expect, it } from "vitest";
import type {
  AgentId,
  AssetKind,
  ProjectAsset,
  TimelineClip,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { FakeEditingHost } from "../testing/editing.js";
import { WriteLeases } from "../writeLeases.js";
import { TurnEditing, type TurnEditingOptions } from "./executor.js";
import { EditingError } from "./host.js";

const clip = (id: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  domId: null,
  kind: "video",
  label: `${id}.mp4`,
  start: 0,
  duration: 2,
  end: 2,
  track: 0,
  zIndex: null,
  src: `assets/${id}.mp4`,
  mediaStart: 0,
  sourceDuration: null,
  volume: 1,
  muted: false,
  compositionSrc: null,
  locked: false,
  provenance: null,
  ...overrides,
});

const snapshot = (clips: TimelineClip[], version = "v1"): TimelineSnapshot => ({
  composition: { path: "index.html", width: 1920, height: 1080, duration: 60 },
  version,
  tracks: [],
  clips,
});

function setup(options: Partial<TurnEditingOptions> = {}) {
  const host = new FakeEditingHost();
  const turn = new AbortController();
  const executor = new TurnEditing({
    host,
    turnSignal: turn.signal,
    turnId: "turn-1",
    ...options,
  });
  const call = (name: string, args: unknown, caller?: AgentId) =>
    executor.execute(name, args, new AbortController().signal, undefined, caller);
  return { host, call };
}

const setLength = { operations: [{ op: "set_composition", duration: 5 }] };

describe("inspect_timeline filters", () => {
  const clips = [
    clip("a", { track: 0, start: 0, end: 4 }),
    clip("b", { track: 0, start: 4, end: 8 }),
    clip("m", { kind: "audio", track: 3, start: 0, end: 60 }),
    clip("t", { kind: "text", track: 2, start: 10, end: 12 }),
  ];

  it("lists only one track", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot(clips);
    const text = (await call("inspect_timeline", { track: 0 })).text;
    expect(text).toContain("2 of 4 clips match (track 0)");
    expect(text).toMatch(/^a \|/m);
    expect(text).toMatch(/^b \|/m);
    expect(text).not.toMatch(/^m \|/m);
  });

  it("lists the clips that overlap a time window", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot(clips);
    const text = (await call("inspect_timeline", { from: 9, to: 11 })).text;
    expect(text).toMatch(/^m \|/m);
    expect(text).toMatch(/^t \|/m);
    expect(text).not.toMatch(/^a \|/m);
  });

  it("pages with offset and limit and says where to continue", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot(clips);
    const first = (await call("inspect_timeline", { limit: 2 })).text;
    expect(first).toContain("clips 1–2 of 4");
    expect(first).toContain("call inspect_timeline again with offset=2");
    const second = (await call("inspect_timeline", { offset: 2, limit: 2 })).text;
    expect(second).toContain("clips 3–4 of 4");
    expect(second).not.toContain("more clips;");
  });

  it("says when nothing matches and refuses bad arguments", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot(clips);
    expect((await call("inspect_timeline", { track: 9 })).text).toContain("No clip matches.");
    expect((await call("inspect_timeline", { limit: 0 })).isError).toBe(true);
    expect((await call("inspect_timeline", { from: -1 })).isError).toBe(true);
  });

  it("shows speed, opacity, grade, effects and automation in the notes", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([
      clip("fx", {
        playbackRate: 2,
        opacity: 0.5,
        colorGrade: "warm-daylight",
        audioFx: 2,
        automation: ["volume"],
      }),
    ]);
    const text = (await call("inspect_timeline", {})).text;
    expect(text).toContain("speed 2×");
    expect(text).toContain("opacity 0.5");
    expect(text).toContain("graded warm-daylight");
    expect(text).toContain("fx ×2");
    expect(text).toContain("automated volume");
  });
});

describe("inspect_project filters", () => {
  const asset = (path: string, kind: AssetKind): ProjectAsset => ({
    path,
    kind,
    bytes: 10,
    duration: 3,
    width: null,
    height: null,
    hasAudio: null,
  });

  it("filters by text and kind and pages the assets", async () => {
    const { host, call } = setup();
    host.inventoryResult = {
      compositions: [],
      assets: [
        asset("assets/a.mp4", "video"),
        asset("assets/b.mp4", "video"),
        asset("assets/music.mp3", "audio"),
      ],
      renders: [],
    };
    const videos = (await call("inspect_project", { kind: "video" })).text;
    expect(videos).toContain("Assets (2 of 3 match video)");
    expect(videos).not.toContain("music.mp3");
    const named = (await call("inspect_project", { query: "MUSIC" })).text;
    expect(named).toContain("assets/music.mp3");
    expect(named).not.toContain("a.mp4");
    const page = (await call("inspect_project", { limit: 1, offset: 0 })).text;
    expect(page).toContain("call inspect_project again with offset=1");
  });
});

describe("browse_presets paging", () => {
  it("passes the page and says how to get the next one", async () => {
    const { host, call } = setup();
    host.presetResults = Array.from({ length: 5 }, (_, index) => ({
      name: `p${index}`,
      kind: "audio_fx" as const,
      title: `P${index}`,
      description: "",
      tags: [],
      duration: null,
    }));
    const text = (await call("browse_presets", { kind: "audio_fx", limit: 2 })).text;
    expect(host.presetRequests[0]?.page).toEqual({ offset: 0, limit: 2 });
    expect(text).toContain("5 audio_fx presets (showing 1–2)");
    expect(text).toContain("set_audio_fx");
    expect(text).toContain("offset=2");
  });
});

describe("edit_timeline: base version", () => {
  it("checks an edit against the version last read this turn", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([clip("a")], "v7");
    await call("inspect_timeline", {});
    await call("edit_timeline", setLength);
    expect(host.applyRequests[0]?.baseVersion).toBe("v7");
  });

  it("learns the version from its own applied batch", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([clip("a")], "v7");
    await call("inspect_timeline", {});
    host.timelineResult = snapshot([clip("a")], "v8");
    await call("edit_timeline", setLength);
    await call("edit_timeline", { operations: [{ op: "set_composition", duration: 6 }] });
    expect(host.applyRequests.map((request) => request.baseVersion)).toEqual(["v7", "v8"]);
  });

  it("lets a version the model names win, and sends none when nothing was read", async () => {
    const { host, call } = setup();
    await call("edit_timeline", setLength);
    host.timelineResult = snapshot([], "v3");
    await call("inspect_timeline", {});
    await call("edit_timeline", { ...setLength, baseVersion: "v1" });
    expect(host.applyRequests[0]?.baseVersion).toBeUndefined();
    expect(host.applyRequests[1]?.baseVersion).toBe("v1");
  });

  it("explains a conflict on a filled version", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([], "v7");
    await call("inspect_timeline", {});
    host.nextApplyError = new EditingError(
      "conflict",
      "index.html changed since the timeline was read",
    );
    const result = await call("edit_timeline", setLength);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("conflict");
    expect(result.text).toContain("your last read of this turn was used");
  });

  it("keeps a conflict on a version the model named as it is", async () => {
    const { host, call } = setup();
    host.nextApplyError = new EditingError("conflict", "stale");
    const result = await call("edit_timeline", { ...setLength, baseVersion: "v1" });
    expect(result.text).not.toContain("your last read");
  });
});

describe("edit_timeline: request id", () => {
  it("gives the same batch the same id, a different batch another, and ignores one the model sent", async () => {
    const { host, call } = setup();
    await call("edit_timeline", setLength);
    await call("edit_timeline", { ...setLength, requestId: "model-made-this-up" });
    await call("edit_timeline", { operations: [{ op: "set_composition", duration: 6 }] });
    const ids = host.applyRequests.map((request) => request.requestId);
    expect(ids[0]).toMatch(/^ov-[A-Za-z0-9_-]{32}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("ties the id to the turn", async () => {
    const first = setup();
    await first.call("edit_timeline", setLength);
    const second = setup({ turnId: "turn-2" });
    await second.call("edit_timeline", setLength);
    expect(first.host.applyRequests[0]?.requestId).not.toBe(
      second.host.applyRequests[0]?.requestId,
    );
  });
});

describe("edit_timeline: dry run", () => {
  it("reports what the batch would change and sends no request id", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([clip("a"), clip("b", { start: 2, end: 4 })], "v1");
    const result = await call("edit_timeline", { dryRun: true, ...setLength });
    // The fake answers with the same timeline, so the batch changes nothing it can show.
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Dry run");
    expect(result.text).toContain("NOTHING was written");
    expect(host.applyRequests[0]).toMatchObject({ dryRun: true });
    expect(host.applyRequests[0]?.requestId).toBeUndefined();
  });

  it("lists added, removed and altered clips and the length change", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([clip("a"), clip("gone")]);
    const original = host.timelineResult;
    const apply = host.apply.bind(host);
    host.apply = async (request, signal) => {
      const response = await apply(request, signal);
      return {
        ...response,
        timeline: {
          ...original,
          composition: { ...original.composition, duration: 70 },
          clips: [clip("a", { start: 3, end: 5, playbackRate: 2 }), clip("fresh", { track: 1 })],
        },
      };
    };
    const text = (await call("edit_timeline", { dryRun: true, ...setLength })).text;
    expect(text).toContain("+ fresh (video");
    expect(text).toContain("- gone (video");
    expect(text).toContain("~ a: start 0→3, end 2→5, speed 1→2");
    expect(text).toContain("composition length 60→70 s");
  });

  it("does not claim a lease, only checks it", async () => {
    const leases = new WriteLeases();
    const { call } = setup({ leases, runIdOf: () => "run-1" });
    await call("edit_timeline", { dryRun: true, ...setLength }, "editor");
    expect(leases.holderOf("index.html")).toBeNull();
    await call("edit_timeline", setLength, "editor");
    expect(leases.holderOf("index.html")).toEqual({ agent: "editor", runId: "run-1" });
  });
});

describe("editing arguments a model leaves blank", () => {
  const edit = (operation: Record<string, unknown>) => ({ operations: [operation] });

  it.each([
    ["null", { clip: null, clips: ["a", "b"] }, { clips: ["a", "b"] }],
    ["an empty string", { clip: "", clips: ["a", "b"] }, { clips: ["a", "b"] }],
    ["blank text", { clip: "  ", clips: ["a", "b"] }, { clips: ["a", "b"] }],
    ["an empty list", { clip: "a", clips: [] }, { clip: "a" }],
  ])("reads %s as not given on remove_clip", async (_label, given, expected) => {
    const { host, call } = setup();
    const result = await call("edit_timeline", edit({ op: "remove_clip", ...given }));
    expect(result.isError).toBeUndefined();
    expect(host.applyRequests[0]?.operations[0]).toEqual({ op: "remove_clip", ...expected });
  });

  it("ignores blank values of fields that belong to another operation", async () => {
    const { host, call } = setup();
    const result = await call(
      "edit_timeline",
      edit({ op: "remove_clip", clip: "a", text: "", start: null, cues: [] }),
    );
    expect(result.isError).toBeUndefined();
    expect(host.applyRequests[0]?.operations[0]).toEqual({ op: "remove_clip", clip: "a" });
  });

  it("reads blank batch options as not given", async () => {
    const { host, call } = setup();
    const result = await call("edit_timeline", {
      ...setLength,
      composition: "",
      baseVersion: null,
      dryRun: null,
    });
    expect(result.isError).toBeUndefined();
    expect(host.applyRequests[0]).not.toHaveProperty("composition");
    expect(host.applyRequests[0]).not.toHaveProperty("dryRun");
  });

  it("still refuses remove_clip with two real targets or with none", async () => {
    const { host, call } = setup();
    for (const given of [
      { clip: "a", clips: ["b"] },
      { clip: "", clips: [] },
      { clip: null, clips: null },
    ]) {
      const result = await call("edit_timeline", edit({ op: "remove_clip", ...given }));
      expect(result.isError).toBe(true);
      expect(result.text).toContain("remove_clip needs exactly one of clip or clips");
    }
    expect(host.applyRequests).toHaveLength(0);
  });

  it("still names a required field that was left blank", async () => {
    const { host, call } = setup();
    const result = await call(
      "edit_timeline",
      edit({ op: "add_text", text: "", start: 0, duration: 1, track: 0 }),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("text must be a non-empty string");
    expect(host.applyRequests).toHaveLength(0);
  });

  it("never drops a blank entry from a list of targets", async () => {
    const { host, call } = setup();
    const result = await call("edit_timeline", edit({ op: "remove_clip", clips: ["a", ""] }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("clips[1] must be a non-empty string");
    expect(host.applyRequests).toHaveLength(0);
  });

  it("reads blank arguments of the other editing tools as not given", async () => {
    const { host, call } = setup();
    host.timelineResult = snapshot([clip("a")]);
    const timeline = await call("inspect_timeline", {
      composition: "",
      track: null,
      from: null,
      to: null,
      offset: null,
      limit: null,
    });
    expect(timeline.isError).toBeUndefined();
    expect(timeline.text).toContain("a.mp4");
    expect(host.timelineRequests.at(-1)).toBeUndefined();
    expect((await call("inspect_project", { query: "", kind: null })).isError).toBeUndefined();
  });
});

describe("edit_timeline: results", () => {
  it("shows operation notes and warnings", async () => {
    const { host, call } = setup();
    host.applyWarnings = ['Clips "a" and "b" overlap on track 0 (1–2 s)'];
    const text = (await call("edit_timeline", setLength)).text;
    expect(text).toContain("Warnings:");
    expect(text).toContain('- Clips "a" and "b" overlap on track 0');
  });

  it("says when Studio answered a repeat with the stored result", async () => {
    const { host, call } = setup();
    const apply = host.apply.bind(host);
    host.apply = async (request, signal) => ({
      ...(await apply(request, signal)),
      replayed: true as const,
    });
    expect((await call("edit_timeline", setLength)).text).toContain("nothing was applied again");
  });
});

describe("edit_timeline: write leases", () => {
  it("refuses a batch on a composition another run holds, with the lease text", async () => {
    const leases = new WriteLeases();
    const { host, call } = setup({
      leases,
      runIdOf: (agent) =>
        agent === "editor" ? "run-editor" : agent === "motion" ? "run-motion" : null,
    });
    expect((await call("edit_timeline", setLength, "editor")).isError).toBeUndefined();
    const refused = await call("edit_timeline", setLength, "motion");
    expect(refused.isError).toBe(true);
    expect(refused.text.toLowerCase()).toContain("editor");
    expect(host.applyRequests).toHaveLength(1);
    // The Director is never blocked from checking, but its writes respect the lease too.
    expect((await call("edit_timeline", setLength, "director")).isError).toBe(true);
    leases.release("run-editor");
    expect((await call("edit_timeline", setLength, "motion")).isError).toBeUndefined();
  });

  it("leases the named composition, not the main one", async () => {
    const leases = new WriteLeases();
    const { call } = setup({ leases, runIdOf: () => "run-1" });
    await call("edit_timeline", { ...setLength, composition: "./compositions/x.html" }, "editor");
    expect(leases.holderOf("compositions/x.html")?.runId).toBe("run-1");
    expect(leases.holderOf("index.html")).toBeNull();
  });
});
