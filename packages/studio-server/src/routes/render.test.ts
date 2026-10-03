import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VALID_CANVAS_RESOLUTIONS } from "@hyperframes/parsers";
import { registerRenderRoutes } from "./render";
import type { StudioApiAdapter } from "../types";

function createAdapter(
  startRenderSpy: ReturnType<typeof vi.fn>,
  rendersDir = mkdtempSync(join(tmpdir(), "hf-render-test-")),
): { adapter: StudioApiAdapter; rendersDir: string } {
  const adapter: StudioApiAdapter = {
    listProjects: () => [],
    // Use a real, existing dir: isSafePath() canonicalizes the project dir with
    // realpath and fails closed if it doesn't exist (real projects always do).
    resolveProject: async (id: string) => ({ id, dir: tmpdir() }),
    bundle: async () => null,
    lint: async () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: () => rendersDir,
    startRender: (opts) => {
      startRenderSpy(opts);
      return {
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
      };
    },
  };
  return { adapter, rendersDir };
}

function buildApp(spy: ReturnType<typeof vi.fn>): {
  app: Hono;
  rendersDir: string;
  cleanup: () => void;
} {
  const { adapter, rendersDir } = createAdapter(spy);
  const app = new Hono();
  registerRenderRoutes(app, adapter);
  return { app, rendersDir, cleanup: () => rmSync(rendersDir, { recursive: true, force: true }) };
}

describe("GET /projects/:id/renders — stale sidecar status", () => {
  it("does not mark an existing output failed from stale metadata", async () => {
    const spy = vi.fn();
    const { app, rendersDir, cleanup } = buildApp(spy);
    try {
      writeFileSync(join(rendersDir, "retry.mp4"), "valid-output");
      writeFileSync(
        join(rendersDir, "retry.meta.json"),
        JSON.stringify({ status: "failed", error: "first attempt" }),
      );
      const res = await app.request("http://localhost/projects/demo/renders");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.renders).toEqual([expect.objectContaining({ id: "retry", status: "complete" })]);
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/render — outputResolution forwarding", () => {
  it("forwards a valid resolution preset to the adapter", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fps: 30,
          quality: "high",
          format: "mp4",
          resolution: "landscape-4k",
        }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
      const opts = spy.mock.calls[0][0];
      expect(opts.outputResolution).toBe("landscape-4k");
    } finally {
      cleanup();
    }
  });

  it("omits outputResolution when the request does not specify one", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4" }),
      });
      expect(res.status).toBe(200);
      const opts = spy.mock.calls[0][0];
      expect(opts.outputResolution).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("drops an invalid resolution string (defense-in-depth, not a 400)", async () => {
    // The route is intentionally lenient on unknown enum values — the producer
    // is the source of truth for validation and emits a clear error message.
    // We just want to make sure garbage doesn't propagate as if it were valid.
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4", resolution: "8k" }),
      });
      expect(res.status).toBe(200);
      const opts = spy.mock.calls[0][0];
      expect(opts.outputResolution).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // Contract pin per PR #2529 R2 review: the HTTP route accepts canonical
  // presets only, not the CLI-side tier aliases (`1080p` / `hd` / `4k` /
  // `uhd`, `landscape-4k` is already canonical). Miga asked that Studio
  // Server's contract stay explicit here rather than silently extending it.
  // Aliases fall through to the same `undefined` sink as any unknown value,
  // which means the render falls back to composition dimensions — a safe,
  // deliberate no-op rather than a portrait-1080p failure mode.
  it.each(["1080p", "4k", "hd", "uhd"])(
    "does NOT accept the CLI-side tier alias %s (canonical-only contract)",
    async (alias) => {
      const spy = vi.fn();
      const { app, cleanup } = buildApp(spy);
      try {
        const res = await app.request("http://localhost/projects/demo/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fps: 30,
            quality: "standard",
            format: "mp4",
            resolution: alias,
          }),
        });
        expect(res.status).toBe(200);
        // Alias falls through to undefined → render uses composition dims.
        // If Studio Server ever extends its contract to accept aliases,
        // it must also plumb `outputResolutionAspectAgnostic` alongside so
        // the compile stage can remap orientation; today the surface is
        // deliberately narrow.
        expect(spy.mock.calls[0][0].outputResolution).toBeUndefined();
      } finally {
        cleanup();
      }
    },
  );

  it("accepts each canonical preset value", async () => {
    for (const preset of VALID_CANVAS_RESOLUTIONS) {
      const spy = vi.fn();
      const { app, cleanup } = buildApp(spy);
      try {
        await app.request("http://localhost/projects/demo/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4", resolution: preset }),
        });
        expect(spy.mock.calls[0][0].outputResolution).toBe(preset);
      } finally {
        cleanup();
      }
    }
  });
});

describe("POST /projects/:id/render — composition forwarding", () => {
  it("forwards a valid composition path to the adapter", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fps: 30,
          quality: "standard",
          format: "mp4",
          composition: "compositions/intro.html",
        }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].composition).toBe("compositions/intro.html");
    } finally {
      cleanup();
    }
  });

  it("omits composition when not specified", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4" }),
      });
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0].composition).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("omits composition when empty string", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4", composition: "" }),
      });
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0].composition).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects path-traversal attempts with 400", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fps: 30,
          quality: "standard",
          format: "mp4",
          composition: "../../../etc/passwd",
        }),
      });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/render — fps wire format", () => {
  // The fps fraction-syntax feature accepts JSON `number` (integer fps) and
  // JSON `string` (ffmpeg-style rational) on the wire, normalizing both to
  // the structured Fps form before invoking the adapter.
  it("forwards integer fps as { num, den: 1 }", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: 60, quality: "standard", format: "mp4" }),
      });
      expect(spy.mock.calls[0][0].fps).toEqual({ num: 60, den: 1 });
    } finally {
      cleanup();
    }
  });

  it("parses '30000/1001' string body as exact NTSC", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: "30000/1001", quality: "standard", format: "mp4" }),
      });
      expect(spy.mock.calls[0][0].fps).toEqual({ num: 30000, den: 1001 });
    } finally {
      cleanup();
    }
  });

  it("falls back to 30/1 for malformed fps values", async () => {
    // Matches the lenient handling of `quality` and `resolution` in the same
    // route — the producer surfaces a clearer downstream error if the value
    // is genuinely unusable.
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: "abc", quality: "standard", format: "mp4" }),
      });
      expect(spy.mock.calls[0][0].fps).toEqual({ num: 30, den: 1 });
    } finally {
      cleanup();
    }
  });

  it("falls back to 30/1 when fps is omitted", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quality: "standard", format: "mp4" }),
      });
      expect(spy.mock.calls[0][0].fps).toEqual({ num: 30, den: 1 });
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/render — composition path safety", () => {
  const tmpDirs: string[] = [];

  function buildAppWithProjectDir(spy: ReturnType<typeof vi.fn>): {
    app: Hono;
    projectDir: string;
  } {
    const projectDir = mkdtempSync(join(tmpdir(), "hf-render-proj-"));
    const rendersDir = mkdtempSync(join(tmpdir(), "hf-render-out-"));
    tmpDirs.push(projectDir, rendersDir);
    const adapter: StudioApiAdapter = {
      listProjects: () => [],
      resolveProject: async (id: string) => ({ id, dir: projectDir }),
      bundle: async () => null,
      lint: async () => ({ findings: [] }),
      runtimeUrl: "/api/runtime.js",
      rendersDir: () => rendersDir,
      startRender: (opts) => {
        spy(opts);
        return { id: opts.jobId, status: "rendering", progress: 0, outputPath: opts.outputPath };
      },
    };
    const app = new Hono();
    registerRenderRoutes(app, adapter);
    return { app, projectDir };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function postComposition(app: Hono, composition: string): Promise<Response> {
    return app.request("http://localhost/projects/demo/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4", composition }),
    });
  }

  // Mirror the repo convention (preview.test.ts): skip symlink cases on
  // non-symlink-privileged Windows runners rather than crash the suite.
  function tryCreateSymlink(target: string, path: string, type: "dir" | "file"): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch {
      return false;
    }
  }

  it("accepts a composition path inside the project directory", async () => {
    const spy = vi.fn();
    const { app } = buildAppWithProjectDir(spy);
    const res = await postComposition(app, "scenes/intro.html");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("rejects a `..` traversal in the composition path", async () => {
    const spy = vi.fn();
    const { app } = buildAppWithProjectDir(spy);
    const res = await postComposition(app, "../../etc/passwd");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a composition reached through an in-project symlink pointing outside the project", async () => {
    const spy = vi.fn();
    const { app, projectDir } = buildAppWithProjectDir(spy);
    const external = mkdtempSync(join(tmpdir(), "hf-render-external-"));
    tmpDirs.push(external);
    writeFileSync(join(external, "secret.html"), "<html></html>");
    if (!tryCreateSymlink(external, join(projectDir, "link"), "dir")) return;
    const res = await postComposition(app, "link/secret.html");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows a composition reached through an in-project symlink that stays inside the project", async () => {
    const spy = vi.fn();
    const { app, projectDir } = buildAppWithProjectDir(spy);
    mkdirSync(join(projectDir, "real"));
    writeFileSync(join(projectDir, "real", "scene.html"), "<html></html>");
    if (!tryCreateSymlink(join(projectDir, "real"), join(projectDir, "alias"), "dir")) return;
    const res = await postComposition(app, "alias/scene.html");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("GET /projects/:id/renders/file/* — path safety", () => {
  const tmpDirs: string[] = [];

  function buildApp(): { app: Hono; rendersDir: string } {
    const rendersDir = mkdtempSync(join(tmpdir(), "hf-renders-out-"));
    tmpDirs.push(rendersDir);
    const adapter: StudioApiAdapter = {
      listProjects: () => [],
      resolveProject: async (id: string) => ({ id, dir: tmpdir() }),
      bundle: async () => null,
      lint: async () => ({ findings: [] }),
      runtimeUrl: "/api/runtime.js",
      rendersDir: () => rendersDir,
      startRender: (opts) => ({
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
      }),
    };
    const app = new Hono();
    registerRenderRoutes(app, adapter);
    return { app, rendersDir };
  }

  // Mirror the repo convention (preview.test.ts / composition tests above):
  // skip symlink cases on non-symlink-privileged Windows runners.
  function tryCreateSymlink(target: string, path: string, type: "dir" | "file"): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch {
      return false;
    }
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("serves non-Latin-1 filenames with RFC 6266 content dispositions", async () => {
    const filename = "測試.mp4";
    const { app, rendersDir } = buildApp();
    const outputPath = join(rendersDir, filename);
    writeFileSync(outputPath, "render-bytes");

    const listResponse = await app.request("http://localhost/projects/demo/renders");
    expect(listResponse.status).toBe(200);
    const jobId = encodeURIComponent(filename.replace(/\.mp4$/, ""));
    const expectedFilename = `filename="__.mp4"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const responses = [
      {
        response: await app.request(`http://localhost/render/${jobId}/view`),
        disposition: "inline",
      },
      {
        response: await app.request(`http://localhost/render/${jobId}/download`),
        disposition: "attachment",
      },
      {
        response: await app.request(
          `http://localhost/projects/demo/renders/file/${encodeURIComponent(filename)}`,
        ),
        disposition: "inline",
      },
    ];

    for (const { response, disposition } of responses) {
      expect(response.status).toBe(200);
      const header = response.headers.get("Content-Disposition");
      expect(header).toBe(`${disposition}; ${expectedFilename}`);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("serves a render file that lives inside rendersDir", async () => {
    const { app, rendersDir } = buildApp();
    writeFileSync(join(rendersDir, "demo.mp4"), "render-bytes");
    const res = await app.request("http://localhost/projects/demo/renders/file/demo.mp4");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("render-bytes");
  });

  describe("byte ranges", () => {
    const url = "http://localhost/projects/demo/renders/file/demo.mp4";

    function bytesApp(): Hono {
      const { app, rendersDir } = buildApp();
      writeFileSync(join(rendersDir, "demo.mp4"), "0123456789");
      return app;
    }

    it.each([
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=4-999", "456789", "bytes 4-9/10"],
    ])("answers Range %s with 206 and exactly those bytes", async (range, body, contentRange) => {
      const res = await bytesApp().request(url, { headers: { Range: range } });
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe(contentRange);
      expect(res.headers.get("Content-Length")).toBe(String(body.length));
      expect(await res.text()).toBe(body);
    });

    it("answers a range past the end with 416 and the file size", async () => {
      const res = await bytesApp().request(url, { headers: { Range: "bytes=10-20" } });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("serves the whole file, advertising ranges, when no usable Range is sent", async () => {
      const app = bytesApp();
      for (const headers of [{}, { Range: "bytes=0-1,3-4" }, { Range: "items=1-2" }]) {
        const res = await app.request(url, { headers });
        expect(res.status).toBe(200);
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        expect(res.headers.get("Content-Length")).toBe("10");
        expect(await res.text()).toBe("0123456789");
      }
    });

    it("streams a render too large to buffer: a 3 GiB file answers a window and a cancelled full read", async () => {
      const { app, rendersDir } = buildApp();
      const big = join(rendersDir, "big.mp4");
      const size = 3 * 1024 * 1024 * 1024;
      const fd = openSync(big, "w");
      try {
        ftruncateSync(fd, size);
        writeSync(fd, "WXYZ", 2 * 1024 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
      const base = "http://localhost/projects/demo/renders/file/big.mp4";

      const window = await app.request(base, { headers: { Range: "bytes=2147483648-2147483651" } });
      expect(window.status).toBe(206);
      expect(window.headers.get("Content-Range")).toBe(`bytes 2147483648-2147483651/${size}`);
      expect(await window.text()).toBe("WXYZ");

      const full = await app.request(base);
      expect(full.status).toBe(200);
      expect(full.headers.get("Content-Length")).toBe(String(size));
      const reader = full.body!.getReader();
      expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
      await reader.cancel();
    });
  });

  it("rejects a file reached through a symlink inside rendersDir pointing outside it", async () => {
    const { app, rendersDir } = buildApp();
    // A bare join()+readFileSync followed the symlink and leaked the target;
    // the resolveWithinProject chokepoint canonicalizes with realpath first.
    const external = mkdtempSync(join(tmpdir(), "hf-renders-external-"));
    tmpDirs.push(external);
    writeFileSync(join(external, "secret.txt"), "TOP-SECRET");
    if (!tryCreateSymlink(join(external, "secret.txt"), join(rendersDir, "leak.txt"), "file"))
      return;
    const res = await app.request("http://localhost/projects/demo/renders/file/leak.txt");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("serves a render file reached through a symlink that stays inside rendersDir", async () => {
    const { app, rendersDir } = buildApp();
    mkdirSync(join(rendersDir, "nested"));
    writeFileSync(join(rendersDir, "nested", "clip.mp4"), "nested-bytes");
    if (!tryCreateSymlink(join(rendersDir, "nested"), join(rendersDir, "alias"), "dir")) return;
    const res = await app.request("http://localhost/projects/demo/renders/file/alias/clip.mp4");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("nested-bytes");
  });
});

describe("POST /render/:jobId/cancel", () => {
  async function startJob(app: Hono): Promise<string> {
    const res = await app.request("http://localhost/projects/demo/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fps: 30, quality: "standard", format: "mp4" }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { jobId: string }).jobId;
  }

  it("marks a rendering job cancelled and invokes the adapter abort hook", async () => {
    const spy = vi.fn();
    let aborted = false;
    const { adapter, rendersDir } = createAdapter(spy);
    const baseStartRender = adapter.startRender.bind(adapter);
    adapter.startRender = (opts) => {
      const state = baseStartRender(opts);
      state.cancel = () => {
        aborted = true;
      };
      return state;
    };
    const app = new Hono();
    registerRenderRoutes(app, adapter);
    try {
      const jobId = await startJob(app);
      const res = await app.request(`http://localhost/render/${jobId}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("cancelled");
      expect(aborted).toBe(true);
      // SSE progress for a cancelled job must terminate (status is terminal).
      const progress = await app.request(`http://localhost/render/${jobId}/progress`);
      expect(progress.status).toBe(200);
    } finally {
      rmSync(rendersDir, { recursive: true, force: true });
    }
  });

  it("does not cancel a job that already completed", async () => {
    const spy = vi.fn();
    const states: Array<{ status: string }> = [];
    const { adapter, rendersDir } = createAdapter(spy);
    const baseStartRender = adapter.startRender.bind(adapter);
    adapter.startRender = (opts) => {
      const state = baseStartRender(opts);
      states.push(state);
      return state;
    };
    const app = new Hono();
    registerRenderRoutes(app, adapter);
    try {
      const jobId = await startJob(app);
      const [state] = states;
      if (state) state.status = "complete";
      const res = await app.request(`http://localhost/render/${jobId}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("complete");
    } finally {
      rmSync(rendersDir, { recursive: true, force: true });
    }
  });

  it("404s for unknown jobs", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/render/nope/cancel", { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/render — legacy telemetry fields tolerance", () => {
  it("ignores legacy telemetryDistinctId / telemetryOptOut without failing", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fps: 30,
          quality: "standard",
          format: "mp4",
          telemetryDistinctId: "browser-user-123",
          telemetryOptOut: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0]).not.toHaveProperty("distinctId");
      expect(spy.mock.calls[0][0]).not.toHaveProperty("telemetryOptOut");
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/render — variables forwarding", () => {
  it("forwards a variables object to the adapter", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format: "mp4",
          variables: { title: "Custom", count: 5, dark: true },
        }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].variables).toEqual({ title: "Custom", count: 5, dark: true });
    } finally {
      cleanup();
    }
  });

  it("omits variables from adapter opts when not provided", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      const res = await app.request("http://localhost/projects/demo/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "mp4" }),
      });
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0].variables).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects non-object variables payloads with 400 (no silent drop)", async () => {
    const spy = vi.fn();
    const { app, cleanup } = buildApp(spy);
    try {
      for (const variables of [["a"], "str", 42, null]) {
        const res = await app.request("http://localhost/projects/demo/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "mp4", variables }),
        });
        expect(res.status).toBe(400);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe("POST /projects/:id/renders/:filename/open — OS default player", () => {
  const tmpDirs: string[] = [];

  function buildOpenApp(openPath: (path: string) => Promise<void>): {
    app: Hono;
    rendersDir: string;
  } {
    const rendersDir = mkdtempSync(join(tmpdir(), "hf-renders-open-"));
    tmpDirs.push(rendersDir);
    const adapter: StudioApiAdapter = {
      listProjects: () => [],
      resolveProject: async (id: string) => (id === "demo" ? { id, dir: tmpdir() } : null),
      bundle: async () => null,
      lint: async () => ({ findings: [] }),
      runtimeUrl: "/api/runtime.js",
      rendersDir: () => rendersDir,
      startRender: (opts) => ({
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
      }),
    };
    const app = new Hono();
    registerRenderRoutes(app, adapter, { openPath });
    return { app, rendersDir };
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("hands the render's absolute path to the OS opener", async () => {
    const opened: string[] = [];
    const { app, rendersDir } = buildOpenApp(async (path) => {
      opened.push(path);
    });
    const filename = "render 測試.mp4";
    writeFileSync(join(rendersDir, filename), "render-bytes");

    const res = await app.request(
      `http://localhost/projects/demo/renders/${encodeURIComponent(filename)}/open`,
      { method: "POST" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ opened: true });
    expect(opened).toEqual([join(rendersDir, filename)]);
  });

  it("refuses a traversal that escapes the renders dir", async () => {
    const opened: string[] = [];
    const { app } = buildOpenApp(async (path) => {
      opened.push(path);
    });

    const res = await app.request(
      `http://localhost/projects/demo/renders/${encodeURIComponent("../index.html")}/open`,
      { method: "POST" },
    );

    expect(res.status).toBe(403);
    expect(opened).toEqual([]);
  });

  it("404s for an unknown project and a missing file without opening anything", async () => {
    const opened: string[] = [];
    const { app } = buildOpenApp(async (path) => {
      opened.push(path);
    });

    const unknownProject = await app.request("http://localhost/projects/nope/renders/x.mp4/open", {
      method: "POST",
    });
    expect(unknownProject.status).toBe(404);

    const missing = await app.request("http://localhost/projects/demo/renders/missing.mp4/open", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    expect(opened).toEqual([]);
  });

  it("reports an opener failure as a 500 instead of a silent success", async () => {
    const { app, rendersDir } = buildOpenApp(async () => {
      throw new Error("no player for .mp4");
    });
    writeFileSync(join(rendersDir, "demo.mp4"), "render-bytes");

    const res = await app.request("http://localhost/projects/demo/renders/demo.mp4/open", {
      method: "POST",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("no player for .mp4"),
    });
  });
});

describe("GET /render/:jobId/download — Windows output paths", () => {
  it("serves the leaf filename when the on-disk file was registered from the list route", async () => {
    // The list route seeds `renderJobs` from on-disk files with
    // `join(rendersDir, filename)` — backslash-separated on win32 — so the
    // download filename must be separator-agnostic, not `/`-split.
    const spy = vi.fn();
    const { app, rendersDir, cleanup } = buildApp(spy);
    try {
      const jobId = "win-job_2026-10-02_00-00-00";
      writeFileSync(join(rendersDir, `${jobId}.mp4`), "render-bytes");
      const list = await app.request("http://localhost/projects/demo/renders");
      expect(list.status).toBe(200);
      const res = await app.request(`http://localhost/render/${jobId}/download`);
      expect(res.status).toBe(200);
      const header = res.headers.get("content-disposition") ?? "";
      expect(header).toContain(`${jobId}.mp4`);
      expect(header).not.toContain("\\");
    } finally {
      cleanup();
    }
  });
});
