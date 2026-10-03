// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaRenderOrigin, QaReportInput } from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { QaService, type QaAnalysis } from "./service.js";
import { QA_RETENTION } from "./retention.js";
import { composition, createQaProject, type QaProject } from "./testSupport.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NOT_ANALYSED: QaAnalysis = {
  sourceData: async () => {
    throw new Error("not analysed");
  },
};

let media = "";
beforeAll(() => {
  media = mkdtempSync(join(tmpdir(), "openvids-qa-retention-media-"));
  for (const name of ["a.mp4", "short.mp4", "card.mp4", "noisycard.mp4"])
    writeFileSync(join(media, name), "media");
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

const projects: QaProject[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

function setup() {
  const project = createQaProject({ media, html: composition(6, []) });
  projects.push(project);
  const clock = { now: Date.now() };
  const service = new QaService(project.adapter, NOT_ANALYSED, { now: () => clock.now });
  const reportFiles = () =>
    readdirSync(project.path(".hyperframes/qa/reports")).filter((name) => name.endsWith(".json"));
  /** A render file and the frame cache QA keeps for it. */
  const render = (name: string, frames = true) => {
    project.write(`renders/${name}`, "video");
    project.write(`renders/${name.replace(/\.[^.]+$/, "")}.meta.json`, "{}");
    if (frames)
      project.write(`.hyperframes/qa/frames/${name.replace(/\.[^.]+$/, "")}/500-640.jpg`, "jpg");
  };
  const exists = (path: string) => existsSync(project.path(path));
  /** Saves one pass of a session; the clock moves on by a second so report ids stay ordered. */
  const save = (
    sessionId: string,
    pass: number,
    path: string | null,
    origin: QaRenderOrigin = "qa",
    overrides: Partial<QaReportInput> = {},
  ) => {
    clock.now += 1000;
    return service.saveReport(project.project, {
      sessionId,
      turnId: sessionId,
      chatId: "chat-1",
      pass,
      passLimit: 3,
      preset: "balanced",
      composition: "index.html",
      fingerprint: "fp",
      timelineVersion: null,
      render: path && {
        path,
        duration: 6,
        width: 160,
        height: 120,
        hasAudio: true,
        quality: "draft",
        origin,
      },
      renderError: null,
      checks: [{ id: "render", status: "ran", detail: null }],
      vision: { status: "unavailable", reason: null, frames: 0, rounds: 0, model: null },
      issues: [],
      resolved: [],
      previousReportId: null,
      ...overrides,
    });
  };
  return { project, service, clock, render, exists, save, reportFiles };
}

describe("QA session cleanup", () => {
  it("deletes the intermediate QA renders with their frame caches and keeps the last one", () => {
    const { project, service, render, exists, save } = setup();
    for (const name of ["qa-1.mp4", "qa-2.mp4", "qa-3.mp4"]) render(name);
    render("mine.mp4");
    const first = save("s1", 1, "renders/qa-1.mp4");
    save("s1", 2, "renders/qa-2.mp4");
    save("s1", 3, "renders/qa-3.mp4");
    const before = service.getReport(project.project, first.id);

    const result = service.finishSession(project.project, "s1", { keep: "renders/qa-3.mp4" });

    expect(result.removedRenders.sort()).toEqual(["renders/qa-1.mp4", "renders/qa-2.mp4"]);
    expect(exists("renders/qa-1.mp4") || exists("renders/qa-2.mp4")).toBe(false);
    expect(exists(".hyperframes/qa/frames/qa-1") || exists(".hyperframes/qa/frames/qa-2")).toBe(
      false,
    );
    expect(exists("renders/qa-1.meta.json") || exists("renders/qa-2.meta.json")).toBe(false);
    expect(exists("renders/qa-3.mp4") && exists("renders/qa-3.meta.json")).toBe(true);
    expect(exists(".hyperframes/qa/frames/qa-3/500-640.jpg")).toBe(true);
    // A render QA never made is not QA's to delete.
    expect(exists("renders/mine.mp4")).toBe(true);
    expect(exists(".hyperframes/qa/frames/mine/500-640.jpg")).toBe(true);
    // The report of a deleted render still reads, unchanged.
    expect(service.getReport(project.project, first.id)).toEqual(before);
    expect(service.listReports(project.project).reports).toHaveLength(3);
  });

  it("never deletes the Director's own render that pass 1 reused, whatever `keep` and `produced` say", () => {
    const { project, service, render, exists, save } = setup();
    render("final.mp4");
    render("qa-2.mp4");
    save("s1", 1, "renders/final.mp4", "turn");
    save("s1", 2, "renders/qa-2.mp4");

    const result = service.finishSession(project.project, "s1", {
      keep: "renders/qa-2.mp4",
      produced: ["renders/final.mp4", "renders/qa-2.mp4"],
    });

    expect(result.removedRenders).toEqual([]);
    expect(exists("renders/final.mp4")).toBe(true);
    expect(exists(".hyperframes/qa/frames/final/500-640.jpg")).toBe(true);

    // Even when no pass ended on a render, the turn's render stays and the QA one goes.
    const again = service.finishSession(project.project, "s1", { keep: null });
    expect(again.removedRenders).toEqual(["renders/qa-2.mp4"]);
    expect(exists("renders/final.mp4")).toBe(true);
  });

  it("deletes a render a stopped pass made before its report, but keeps the file `keep` names even when passes share it", () => {
    const { project, service, render, exists, save } = setup();
    render("preview.mp4");
    render("unreported.mp4");
    save("s1", 1, "renders/preview.mp4");
    save("s1", 2, "renders/preview.mp4");

    const result = service.finishSession(project.project, "s1", {
      keep: "renders/preview.mp4",
      produced: ["renders/preview.mp4", "renders/unreported.mp4"],
    });

    expect(result.removedRenders).toEqual(["renders/unreported.mp4"]);
    expect(exists("renders/preview.mp4")).toBe(true);
    expect(exists(".hyperframes/qa/frames/unreported")).toBe(false);
  });

  it("never deletes the render another session currently ends on, and refuses paths outside renders/", () => {
    const { project, service, render, exists, save } = setup();
    render("shared.mp4");
    render("other-old.mp4");
    save("s2", 1, "renders/other-old.mp4");
    save("s2", 2, "renders/shared.mp4");
    save("s1", 1, "renders/shared.mp4");

    const result = service.finishSession(project.project, "s1", {
      keep: null,
      produced: ["renders/other-old.mp4"],
    });

    // `shared.mp4` is where session s2 stands now; `other-old.mp4` was s2's earlier pass, so it may go.
    expect(result.removedRenders).toEqual(["renders/other-old.mp4"]);
    expect(exists("renders/shared.mp4")).toBe(true);
    // Only files of renders/ can be named.
    service.finishSession(project.project, "s1", { keep: null, produced: ["../index.html"] });
    expect(exists("index.html")).toBe(true);
  });
});

describe("QA report retention", () => {
  it("prunes old sessions but keeps the most recent ones, anything young, and a running session", () => {
    const { project, service, clock, save, reportFiles } = setup();
    const start = clock.now;
    // A session still running, the oldest of all.
    save("live", 1, null);
    for (let i = 0; i < QA_RETENTION.keepSessions + 5; i += 1) {
      clock.now = start + (i + 1) * HOUR;
      save(`s${i}`, 1, null);
      save(`s${i}`, 2, null);
      service.finishSession(project.project, `s${i}`, { keep: null });
    }
    // All of it is younger than the retention age: nothing was pruned while saving.
    expect(reportFiles()).toHaveLength(1 + (QA_RETENTION.keepSessions + 5) * 2);

    clock.now = start + 30 * DAY;
    service.finishSession(project.project, "nobody", { keep: null });

    const kept = service.listReports(project.project).reports;
    const sessions = new Set(kept.map((report) => report.sessionId));
    expect(sessions.has("live")).toBe(true);
    // The 20 newest sessions (s5 … s24) keep both of their passes; the 5 oldest are gone.
    expect(sessions.size).toBe(QA_RETENTION.keepSessions + 1);
    for (let i = 0; i < 5; i += 1) expect(sessions.has(`s${i}`)).toBe(false);
    for (let i = 5; i < 25; i += 1) expect(sessions.has(`s${i}`)).toBe(true);
    expect(kept).toHaveLength(1 + QA_RETENTION.keepSessions * 2);
  }, 30_000);

  it("keeps every session younger than the retention age, however many there are", () => {
    const { project, service, clock, save } = setup();
    const start = clock.now;
    for (let i = 0; i < QA_RETENTION.keepSessions + 10; i += 1) {
      clock.now = start + i * 1000;
      save(`s${i}`, 1, null);
    }
    clock.now = start + QA_RETENTION.keepMs - HOUR;
    service.finishSession(project.project, "nobody", { keep: null });
    expect(service.listReports(project.project).reports).toHaveLength(
      QA_RETENTION.keepSessions + 10,
    );
  });

  it("does not stop on damaged or foreign report files, and clears old damaged ones", () => {
    const { project, service, clock, save, reportFiles } = setup();
    const start = clock.now;
    for (let i = 0; i < QA_RETENTION.keepSessions + 2; i += 1) {
      clock.now = start + i * HOUR;
      save(`s${i}`, 1, null);
      service.finishSession(project.project, `s${i}`, { keep: null });
    }
    const dir = project.path(".hyperframes/qa/reports");
    const old = new Date(start - 10 * DAY);
    writeFileSync(join(dir, "qa-20240101000000-abcdef.json"), "{ not json");
    writeFileSync(join(dir, "qa-20240102000000-abcdef.json"), JSON.stringify({ id: "x" }));
    utimesSync(join(dir, "qa-20240101000000-abcdef.json"), old, old);
    utimesSync(join(dir, "qa-20240102000000-abcdef.json"), old, old);
    // A recent damaged file (maybe being written by something else) and a foreign file stay.
    writeFileSync(join(dir, "qa-20990101000000-abcdef.json"), "{ not json");
    writeFileSync(join(dir, "notes.json"), "{}");

    clock.now = start + 30 * DAY;
    const recent = new Date(clock.now - HOUR);
    utimesSync(join(dir, "qa-20990101000000-abcdef.json"), recent, recent);
    const result = service.finishSession(project.project, "nobody", { keep: null });

    expect(result.removedReports).toBe(2 + 2);
    const files = reportFiles();
    expect(files).toContain("qa-20990101000000-abcdef.json");
    expect(files).toContain("notes.json");
    expect(files).not.toContain("qa-20240101000000-abcdef.json");
    expect(files).not.toContain("qa-20240102000000-abcdef.json");
    expect(service.listReports(project.project).reports).toHaveLength(QA_RETENTION.keepSessions);
  });

  it("deletes the frame cache of a render that is gone and never touches renders", () => {
    const { project, service, render, exists, save } = setup();
    render("kept.mp4");
    render("gone.mp4");
    project.write("renders/mine.mp4", "video");
    rmSync(project.path("renders/gone.mp4"));
    save("s1", 1, "renders/kept.mp4");

    // Saving a report runs the retention, which drops the orphan cache.
    expect(exists(".hyperframes/qa/frames/gone")).toBe(false);
    expect(exists(".hyperframes/qa/frames/kept/500-640.jpg")).toBe(true);
    for (const file of ["kept", "mine"]) expect(exists(`renders/${file}.mp4`)).toBe(true);
    mkdirSync(project.path(".hyperframes/qa/frames/stale"), { recursive: true });
    service.finishSession(project.project, "s1", { keep: "renders/kept.mp4" });
    expect(exists(".hyperframes/qa/frames/stale")).toBe(false);
    expect(exists("renders/mine.mp4")).toBe(true);
  });
});
