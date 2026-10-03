// @vitest-environment node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  PROVENANCE_PATH,
  WEBSITE_LIMITS,
  isRecordWebsiteResult,
  isWebsiteFileResult,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isResearchFailure } from "./errors.js";
import { readLedger } from "./provenance.js";
import type { ResearchServiceOptions } from "./service.js";
import { createResearchFixture, media, redirect, type ResearchFixture } from "./testSupport.js";

let fixture: ResearchFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

/** A fixture with full access on (reading linked pages stays on). */
function setup(options: Parameters<typeof createResearchFixture>[0] = {}): ResearchFixture {
  const f = createResearchFixture(options);
  fixture = f;
  f.service.updatePolicy({ websites: { fullAccess: true } });
  return f;
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isResearchFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected a research failure");
}

const webFiles = (f: ResearchFixture): string[] => {
  const dir = join(f.project.dir, "assets/web");
  // readdir joins with the platform separator; the wire and the assertions use "/".
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((entry) => entry.split(sep).join("/"))
        .sort()
    : [];
};

const LOTTIE = JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 90, layers: [] });

describe("the full-access gate", () => {
  it("refuses both requests while full access is off, before any request is made", async () => {
    const f = createResearchFixture();
    fixture = f;
    const read = await failure(
      f.service.websiteFile(f.project, { url: "https://example.com/a.txt", mode: "read" }),
    );
    expect(read.code).toBe("blocked_by_policy");
    expect(read.message).toContain("Settings → Asset Search → Websites");
    const record = await failure(
      f.service.websiteRecord(f.project, { url: "https://example.com/", seconds: 3 }),
    );
    expect(record.code).toBe("blocked_by_policy");
    expect(f.net.calls).toEqual([]);
    expect(webFiles(f)).toEqual([]);
  });

  it("refuses both while reading linked pages is off, even with full access on", async () => {
    const f = setup();
    f.service.updatePolicy({ websites: { fullAccess: true, readLinkedPages: false } });
    expect(
      (
        await failure(
          f.service.websiteFile(f.project, { url: "https://example.com/a.txt", mode: "read" }),
        )
      ).code,
    ).toBe("blocked_by_policy");
    expect(
      (
        await failure(
          f.service.websiteRecord(f.project, { url: "https://example.com/", seconds: 3 }),
        )
      ).code,
    ).toBe("blocked_by_policy");
    expect(f.net.calls).toEqual([]);
  });
});

describe("reading files as text", () => {
  it("returns the text of a stylesheet and saves nothing", async () => {
    const f = setup();
    f.net.when("https://example.com/style.css", media("body { color: red }", "text/css"));
    const result = await f.service.websiteFile(f.project, {
      url: "https://example.com/style.css",
      mode: "read",
    });
    expect(isWebsiteFileResult(result)).toBe(true);
    expect(result).toMatchObject({
      url: "https://example.com/style.css",
      finalUrl: "https://example.com/style.css",
      kind: "stylesheet",
      mimeType: "text/css",
      truncated: false,
      text: "body { color: red }",
    });
    expect(result.path).toBeUndefined();
    expect(webFiles(f)).toEqual([]);
  });

  it("cuts a long text at the read limit and marks it truncated", async () => {
    const f = setup();
    f.net.when(
      "https://example.com/long.txt",
      media("x".repeat(WEBSITE_LIMITS.readTextChars + 500), "text/plain"),
    );
    const result = await f.service.websiteFile(f.project, {
      url: "https://example.com/long.txt",
      mode: "read",
    });
    expect(result.text).toHaveLength(WEBSITE_LIMITS.readTextChars);
    expect(result.truncated).toBe(true);
  });

  it("refuses to read a binary file and points at save", async () => {
    const f = setup();
    f.net.when("https://example.com/logo.png", media("PNGDATA", "image/png"));
    const refused = await failure(
      f.service.websiteFile(f.project, { url: "https://example.com/logo.png", mode: "read" }),
    );
    expect(refused.code).toBe("invalid_request");
    expect(refused.message).toContain("save");
    expect(webFiles(f)).toEqual([]);
  });

  it("maps a missing file to unavailable and a server error to network", async () => {
    const f = setup();
    f.net.when("https://example.com/gone.css", media("", "text/css", 404));
    expect(
      (
        await failure(
          f.service.websiteFile(f.project, { url: "https://example.com/gone.css", mode: "read" }),
        )
      ).code,
    ).toBe("unavailable");
    f.net.when("https://example.com/broken.css", media("", "text/css", 500));
    expect(
      (
        await failure(
          f.service.websiteFile(f.project, { url: "https://example.com/broken.css", mode: "read" }),
        )
      ).code,
    ).toBe("network");
  });
});

describe("saving files", () => {
  it("downloads a file into assets/web/<host>/files/ with a provenance record", async () => {
    const f = setup();
    f.net.when("https://example.com/hero.png", media("PNGDATA", "image/png"));
    const result = await f.service.websiteFile(f.project, {
      url: "https://example.com/hero.png",
      mode: "save",
      pageUrl: "https://example.com/",
      agent: "motion",
      turnId: "turn-2",
    });
    expect(result).toMatchObject({
      url: "https://example.com/hero.png",
      finalUrl: "https://example.com/hero.png",
      kind: "image",
      mimeType: "image/png",
      bytes: 7,
      path: "assets/web/example.com/files/hero.png",
    });
    expect(readFileSync(join(f.project.dir, result.path ?? ""), "utf8")).toBe("PNGDATA");

    const records = readLedger(f.project.dir).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      asset: "assets/web/example.com/files/hero.png",
      mediaKind: "picture",
      title: "hero.png from example.com",
      originalUrl: "https://example.com/hero.png",
      pageUrl: "https://example.com/",
      source: { id: "website", name: "example.com", trusted: false },
      licenseId: "unknown",
      licenseStatus: "unknown",
      licenseConfidence: "none",
      retrievedBy: { agent: "motion", turnId: "turn-2", model: null },
      bytes: 7,
      contentType: "image/png",
      policyMode: "trusted",
    });
    expect(records[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0]?.originalSha256).toBe(records[0]?.sha256);
  });

  it("reuses an identical file and gives a different file with the same name -2", async () => {
    const f = setup();
    f.net.when("https://example.com/hero.png", media("PNGDATA", "image/png"));
    const first = await f.service.websiteFile(f.project, {
      url: "https://example.com/hero.png",
      mode: "save",
    });
    const again = await f.service.websiteFile(f.project, {
      url: "https://example.com/hero.png",
      mode: "save",
    });
    expect(again.path).toBe(first.path);
    expect(webFiles(f)).toEqual(["example.com", "example.com/files", "example.com/files/hero.png"]);
    expect(readLedger(f.project.dir).records).toHaveLength(1);

    f.net.when("https://example.com/hero.png", media("OTHER!!", "image/png"));
    const other = await f.service.websiteFile(f.project, {
      url: "https://example.com/hero.png",
      mode: "save",
    });
    expect(other.path).toBe("assets/web/example.com/files/hero-2.png");
    expect(readFileSync(join(f.project.dir, other.path ?? ""), "utf8")).toBe("OTHER!!");
    expect(
      readLedger(f.project.dir)
        .records.map((record) => record.asset)
        .sort(),
    ).toEqual(["assets/web/example.com/files/hero-2.png", "assets/web/example.com/files/hero.png"]);
  });

  it("falls back to a name from the kind when the URL has none", async () => {
    const f = setup();
    f.net.when("https://example.com/", media("PNGDATA", "image/png"));
    const result = await f.service.websiteFile(f.project, {
      url: "https://example.com/",
      mode: "save",
    });
    expect(result.path).toBe("assets/web/example.com/files/file.png");
  });
});

describe("animation classification", () => {
  it("recognizes Lottie JSON, .lottie and .riv as animations and plain JSON as data", async () => {
    const f = setup();
    f.net.when("https://example.com/anim.json", media(LOTTIE, "application/json"));
    const read = await f.service.websiteFile(f.project, {
      url: "https://example.com/anim.json",
      mode: "read",
    });
    expect(read.kind).toBe("animation");

    const saved = await f.service.websiteFile(f.project, {
      url: "https://example.com/anim.json",
      mode: "save",
    });
    expect(saved.kind).toBe("animation");
    expect(readLedger(f.project.dir).records[0]?.mediaKind).toBe("animation");

    f.net.when("https://example.com/motion.lottie", media("ZIP", "application/zip"));
    expect(
      (
        await f.service.websiteFile(f.project, {
          url: "https://example.com/motion.lottie",
          mode: "save",
        })
      ).kind,
    ).toBe("animation");

    f.net.when("https://example.com/ui.riv", media("RIVE", "application/octet-stream"));
    expect(
      (
        await f.service.websiteFile(f.project, {
          url: "https://example.com/ui.riv",
          mode: "save",
        })
      ).kind,
    ).toBe("animation");

    f.net.when("https://example.com/plain.json", media('{"a":1}', "application/json"));
    expect(
      (
        await f.service.websiteFile(f.project, {
          url: "https://example.com/plain.json",
          mode: "read",
        })
      ).kind,
    ).toBe("data");
  });
});

describe("the address rules", () => {
  it("refuses a redirect to a private address without following it", async () => {
    const f = setup();
    f.net.when("https://public.example.com/a.png", redirect("http://127.0.0.1/secret.png"));
    const refused = await failure(
      f.service.websiteFile(f.project, { url: "https://public.example.com/a.png", mode: "save" }),
    );
    expect(refused.code).toBe("blocked_by_policy");
    expect(f.net.calls).toEqual(["https://public.example.com/a.png"]);
    expect(webFiles(f)).toEqual([]);
  });

  it("refuses a redirect to a host that resolves to a private address", async () => {
    const f = setup({ dns: { "rebind.example.com": "10.0.0.7" } });
    f.net.when("https://public.example.com/a.png", redirect("https://rebind.example.com/a.png"));
    expect(
      (
        await failure(
          f.service.websiteFile(f.project, {
            url: "https://public.example.com/a.png",
            mode: "save",
          }),
        )
      ).code,
    ).toBe("blocked_by_policy");
    expect(webFiles(f)).toEqual([]);
  });

  it("follows a redirect to another public host and files under the final host", async () => {
    const f = setup();
    f.net.when("https://public.example.com/a.png", redirect("https://cdn.example.com/files/a.png"));
    f.net.when("https://cdn.example.com/files/a.png", media("PNGDATA", "image/png"));
    const result = await f.service.websiteFile(f.project, {
      url: "https://public.example.com/a.png",
      mode: "save",
    });
    expect(result.finalUrl).toBe("https://cdn.example.com/files/a.png");
    expect(result.path).toBe("assets/web/cdn.example.com/files/a.png");
  });
});

describe("limits", () => {
  it("refuses a file the server says is over the limit", async () => {
    const f = setup();
    f.net.when(
      "https://example.com/big.bin",
      () =>
        new Response("x", {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(WEBSITE_LIMITS.fileBytes + 1),
          },
        }),
    );
    const refused = await failure(
      f.service.websiteFile(f.project, { url: "https://example.com/big.bin", mode: "save" }),
    );
    expect(refused.code).toBe("too_large");
    expect(webFiles(f)).toEqual([]);
  });
});

describe("cancellation", () => {
  it("a cancel while downloading is answered cancelled and writes nothing", async () => {
    const f = setup();
    const started = Promise.withResolvers<void>();
    f.net.when("https://example.com/slow.png", (_url, init) => {
      started.resolve();
      const hung = Promise.withResolvers<Response>();
      init.signal.addEventListener("abort", () => hung.reject(new Error("Aborted")), {
        once: true,
      });
      return hung.promise;
    });
    const pending = f.service.websiteFile(f.project, {
      url: "https://example.com/slow.png",
      mode: "save",
      requestId: "req-file",
    });
    await started.promise;
    expect(f.service.cancel(f.project, "req-file")).toBe("cancelled");
    expect((await failure(pending)).code).toBe("cancelled");
    expect(webFiles(f)).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });

  it("a cancel that arrives before the request refuses it", async () => {
    const f = setup();
    expect(f.service.cancel(f.project, "early-file")).toBe("cancelled");
    const pending = f.service.websiteFile(f.project, {
      url: "https://example.com/a.png",
      mode: "save",
      requestId: "early-file",
    });
    expect((await failure(pending)).code).toBe("cancelled");
    expect(f.net.calls).toEqual([]);
    expect(webFiles(f)).toEqual([]);
  });

  it("a cancel after the file was committed is told finished", async () => {
    const f = setup();
    f.net.when("https://example.com/a.png", media("PNGDATA", "image/png"));
    await f.service.websiteFile(f.project, {
      url: "https://example.com/a.png",
      mode: "save",
      requestId: "done-file",
    });
    expect(f.service.cancel(f.project, "done-file")).toBe("finished");
  });
});

describe("recording pages", () => {
  it("records through the adapter, moves the MP4 into the project and cleans the temp file", async () => {
    const outFiles: string[] = [];
    const recordWebsite: NonNullable<ResearchServiceOptions["recordWebsite"]> = vi.fn(
      async (opts) => {
        outFiles.push(opts.outFile);
        writeFileSync(opts.outFile, "MP4DATA");
        return {
          finalUrl: "https://example.com/hero",
          width: opts.width,
          height: opts.height,
          duration: opts.seconds,
          notes: ["scrolled"],
        };
      },
    );
    const f = setup({ recordWebsite });
    const result = await f.service.websiteRecord(f.project, {
      url: "https://example.com/",
      seconds: 5,
      selector: ".hero",
      agent: "motion",
      turnId: "turn-3",
    });
    expect(isRecordWebsiteResult(result)).toBe(true);
    expect(result.path).toMatch(
      /^assets\/web\/example\.com\/recordings\/example\.com-\d{8}-\d{6}\.mp4$/,
    );
    expect(readFileSync(join(f.project.dir, result.path), "utf8")).toBe("MP4DATA");
    expect(result).toMatchObject({
      finalUrl: "https://example.com/hero",
      width: 1920,
      height: 1080,
      duration: 5,
      bytes: 7,
      notes: ["scrolled"],
    });
    expect(outFiles.every((file) => !existsSync(file))).toBe(true);
    expect(f.net.calls).toEqual([]);

    const records = readLedger(f.project.dir).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      asset: result.path,
      mediaKind: "video",
      title: "Recording of example.com/hero (5 s)",
      originalUrl: "https://example.com/",
      pageUrl: "https://example.com/",
      contentType: "video/mp4",
      bytes: 7,
      retrievedBy: { agent: "motion", turnId: "turn-3" },
    });
  });

  it("defaults to 1920x1080 and rounds odd sides down to even", async () => {
    const seen: Array<{ width: number; height: number }> = [];
    const recordWebsite: NonNullable<ResearchServiceOptions["recordWebsite"]> = async (opts) => {
      seen.push({ width: opts.width, height: opts.height });
      writeFileSync(opts.outFile, "MP4");
      return {
        finalUrl: opts.url,
        width: opts.width,
        height: opts.height,
        duration: opts.seconds,
        notes: [],
      };
    };
    const f = setup({ recordWebsite });
    await f.service.websiteRecord(f.project, { url: "https://example.com/", seconds: 1 });
    await f.service.websiteRecord(f.project, {
      url: "https://example.com/",
      seconds: 2,
      width: 1001,
      height: 901,
    });
    expect(seen).toEqual([
      { width: 1920, height: 1080 },
      { width: 1000, height: 900 },
    ]);
  });

  it("maps an adapter failure to its research error", async () => {
    const f = setup({
      recordWebsite: async () => ({
        error: { code: "unavailable", message: "The page answered 404" },
      }),
    });
    expect(
      await failure(
        f.service.websiteRecord(f.project, { url: "https://example.com/", seconds: 2 }),
      ),
    ).toEqual({ code: "unavailable", message: "The page answered 404" });
    expect(webFiles(f)).toEqual([]);
  });

  it("is unsupported without a recorder", async () => {
    const f = setup();
    expect(
      (
        await failure(
          f.service.websiteRecord(f.project, { url: "https://example.com/", seconds: 2 }),
        )
      ).code,
    ).toBe("unsupported");
    expect(f.net.calls).toEqual([]);
  });

  it("refuses private addresses", async () => {
    const f = setup();
    expect(
      (await failure(f.service.websiteRecord(f.project, { url: "http://127.0.0.1/", seconds: 2 })))
        .code,
    ).toBe("blocked_by_policy");
  });

  it("a cancel while recording is answered cancelled and writes nothing", async () => {
    const started = Promise.withResolvers<void>();
    const f = setup({
      recordWebsite: (opts) => {
        started.resolve();
        const hung = Promise.withResolvers<never>();
        opts.signal.addEventListener("abort", () => hung.reject(new Error("Aborted")), {
          once: true,
        });
        return hung.promise;
      },
    });
    const pending = f.service.websiteRecord(f.project, {
      url: "https://example.com/",
      seconds: 4,
      requestId: "req-rec",
    });
    await started.promise;
    expect(f.service.cancel(f.project, "req-rec")).toBe("cancelled");
    expect((await failure(pending)).code).toBe("cancelled");
    expect(webFiles(f)).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });
});
