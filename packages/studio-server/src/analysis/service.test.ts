// @vitest-environment node
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisJob, AnalyzeRequest, SaveSegmentsRequest } from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeAssetRanges } from "../editing/assetRanges.js";
import type { ResolvedProject } from "../types.js";
import { isAnalysisFailure } from "./errors.js";
import { AnalysisService } from "./service.js";
import { AnalysisStore } from "./store.js";
import { writeBrokenExe, writeHangExe } from "../helpers/fakeFfmpeg.js";
import {
  addClip,
  createAnalysisProject,
  ffmpegSync,
  waitFor,
  hasFfmpeg,
  makeClip,
  SCRIPT,
  type TestProject,
} from "./testSupport.js";

const SOURCE = "assets/talk.mp4";
let scratch = "";
let clip = "";
const projects: TestProject[] = [];

beforeAll(() => {
  if (!hasFfmpeg) return;
  scratch = mkdtempSync(join(tmpdir(), "openvids-analysis-clip-"));
  clip = join(scratch, "clip.mp4");
  makeClip(clip);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const test of projects.splice(0)) test.cleanup();
});

function setup(options: { speech?: boolean; source?: string } = {}) {
  const test = createAnalysisProject({ speech: options.speech });
  projects.push(test);
  addClip(test, clip, options.source ?? SOURCE);
  const service = new AnalysisService(test.adapter);
  return { test, service, project: test.project };
}

async function settle(service: AnalysisService, project: ResolvedProject, job: AnalysisJob) {
  let current = job;
  await waitFor(() => {
    current = service.getJob(project, job.id) ?? job;
    return current.status !== "running";
  }, "the analysis job to finish");
  return current;
}

async function analyze(
  service: AnalysisService,
  project: ResolvedProject,
  request: Partial<AnalyzeRequest> = {},
) {
  return settle(service, project, await service.startJob(project, { source: SOURCE, ...request }));
}

const outcomes = (job: AnalysisJob) => job.results.map((result) => [result.stage, result.outcome]);
const ALL = ["silence", "speakers", "shots", "transcript", "takes", "segments"] as const;

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAnalysisFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** One segment over the whole transcript, the way an agent would after reading it. */
async function wholeTranscript(
  service: AnalysisService,
  project: ResolvedProject,
  source = SOURCE,
): Promise<SaveSegmentsRequest> {
  const view = await service.transcript(project, source, {});
  const last = view.sentences.at(-1)?.id ?? "s1";
  return {
    source,
    transcriptVersion: view.version,
    segments: [
      {
        firstSentence: "s1",
        lastSentence: last,
        title: "Talk",
        summary: "The whole talk",
        role: "main",
        priority: "should",
      },
    ],
  };
}

describe.skipIf(!hasFfmpeg)("analysis of a real clip", () => {
  it("computes every stage once and serves the next run, even from a new service, from the cache", async () => {
    const { test, service, project } = setup();
    const first = await analyze(service, project);
    expect(first.status).toBe("completed");
    expect(first.progress).toBe(100);
    expect(outcomes(first)).toEqual(ALL.map((stage) => [stage, "computed"]));

    const overview = await service.overview(project, SOURCE);
    expect(overview.silence?.longest[0]).toMatchObject({
      start: expect.closeTo(3, 0),
      end: expect.closeTo(5, 0),
    });
    expect(overview.shots?.count).toBeGreaterThanOrEqual(3);
    expect(overview.shots?.problems.some((problem) => problem.kind === "black")).toBe(true);
    expect(overview.transcript?.sentences).toBeGreaterThanOrEqual(4);
    expect(overview.speakers?.method).toBe("single");
    expect(overview.segments?.origin).toBe("draft");
    expect(
      overview.status.stages.every(
        (stage) => stage.status === "fresh" || stage.status === "missing",
      ),
    ).toBe(true);

    const restarted = new AnalysisService(test.adapter);
    const second = await analyze(restarted, project);
    expect(outcomes(second)).toEqual(ALL.map((stage) => [stage, "cached"]));
    expect(test.speech.transcribeCalls).toBe(1);
    expect(test.speech.diarizeCalls).toBe(1);
  });

  it("joins a second request for a source that is being analysed instead of starting another job", async () => {
    const { test, service, project } = setup();
    test.speech.hang = true;
    const first = await service.startJob(project, { source: SOURCE });
    const second = await service.startJob(project, { source: `./${SOURCE}` });
    expect(second.id).toBe(first.id);
    await service.cancelJob(project, first.id);
  });

  it("cancels a job: the recognizer is aborted, finished stages stay cached, the next run resumes", async () => {
    const { test, service, project } = setup();
    test.speech.hang = true;
    const job = await service.startJob(project, { source: SOURCE });
    // The stage flips to "transcript" before the recognizer is called; wait for the call itself so the cancel
    // reaches a running recognizer even when the machine is busy.
    await waitFor(() => test.speech.transcribeCalls === 1, "the recognizer to start");
    const cancelled = await service.cancelJob(project, job.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error?.code).toBe("cancelled");
    expect(test.speech.abortedCalls).toBe(1);
    expect(outcomes(cancelled ?? job)).toEqual([
      ["silence", "computed"],
      ["speakers", "computed"],
      ["shots", "computed"],
    ]);

    test.speech.hang = false;
    const resumed = await analyze(service, project);
    expect(outcomes(resumed)).toEqual([
      ["silence", "cached"],
      ["speakers", "cached"],
      ["shots", "cached"],
      ["transcript", "computed"],
      ["takes", "computed"],
      ["segments", "computed"],
    ]);
  });

  // The Windows stand-in is a ~86 MB compiled exe whose first spawn takes
  // ~1 s cold, so this gets a longer budget than the 5 s default.
  it("kills the ffmpeg child when a job is cancelled", async () => {
    const test = createAnalysisProject();
    projects.push(test);
    addClip(test, clip, SOURCE);
    const pidFile = join(test.root, "pid");
    // A `.sh` stand-in cannot exec on Windows (`spawn EFTYPE`), so the
    // stand-in is a tiny compiled exe there (see helpers/fakeFfmpeg.ts).
    // It lives outside the project dir: Windows locks a running exe's own
    // image file, which would break the project's recursive cleanup.
    const exeDir = mkdtempSync(join(tmpdir(), "openvids-fake-ffmpeg-"));
    const fake = await writeHangExe(exeDir, pidFile);
    try {
      const service = new AnalysisService(test.adapter, { ffmpegPath: fake });
      const project = test.project;

      const job = await service.startJob(project, { source: SOURCE, stages: ["silence"] });
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() !== "",
        "ffmpeg to start",
      );
      const pid = Number(readFileSync(pidFile, "utf-8"));
      expect(() => process.kill(pid, 0)).not.toThrow();

      expect((await service.cancelJob(project, job.id))?.status).toBe("cancelled");
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "the ffmpeg process to be gone");
    } finally {
      // The killed exe's image lock releases asynchronously; best effort.
      try {
        rmSync(exeDir, { recursive: true, force: true });
      } catch {
        // Temp dir reclaimed by the OS; never fail the test on cleanup.
      }
    }
  }, 30_000);

  it("fails one stage without losing the others: a broken ffmpeg fails silence and keeps the transcript", async () => {
    const test = createAnalysisProject();
    projects.push(test);
    addClip(test, clip, SOURCE);
    const fake = await writeBrokenExe(test.root);
    const service = new AnalysisService(test.adapter, { ffmpegPath: fake });

    const job = await settle(
      service,
      test.project,
      await service.startJob(test.project, { source: SOURCE }),
    );
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("failed");
    expect(outcomes(job)).toEqual([
      ["silence", "failed"],
      ["speakers", "computed"],
      ["shots", "failed"],
      ["transcript", "computed"],
      ["takes", "computed"],
      ["segments", "computed"],
    ]);
    const overview = await service.overview(test.project, SOURCE);
    expect(overview.silence).toBeNull();
    expect(overview.status.stages.find((stage) => stage.stage === "silence")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("boom"),
    });
  });
});

describe.skipIf(!hasFfmpeg)("invalidation and reuse", () => {
  it("treats a touched file as unchanged and an edited one as stale, wiping frames, notes and agent segments", async () => {
    const { test, service, project } = setup();
    await analyze(service, project);
    await service.saveSegments(project, await wholeTranscript(service, project));
    await service.frames(project, { source: SOURCE, times: [1] });
    await service.saveVisionNotes(project, {
      source: SOURCE,
      notes: [
        { start: 0, end: 1, frames: [1], quality: "good", tags: ["slate"], finding: "a slate" },
      ],
    });
    const framesDir = join(test.project.dir, ".hyperframes/analysis/sources");

    // Same bytes, newer mtime: still fresh, nothing recomputed.
    const file = test.path(SOURCE);
    const later = new Date(statSync(file).mtimeMs + 60_000);
    utimesSync(file, later, later);
    const sources = await service.listSources(project);
    expect(sources[0]?.stages.filter((stage) => stage.status === "stale")).toEqual([]);
    expect(outcomes(await analyze(service, project))).toEqual(
      ALL.map((stage) => [stage, "cached"]),
    );
    expect(test.speech.transcribeCalls).toBe(1);

    // Different bytes: every stored stage is stale and served nowhere until analysed again.
    appendFileSync(file, Buffer.alloc(64, 1));
    const stale = (await service.listSources(project))[0];
    expect(
      stale?.stages.filter((stage) => stage.status === "stale").map((stage) => stage.stage),
    ).toEqual(expect.arrayContaining(["silence", "transcript", "segments", "vision"]));
    expect((await rejection(service.transcript(project, SOURCE, {}))).code).toBe("stale");
    expect((await rejection(service.frames(project, { source: SOURCE, times: [1] }))).code).toBe(
      "stale",
    );
    expect((await service.overview(project, SOURCE)).transcript).toBeNull();
    expect(existsSync(framesDir)).toBe(true);

    const rerun = await analyze(service, project);
    expect(outcomes(rerun)).toEqual(ALL.map((stage) => [stage, "computed"]));
    expect(test.speech.transcribeCalls).toBe(2);
    const overview = await service.overview(project, SOURCE);
    expect(overview.segments?.origin).toBe("draft");
    expect(overview.vision).toBeNull();
    expect(await service.artifact(project, SOURCE, "vision")).toEqual({
      source: SOURCE,
      notes: [],
      inspectedFrames: [],
    });
    const again = await service.frames(project, { source: SOURCE, times: [1] });
    expect(again.frames[0]?.cached).toBe(false);
  });

  it("reuses the artifacts of a renamed file with identical content instead of recognizing it again", async () => {
    const { test, service, project } = setup();
    await analyze(service, project);
    await service.saveSegments(project, await wholeTranscript(service, project));

    renameSync(test.path(SOURCE), test.path("assets/renamed.mp4"));
    const job = await settle(
      service,
      project,
      await service.startJob(project, { source: "assets/renamed.mp4" }),
    );
    expect(outcomes(job)).toEqual(ALL.map((stage) => [stage, "cached"]));
    expect(test.speech.transcribeCalls).toBe(1);

    const transcript = await service.artifact(project, "assets/renamed.mp4", "transcript");
    expect(transcript).toMatchObject({ source: "assets/renamed.mp4" });
    const overview = await service.overview(project, "assets/renamed.mp4");
    expect(overview.segments).toMatchObject({ origin: "semantic", source: "assets/renamed.mp4" });
    expect(overview.segments?.transcriptVersion).toBe(overview.transcript?.version);
    expect((await service.listSources(project)).map((entry) => entry.source)).toEqual([
      "assets/renamed.mp4",
    ]);
  });

  it("sweeps the analysis and cut plans of a deleted file but never reuses their ids", async () => {
    const { test, project } = setup();
    const service = new AnalysisService(test.adapter, { orphanIntervalMs: 0 });
    await analyze(service, project);
    await service.saveSegments(project, await wholeTranscript(service, project));
    await service.planCut(project, { source: SOURCE });
    const store = new AnalysisStore(project.dir);
    expect((await store.listManifests()).map((manifest) => manifest.path)).toEqual([SOURCE]);

    rmSync(test.path(SOURCE));
    expect((await service.listSources(project)).map((entry) => entry.source)).toEqual([]);
    expect(await store.listManifests()).toEqual([]);
    expect(await store.listCuts()).toEqual([]);

    addClip(test, clip, "assets/other.mp4");
    await analyze(service, project, { source: "assets/other.mp4" });
    await service.saveSegments(project, {
      ...(await wholeTranscript(service, project, "assets/other.mp4")),
    });
    expect((await service.planCut(project, { source: "assets/other.mp4" })).id).toBe("cut-2");
  });

  it("keeps the artifacts of a renamed file for adoption, then drops the old copy once the new name has them", async () => {
    const { test, project } = setup();
    const service = new AnalysisService(test.adapter, { orphanIntervalMs: 0 });
    await analyze(service, project);
    const store = new AnalysisStore(project.dir);

    renameSync(test.path(SOURCE), test.path("assets/renamed.mp4"));
    expect((await service.cleanOrphans(project))?.sources).toEqual([]);
    expect((await store.listManifests()).map((manifest) => manifest.path)).toEqual([SOURCE]);

    const job = await settle(
      service,
      project,
      await service.startJob(project, { source: "assets/renamed.mp4" }),
    );
    expect(outcomes(job)).toEqual(ALL.map((stage) => [stage, "cached"]));
    expect(test.speech.transcribeCalls).toBe(1);

    expect((await service.cleanOrphans(project))?.sources).toEqual([SOURCE]);
    expect((await store.listManifests()).map((manifest) => manifest.path)).toEqual([
      "assets/renamed.mp4",
    ]);
  });

  it("runs the sweep at most once per interval unless forced", async () => {
    const { test, project } = setup();
    const service = new AnalysisService(test.adapter, { orphanIntervalMs: 60_000 });
    expect(await service.cleanOrphans(project)).not.toBeNull();
    expect(await service.cleanOrphans(project)).toBeNull();
    expect(await service.cleanOrphans(project, { force: true })).not.toBeNull();
  });

  it("keeps agent segments while the transcript is unchanged and drops them when it changes", async () => {
    const { test, service, project } = setup();
    await analyze(service, project);
    await service.saveSegments(project, await wholeTranscript(service, project));

    // A recomputed pause map does not disturb them, not even under force; the transcript they need is not recomputed.
    const silence = await analyze(service, project, {
      stages: ["silence", "segments"],
      force: true,
    });
    expect(outcomes(silence)).toEqual([
      ["silence", "computed"],
      ["transcript", "cached"],
      ["segments", "cached"],
    ]);
    expect(test.speech.transcribeCalls).toBe(1);
    expect(silence.results[2]?.detail).toContain("kept");
    expect((await service.overview(project, SOURCE)).segments?.origin).toBe("semantic");

    // Words that differ make a new transcript version: the agent's sentence ids no longer mean anything.
    test.speech.words = SCRIPT.slice(0, 10);
    const changed = await analyze(service, project, { force: true });
    expect(outcomes(changed).find(([stage]) => stage === "transcript")).toEqual([
      "transcript",
      "computed",
    ]);
    const segments = changed.results.find((result) => result.stage === "segments");
    expect(segments).toMatchObject({ outcome: "computed" });
    expect(segments?.detail).toContain("dropped");
    expect((await service.overview(project, SOURCE)).segments?.origin).toBe("draft");
  });

  it("recomputes a stage whose recorded recipe is older, rebuilding the transcript without recognizing again", async () => {
    const { test, service, project } = setup();
    await analyze(service, project);
    await service.saveSegments(project, await wholeTranscript(service, project));
    const before = await service.overview(project, SOURCE);

    // A stage made by an older method is stale, and so is whatever was built on it.
    await new AnalysisStore(project.dir).updateManifest(SOURCE, (manifest) => {
      const record = manifest.stages.transcript;
      if (record) record.recipe = "sentences/1";
    });
    const states = (await service.listSources(project))[0]?.stages ?? [];
    expect(states.find((stage) => stage.stage === "transcript")).toMatchObject({
      status: "stale",
      detail: "analysis method updated",
    });
    expect(states.find((stage) => stage.stage === "takes")?.status).toBe("stale");
    expect(states.find((stage) => stage.stage === "silence")?.status).toBe("fresh");

    // The words are reused; the identical result leaves what was built on it (even the agent's segments) valid.
    const job = await analyze(service, project);
    expect(outcomes(job)).toEqual([
      ["silence", "cached"],
      ["speakers", "cached"],
      ["shots", "cached"],
      ["transcript", "computed"],
      ["takes", "cached"],
      ["segments", "cached"],
    ]);
    expect(job.results.find((result) => result.stage === "transcript")?.detail).toBe(
      "rebuilt from the stored recognizer words",
    );
    expect(test.speech.transcribeCalls).toBe(1);
    const after = await service.overview(project, SOURCE);
    expect(after.transcript?.version).toBe(before.transcript?.version);
    expect(after.segments?.origin).toBe("semantic");
    expect(after.status.stages.some((stage) => stage.status === "stale")).toBe(false);
    expect(outcomes(await analyze(service, project))).toEqual(
      ALL.map((stage) => [stage, "cached"]),
    );
  });

  it("recomputes only the stage whose recipe is older when nothing else depends on the change", async () => {
    const { service, project } = setup();
    await analyze(service, project);
    await new AnalysisStore(project.dir).updateManifest(SOURCE, (manifest) => {
      const record = manifest.stages.silence;
      if (record) delete record.recipe;
    });
    const job = await analyze(service, project);
    expect(outcomes(job).filter(([, outcome]) => outcome === "computed")).toEqual([
      ["silence", "computed"],
    ]);
  });
});

describe.skipIf(!hasFfmpeg)("speech that is not there", () => {
  it("marks the transcript unavailable, skips what depends on it, and computes the rest", async () => {
    const { test, service, project } = setup();
    test.speech.unavailable = "no recognizer installed";
    const job = await analyze(service, project);
    expect(job.status).toBe("completed");
    expect(outcomes(job)).toEqual([
      ["silence", "computed"],
      ["speakers", "computed"],
      ["shots", "computed"],
      ["transcript", "unavailable"],
      ["takes", "skipped"],
      ["segments", "skipped"],
    ]);
    expect(job.results.find((result) => result.stage === "transcript")?.detail).toBe(
      "no recognizer installed",
    );

    const states = (await service.listSources(project))[0]?.stages ?? [];
    expect(states.find((stage) => stage.stage === "transcript")).toMatchObject({
      status: "unavailable",
      detail: "no recognizer installed",
    });
    const refusal = await rejection(service.transcript(project, SOURCE, {}));
    expect(refusal).toMatchObject({ code: "unavailable", message: "no recognizer installed" });

    // Unavailable is not remembered as a result: once a recognizer exists the next run uses it.
    test.speech.unavailable = null;
    const retry = await analyze(service, project);
    expect(outcomes(retry)).toEqual([
      ["silence", "cached"],
      ["speakers", "cached"],
      ["shots", "cached"],
      ["transcript", "computed"],
      ["takes", "computed"],
      ["segments", "computed"],
    ]);
  });

  it("assumes one speaker, and says why, when the adapter has no recognizer or diarizer at all", async () => {
    const { service, project } = setup({ speech: false });
    const job = await analyze(service, project);
    expect(outcomes(job).find(([stage]) => stage === "transcript")).toEqual([
      "transcript",
      "unavailable",
    ]);
    expect(await service.artifact(project, SOURCE, "speakers")).toMatchObject({
      method: "single",
      note: expect.stringContaining("diarizer"),
    });
  });

  it("skips picture stages for an audio file and everything audible for a silent video", async () => {
    const test = createAnalysisProject();
    projects.push(test);
    const audio = join(test.root, "voice.wav");
    ffmpegSync(["-f", "lavfi", "-i", "sine=f=300:d=3", audio]);
    addClip(test, audio, "assets/voice.wav");
    const silent = join(test.root, "mute.mp4");
    ffmpegSync([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x120:d=3:r=25",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      silent,
    ]);
    addClip(test, silent, "assets/mute.mp4");
    const service = new AnalysisService(test.adapter);

    const voice = await settle(
      service,
      test.project,
      await service.startJob(test.project, { source: "assets/voice.wav" }),
    );
    expect(outcomes(voice).find(([stage]) => stage === "shots")).toEqual(["shots", "skipped"]);
    expect(outcomes(voice).find(([stage]) => stage === "transcript")).toEqual([
      "transcript",
      "computed",
    ]);

    const mp4 = await settle(
      service,
      test.project,
      await service.startJob(test.project, { source: "assets/mute.mp4" }),
    );
    expect(outcomes(mp4)).toEqual([
      ["silence", "skipped"],
      ["speakers", "skipped"],
      ["shots", "computed"],
      ["transcript", "skipped"],
      ["takes", "skipped"],
      ["segments", "skipped"],
    ]);
  });
});

describe.skipIf(!hasFfmpeg)("frames", () => {
  it("decodes a frame once, serves it from the cache after, and records what was looked at", async () => {
    const { service, project } = setup();
    const first = await service.frames(project, { source: SOURCE, times: [1, 4.5], width: 320 });
    expect(first.frames.map((frame) => [frame.time, frame.cached])).toEqual([
      [1, false],
      [4.5, false],
    ]);
    expect(
      Buffer.from(first.frames[0]?.data ?? "", "base64")
        .subarray(0, 2)
        .toString("hex"),
    ).toBe("ffd8");

    const second = await service.frames(project, {
      source: SOURCE,
      times: [4.5, 1, 7],
      width: 320,
    });
    expect(second.frames.map((frame) => frame.cached)).toEqual([true, true, false]);
    // Another width is another image.
    expect((await service.frames(project, { source: SOURCE, times: [1] })).frames[0]?.cached).toBe(
      false,
    );

    expect(await service.artifact(project, SOURCE, "vision")).toMatchObject({
      inspectedFrames: [1, 4.5, 7],
    });
  });

  it("refuses times past the end of the media", async () => {
    const { service, project } = setup();
    const refusal = await rejection(service.frames(project, { source: SOURCE, times: [30] }));
    expect(refusal.code).toBe("invalid_request");
    expect(refusal.message).toContain("past the end");
  });
});

describe.skipIf(!hasFfmpeg)("vision notes", () => {
  it("numbers notes v1…, replaces a note over the same range keeping its id, and keeps them in time order", async () => {
    const { service, project } = setup();
    const note = (start: number, end: number, finding: string) => ({
      start,
      end,
      frames: [start],
      quality: "good" as const,
      tags: ["slide"],
      finding,
    });
    await service.saveVisionNotes(project, {
      source: SOURCE,
      notes: [note(4, 5, "b"), note(1, 2, "a")],
    });
    const saved = await service.saveVisionNotes(project, {
      source: SOURCE,
      notes: [note(1, 2, "a again"), note(6, 7, "c")],
    });
    expect(saved.notes.map((entry) => [entry.id, entry.start, entry.finding])).toEqual([
      ["v2", 1, "a again"],
      ["v1", 4, "b"],
      ["v3", 6, "c"],
    ]);
    const refusal = await rejection(
      service.saveVisionNotes(project, { source: SOURCE, notes: [note(9, 12, "x")] }),
    );
    expect(refusal.code).toBe("invalid_request");
  });
});

describe.skipIf(!hasFfmpeg)("cut plans", () => {
  it("needs analysis first, plans on top of a base plan, refuses unknown ones and goes stale with the source", async () => {
    const { test, service, project } = setup();
    expect((await rejection(service.planCut(project, { source: SOURCE }))).code).toBe(
      "not_analyzed",
    );
    await analyze(service, project);

    expect(
      (await rejection(service.planCut(project, { source: SOURCE, basedOn: "cut-9" }))).code,
    ).toBe("unknown_plan");
    const first = await service.planCut(project, { source: SOURCE, label: "rough cut" });
    expect(first.id).toBe("cut-1");
    expect(first.basedOn).toBeNull();
    const second = await service.planCut(project, {
      source: SOURCE,
      basedOn: "cut-1",
      maxPause: 0.4,
    });
    expect(second).toMatchObject({ id: "cut-2", basedOn: "cut-1" });
    expect(second.request).toMatchObject({ maxPause: 0.4 });
    expect((await service.listCuts(project, SOURCE)).map((plan) => plan.id)).toEqual([
      "cut-1",
      "cut-2",
    ]);
    expect((await rejection(service.getCut(project, "cut-7"))).code).toBe("unknown_plan");

    expect((await service.getCut(project, "cut-1")).applied).toBeNull();
    const stamped = `<div data-composition-id="main"><video class="clip" data-ov-cut="cut-1"></video><video class="clip" data-ov-cut="cut-1"></video></div>`;
    writeFileSync(test.path("index.html"), stamped);
    expect((await service.getCut(project, "cut-1")).applied).toEqual({
      composition: "index.html",
      clips: 2,
    });
    expect((await service.listCuts(project, SOURCE)).map((plan) => plan.applied?.clips)).toEqual([
      2,
      undefined,
    ]);
    // Restoring the composition (Revert) clears it: nothing remembers a stale "applied".
    writeFileSync(test.path("index.html"), `<div data-composition-id="main"></div>`);
    expect((await service.getCut(project, "cut-1")).applied).toBeNull();
    expect((await service.getCut(project, "cut-1")).warnings.join(" ")).not.toContain(
      "out of date",
    );

    appendFileSync(test.path(SOURCE), Buffer.alloc(32, 2));
    expect((await service.getCut(project, "cut-2")).warnings.join(" ")).toContain("out of date");
    expect((await rejection(service.planCut(project, { source: SOURCE }))).code).toBe("stale");
  });

  it("plans inside the picked fragment and goes out of date when the pick changes", async () => {
    const { service, project } = setup();
    await analyze(service, project);
    writeAssetRanges(project.dir, new Map([[SOURCE, { start: 2, end: 6 }]]));
    const plan = await service.planCut(project, { source: SOURCE });
    expect(plan.mediaRange).toEqual({ start: 2, end: 6 });
    expect(plan.ranges.length).toBeGreaterThan(0);
    for (const range of plan.ranges) {
      expect(range.from).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(range.to).toBeLessThanOrEqual(6 + 1e-9);
    }
    expect((await service.getCut(project, plan.id)).warnings.join(" ")).not.toContain(
      "out of date",
    );

    writeAssetRanges(project.dir, new Map([[SOURCE, { start: 0, end: 4 }]]));
    const stale = await service.getCut(project, plan.id);
    expect(stale.warnings.join(" ")).toContain("out of date");
    expect(stale.ranges).toEqual(plan.ranges); // the stored plan is reported as it was made
  });
});

describe("sources", () => {
  it("refuses paths that are not video or audio inside the project", async () => {
    const test = createAnalysisProject();
    projects.push(test);
    writeFileSync(test.path("notes.txt"), "x");
    writeFileSync(test.path("clip.mp4"), "not really a video");
    const service = new AnalysisService(test.adapter);
    const code = async (source: string) =>
      (await rejection(service.resolveSource(test.project, source))).code;

    expect(await code("notes.txt")).toBe("invalid_request");
    expect(await code("../outside.mp4")).toBe("invalid_request");
    expect(await code("/etc/hosts.mp4")).toBe("invalid_request");
    expect(await code(".hyperframes/analysis/x.mp4")).toBe("invalid_request");
    expect(await code("missing.mp4")).toBe("unknown_source");
    expect(await code("")).toBe("invalid_request");
    expect((await service.resolveSource(test.project, "./clip.mp4")).path).toBe("clip.mp4");
    expect((await service.resolveSource(test.project, test.path("clip.mp4"))).path).toBe(
      "clip.mp4",
    );
  });
});
