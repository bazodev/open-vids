// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORY_GRAPH_SCHEMA } from "@hyperframes/agent-protocol";
import type {
  QaCheckResponse,
  QaCheckRun,
  QaIssueDraft,
  StoryGraph,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LayoutCheckFinding, StudioApiAdapter } from "../types.js";
import { QaFailure } from "./errors.js";
import { QaService, type QaAnalysis } from "./service.js";
import { writeHangExe } from "../helpers/fakeFfmpeg.js";
import {
  RENDERS,
  composition,
  createQaProject,
  hasFfmpeg,
  makeMedia,
  type ClipSpec,
  type QaProject,
} from "./testSupport.js";
import { timelineIssues } from "./timelineChecks.js";
import type { QaTimeline } from "./timelineModel.js";

const run = hasFfmpeg ? describe : describe.skip;

let media = "";
beforeAll(() => {
  media = mkdtempSync(join(tmpdir(), "openvids-qa-media-"));
  if (hasFfmpeg) makeMedia(media);
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

const projects: QaProject[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

const NOT_ANALYSED: QaAnalysis = {
  sourceData: async () => {
    throw new Error("not analysed");
  },
};

const REQUEST = { render: "renders/out.mp4", framesPerMinute: 12, maxFrames: 24 } as const;

function setup(options: {
  duration: number;
  clips: ClipSpec[];
  render?: (file: string) => void;
  adapter?: Partial<StudioApiAdapter>;
  analysis?: QaAnalysis;
  ffmpegPath?: string;
}) {
  const project = createQaProject({
    media,
    html: composition(options.duration, options.clips),
    adapter: options.adapter,
  });
  projects.push(project);
  options.render?.(project.path("renders/out.mp4"));
  const service = new QaService(project.adapter, options.analysis ?? NOT_ANALYSED, {
    ffmpegPath: options.ffmpegPath,
  });
  return { project, service };
}

const video = (id: string, src: string, attrs: string): ClipSpec => ({
  id,
  attrs: `src="assets/${src}" ${attrs} playsinline`,
});

function statusOf(response: QaCheckResponse, id: QaCheckRun["id"]): QaCheckRun {
  const found = response.checks.find((check) => check.id === id);
  if (!found) throw new Error(`no ${id} check in ${JSON.stringify(response.checks)}`);
  return found;
}

const byCheck = (response: QaCheckResponse, check: string): QaIssueDraft[] =>
  response.issues.filter((issue) => issue.check === check);

function only(issues: QaIssueDraft[]): QaIssueDraft {
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  if (!issue) throw new Error("unreachable");
  return issue;
}

run("render checks", () => {
  it("finds a black stretch in the render and does not report the same hole twice", async () => {
    const { service, project } = setup({
      duration: 5.5,
      clips: [
        video("first", "a.mp4", 'data-start="0" data-duration="2" data-track-index="0"'),
        video("second", "a.mp4", 'data-start="3.5" data-duration="2" data-track-index="0"'),
      ],
      render: RENDERS.blackGap,
    });
    const response = await service.check(project.project, REQUEST);
    const black = only(response.issues.filter((issue) => issue.kind === "black_frames"));
    expect(black).toMatchObject({
      severity: "error",
      source: "render",
      check: "blackdetect",
      owner: "editor",
      fixable: true,
    });
    expect(black.start).toBeCloseTo(2, 0);
    expect(black.end).toBeCloseTo(3.5, 0);
    // The clips on both sides of the hole are named so the editor can act on them.
    expect(black.clipIds).toEqual(expect.arrayContaining(["hf-first", "hf-second"]));
    // The timeline's own prediction of this hole is the same issue: not reported again.
    expect(byCheck(response, "timeline.gap")).toEqual([]);
    expect(statusOf(response, "black_frames").status).toBe("ran");
    expect(statusOf(response, "render").detail).toContain("160×120");
  });

  it("reports a hole of the timeline that the render does not show as black", async () => {
    const { service, project } = setup({
      duration: 6,
      clips: [
        video("first", "a.mp4", 'data-start="0" data-duration="2" data-track-index="0"'),
        video("second", "a.mp4", 'data-start="4" data-duration="2" data-track-index="0"'),
      ],
      render: RENDERS.clean,
    });
    const gap = only(byCheck(await service.check(project.project, REQUEST), "timeline.gap"));
    expect(gap).toMatchObject({ kind: "black_frames", source: "timeline", severity: "error" });
    expect([gap.start, gap.end]).toEqual([2, 4]);
  });

  it("drops a render freeze where the source is static by design and keeps one where the source moves", async () => {
    // A card never moves (one is pixel-perfect, one carries sensor noise the encode flattened), so a render that
    // shows it frozen is exactly right.
    for (const source of ["card.mp4", "noisycard.mp4"]) {
      const card = setup({
        duration: 5,
        clips: [video("card", source, 'data-start="0" data-duration="5" data-track-index="0"')],
        render: RENDERS.staticCard,
      });
      const still = await card.service.check(card.project.project, REQUEST);
      expect(still.issues.filter((issue) => issue.kind === "frozen_frames")).toEqual([]);
      expect(statusOf(still, "frozen_frames").status).toBe("ran");
    }

    // The source moves all along (and is long enough), but the render holds a frame from 2 s: the render is stuck.
    const stuck = setup({
      duration: 5,
      clips: [video("talk", "a.mp4", 'data-start="0" data-duration="5" data-track-index="0"')],
      render: RENDERS.frozenTail,
    });
    const response = await stuck.service.check(stuck.project.project, REQUEST);
    const frozen = only(response.issues.filter((issue) => issue.kind === "frozen_frames"));
    expect(frozen).toMatchObject({
      severity: "warning",
      source: "render",
      check: "freezedetect",
      subject: "hf-talk",
      owner: "editor",
    });
    expect(frozen.start).toBeCloseTo(2, 0);
    expect(frozen.end).toBeCloseTo(5, 1);
  });

  it("reports a video clip playing past its media as one frozen-picture issue, found by both checks", async () => {
    const { service, project } = setup({
      duration: 5,
      clips: [video("tail", "short.mp4", 'data-start="0" data-duration="5" data-track-index="0"')],
      render: RENDERS.frozenTail,
    });
    const response = await service.check(project.project, REQUEST);
    const frozen = only(response.issues.filter((issue) => issue.kind === "frozen_frames"));
    expect(frozen).toMatchObject({
      severity: "error",
      check: "timeline.past_media",
      subject: "hf-tail",
      clipIds: ["hf-tail"],
      owner: "editor",
    });
    expect(frozen.start).toBeCloseTo(2, 0);
    expect(frozen.end).toBeCloseTo(5, 1);
    // The render's freeze on the same clip was folded into it rather than counted as a second problem.
    expect(frozen.message).toContain("and 1 more like it");
    expect(statusOf(response, "frozen_frames").status).toBe("ran");
  });

  it("finds a silent stretch under an audible clip, owned by the editor for A-roll and the audio specialist for audio clips", async () => {
    const aroll = setup({
      duration: 6,
      clips: [video("talk", "a.mp4", 'data-start="0" data-duration="6" data-track-index="0"')],
      render: RENDERS.silentStretch,
    });
    const silence = only(
      byCheck(await aroll.service.check(aroll.project.project, REQUEST), "audio.silence"),
    );
    expect(silence).toMatchObject({
      kind: "audio_gap",
      severity: "warning",
      subject: "hf-talk",
      owner: "editor",
    });
    expect(silence.start).toBeCloseTo(2, 0);
    expect(silence.end).toBeCloseTo(4.5, 0);

    const music = setup({
      duration: 6,
      clips: [
        video("pic", "short.mp4", 'data-start="0" data-duration="2" data-track-index="0"'),
        {
          id: "bed",
          tag: "audio",
          attrs: 'src="assets/a.mp4" data-start="0" data-duration="6" data-track-index="3"',
        },
      ],
      render: RENDERS.silentStretch,
    });
    const quiet = only(
      byCheck(await music.service.check(music.project.project, REQUEST), "audio.silence"),
    );
    expect(quiet).toMatchObject({ subject: "hf-bed", owner: "audio" });
  });

  it("drops a render silence that is a pause in the clip's own source, and keeps one where the source has sound", async () => {
    const clip = (src: string) => [
      video("talk", src, 'data-start="0" data-duration="6" data-track-index="0"'),
    ];
    // No silence map in the analysis store: the source segment itself is measured.
    const natural = setup({
      duration: 6,
      clips: clip("paused.mp4"),
      render: RENDERS.silentStretch,
    });
    expect(
      byCheck(await natural.service.check(natural.project.project, REQUEST), "audio.silence"),
    ).toEqual([]);
    const stuck = setup({ duration: 6, clips: clip("a.mp4"), render: RENDERS.silentStretch });
    expect(
      only(byCheck(await stuck.service.check(stuck.project.project, REQUEST), "audio.silence")),
    ).toMatchObject({ subject: "hf-talk", owner: "editor" });

    // The cached level-based silence map decides when there is one: it wins over what the file would measure.
    const silenceMap = (silences: Array<{ start: number; end: number }>): QaAnalysis => ({
      sourceData: async (_project, source) => ({
        source,
        kind: "video",
        duration: 6,
        transcript: null,
        takes: null,
        silence: { source, thresholdDb: -45, minSilence: 0.2, silences, silenceSeconds: 2.5 },
        segments: null,
        version: "v1",
      }),
    });
    const mapped = setup({
      duration: 6,
      clips: clip("a.mp4"),
      render: RENDERS.silentStretch,
      analysis: silenceMap([{ start: 1.9, end: 4.6 }]),
    });
    expect(
      byCheck(await mapped.service.check(mapped.project.project, REQUEST), "audio.silence"),
    ).toEqual([]);
    const elsewhere = setup({
      duration: 6,
      clips: clip("paused.mp4"),
      render: RENDERS.silentStretch,
      analysis: silenceMap([{ start: 0, end: 0.5 }]),
    });
    expect(
      only(
        byCheck(await elsewhere.service.check(elsewhere.project.project, REQUEST), "audio.silence"),
      ),
    ).toMatchObject({ subject: "hf-talk" });
  });

  it("maps the render silence to the clip's source time before judging the source", async () => {
    // The clip plays its source from 1 s, so the render silence at 2–4.5 s is source 3–5.5 s. The source pause is
    // 2–4.5 s: only 1.5 of those 2.5 s are silent in the source, so this is not a natural pause. Compared at the same
    // numbers (no mapping) it would look like one.
    const { service, project } = setup({
      duration: 5,
      clips: [
        video(
          "talk",
          "paused.mp4",
          'data-start="0" data-duration="5" data-media-start="1" data-track-index="0"',
        ),
      ],
      render: RENDERS.silentStretch,
    });
    const response = await service.check(project.project, REQUEST);
    expect(only(byCheck(response, "audio.silence"))).toMatchObject({ subject: "hf-talk" });
  });

  it("reports a hole in the sound that no audible clip covers, between audible clips", async () => {
    // A-roll 0–2 s, nothing from 2 to 4.5 s, A-roll again 4.5–6 s; the render is silent from 2 s to 4.5 s.
    const aroll = setup({
      duration: 6,
      clips: [
        video("before", "a.mp4", 'data-start="0" data-duration="2" data-track-index="0"'),
        video("after", "a.mp4", 'data-start="4.5" data-duration="1.5" data-track-index="0"'),
      ],
      render: RENDERS.silentStretch,
    });
    const response = await aroll.service.check(aroll.project.project, REQUEST);
    const hole = only(byCheck(response, "render.audio_hole"));
    expect(hole).toMatchObject({
      kind: "audio_gap",
      severity: "warning",
      source: "render",
      subject: "hole:2.0",
      clipIds: ["hf-before", "hf-after"],
      owner: "editor",
      fixable: true,
    });
    expect(hole.start).toBeCloseTo(2, 0);
    expect(hole.end).toBeCloseTo(4.5, 0);
    expect(hole.message).toContain("The sound drops out for");
    // The "silence under an audible clip" rule does not fire for a stretch nothing is meant to cover.
    expect(byCheck(response, "audio.silence")).toEqual([]);

    // Only music or sound effects on both sides of the hole: the audio specialist owns it.
    const music = setup({
      duration: 6,
      clips: [
        {
          id: "m1",
          tag: "audio",
          attrs: 'src="assets/a.mp4" data-start="0" data-duration="2" data-track-index="3"',
        },
        {
          id: "m2",
          tag: "audio",
          attrs: 'src="assets/a.mp4" data-start="4.5" data-duration="1.5" data-track-index="3"',
        },
      ],
      render: RENDERS.silentStretch,
    });
    expect(
      only(byCheck(await music.service.check(music.project.project, REQUEST), "render.audio_hole")),
    ).toMatchObject({ owner: "audio", clipIds: ["hf-m1", "hf-m2"] });
  });

  it("does not call silence after the last audible clip (or before the first) a hole", async () => {
    const tail = setup({
      duration: 6,
      clips: [video("talk", "a.mp4", 'data-start="0" data-duration="2" data-track-index="0"')],
      render: RENDERS.silentStretch,
    });
    const afterLast = await tail.service.check(tail.project.project, REQUEST);
    expect(byCheck(afterLast, "render.audio_hole")).toEqual([]);

    const head = setup({
      duration: 6,
      clips: [video("talk", "a.mp4", 'data-start="4.5" data-duration="1.5" data-track-index="0"')],
      render: RENDERS.silentStretch,
    });
    expect(
      byCheck(await head.service.check(head.project.project, REQUEST), "render.audio_hole"),
    ).toEqual([]);
  });

  it("reports a render without an audio stream when the timeline has audible clips, and skips the check when none is expected", async () => {
    const audible = setup({
      duration: 4,
      clips: [video("talk", "a.mp4", 'data-start="0" data-duration="4" data-track-index="0"')],
      render: RENDERS.videoOnly,
    });
    const response = await audible.service.check(audible.project.project, REQUEST);
    expect(only(byCheck(response, "audio.no_stream"))).toMatchObject({
      kind: "audio_gap",
      severity: "error",
      owner: "audio",
      clipIds: ["hf-talk"],
    });
    expect(statusOf(response, "audio").status).toBe("ran");

    const silent = setup({
      duration: 4,
      clips: [video("pic", "short.mp4", 'data-start="0" data-duration="2" data-track-index="0"')],
      render: RENDERS.videoOnly,
    });
    const quiet = await silent.service.check(silent.project.project, REQUEST);
    expect(quiet.issues.filter((issue) => issue.kind === "audio_gap")).toEqual([]);
    expect(statusOf(quiet, "audio").status).toBe("skipped");
  });

  it("finds nothing in a clean render of a clean timeline", async () => {
    const { service, project } = setup({
      duration: 6,
      clips: [video("talk", "a.mp4", 'data-start="0" data-duration="6" data-track-index="0"')],
      render: RENDERS.clean,
    });
    const response = await service.check(project.project, REQUEST);
    expect(response.issues).toEqual([]);
    expect(response.checks.map((check) => [check.id, check.status])).toEqual([
      ["render", "ran"],
      ["black_frames", "ran"],
      ["frozen_frames", "ran"],
      ["audio", "ran"],
      ["timeline", "ran"],
      ["layout", "unavailable"],
    ]);
    expect(response.duration).toBeCloseTo(6, 1);
    expect(response.composition).toBe("index.html");
    expect(response.timelineVersion).toMatch(/^sha256:/);
    expect(response.fingerprint).toBe(service.state(project.project).fingerprint);
  });

  it("answers with unavailable checks, not an error, when ffmpeg cannot run", async () => {
    const { service, project } = setup({
      duration: 6,
      clips: [
        video("flash", "short.mp4", 'data-start="1" data-duration="0.1" data-track-index="2"'),
      ],
      render: RENDERS.clean,
      ffmpegPath: "/nonexistent/ffmpeg",
    });
    const response = await service.check(project.project, REQUEST);
    for (const id of ["black_frames", "frozen_frames", "audio"] as const) {
      expect(statusOf(response, id).status).toBe("unavailable");
      expect(statusOf(response, id).detail).toContain("ffmpeg");
    }
    // The timeline check does not need ffmpeg and still ran.
    expect(statusOf(response, "timeline").status).toBe("ran");
    expect(byCheck(response, "timeline.flash_clip")).toHaveLength(1);
  });
});

function word(i: number, text: string, start: number, end: number) {
  return { i, text, start, end, speaker: null };
}

function transcript(words: TranscriptArtifact["words"]): TranscriptArtifact {
  return { source: "assets/a.mp4", language: "en", words, sentences: [], speechSeconds: 1 };
}

run("timeline checks", () => {
  const talk = transcript([word(0, "hello", 1, 1.6), word(1, "world", 3, 3.5)]);
  const analysis: QaAnalysis = {
    sourceData: async (_project, source) => {
      if (source !== "assets/a.mp4") throw new Error("not analysed");
      return {
        source,
        kind: "video",
        duration: 6,
        transcript: talk,
        takes: null,
        silence: null,
        segments: null,
        version: "v1",
      };
    },
  };

  it("finds a flash clip, a micro gap, a missing source file and a cut inside a word", async () => {
    const { service, project } = setup({
      duration: 6,
      clips: [
        video("main1", "a.mp4", 'data-start="0" data-duration="2" data-track-index="0"'),
        video("main2", "a.mp4", 'data-start="2.2" data-duration="2" data-track-index="0"'),
        video(
          "talk",
          "a.mp4",
          'data-start="4.2" data-duration="1.5" data-media-start="1.3" data-track-index="0"',
        ),
        video("flash", "short.mp4", 'data-start="1" data-duration="0.12" data-track-index="2"'),
        video("gone", "gone.mp4", 'data-start="3" data-duration="1" data-track-index="1" muted'),
      ],
      render: RENDERS.clean,
      analysis,
    });
    const response = await service.check(project.project, REQUEST);

    expect(only(byCheck(response, "timeline.flash_clip"))).toMatchObject({
      kind: "awkward_cut",
      subject: "hf-flash",
      clipIds: ["hf-flash"],
      severity: "warning",
    });
    const gap = only(byCheck(response, "timeline.micro_gap"));
    expect(gap).toMatchObject({ kind: "awkward_cut", clipIds: ["hf-main1", "hf-main2"] });
    expect(gap.end - gap.start).toBeCloseTo(0.2, 2);
    expect(only(byCheck(response, "timeline.missing_file"))).toMatchObject({
      kind: "missing_broll",
      severity: "error",
      subject: "assets/gone.mp4",
      clipIds: ["hf-gone"],
    });
    const cut = only(byCheck(response, "timeline.cut_in_word"));
    expect(cut).toMatchObject({
      kind: "awkward_cut",
      subject: "hf-talk:in",
      start: 4.2,
      clipIds: ["hf-talk"],
    });
    expect(cut.message).toContain('"hello"');
    expect(statusOf(response, "timeline").detail).toContain("1 transcript");
  });

  it("does not call a cut in a measured pause a cut inside a word, however long the word's timing", async () => {
    // Recognizer timings stretch "hello" over the pause after it (1.0–1.6); the level map measured silence at 1.25–1.6.
    const paused: QaAnalysis = {
      sourceData: async (project, source) => ({
        ...(await analysis.sourceData(project, source)),
        silence: {
          source,
          thresholdDb: -45,
          minSilence: 0.2,
          silences: [{ start: 1.25, end: 1.6 }],
          silenceSeconds: 0.35,
        },
      }),
    };
    const { service, project } = setup({
      duration: 6,
      clips: [
        video(
          "talk",
          "a.mp4",
          'data-start="0" data-duration="1.5" data-media-start="1.3" data-track-index="0"',
        ),
      ],
      render: RENDERS.clean,
      analysis: paused,
    });
    const response = await service.check(project.project, REQUEST);
    expect(byCheck(response, "timeline.cut_in_word")).toEqual([]);
  });

  it("does not look for cuts inside words without a fresh transcript, and says so", async () => {
    const { service, project } = setup({
      duration: 6,
      clips: [
        video(
          "talk",
          "a.mp4",
          'data-start="0" data-duration="1.5" data-media-start="1.3" data-track-index="0"',
        ),
      ],
      render: RENDERS.clean,
    });
    const response = await service.check(project.project, REQUEST);
    expect(byCheck(response, "timeline.cut_in_word")).toEqual([]);
    expect(statusOf(response, "timeline").detail).toContain("cuts inside words were not checked");
  });

  it("reports Missing Asset nodes of built chapters as unfixable research issues", () => {
    const base = {
      position: { x: 0, y: 0 },
      locked: false,
      createdBy: "ai" as const,
      userEdited: [],
    };
    const graph: StoryGraph = {
      schema: STORY_GRAPH_SCHEMA,
      id: "story-1",
      title: "Story",
      brief: "",
      settings: { composition: null, captionPreset: null },
      nodes: [
        {
          ...base,
          id: "c1",
          kind: "chapter",
          title: "Intro",
          purpose: "",
          description: "",
          narrativeRole: "intro",
          estimatedDuration: 4,
          status: "needs_material",
          sourceRanges: [],
          aRoll: "",
          bRoll: "",
          captions: false,
          graphics: "",
          audio: "",
          previewFrame: null,
        },
        {
          ...base,
          id: "m1",
          kind: "missing",
          title: "Keyboard close-up",
          mediaKind: "video",
          need: "shallow depth of field",
          neededDuration: null,
        },
        {
          ...base,
          id: "m2",
          kind: "missing",
          title: "Chapter that is not built",
          mediaKind: "picture",
          need: "x",
          neededDuration: null,
        },
        {
          ...base,
          id: "c2",
          kind: "chapter",
          title: "Later",
          purpose: "",
          description: "",
          narrativeRole: "main",
          estimatedDuration: 4,
          status: "needs_material",
          sourceRanges: [],
          aRoll: "",
          bRoll: "",
          captions: false,
          graphics: "",
          audio: "",
          previewFrame: null,
        },
      ],
      edges: [],
      attachments: [
        {
          id: "a1",
          node: "m1",
          chapter: "c1",
          placement: "middle",
          offset: null,
          duration: null,
          createdBy: "ai",
        },
        {
          id: "a2",
          node: "m2",
          chapter: "c2",
          placement: "middle",
          offset: null,
          duration: null,
          createdBy: "ai",
        },
      ],
      removedByUser: [],
      review: null,
      build: {
        at: 1,
        turnId: null,
        composition: "index.html",
        version: "v",
        duration: 4,
        chapters: [{ node: "c1", start: 0, end: 4, clips: 1 }],
        warnings: [],
      },
      updatedAt: 1,
      updatedBy: "ai",
    };
    const timeline: QaTimeline = {
      snapshot: {
        composition: { path: "index.html", width: 1920, height: 1080, duration: 4 },
        version: "v",
        tracks: [],
        clips: [],
      },
      rates: new Map(),
      missing: new Set(),
      hasAudio: new Map(),
      transcripts: new Map(),
      cues: [],
      graph,
    };
    const issues = timelineIssues(timeline);
    // m2 belongs to a chapter that was never built, so the timeline has no place waiting for it.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "missing_broll",
      severity: "warning",
      owner: "research",
      fixable: false,
      check: "story.missing_asset",
      start: 0,
      end: 4,
    });
    expect(issues[0]?.message).toContain("Keyboard close-up");
  });
});

run("layout check", () => {
  const TITLE: ClipSpec = {
    id: "title",
    tag: "div",
    attrs: 'data-start="0" data-duration="3" data-track-index="2"',
    text: "Big title",
  };
  const base: ClipSpec = video(
    "talk",
    "a.mp4",
    'data-start="0" data-duration="6" data-track-index="0"',
  );

  const finding = (extra: Partial<LayoutCheckFinding>): LayoutCheckFinding => ({
    code: "content_overlap",
    severity: "error",
    time: 1.5,
    selector: "#caption-word-0-1",
    containerSelector: "#title",
    text: "everyone",
    message: "Two text blocks overlap and may render unreadable.",
    fixHint: "Give each block its own zone.",
    ...extra,
  });

  it("maps audit findings to caption collisions, overlaps and out-of-bounds issues owned by motion", async () => {
    const calls: Array<{ times: number[] }> = [];
    const { service, project } = setup({
      duration: 6,
      clips: [base, TITLE],
      render: RENDERS.clean,
      adapter: {
        checkLayout: async ({ times }) => {
          calls.push({ times });
          return {
            samples: times,
            findings: [
              finding({}),
              finding({ selector: "#caption-word-0-2", text: "and" }),
              finding({
                code: "text_box_overflow",
                severity: "warning",
                selector: "#title",
                containerSelector: undefined,
                firstSeen: 1,
                lastSeen: 2,
                dataAttributes: { "data-hf-id": "hf-title" },
                message: "Text extends outside its box.",
              }),
              finding({ selector: "#a", containerSelector: "#b", text: "a" }),
              finding({ code: "sweep_static", selector: "[data-composition-id]" }),
            ],
          };
        },
      },
    });
    const response = await service.check(project.project, REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.times).toEqual([1.5]);
    expect(statusOf(response, "layout")).toMatchObject({ status: "ran" });

    const layout = response.issues.filter((issue) => issue.source === "layout");
    expect(layout).toHaveLength(3);
    const caption = only(layout.filter((issue) => issue.kind === "caption_collision"));
    expect(caption).toMatchObject({
      severity: "error",
      owner: "motion",
      fixable: true,
      subject: "caption × #title",
      check: "layout.content_overlap",
      suggestion: "Give each block its own zone.",
    });
    // The two caption words are one issue about the title, and the title clip is named through its DOM id.
    expect(caption.message).toContain("and 1 more like it");
    expect(caption.clipIds).toEqual(["hf-title"]);
    const bounds = only(layout.filter((issue) => issue.kind === "out_of_bounds"));
    expect(bounds).toMatchObject({
      owner: "motion",
      severity: "warning",
      start: 1,
      end: 2,
      subject: "#title",
    });
    expect(bounds.clipIds).toEqual(["hf-title"]);
    expect(only(layout.filter((issue) => issue.kind === "layout_overlap")).subject).toBe("#a × #b");
  });

  it("is unavailable without an adapter capability, and reports the adapter's reason or failure", async () => {
    const bare = setup({ duration: 6, clips: [base, TITLE], render: RENDERS.clean });
    const none = await bare.service.check(bare.project.project, REQUEST);
    expect(statusOf(none, "layout")).toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("no layout checker"),
    });

    const refused = setup({
      duration: 6,
      clips: [base, TITLE],
      render: RENDERS.clean,
      adapter: { checkLayout: async () => ({ unavailable: "Chrome is not installed" }) },
    });
    expect(
      statusOf(await refused.service.check(refused.project.project, REQUEST), "layout"),
    ).toEqual({
      id: "layout",
      status: "unavailable",
      detail: "Chrome is not installed",
    });

    const broken = setup({
      duration: 6,
      clips: [base, TITLE],
      render: RENDERS.clean,
      adapter: {
        checkLayout: async () => {
          throw new Error("browser crashed");
        },
      },
    });
    const crashed = await broken.service.check(broken.project.project, REQUEST);
    expect(statusOf(crashed, "layout")).toEqual({
      id: "layout",
      status: "failed",
      detail: "browser crashed",
    });
    // One failed check never fails the request: the others ran.
    expect(statusOf(crashed, "black_frames").status).toBe("ran");
  });

  it("skips the audit when there is nothing to audit or the composition is not the main one", async () => {
    let called = 0;
    const adapter: Partial<StudioApiAdapter> = {
      checkLayout: async ({ times }) => {
        called += 1;
        return { samples: times, findings: [] };
      },
    };
    const plain = setup({ duration: 6, clips: [base], render: RENDERS.clean, adapter });
    expect(
      statusOf(await plain.service.check(plain.project.project, REQUEST), "layout").status,
    ).toBe("skipped");

    const alt = setup({ duration: 6, clips: [base, TITLE], render: RENDERS.clean, adapter });
    alt.project.write("compositions/alt.html", composition(6, [TITLE]));
    const response = await alt.service.check(alt.project.project, {
      ...REQUEST,
      composition: "compositions/alt.html",
    });
    expect(statusOf(response, "layout")).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("main composition"),
    });
    expect(called).toBe(0);
  });
});

run("cancellation", () => {
  it("kills ffmpeg and stops the layout checker when the request is aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openvids-qa-hang-"));
    const exeDir = mkdtempSync(join(tmpdir(), "openvids-qa-fake-"));
    try {
      const pidFile = join(dir, "pid");
      // A `.sh` stand-in cannot exec on Windows (`spawn EFTYPE`): compiled
      // exe there (see helpers/fakeFfmpeg.ts), kept outside `dir` since
      // Windows locks a running exe's image file against cleanup.
      const hang = await writeHangExe(exeDir, pidFile);
      let layoutAborted = false;
      const { service, project } = setup({
        duration: 6,
        clips: [
          video("talk", "a.mp4", 'data-start="0" data-duration="6" data-track-index="0"'),
          {
            id: "title",
            tag: "div",
            attrs: 'data-start="0" data-duration="3" data-track-index="2"',
            text: "T",
          },
        ],
        render: RENDERS.clean,
        ffmpegPath: hang,
        adapter: {
          checkLayout: ({ signal }) => {
            const { promise, reject } = Promise.withResolvers<never>();
            signal.addEventListener("abort", () => {
              layoutAborted = true;
              reject(signal.reason);
            });
            return promise;
          },
        },
      });
      const controller = new AbortController();
      const outcome = service.check(project.project, REQUEST, controller.signal).then(
        () => null,
        (error: unknown) => error,
      );
      // Generous: the suite runs next to other ffmpeg-heavy suites.
      const WAIT = { timeout: 10_000, interval: 25 };
      // Both ffmpeg children (picture and audio) are running once each has written its pid.
      const pids = await vi.waitFor(() => {
        const started = readFileSync(pidFile, "utf-8").trim().split("\n").map(Number);
        expect(started.length).toBeGreaterThanOrEqual(2);
        return started;
      }, WAIT);
      controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(QaFailure);
      expect(error).toMatchObject({ error: { code: "cancelled" } });
      expect(layoutAborted).toBe(true);
      for (const pid of pids) {
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), WAIT);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // The killed exe's image lock releases asynchronously; best effort.
      try {
        rmSync(exeDir, { recursive: true, force: true });
      } catch {
        // Temp dir reclaimed by the OS; never fail the test on cleanup.
      }
    }
  }, 30_000);
});
