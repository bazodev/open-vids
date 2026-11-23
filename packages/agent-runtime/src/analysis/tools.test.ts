import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentId,
  FramesRequest,
  SpecialistId,
  TimelineClip,
  TakeIssue,
  TimelineSnapshot,
  TranscriptView,
} from "@hyperframes/agent-protocol";
import { buildHostTools } from "../agents/tools.js";
import { EditingError } from "../editing/host.js";
import { FakeEditingHost } from "../testing/editing.js";
import { FakeAnalysisHost, FAKE_JPEG, SAMPLE_SOURCE, sampleOverview } from "../testing/analysis.js";
import { TurnAnalysis } from "./executor.js";
import { AnalysisToolError } from "./host.js";
import { RESULT_CHARS, TRANSCRIPT_CHARS } from "./format.js";
import { analyzeAndWait } from "./jobs.js";
import { ANALYSIS_TOOL_NAMES, analysisToolsFor, isAnalysisToolName } from "./tools.js";

const ANALYSIS = Object.values<string>(ANALYSIS_TOOL_NAMES);

function analysisToolsOf(
  agent: AgentId,
  enabled: SpecialistId[],
  options: { analysis?: boolean; editing?: boolean } = {},
): string[] {
  return buildHostTools(
    agent,
    { enabled, jev: true, editing: options.editing ?? true, analysis: options.analysis ?? true },
    async () => ({ text: "" }),
  )
    .map((tool) => tool.name)
    .filter(isAnalysisToolName);
}

describe("analysis tool availability", () => {
  const sorted = (names: string[]) => [...names].sort();

  it("gives the Director the tools of every specialist that is off in this chat", () => {
    const base = ["analyze_media", "read_analysis", "read_transcript", "save_segments"];
    expect(analysisToolsOf("director", ["editor", "vision"])).toEqual(base);
    // Vision is off: the Director looks at frames and keeps the notes itself.
    expect(analysisToolsOf("director", ["editor"])).toEqual([
      ...base,
      "inspect_frames",
      "save_vision_notes",
    ]);
    // The Editor is off: the Director plans and builds the cut itself.
    expect(analysisToolsOf("director", ["vision", "motion"])).toEqual([
      ...base,
      "plan_cut",
      "build_rough_cut",
    ]);
    expect(sorted(analysisToolsOf("director", []))).toEqual(sorted(ANALYSIS));
  });

  it("does not give specialists anything because another specialist is off", () => {
    expect(analysisToolsOf("editor", ["editor"])).toEqual(
      analysisToolsOf("editor", ["editor", "vision"]),
    );
    expect(analysisToolsOf("vision", ["vision"])).toEqual(
      analysisToolsOf("vision", ["vision", "editor"]),
    );
  });

  it("gives specialists what their domain needs", () => {
    const all: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
    expect(analysisToolsOf("editor", all)).toEqual([
      "analyze_media",
      "read_analysis",
      "read_transcript",
      "save_segments",
      "plan_cut",
      "build_rough_cut",
    ]);
    expect(analysisToolsOf("vision", all)).toEqual([
      "analyze_media",
      "read_analysis",
      "read_transcript",
      "inspect_frames",
      "save_vision_notes",
    ]);
    for (const reader of ["motion", "audio", "research"] as const) {
      expect(analysisToolsOf(reader, all)).toEqual(["read_analysis", "read_transcript"]);
    }
  });

  it("lets Jev only read the analysis, whatever is enabled", () => {
    const all: SpecialistId[] = ["editor", "vision", "motion", "audio", "research"];
    expect(analysisToolsFor("jev", all)).toEqual(["read_analysis"]);
    expect(analysisToolsFor("jev", [])).toEqual(["read_analysis"]);
  });

  it("offers nothing without an analysis host, and no rough cut without an editing host", () => {
    expect(analysisToolsOf("editor", ["editor"], { analysis: false })).toEqual([]);
    expect(analysisToolsOf("editor", ["editor"], { editing: false })).not.toContain(
      "build_rough_cut",
    );
    expect(analysisToolsOf("editor", ["editor"], { editing: false })).toContain("plan_cut");
    // The Director inherits the rough cut the same way: no editing host, no build_rough_cut.
    expect(analysisToolsOf("director", [], { editing: false })).not.toContain("build_rough_cut");
  });
});

function clip(id: string, src: string | null, track: number, start: number): TimelineClip {
  return {
    id,
    domId: null,
    kind: "video",
    label: id,
    start,
    duration: 5,
    end: start + 5,
    track,
    zIndex: 1,
    src,
    mediaStart: 0,
    sourceDuration: 1_420,
    volume: 1,
    muted: false,
    compositionSrc: null,
    locked: false,
    provenance: null,
  };
}

function timelineOf(clips: TimelineClip[]): TimelineSnapshot {
  return {
    composition: { path: "index.html", width: 1920, height: 1080, duration: 30 },
    version: "sha256:tl1",
    tracks: [],
    clips,
  };
}

function setup() {
  const host = new FakeAnalysisHost();
  const editing = new FakeEditingHost();
  const analysis = new TurnAnalysis({
    host,
    editing,
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    pollMs: 1,
  });
  const call = (name: string, args: unknown) =>
    analysis.execute(name, args, new AbortController().signal);
  return { host, editing, analysis, call };
}

describe("analyze_media", () => {
  it("waits for the job and returns the compact overview with what each stage did", async () => {
    const { host, call } = setup();
    host.runningPolls = 2;
    const result = await call("analyze_media", { source: SAMPLE_SOURCE, language: "en" });
    expect(result.isError).toBeUndefined();
    expect(host.startRequests).toEqual([{ source: SAMPLE_SOURCE, language: "en" }]);
    expect(result.text).toContain("silence cached");
    expect(result.text).toContain("transcript computed 12.5 s");
    expect(result.text).toContain("3600 words");
    expect(result.text).toContain("S1 82 %");
    expect(result.text).toContain("black 01:40.0–01:42.0");
    expect(result.text).toContain("t1 retake 00:10.0–00:14.0 s1+s2 [cut]");
    expect(result.text).toContain("100.5, 101.5 s");
  });

  it("reports a stage this machine cannot run instead of failing", async () => {
    const { host, call } = setup();
    host.jobResults = [
      { stage: "transcript", outcome: "unavailable", seconds: 0, detail: "no speech recognizer" },
    ];
    const result = await call("analyze_media", { source: SAMPLE_SOURCE });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("transcript unavailable — no speech recognizer");
  });

  it("treats null arguments as absent and rejects what the protocol rejects", async () => {
    const { host, call } = setup();
    await call("analyze_media", { source: SAMPLE_SOURCE, language: null, force: null });
    expect(host.startRequests[0]).toEqual({ source: SAMPLE_SOURCE });

    const bad = await call("analyze_media", { source: SAMPLE_SOURCE, language: "english please" });
    expect(bad).toEqual({
      isError: true,
      text: expect.stringMatching(/^invalid_request: language must be a language code/),
    });
    expect((await call("analyze_media", {})).text).toMatch(/^invalid_request: source/);
    expect(host.startRequests).toHaveLength(1);
  });

  it("maps a failed job and a service error onto their codes", async () => {
    const { host, call } = setup();
    host.nextError = new AnalysisToolError("unknown_source", "no such file");
    expect(await call("analyze_media", { source: "nope.mp4" })).toEqual({
      isError: true,
      text: "unknown_source: no such file",
    });
  });

  it("tells the model a refused start (an analysis is running) is a conflict and how to wait for it", async () => {
    const { host, call } = setup();
    host.nextError = new AnalysisToolError(
      "conflict",
      "assets/a.mp4 is already being analysed without recomputing transcript",
    );
    const result = await call("analyze_media", { source: SAMPLE_SOURCE, force: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^conflict: .*already being analysed.*Nothing was started\./s);
    expect(result.text).toContain("without force or language");
  });
});

describe("read_analysis", () => {
  it("returns the overview, a section from it, and the full silence and shot artifacts", async () => {
    const { host, call } = setup();
    expect((await call("read_analysis", { source: SAMPLE_SOURCE })).text).toContain(
      "Analysis of assets/raw-talk.mp4",
    );
    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "takes" })).text,
    ).toContain("t1 retake");
    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "silence" })).text,
    ).toContain("00:41.0–00:44.9 (3.9 s)");
    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "shots" })).text,
    ).toContain("k1 00:00.0–23:40.0");
    expect(host.artifactRequests).toEqual([`${SAMPLE_SOURCE}:silence`, `${SAMPLE_SOURCE}:shots`]);
    expect((await call("read_analysis", { source: SAMPLE_SOURCE, section: "bogus" })).text).toMatch(
      /^invalid_request: section must be one of overview, speakers/,
    );
  });

  it("keeps the 'continue with' notice of the shot list however many problems the picture has", async () => {
    const { host, call } = setup();
    host.shotsResult = {
      source: SAMPLE_SOURCE,
      sceneThreshold: 0.3,
      shots: Array.from({ length: 2_000 }, (_, index) => ({
        id: `k${index + 1}`,
        start: index * 2,
        end: index * 2 + 2,
      })),
      problems: Array.from({ length: 600 }, (_, index) => ({
        kind: index % 2 === 0 ? "black" : "frozen",
        start: index * 5,
        end: index * 5 + 1,
      })),
    };
    const first = (await call("read_analysis", { source: SAMPLE_SOURCE, section: "shots" })).text;
    expect(first.length).toBeLessThanOrEqual(RESULT_CHARS);
    expect(first).toMatch(/… \d+ more problems not shown/);
    const notice = /… (\d+) more shots; continue with read_analysis section=shots offset=(\d+)$/;
    const match = notice.exec(first);
    expect(match).not.toBeNull();
    // Following the offset reaches the next shot.
    const offset = Number(match?.[2]);
    expect(first).toContain(`k${offset} `);
    const second = (
      await call("read_analysis", { source: SAMPLE_SOURCE, section: "shots", offset })
    ).text;
    expect(second).toContain(`k${offset + 1} `);
  });

  it("lists only the vision targets that are still open, and existing cut plans", async () => {
    const { host, call } = setup();
    host.overviewResult = {
      ...sampleOverview(),
      visionTargets: [
        {
          start: 100,
          end: 102,
          reason: "visual_problem",
          ref: "k2",
          times: [100.5],
          inspected: true,
        },
        {
          start: 300,
          end: 303,
          reason: "segment_sample",
          ref: "g4",
          times: [301, 302],
          inspected: false,
        },
      ],
    };
    const vision = (await call("read_analysis", { source: SAMPLE_SOURCE, section: "vision" })).text;
    expect(vision).toContain("2 suggested, 1 not yet inspected");
    expect(vision).toContain("segment_sample g4 05:00.0–05:03.0 frames at 301, 302 s");
    expect(vision).not.toContain("visual_problem k2");

    const plan = await call("plan_cut", { source: SAMPLE_SOURCE });
    expect(plan.isError).toBeUndefined();
    host.overviewResult = {
      ...host.overviewResult,
      cuts: await host.listCuts(undefined, new AbortController().signal),
    };
    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "cuts" })).text,
    ).toContain('cut-1 "rough cut"');
  });
});

describe("plan_cut arguments a model leaves blank", () => {
  it("reads an empty basedOn, label and order as not given", async () => {
    const { host, call } = setup();
    const result = await call("plan_cut", {
      source: SAMPLE_SOURCE,
      basedOn: "",
      label: "  ",
      order: [],
    });
    expect(result.isError).toBeUndefined();
    expect(host.planRequests[0]).toEqual({ source: SAMPLE_SOURCE });
  });

  it("keeps the blanks that mean something: no hook, and no take issues to cut", async () => {
    const { host, call } = setup();
    const result = await call("plan_cut", {
      source: SAMPLE_SOURCE,
      basedOn: "cut-1",
      hook: null,
      removeIssues: [],
    });
    expect(result.isError).toBeUndefined();
    expect(host.planRequests[0]).toEqual({
      source: SAMPLE_SOURCE,
      basedOn: "cut-1",
      hook: null,
      removeIssues: [],
    });
  });

  it("still refuses a blank source, and a blank entry in a list", async () => {
    const { host, call } = setup();
    expect((await call("plan_cut", { source: "" })).text).toContain(
      "source must be a non-empty string",
    );
    expect((await call("plan_cut", { source: SAMPLE_SOURCE, drop: ["g1", ""] })).text).toContain(
      "drop[1] must be a non-empty string",
    );
    expect(host.planRequests).toHaveLength(0);
  });
});

describe("read_analysis paging", () => {
  const issue = (index: number): TakeIssue => ({
    id: `t${index}`,
    kind: "retake",
    start: index * 10,
    end: index * 10 + 4,
    sentences: [`s${index}`],
    confidence: 0.9,
    action: "review",
    note: `a long note about this take that takes up some room in the page ${index} `.repeat(3),
    keep: null,
  });
  const ids = (text: string) =>
    [...text.matchAll(/^(t\d+) /gm)].flatMap((m) => (m[1] ? [m[1]] : []));

  it("pages a long list: each page names the offset of the next, and the pages together are the whole list", async () => {
    const { host, call } = setup();
    host.overviewResult = {
      ...host.overviewResult,
      takes: {
        counts: { retake: 120 },
        issues: Array.from({ length: 120 }, (_, i) => issue(i + 1)),
      },
    };
    const seen: string[] = [];
    let offset = 0;
    for (let pages = 0; pages < 50; pages += 1) {
      const { text, isError } = await call("read_analysis", {
        source: SAMPLE_SOURCE,
        section: "takes",
        offset,
      });
      expect(isError).toBeUndefined();
      seen.push(...ids(text));
      const next = /continue with read_analysis section=takes offset=(\d+)/.exec(text);
      if (!next) break;
      const nextOffset = Number(next[1]);
      expect(nextOffset).toBeGreaterThan(offset);
      expect(ids(text)).toHaveLength(nextOffset - offset);
      offset = nextOffset;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `t${i + 1}`));
    expect(offset).toBeGreaterThan(0);
  });

  it("starts a page with the range it shows, pages the full silence list, and refuses a bad or too large offset", async () => {
    const { host, call } = setup();
    host.silenceResult = {
      ...host.silenceResult,
      silences: Array.from({ length: 900 }, (_, i) => ({ start: i * 3, end: i * 3 + 1 })),
    };
    const first = await call("read_analysis", { source: SAMPLE_SOURCE, section: "silence" });
    const next = /continue with read_analysis section=silence offset=(\d+)/.exec(first.text);
    expect(next).not.toBeNull();
    const second = await call("read_analysis", {
      source: SAMPLE_SOURCE,
      section: "silence",
      offset: Number(next?.[1]),
    });
    expect(second.text).toContain(`silences ${Number(next?.[1]) + 1}–`);
    expect(second.text).toContain("of 900:");

    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "silence", offset: 5000 }))
        .text,
    ).toBe(
      "Pauses of assets/raw-talk.mp4: 900 silences of at least 0.3 s below -35 dB · 3.9 s in total\nNo silences at offset 5000: the list has 900.",
    );
    expect(
      (await call("read_analysis", { source: SAMPLE_SOURCE, section: "takes", offset: -1 })).text,
    ).toBe("invalid_request: offset must be a whole number from 0");
  });
});

describe("analyze_media progress and deadline", () => {
  it("reports the job's progress on the tool's progress channel", async () => {
    const { host, analysis } = setup();
    host.runningPolls = 3;
    host.progressScript = [10, 55, 90];
    const seen: number[] = [];
    const result = await analysis.execute(
      "analyze_media",
      { source: SAMPLE_SOURCE },
      new AbortController().signal,
      (percent) => seen.push(percent),
    );
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([40, 10, 55, 90, 100]);
  });

  it("cancels a job that stops moving and says which stage stood still", async () => {
    const host = new FakeAnalysisHost();
    host.jobGate = Promise.withResolvers<void>().promise;
    const analysis = new TurnAnalysis({
      host,
      editing: null,
      turnSignal: new AbortController().signal,
      pollMs: 1,
      stallMs: 40,
    });
    const result = await analysis.execute(
      "analyze_media",
      { source: SAMPLE_SOURCE },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /^stalled: The analysis of assets\/raw-talk\.mp4 made no progress for 1 seconds \(stage transcript, 40 %\) and was cancelled\./,
    );
    expect(host.cancelledJobs).toEqual(["job-1"]);
  });

  it("leaves a job someone else started running when it stalls", async () => {
    const host = new FakeAnalysisHost();
    host.jobGate = Promise.withResolvers<void>().promise;
    host.joinsRunningJob = true;
    const request = { source: SAMPLE_SOURCE };
    await expect(
      analyzeAndWait(host, request, new AbortController().signal, { pollMs: 1, stallMs: 20 }),
    ).rejects.toMatchObject({
      code: "stalled",
      message: expect.stringContaining("started by someone else and keeps running"),
    });
    expect(host.cancelledJobs).toEqual([]);
  });

  it("does not stall while the progress keeps moving", async () => {
    const host = new FakeAnalysisHost();
    host.runningPolls = 6;
    host.progressScript = [5, 10, 20, 30, 40, 50];
    let clock = 0;
    const job = await analyzeAndWait(
      host,
      { source: SAMPLE_SOURCE },
      new AbortController().signal,
      {
        pollMs: 1,
        stallMs: 1_000,
        now: () => {
          clock += 400;
          return clock;
        },
      },
    );
    expect(job.status).toBe("completed");
    expect(host.cancelledJobs).toEqual([]);
  });

  it("does not stall a recognizer that shows no progress but keeps reporting signs of life", async () => {
    const waitFor = async (heartbeats: boolean) => {
      const host = new FakeAnalysisHost();
      host.runningPolls = 12;
      host.heartbeats = heartbeats;
      let clock = 0;
      const outcome = await analyzeAndWait(
        host,
        { source: SAMPLE_SOURCE },
        new AbortController().signal,
        {
          pollMs: 1,
          stallMs: 1_000,
          now: () => {
            clock += 400;
            return clock;
          },
        },
      ).then(
        (job) => job.status,
        (error: unknown) => (error instanceof AnalysisToolError ? error.code : "other"),
      );
      return { outcome, cancelled: host.cancelledJobs };
    };
    // Same flat stage and progress for twelve polls (4.8 s of clock against a 1 s deadline): only the heartbeat differs.
    expect(await waitFor(false)).toEqual({ outcome: "stalled", cancelled: ["job-1"] });
    expect(await waitFor(true)).toEqual({ outcome: "completed", cancelled: [] });
  });
});

function longTranscript(count: number): TranscriptView {
  return {
    source: SAMPLE_SOURCE,
    version: "sha256:aaaa",
    language: "en",
    from: 0,
    to: count * 5,
    totalSentences: count,
    sentences: Array.from({ length: count }, (_, index) => ({
      id: `s${index + 1}`,
      start: index * 5,
      end: index * 5 + 4,
      firstWord: index * 8,
      lastWord: index * 8 + 7,
      text: `Sentence number ${index + 1} says something moderately long to fill the page.`,
      speaker: "S1",
    })),
  };
}

describe("read_transcript", () => {
  it("prints compact lines with the version, marks take issues and accepts clock times", async () => {
    const { host, call } = setup();
    const result = await call("read_transcript", {
      source: SAMPLE_SOURCE,
      from: "00:10.0",
      to: 30,
    });
    expect(host.transcriptRequests).toEqual([{ source: SAMPLE_SOURCE, from: 10, to: 30 }]);
    expect(result.text).toContain("version sha256:aaaa");
    expect(result.text).toContain("s1 [00:10.0–00:12.0] S1: So the thing is  ⟨t1 retake⟩");
    expect(result.text).toContain("s2 [00:12.5–00:15.0] S1: The thing is simple  ⟨t1 retake⟩");
    expect(result.text).toContain("s3 [00:20.0–00:30.0] S1: Here is the rest.");
    expect(result.text).not.toContain("s3 [00:20.0–00:30.0] S1: Here is the rest.  ⟨");
  });

  it("still reads when the overview needed for the marks is unavailable", async () => {
    const { host, call } = setup();
    host.overview = async () => {
      throw new AnalysisToolError("not_analyzed", "run analyze_media");
    };
    const result = await call("read_transcript", { source: SAMPLE_SOURCE });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("s1 [00:10.0–00:12.0]");
  });

  it("pages a long transcript and says where to continue", async () => {
    const { host, call } = setup();
    host.transcriptResult = longTranscript(400);
    const result = await call("read_transcript", { source: SAMPLE_SOURCE });
    expect(result.text.length).toBeLessThan(TRANSCRIPT_CHARS + 600);
    expect(result.text).toMatch(/… \d+ more sentences not shown/);
    const shown = [...result.text.matchAll(/^s(\d+) \[/gm)].map((match) => Number(match[1]));
    const last = shown.at(-1) ?? 0;
    expect(shown[0]).toBe(1);
    expect(shown).toEqual(Array.from({ length: last }, (_, index) => index + 1));
    expect(result.text).toContain(`Continue with read_transcript from=${(last - 1) * 5 + 4}`);
  });

  it("refuses an inverted or malformed window before calling the service", async () => {
    const { host, call } = setup();
    expect((await call("read_transcript", { source: SAMPLE_SOURCE, from: 30, to: 10 })).text).toBe(
      "invalid_request: to must be after from",
    );
    expect((await call("read_transcript", { source: SAMPLE_SOURCE, from: "soon" })).text).toMatch(
      /^invalid_request: from must be seconds/,
    );
    expect((await call("read_transcript", { source: SAMPLE_SOURCE, from: -1 })).isError).toBe(true);
    expect(host.transcriptRequests).toEqual([]);
  });
});

describe("save_segments", () => {
  const segment = {
    firstSentence: "s1",
    lastSentence: "s2",
    title: "Intro",
    summary: "He introduces the topic.",
    role: "intro",
    priority: "must",
  };

  it("saves the segmentation against the transcript version that was read", async () => {
    const { host, call } = setup();
    const result = await call("save_segments", {
      source: SAMPLE_SOURCE,
      transcriptVersion: "sha256:aaaa",
      segments: [
        segment,
        {
          ...segment,
          firstSentence: "s3",
          lastSentence: "s3",
          priority: "drop",
          role: "tangent",
          title: "Aside",
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Saved 2 segments (must 1, drop 1)");
    expect(result.text).toContain("g1 00:10.0–00:15.0 s1–s2 · intro · must");
    expect(host.segmentRequests).toHaveLength(1);
  });

  it("validates every segment and maps a stale transcript version to conflict", async () => {
    const { host, call } = setup();
    const base = { source: SAMPLE_SOURCE, transcriptVersion: "sha256:aaaa" };
    expect((await call("save_segments", { ...base, segments: [] })).text).toBe(
      "invalid_request: segments must be a non-empty array",
    );
    expect(
      (await call("save_segments", { ...base, segments: [{ ...segment, role: "boss" }] })).text,
    ).toMatch(/^invalid_request: segments\[0\]\.role must be one of hook, intro/);
    expect(
      (await call("save_segments", { ...base, segments: [{ ...segment, extra: 1 }] })).text,
    ).toMatch(/unknown field "extra"/);
    expect(
      await call("save_segments", {
        ...base,
        transcriptVersion: "sha256:old",
        segments: [segment],
      }),
    ).toEqual({ isError: true, text: "conflict: The transcript changed since it was read." });
    expect(host.segmentRequests).toEqual([]);
  });
});

describe("inspect_frames", () => {
  it("returns the images with one text line per frame and marks cached frames", async () => {
    const { host, call } = setup();
    const first = await call("inspect_frames", {
      source: SAMPLE_SOURCE,
      times: [100.5, 101.5],
      width: 640,
    });
    expect(first.images).toEqual([
      { mimeType: "image/jpeg", data: FAKE_JPEG },
      { mimeType: "image/jpeg", data: FAKE_JPEG },
    ]);
    expect(first.text).toContain("2 frames of assets/raw-talk.mp4");
    expect(first.text).toContain("1. 100.5 s (01:40.5)");
    expect(first.text).not.toContain("cached");
    expect(host.frameRequests[0]).toEqual({
      source: SAMPLE_SOURCE,
      times: [100.5, 101.5],
      width: 640,
    });

    await call("save_vision_notes", {
      source: SAMPLE_SOURCE,
      notes: [
        {
          start: 100,
          end: 102,
          frames: [100.5],
          quality: "poor",
          tags: ["black"],
          finding: "Black.",
        },
      ],
    });
    const again = await call("inspect_frames", { source: SAMPLE_SOURCE, times: [100.5, 300] });
    expect(again.text).toContain("1. 100.5 s (01:40.5) — cached");
    expect(again.text).not.toContain("2. 300 s (05:00.0) — cached");
  });

  it("refuses too many frames, a bad width and an empty list", async () => {
    const { host, call } = setup();
    const times = Array.from({ length: 13 }, (_, index) => index * 10);
    expect((await call("inspect_frames", { source: SAMPLE_SOURCE, times })).text).toBe(
      "invalid_request: times exceeds 12 entries",
    );
    expect((await call("inspect_frames", { source: SAMPLE_SOURCE, times: [] })).isError).toBe(true);
    expect(
      (await call("inspect_frames", { source: SAMPLE_SOURCE, times: [1], width: 100 })).text,
    ).toMatch(/^invalid_request: width must be an integer from 160 to 1280/);
    expect(host.frameRequests).toEqual([]);
  });

  it("returns an error, not a partial success, when frames cannot be extracted", async () => {
    const { host, call } = setup();
    host.nextError = new AnalysisToolError("failed", "ffmpeg could not decode the frame");
    const result = await call("inspect_frames", { source: SAMPLE_SOURCE, times: [5] });
    expect(result).toEqual({ isError: true, text: "failed: ffmpeg could not decode the frame" });
    expect(result.images).toBeUndefined();
  });

  describe("frame budget", () => {
    const PROJECT = join(tmpdir(), "ov-frames-project");

    function capped(framesPerSource: number, host = new FakeAnalysisHost()) {
      const analysis = new TurnAnalysis({
        host,
        editing: null,
        turnSignal: new AbortController().signal,
        pollMs: 1,
        framesPerSource,
        projectDir: PROJECT,
      });
      const call = (args: unknown) =>
        analysis.execute("inspect_frames", args, new AbortController().signal);
      return { host, call };
    }

    it("counts every spelling of one file against the same budget", async () => {
      const { host, call } = capped(2);
      expect((await call({ source: SAMPLE_SOURCE, times: [1, 2] })).isError).toBeUndefined();
      for (const spelling of [
        `./${SAMPLE_SOURCE}`,
        ` ${SAMPLE_SOURCE.replaceAll("/", "\\")} `,
        join(PROJECT, SAMPLE_SOURCE),
      ]) {
        const refused = await call({ source: spelling, times: [3] });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("Frame budget");
      }
      expect(host.frameRequests).toHaveLength(1);
      // frames already inspected stay free whatever the spelling
      expect((await call({ source: `./${SAMPLE_SOURCE}`, times: [2, 1] })).isError).toBeUndefined();
    });

    it("reserves the budget before extraction, so parallel calls cannot exceed it", async () => {
      const gate = Promise.withResolvers<void>();
      class SlowHost extends FakeAnalysisHost {
        override async frames(request: FramesRequest, signal: AbortSignal) {
          await gate.promise;
          return super.frames(request, signal);
        }
      }
      const { host, call } = capped(2, new SlowHost());
      const results = Promise.all([
        call({ source: SAMPLE_SOURCE, times: [1, 2] }),
        call({ source: `./${SAMPLE_SOURCE}`, times: [3, 4] }),
      ]);
      gate.resolve();
      const [first, second] = await results;
      expect(first.isError).toBeUndefined();
      expect(second.isError).toBe(true);
      expect(host.frameRequests).toHaveLength(1);
    });

    it("gives the reservation back when extraction fails", async () => {
      const { host, call } = capped(2);
      host.nextError = new AnalysisToolError("failed", "ffmpeg could not decode the frame");
      expect((await call({ source: SAMPLE_SOURCE, times: [1, 2] })).isError).toBe(true);
      expect((await call({ source: SAMPLE_SOURCE, times: [3, 4] })).isError).toBeUndefined();
    });
  });
});

describe("save_vision_notes", () => {
  it("validates notes and reports the totals", async () => {
    const { host, call } = setup();
    const note = {
      start: 100,
      end: 102,
      frames: [100.5, 101.5],
      quality: "poor",
      tags: ["Black"],
      finding: "Black frame.",
    };
    const ok = await call("save_vision_notes", { source: SAMPLE_SOURCE, notes: [note] });
    expect(ok.text).toContain(
      "Saved 1 visual note. The source now has 1 notes and 2 inspected frames",
    );
    expect(host.visionRequests[0]?.notes[0]?.tags).toEqual(["black"]);

    expect(
      (await call("save_vision_notes", { source: SAMPLE_SOURCE, notes: [{ ...note, end: 100 }] }))
        .text,
    ).toBe("invalid_request: notes[0].end must be after start");
    expect(
      (
        await call("save_vision_notes", {
          source: SAMPLE_SOURCE,
          notes: [{ ...note, quality: "meh" }],
        })
      ).text,
    ).toMatch(/quality must be one of good, usable, poor, unusable/);
    expect(host.visionRequests).toHaveLength(1);
  });
});

describe("plan_cut", () => {
  it("returns the plan id, stats, warnings and the kept order", async () => {
    const { host, call } = setup();
    host.planRanges = [
      { from: 10, to: 12, at: 0, segment: "g2", hook: true },
      { from: 0, to: 5, at: 2, segment: "g1", hook: false },
      { from: 5, to: 9, at: 7, segment: "g1", hook: false },
      { from: 10, to: 20, at: 11, segment: "g2", hook: false },
    ];
    const result = await call("plan_cut", {
      source: SAMPLE_SOURCE,
      label: "rough cut",
      hook: { firstSentence: "s5", lastSentence: "s6" },
      maxPause: 0.5,
    });
    expect(host.planRequests[0]).toEqual({
      source: SAMPLE_SOURCE,
      label: "rough cut",
      hook: { firstSentence: "s5", lastSentence: "s6" },
      maxPause: 0.5,
    });
    expect(result.text).toContain('Cut plan cut-1 "rough cut"');
    expect(result.text).toContain("Length 00:21.0 from 23:40.0");
    expect(result.text).toContain("4 ranges");
    expect(result.text).toContain("Order: hook → g1 → g2");
    expect(result.text).toContain("pauses 40 s, fillers 12, bad takes 1");
    expect(result.text).toContain("build_rough_cut plan=cut-1");
  });

  it("names detected picture problems kept in the cut that Vision has not inspected", async () => {
    const { host, call } = setup();
    // The sample overview has one uninspected black target at 100–102 s.
    host.planRanges = [{ from: 95, to: 110, at: 0, segment: "g1", hook: false }];
    expect((await call("plan_cut", { source: SAMPLE_SOURCE })).text).toContain(
      "Not yet inspected by Vision and kept in this cut: 1 detected picture problem at source 01:40.0–01:42.0",
    );

    host.planRanges = [{ from: 0, to: 90, at: 0, segment: "g1", hook: false }];
    expect((await call("plan_cut", { source: SAMPLE_SOURCE })).text).not.toContain(
      "Not yet inspected",
    );

    const inspected = sampleOverview();
    inspected.visionTargets = inspected.visionTargets.map((target) => ({
      ...target,
      inspected: true,
    }));
    host.overviewResult = inspected;
    host.planRanges = [{ from: 95, to: 110, at: 0, segment: "g1", hook: false }];
    expect((await call("plan_cut", { source: SAMPLE_SOURCE })).text).not.toContain(
      "Not yet inspected",
    );
  });

  it("keeps hook: null (drop the base plan's hook), drops other nulls, and validates like the service", async () => {
    const { host, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE, basedOn: "cut-1", hook: null, order: null });
    expect(host.planRequests[0]).toEqual({ source: SAMPLE_SOURCE, basedOn: "cut-1", hook: null });

    expect(
      (await call("plan_cut", { source: SAMPLE_SOURCE, maxPause: 0.5, pauseKeep: 0.8 })).text,
    ).toBe("invalid_request: pauseKeep must not exceed maxPause");
    expect((await call("plan_cut", { source: SAMPLE_SOURCE, mood: "fast" })).text).toBe(
      'invalid_request: unknown field "mood"',
    );
    expect((await call("plan_cut", { source: SAMPLE_SOURCE, targetDuration: 0 })).text).toBe(
      "invalid_request: targetDuration must be greater than 0",
    );
    expect(host.planRequests).toHaveLength(1);
  });

  it("passes the service's refusals through with their code", async () => {
    const { host, call } = setup();
    host.nextError = new AnalysisToolError("not_analyzed", "run analyze_media first");
    expect(await call("plan_cut", { source: SAMPLE_SOURCE })).toEqual({
      isError: true,
      text: "not_analyzed: run analyze_media first",
    });
  });
});

describe("build_rough_cut", () => {
  it("composes ONE atomic batch: replace the previous cut on its track, add_sequence stamped with the plan and turn, set_composition; clips on other tracks stay", async () => {
    const { editing, call } = setup();
    editing.timelineResult = timelineOf([
      clip("c1", SAMPLE_SOURCE, 0, 0),
      clip("c2", `./${SAMPLE_SOURCE}`, 0, 5),
      clip("c3", SAMPLE_SOURCE, 1, 0),
      clip("c4", "assets/other.mp4", 1, 5),
      clip("title", null, 2, 0),
    ]);
    await call("plan_cut", { source: SAMPLE_SOURCE });
    const result = await call("build_rough_cut", { plan: "cut-1" });

    expect(result.isError).toBeUndefined();
    expect(editing.applyRequests).toHaveLength(1);
    expect(editing.applyRequests[0]).toEqual({
      baseVersion: "sha256:tl1",
      operations: [
        { op: "remove_clip", clips: ["c1", "c2"] },
        {
          op: "add_sequence",
          asset: SAMPLE_SOURCE,
          track: 0,
          start: 0,
          ranges: [
            { from: 12.5, to: 15 },
            { from: 20, to: 30 },
            { from: 100.5, to: 104 },
          ],
          edgeFade: 0.02,
          provenance: { cut: "cut-1", turn: "turn-1" },
        },
        { op: "set_composition", duration: 16 },
      ],
    });
    expect(result.text).toContain(
      'Built cut-1 "rough cut" on index.html, track 0: 3 clips, 00:16.0 long',
    );
    expect(result.text).toContain("replaced 2 earlier clips");
    // The cutaway of the same source on track 1, the other source and the title are kept, and the result says so.
    expect(result.text).toContain(
      "Kept 3 clips on other tracks (cutaways, B-roll, graphics, captions, manual additions); their positions refer to the previous cut",
    );
  });

  it("removes the untouched template placeholder on the target track with the previous cut, and leaves one on another track", async () => {
    const { editing, call } = setup();
    editing.timelineResult = timelineOf([
      { ...clip("ph", null, 0, 0), placeholder: true },
      { ...clip("ph-other", null, 4, 0), placeholder: true },
      clip("c1", SAMPLE_SOURCE, 0, 0),
    ]);
    await call("plan_cut", { source: SAMPLE_SOURCE });
    const result = await call("build_rough_cut", { plan: "cut-1" });

    expect(editing.applyRequests[0]?.operations[0]).toEqual({
      op: "remove_clip",
      clips: ["c1", "ph"],
    });
    expect(result.text).toContain("removed the untouched template placeholder");
    expect(result.text).toContain("Kept 1 clip on other tracks");
  });

  it("maps kept material over black/frozen picture onto timeline times", async () => {
    const { host, call } = setup();
    host.overviewResult = {
      ...sampleOverview(),
      shots: {
        count: 3,
        averageSeconds: 10,
        problems: [
          { kind: "black", start: 100, end: 102 },
          { kind: "frozen", start: 21, end: 23 },
          { kind: "black", start: 500, end: 510 },
        ],
      },
    };
    await call("plan_cut", { source: SAMPLE_SOURCE });
    const result = await call("build_rough_cut", { plan: "cut-1", track: 2 });
    // range [100.5, 104] sits at 12.5: the black stretch keeps 100.5–102 → 12.5–14; [20, 30] at 2.5: frozen 21–23 → 3.5–5.5.
    expect(result.text).toContain(
      "- frozen at 00:03.5–00:05.5 (3.5–5.5 s on the timeline; source 00:21.0–00:23.0)",
    );
    expect(result.text).toContain(
      "- black at 00:12.5–00:14.0 (12.5–14 s on the timeline; source 01:40.5–01:42.0)",
    );
    expect(result.text).not.toContain("500");
    expect(result.text).toContain("track 2");
    expect(result.text.indexOf("frozen at")).toBeLessThan(result.text.indexOf("black at"));
  });

  it("sends no remove operation for a timeline that does not play the source", async () => {
    const { editing, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE });
    await call("build_rough_cut", { plan: "cut-1" });
    expect(editing.applyRequests[0]?.operations.map((operation) => operation.op)).toEqual([
      "add_sequence",
      "set_composition",
    ]);
  });

  it("reports the edit error when the batch is refused, and writes nothing else", async () => {
    const { editing, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE });
    editing.nextApplyError = new EditingError("conflict", "the composition changed", 1);
    expect(await call("build_rough_cut", { plan: "cut-1" })).toEqual({
      isError: true,
      text: "conflict (operations[1]): the composition changed",
    });
    expect(editing.applyFinished).toEqual([]);
  });

  it("writes word-synced captions for exactly the kept material in the same batch when asked", async () => {
    const { host, editing, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE });
    const result = await call("build_rough_cut", { plan: "cut-1", captions: "karaoke" });

    expect(result.isError).toBeUndefined();
    expect(host.transcriptRequests.at(-1)).toEqual({
      source: SAMPLE_SOURCE,
      from: 12.5,
      to: 104,
      words: true,
    });
    expect(editing.applyRequests).toHaveLength(1);
    const operations = editing.applyRequests[0]?.operations ?? [];
    expect(operations.map((operation) => operation.op)).toEqual([
      "add_sequence",
      "set_composition",
      "apply_captions",
    ]);
    const captions = operations[2];
    if (captions?.op !== "apply_captions") throw new Error("expected apply_captions");
    expect(captions.preset).toBe("karaoke");
    // The second sentence plays first (0–2.5 s), the third follows (2.5–12.5 s); the third range has no speech.
    expect(captions.cues[0]).toMatchObject({ text: "w4 w5 w6 w7 w8 w9", start: 0 });
    expect(captions.cues.every((cue) => cue.end <= 12.5 + 1e-6)).toBe(true);
    expect(captions.cues.map((cue) => cue.start)).toEqual(
      [...captions.cues.map((cue) => cue.start)].sort((a, b) => a - b),
    );
    // Cues break at the sentence end: no cue carries words of both sentences.
    expect(captions.cues.some((cue) => cue.text.includes("w9") && cue.text.includes("w10"))).toBe(
      false,
    );
    expect(result.text).toContain(`Captions: ${captions.cues.length} cues in the karaoke style`);
  });

  it("refuses a caption argument that is not a preset name before editing", async () => {
    const { editing, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE });
    expect((await call("build_rough_cut", { plan: "cut-1", captions: 3 })).text).toMatch(
      /^invalid_request: captions must be the name of a caption preset/,
    );
    expect(editing.applyRequests).toEqual([]);
  });

  it("validates its arguments and refuses unknown plans and oversized plans before editing", async () => {
    const { host, editing, call } = setup();
    expect((await call("build_rough_cut", {})).text).toMatch(
      /^invalid_request: plan must be a plan id/,
    );
    expect((await call("build_rough_cut", { plan: "cut-9" })).text).toMatch(/^unknown_plan:/);
    await call("plan_cut", { source: SAMPLE_SOURCE });
    expect((await call("build_rough_cut", { plan: "cut-1", track: -1 })).text).toMatch(
      /^invalid_request: track must be an integer/,
    );

    host.planRanges = Array.from({ length: 1_001 }, (_, index) => ({
      from: index,
      to: index + 0.5,
      at: index * 0.5,
      segment: null,
      hook: false,
    }));
    await call("plan_cut", { source: SAMPLE_SOURCE });
    expect((await call("build_rough_cut", { plan: "cut-2" })).text).toMatch(
      /^invalid_request: Plan cut-2 has 1001 ranges/,
    );
    expect(editing.applyRequests).toEqual([]);
  });

  it("refuses a plan the service reports as out of date and builds nothing", async () => {
    const { host, editing, call } = setup();
    await call("plan_cut", { source: SAMPLE_SOURCE });
    const plan = host.cutPlans.get("cut-1");
    if (!plan) throw new Error("plan_cut stored no plan");
    host.cutPlans.set("cut-1", {
      ...plan,
      warnings: ["This plan is out of date: assets/raw-talk.mp4 changed after the plan was made"],
      outOfDate: "assets/raw-talk.mp4 changed after the plan was made",
    });
    const result = await call("build_rough_cut", { plan: "cut-1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /^stale: Cut plan cut-1 is out of date: assets\/raw-talk\.mp4 changed/,
    );
    expect(result.text).toContain("plan_cut");
    expect(editing.applyRequests).toEqual([]);
  });

  it("is unavailable without an editing host", async () => {
    const host = new FakeAnalysisHost();
    const analysis = new TurnAnalysis({
      host,
      editing: null,
      turnSignal: new AbortController().signal,
      pollMs: 1,
    });
    await analysis.execute("plan_cut", { source: SAMPLE_SOURCE }, new AbortController().signal);
    expect(
      await analysis.execute("build_rough_cut", { plan: "cut-1" }, new AbortController().signal),
    ).toEqual({
      isError: true,
      text: "unavailable: Editing is not available in this runtime.",
    });
  });
});

describe("activity rows", () => {
  function labels(agent: AgentId, planClips?: (plan: string) => number | undefined) {
    const tools = buildHostTools(
      agent,
      { enabled: [], jev: false, editing: true, analysis: true, ...(planClips && { planClips }) },
      async () => ({ text: "" }),
    );
    return (name: string, args: unknown) =>
      tools.find((tool) => tool.name === name)?.activity?.(args);
  }

  it("labels calls for the chat without exposing raw arguments", () => {
    const label = labels("director", (plan) => (plan === "cut-2" ? 143 : undefined));
    expect(label("analyze_media", { source: "assets/raw-talk.mp4" })).toEqual({
      category: "other",
      label: "Analyzing raw-talk.mp4",
      labelCode: "analyzing_source",
      labelParams: { name: "raw-talk.mp4" },
    });
    expect(label("read_analysis", { source: "a.mp4", section: "takes" })?.label).toBe(
      "Reading the analysis · takes",
    );
    expect(label("read_analysis", { source: "a.mp4" })?.label).toBe("Reading the analysis");
    expect(label("read_transcript", {})?.label).toBe("Reading the transcript");
    expect(label("save_segments", { segments: new Array(14).fill({}) })?.label).toBe(
      "Saving 14 segments",
    );
    expect(label("save_segments", { segments: [{}] })?.label).toBe("Saving 1 segment");
    expect(label("inspect_frames", { times: [1, 2, 3, 4, 5, 6, 7, 8] })?.label).toBe(
      "Looking at 8 frames",
    );
    expect(label("save_vision_notes", { notes: [{}, {}, {}] })?.label).toBe(
      "Saving 3 visual notes",
    );
    expect(label("plan_cut", { label: "rough cut" })?.label).toBe("Planning the cut · rough cut");
    expect(label("build_rough_cut", { plan: "cut-2" })).toEqual({
      category: "edit",
      label: "Building the rough cut · 143 clips",
      labelCode: "building_rough_cut_clips",
      labelParams: { count: 143 },
    });
    expect(label("build_rough_cut", { plan: "cut-7" })?.label).toBe("Building the rough cut");
  });

  it("never throws on malformed arguments", () => {
    const label = labels("director");
    for (const name of ANALYSIS) {
      for (const args of [
        undefined,
        null,
        42,
        "x",
        [],
        { source: 7, segments: "no", times: {}, plan: [] },
      ]) {
        expect(() => label(name, args)).not.toThrow();
      }
    }
    expect(label("analyze_media", null)?.label).toBe("Analyzing the media");
    expect(label("save_segments", { segments: "no" })?.label).toBe("Saving 0 segments");
  });
});

describe("TurnAnalysis", () => {
  it("refuses unknown tools, and every call after shutdown", async () => {
    const { host, analysis, call } = setup();
    expect(await call("analyze_everything", {})).toEqual({
      isError: true,
      text: "Unknown analysis tool analyze_everything.",
    });
    await analysis.shutdown();
    expect(await call("read_analysis", { source: SAMPLE_SOURCE })).toEqual({
      isError: true,
      text: "The turn is finishing; analysis is closed.",
    });
    expect(host.overviewRequests).toEqual([]);
  });

  it("turns a non-object arguments payload into an error the model can correct", async () => {
    const { call } = setup();
    expect((await call("read_transcript", "s1")).text).toBe(
      "invalid_request: arguments must be a JSON object",
    );
  });

  it("does not leak unexpected failures as tool crashes", async () => {
    const { host, call } = setup();
    host.overview = async () => {
      throw new Error("boom");
    };
    expect(await call("read_analysis", { source: SAMPLE_SOURCE })).toEqual({
      isError: true,
      text: "internal: boom",
    });
  });
});
