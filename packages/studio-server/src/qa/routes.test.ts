// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  isQaReport,
  qaCounts,
  type QaError,
  type QaIssue,
  type QaReport,
  type QaReportInput,
  type QaReportList,
} from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerQaRoutes } from "../routes/qa.js";
import { writeHangExe } from "../helpers/fakeFfmpeg.js";
import {
  RENDERS,
  composition,
  createQaProject,
  hasFfmpeg,
  makeMedia,
  type QaProject,
} from "./testSupport.js";

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

const HTML = composition(6, [
  {
    id: "talk",
    attrs: 'src="assets/a.mp4" data-start="0" data-duration="6" data-track-index="0" playsinline',
  },
]);

function setup(options: { ffmpegPath?: string } = {}) {
  let clock = 1_790_000_000_000;
  const project = createQaProject({ media, html: HTML });
  projects.push(project);
  const api = new Hono();
  registerQaRoutes(api, project.adapter, NOT_ANALYSED, {
    ffmpegPath: options.ffmpegPath,
    now: () => (clock += 1000),
  });
  const send = (method: string, path: string, body?: unknown, init: RequestInit = {}) =>
    api.request(`/projects/demo/qa/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
  return { project, api, send };
}

async function errorOf(response: Response): Promise<QaError> {
  const body: { error: QaError } = await response.json();
  return body.error;
}

function issue(n: number, status: QaIssue["status"] = "new"): QaIssue {
  return {
    id: `p1-${n}`,
    status,
    firstSeenPass: 1,
    kind: "frozen_frames",
    severity: n === 1 ? "error" : "warning",
    source: "render",
    check: "freezedetect",
    start: n,
    end: n + 1,
    clipIds: ["hf-talk"],
    subject: `clip-${n}`,
    message: "stuck",
    fixable: n !== 2,
    owner: "editor",
    suggestion: null,
  };
}

function reportInput(fingerprint: string, overrides: Partial<QaReportInput> = {}): QaReportInput {
  return {
    sessionId: "turn-1",
    turnId: "turn-1",
    chatId: "chat-1",
    pass: 1,
    passLimit: 2,
    preset: "balanced",
    composition: "index.html",
    fingerprint,
    timelineVersion: "sha256:abc",
    render: {
      path: "renders/out.mp4",
      duration: 6,
      width: 160,
      height: 120,
      hasAudio: true,
      quality: "draft",
      origin: "qa",
    },
    renderError: null,
    checks: [{ id: "render", status: "ran", detail: null }],
    vision: {
      status: "unavailable",
      reason: "Vision is not enabled",
      frames: 0,
      rounds: 0,
      model: null,
    },
    issues: [issue(1), issue(2)],
    resolved: [{ ...issue(3), status: "fixed" }],
    previousReportId: null,
    ...overrides,
  };
}

describe("QA reports", () => {
  it("stores a pass atomically, with counts computed by the service and the current flag derived", async () => {
    const { send, project } = setup();
    const state: { fingerprint: string } = await (await send("GET", "state")).json();
    const input = reportInput(state.fingerprint);

    const saved = await send("POST", "reports", input);
    expect(saved.status).toBe(200);
    const report: QaReport = await saved.json();
    expect(isQaReport(report)).toBe(true);
    expect(report).toMatchObject({
      schemaVersion: 1,
      sessionId: "turn-1",
      createdAt: 1_790_000_001_000,
      current: true,
      counts: qaCounts(input.issues, input.resolved),
    });
    expect(report.id).toMatch(/^qa-\d{14}-[0-9a-f]{6}$/);
    expect(report.counts).toMatchObject({
      issues: 2,
      errors: 1,
      warnings: 1,
      fixable: 1,
      new: 2,
      fixed: 1,
    });

    const dir = project.path(".hyperframes/qa/reports");
    // Exactly the report file: no temp file is left behind.
    expect(readdirSync(dir)).toEqual([`${report.id}.json`]);
    const onDisk: unknown = JSON.parse(readFileSync(join(dir, `${report.id}.json`), "utf-8"));
    expect(onDisk).toMatchObject({
      id: report.id,
      schemaVersion: 1,
      fingerprint: state.fingerprint,
    });
    expect(onDisk).not.toHaveProperty("current");

    const fetched: QaReport = await (await send("GET", `reports/${report.id}`)).json();
    expect(fetched).toEqual(report);
  });

  it("flips `current` when the project changes and back when it returns to the rendered state, and QA files never change the fingerprint", async () => {
    const { send, project } = setup();
    const before: { fingerprint: string } = await (await send("GET", "state")).json();
    const report: QaReport = await (
      await send("POST", "reports", reportInput(before.fingerprint))
    ).json();

    // Writing the report (and its folder) is not a project change.
    const after: { fingerprint: string } = await (await send("GET", "state")).json();
    expect(after.fingerprint).toBe(before.fingerprint);

    const original = readFileSync(project.path("index.html"), "utf-8");
    project.write("index.html", original.replace('data-duration="6"', 'data-duration="5"'));
    const changed: { fingerprint: string } = await (await send("GET", "state")).json();
    expect(changed.fingerprint).not.toBe(before.fingerprint);
    const list: QaReportList = await (await send("GET", "reports")).json();
    expect(list.fingerprint).toBe(changed.fingerprint);
    expect(list.reports.map((entry) => [entry.id, entry.current])).toEqual([[report.id, false]]);
    expect(((await (await send("GET", `reports/${report.id}`)).json()) as QaReport).current).toBe(
      false,
    );

    project.write("index.html", original);
    const restored: QaReportList = await (await send("GET", "reports")).json();
    expect(restored.reports[0]?.current).toBe(true);
  });

  it("lists newest first with summaries and skips damaged or foreign files", async () => {
    const { send, project } = setup();
    const state: { fingerprint: string } = await (await send("GET", "state")).json();
    const first: QaReport = await (
      await send("POST", "reports", reportInput(state.fingerprint, { pass: 1 }))
    ).json();
    const second: QaReport = await (
      await send(
        "POST",
        "reports",
        reportInput(state.fingerprint, { pass: 2, previousReportId: first.id }),
      )
    ).json();

    const dir = project.path(".hyperframes/qa/reports");
    writeFileSync(join(dir, "qa-20250101000000-abcdef.json"), "{ not json");
    writeFileSync(
      join(dir, "qa-20250102000000-abcdef.json"),
      JSON.stringify({ id: "qa-20250102000000-abcdef" }),
    );
    writeFileSync(join(dir, "notes.json"), "{}");
    // A report copied under another name is not trusted: its id must match its file.
    writeFileSync(
      join(dir, "qa-20260101000000-123456.json"),
      readFileSync(join(dir, `${first.id}.json`)),
    );

    const list: QaReportList = await (await send("GET", "reports")).json();
    expect(list.reports.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(list.reports[0]).toMatchObject({
      sessionId: "turn-1",
      pass: 2,
      passLimit: 2,
      composition: "index.html",
      renderPath: "renders/out.mp4",
      renderError: null,
      current: true,
      counts: { issues: 2 },
    });

    const damaged = await send("GET", "reports/qa-20250101000000-abcdef");
    expect(damaged.status).toBe(404);
    expect((await errorOf(damaged)).code).toBe("not_found");
    expect((await send("GET", "reports/..%2F..%2Findex.html")).status).toBe(404);
  });

  it("rejects invalid reports, unknown projects and oversized bodies with QA errors", async () => {
    const { send, api } = setup();
    const bad = await send("POST", "reports", { sessionId: "x" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("invalid_request");

    const notJson = await send("POST", "reports", "{ nope");
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).code).toBe("invalid_request");

    const huge = await send(
      "POST",
      "reports",
      JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    );
    expect(huge.status).toBe(400);
    expect((await errorOf(huge)).code).toBe("invalid_request");

    const gone = await api.request("/projects/nope/qa/state");
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe("not_found");
    expect((await send("GET", "reports/unknown")).status).toBe(404);
  });

  it("ends a session over HTTP: deletes its intermediate QA render, keeps `keep`, and validates the body", async () => {
    const { send, project } = setup();
    const state: { fingerprint: string } = await (await send("GET", "state")).json();
    const render = (path: string, origin: "qa" | "turn") =>
      reportInput(state.fingerprint, {
        render: {
          path,
          duration: 6,
          width: 160,
          height: 120,
          hasAudio: true,
          quality: "draft",
          origin,
        },
      });
    project.write("renders/first.mp4", "video");
    project.write("renders/last.mp4", "video");
    await send("POST", "reports", render("renders/first.mp4", "qa"));
    await send("POST", "reports", render("renders/last.mp4", "qa"));

    const bad = await send("POST", "sessions/turn-1/finish", { keep: "index.html" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("invalid_request");

    const done = await send("POST", "sessions/turn-1/finish", { keep: "renders/last.mp4" });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ removedRenders: ["renders/first.mp4"], removedReports: 0 });
    expect(existsSync(project.path("renders/first.mp4"))).toBe(false);
    expect(existsSync(project.path("renders/last.mp4"))).toBe(true);
  });
});

run("QA frames and check requests", () => {
  const REQUEST = { render: "renders/out.mp4", framesPerMinute: 12, maxFrames: 24 };

  it("grabs JPEGs of the render, caches them per render file and drops the cache when the file is rewritten", async () => {
    const { send, project } = setup();
    RENDERS.clean(project.path("renders/out.mp4"));

    const first = await send("POST", "frames", { render: "renders/out.mp4", times: [0.5, 2.5] });
    expect(first.status).toBe(200);
    const body: {
      frames: Array<{ time: number; mimeType: string; data: string; cached: boolean }>;
    } = await first.json();
    expect(body.frames.map((frame) => [frame.time, frame.mimeType, frame.cached])).toEqual([
      [0.5, "image/jpeg", false],
      [2.5, "image/jpeg", false],
    ]);
    for (const frame of body.frames) {
      const bytes = Buffer.from(frame.data, "base64");
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    }
    const dir = project.path(".hyperframes/qa/frames/out");
    expect(
      readdirSync(dir)
        .filter((name) => name.endsWith(".jpg"))
        .sort(),
    ).toEqual(["2500-640.jpg", "500-640.jpg"]);

    const again = await (
      await send("POST", "frames", { render: "renders/out.mp4", times: [0.5, 2.5] })
    ).json();
    expect(again.frames.map((frame: { cached: boolean }) => frame.cached)).toEqual([true, true]);
    // Another width is another picture.
    const narrow = await (
      await send("POST", "frames", { render: "renders/out.mp4", times: [0.5], width: 320 })
    ).json();
    expect(narrow.frames[0].cached).toBe(false);

    // The same file name now holds a different render: the old frames must not be served.
    RENDERS.frozenTail(project.path("renders/out.mp4"));
    const fresh = await (
      await send("POST", "frames", { render: "renders/out.mp4", times: [0.5, 2.5] })
    ).json();
    expect(fresh.frames.map((frame: { cached: boolean }) => frame.cached)).toEqual([false, false]);

    // A time past the end is the last picture, not an error.
    const late = await send("POST", "frames", { render: "renders/out.mp4", times: [500] });
    expect(late.status).toBe(200);
  });

  it("refuses requests that are not about a render of this project", async () => {
    const { send, project } = setup();
    RENDERS.clean(project.path("renders/out.mp4"));
    const refusal = async (response: Response, status: number, code: QaError["code"]) => {
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    };
    await refusal(
      await send("POST", "check", { ...REQUEST, render: "assets/a.mp4" }),
      400,
      "invalid_request",
    );
    await refusal(
      await send("POST", "check", { ...REQUEST, render: "renders/../index.html" }),
      400,
      "invalid_request",
    );
    await refusal(
      await send("POST", "check", { ...REQUEST, maxFrames: 1000 }),
      400,
      "invalid_request",
    );
    await refusal(await send("POST", "check", "[]"), 400, "invalid_request");
    await refusal(
      await send("POST", "check", { ...REQUEST, render: "renders/missing.mp4" }),
      404,
      "not_found",
    );
    await refusal(
      await send("POST", "check", { ...REQUEST, composition: "compositions/none.html" }),
      404,
      "not_found",
    );
    await refusal(
      await send("POST", "frames", {
        render: "renders/out.mp4",
        times: Array.from({ length: 13 }, (_, i) => i),
      }),
      400,
      "invalid_request",
    );
    await refusal(
      await send("POST", "frames", { render: "renders/out.mp4", times: [-1] }),
      400,
      "invalid_request",
    );
    await refusal(
      await send("POST", "frames", { render: "renders/nope.mp4", times: [1] }),
      404,
      "not_found",
    );
  });

  it("answers a check over HTTP with the wire shape, and stops the work when the client disconnects", async () => {
    const ok = setup();
    RENDERS.clean(ok.project.path("renders/out.mp4"));
    const done = await ok.send("POST", "check", REQUEST);
    expect(done.status).toBe(200);
    const answer: unknown = await done.json();
    expect(answer).toMatchObject({
      composition: "index.html",
      issues: [],
      checks: expect.any(Array),
      samples: expect.any(Array),
    });

    const dir = mkdtempSync(join(tmpdir(), "openvids-qa-hang-"));
    const exeDir = mkdtempSync(join(tmpdir(), "openvids-qa-fake-"));
    try {
      const pidFile = join(dir, "pid");
      // A `.sh` stand-in cannot exec on Windows (`spawn EFTYPE`): compiled
      // exe there (see helpers/fakeFfmpeg.ts), kept outside `dir` since
      // Windows locks a running exe's image file against cleanup.
      const { send, project: hangProject } = setup({
        ffmpegPath: await writeHangExe(exeDir, pidFile),
      });
      RENDERS.clean(hangProject.path("renders/out.mp4"));
      // Generous: the suite runs next to other ffmpeg-heavy suites.
      const WAIT = { timeout: 10_000, interval: 25 };
      const client = new AbortController();
      const pending = send("POST", "check", REQUEST, { signal: client.signal });
      const pids = await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
        const started = readFileSync(pidFile, "utf-8").trim().split("\n").map(Number);
        expect(started.length).toBeGreaterThanOrEqual(2);
        return started;
      }, WAIT);
      client.abort();
      // The route's own response to a vanished client; what matters is that the work ended.
      await pending.then(
        (response) => response.status,
        () => 0,
      );
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
