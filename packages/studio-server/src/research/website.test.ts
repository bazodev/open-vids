// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isReadWebsiteResult,
  PROVENANCE_PATH,
  type WebsiteStyle,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebsiteInspection, WebsiteInspectionResult } from "../types.js";
import { isResearchFailure } from "./errors.js";
import { readLedger } from "./provenance.js";
import { createResearchFixture, type ResearchFixture } from "./testSupport.js";

let fixture: ResearchFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const bytes = (text: string) => new TextEncoder().encode(text);

const SITE: WebsiteStyle = {
  url: "https://www.example.com/",
  finalUrl: "https://www.example.com/en",
  host: "example.com",
  title: "Example",
  description: "An example site",
  themeColor: "#0a0a0a",
  language: "en",
  colors: [{ hex: "#0a0a0a", role: "background", count: 40 }],
  fonts: [
    {
      family: "Inter",
      weights: [400, 600],
      source: "self_hosted",
      url: "https://www.example.com/fonts/inter.woff2",
      usedFor: ["body"],
    },
  ],
  textStyles: [],
  radii: [],
  shadows: [],
  buttons: [],
  tokens: [],
  motion: { durationsMs: [200], easings: ["ease-out"], keyframes: [], properties: ["opacity"] },
  logos: [],
  favicon: null,
  ogImage: null,
  headings: ["Build faster"],
  navLabels: [],
  notes: [],
  capturedAt: 1,
};

function inspection(): WebsiteInspection {
  return {
    site: SITE,
    screenshots: [
      {
        name: "viewport.jpg",
        mimeType: "image/jpeg",
        data: bytes("jpeg-top"),
        width: 1440,
        height: 900,
      },
      {
        name: "fullpage.jpg",
        mimeType: "image/jpeg",
        data: bytes("jpeg-full"),
        width: 1440,
        height: 2400,
      },
    ],
    logo: {
      name: "logo.svg",
      mimeType: "image/svg+xml",
      data: bytes("<svg/>"),
      url: "https://www.example.com/",
    },
    fonts: [
      {
        name: "../../Inter Var.woff2",
        mimeType: "font/woff2",
        data: bytes("woff2-bytes"),
        family: "Inter",
        weight: 400,
        style: "normal",
        url: "https://www.example.com/fonts/inter.woff2",
      },
    ],
  };
}

function setup(
  result: (
    signal: AbortSignal,
  ) => Promise<WebsiteInspectionResult> | WebsiteInspectionResult = inspection,
  options: Parameters<typeof createResearchFixture>[0] = {},
) {
  const inspect = vi.fn(async (opts: { url: string; signal: AbortSignal }) => result(opts.signal));
  fixture = createResearchFixture({ ...options, inspectWebsite: inspect });
  return { f: fixture, inspect };
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
  return existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).sort() : [];
};

describe("the Websites setting", () => {
  it("is on by default and survives a policy file written before it existed", () => {
    const { f } = setup();
    expect(f.service.policy().websites).toEqual({ readLinkedPages: true, fullAccess: false });
  });

  it("refuses every read when switched off, before any page is opened", async () => {
    const { f, inspect } = setup();
    f.service.updatePolicy({ websites: { readLinkedPages: false } });
    const refused = await failure(f.service.website(f.project, { url: "https://example.com" }));
    expect(refused.code).toBe("blocked_by_policy");
    expect(refused.message).toContain("Settings");
    expect(inspect).not.toHaveBeenCalled();

    f.service.updatePolicy({ websites: { readLinkedPages: true } });
    await f.service.website(f.project, { url: "https://example.com" });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});

describe("the address rules", () => {
  it.each([
    ["ftp://example.com/file", "invalid_request"],
    ["file:///etc/passwd", "invalid_request"],
    ["javascript:alert(1)", "invalid_request"],
    ["not a url", "invalid_request"],
    ["https://user:secret@example.com/", "blocked_by_policy"],
    ["http://127.0.0.1:5480/", "blocked_by_policy"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_by_policy"],
    ["http://[::1]/", "blocked_by_policy"],
    ["http://localhost:3000/", "blocked_by_policy"],
    ["http://intranet/", "blocked_by_policy"],
    ["http://printer.local/", "blocked_by_policy"],
  ])("refuses %s without opening it", async (url, code) => {
    const { f, inspect } = setup();
    expect((await failure(f.service.website(f.project, { url }))).code).toBe(code);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address", async () => {
    const { f, inspect } = setup(inspection, { dns: { "rebind.example.com": "10.0.0.7" } });
    const refused = await failure(
      f.service.website(f.project, { url: "https://rebind.example.com/" }),
    );
    expect(refused.code).toBe("blocked_by_policy");
    expect(refused.message).toContain("10.0.0.7");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("is not bound to the trusted sources: any public site the user linked can be read", async () => {
    const { f, inspect } = setup();
    expect(f.service.policy().mode).toBe("trusted");
    await f.service.website(f.project, { url: "https://some-brand.example.org/" });
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://some-brand.example.org/" }),
    );
  });
});

describe("reading", () => {
  it("answers the style with base64 screenshots and writes nothing without save", async () => {
    const { f } = setup();
    const result = await f.service.website(f.project, { url: "https://www.example.com/" });
    expect(isReadWebsiteResult(result)).toBe(true);
    expect(result.site.host).toBe("example.com");
    expect(result.screenshots.map((shot) => shot.name)).toEqual(["viewport.jpg", "fullpage.jpg"]);
    expect(Buffer.from(result.screenshots[0]?.data ?? "", "base64").toString()).toBe("jpeg-top");
    expect(result.saved).toBeUndefined();
    expect(webFiles(f)).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });

  it("maps a page that cannot be read to a typed error", async () => {
    const { f } = setup(() => ({
      error: { code: "unavailable", message: "The page answered 404" },
    }));
    expect(await failure(f.service.website(f.project, { url: "https://example.com/x" }))).toEqual({
      code: "unavailable",
      message: "The page answered 404",
    });
  });

  it("is unsupported where no browser capability exists", async () => {
    fixture = createResearchFixture();
    expect(
      (await failure(fixture.service.website(fixture.project, { url: "https://example.com" })))
        .code,
    ).toBe("unsupported");
  });
});

describe("save", () => {
  it("writes screenshots, logo and fonts under assets/web/<host>/ with a provenance record each", async () => {
    const { f } = setup();
    const result = await f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
      agent: "motion",
      turnId: "turn-1",
    });

    // `readdirSync(recursive)` joins with the OS separator (backslashes on
    // Windows); the saved/provenance paths below stay forward-slash.
    expect(webFiles(f).map((entry) => entry.replaceAll("\\", "/"))).toEqual([
      "example.com",
      "example.com/fonts",
      "example.com/fonts/inter-var.woff2",
      "example.com/fullpage.jpg",
      "example.com/logo.svg",
      "example.com/viewport.jpg",
    ]);
    expect(result.saved).toEqual({
      dir: "assets/web/example.com",
      files: [
        "assets/web/example.com/viewport.jpg",
        "assets/web/example.com/fullpage.jpg",
        "assets/web/example.com/logo.svg",
        "assets/web/example.com/fonts/inter-var.woff2",
      ],
      logo: "assets/web/example.com/logo.svg",
      screenshots: ["assets/web/example.com/viewport.jpg", "assets/web/example.com/fullpage.jpg"],
      fonts: [
        {
          family: "Inter",
          weight: 400,
          style: "normal",
          path: "assets/web/example.com/fonts/inter-var.woff2",
        },
      ],
    });
    expect(readFileSync(join(f.project.dir, "assets/web/example.com/viewport.jpg"), "utf8")).toBe(
      "jpeg-top",
    );

    const records = readLedger(f.project.dir).records;
    expect(records.map((record) => [record.asset, record.mediaKind])).toEqual([
      ["assets/web/example.com/viewport.jpg", "picture"],
      ["assets/web/example.com/fullpage.jpg", "picture"],
      ["assets/web/example.com/logo.svg", "picture"],
      ["assets/web/example.com/fonts/inter-var.woff2", "font"],
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        source: { id: "website", name: "example.com", trusted: false },
        pageUrl: "https://www.example.com/en",
        licenseId: "unknown",
        licenseStatus: "unknown",
        licenseConfidence: "none",
        retrievedBy: { agent: "motion", turnId: "turn-1" },
        attribution: "From example.com (website reference)",
      });
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(records[3]?.originalUrl).toBe("https://www.example.com/fonts/inter.woff2");
    expect(records[0]?.originalUrl).toBe("https://www.example.com/en");
  });

  it("shows up in the project's Sources & Licenses view as unknown-license references", async () => {
    const { f } = setup();
    await f.service.website(f.project, { url: "https://www.example.com/", save: true });
    const view = await f.service.sources(f.project);
    expect(view.summary).toMatchObject({ total: 4, unknown: 4 });
    expect(view.records.every((record) => record.present)).toBe(true);
  });

  it("saves again over the same paths without duplicating records", async () => {
    const { f } = setup();
    await f.service.website(f.project, { url: "https://www.example.com/", save: true });
    await f.service.website(f.project, { url: "https://www.example.com/", save: true });
    expect(readLedger(f.project.dir).records).toHaveLength(4);
    expect(webFiles(f)).toHaveLength(6);
  });

  it("never lets a file name leave the site folder", async () => {
    const hostile = (): WebsiteInspection => ({
      ...inspection(),
      logo: {
        name: "/../../../../etc/logo.svg",
        mimeType: "image/svg+xml",
        data: bytes("<svg/>"),
        url: "https://www.example.com/",
      },
      fonts: [],
    });
    const { f } = setup(hostile);
    const result = await f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
    });
    expect(result.saved?.logo).toBe("assets/web/example.com/logo.svg");
    expect(existsSync(join(f.project.dir, "..", "..", "etc"))).toBe(false);
  });

  it("keeps two fonts of the same file name apart", async () => {
    const twin = (weight: number) => ({
      name: "inter.woff2",
      mimeType: "font/woff2",
      data: bytes(`woff2-${weight}`),
      family: "Inter",
      weight,
      style: "normal" as const,
      url: `https://www.example.com/fonts/inter-${weight}.woff2`,
    });
    const { f } = setup(() => ({ ...inspection(), fonts: [twin(400), twin(700)] }));
    const result = await f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
    });
    expect(result.saved?.fonts.map((font) => font.path)).toEqual([
      "assets/web/example.com/fonts/inter.woff2",
      "assets/web/example.com/fonts/inter-2.woff2",
    ]);
  });
});

describe("cancellation", () => {
  /** A browser that never finishes until its signal aborts. */
  const hanging = (started: () => void) => (signal: AbortSignal) =>
    new Promise<WebsiteInspectionResult>((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });

  it("a cancel while the page is rendering is answered cancelled and writes nothing", async () => {
    let begin = () => {};
    const running = new Promise<void>((resolve) => (begin = resolve));
    const { f } = setup(hanging(() => begin()));
    const pending = f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
      requestId: "req-1",
    });
    await running;
    expect(f.service.cancel(f.project, "req-1")).toBe("cancelled");
    expect((await failure(pending)).code).toBe("cancelled");
    expect(webFiles(f)).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });

  it("a client that disconnects stops the browser", async () => {
    let begin = () => {};
    const running = new Promise<void>((resolve) => (begin = resolve));
    const { f, inspect } = setup(hanging(() => begin()));
    const client = new AbortController();
    const pending = f.service.website(
      f.project,
      { url: "https://www.example.com/" },
      client.signal,
    );
    await running;
    client.abort();
    expect((await failure(pending)).code).toBe("cancelled");
    expect(inspect.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("a cancel that arrives before the request refuses it", async () => {
    const { f } = setup((signal) => {
      signal.throwIfAborted();
      return inspection();
    });
    expect(f.service.cancel(f.project, "early")).toBe("cancelled");
    const pending = f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
      requestId: "early",
    });
    expect((await failure(pending)).code).toBe("cancelled");
    expect(webFiles(f)).toEqual([]);
  });

  it("a cancel after the files were committed is told so, and the request finishes", async () => {
    const { f } = setup();
    const result = await f.service.website(f.project, {
      url: "https://www.example.com/",
      save: true,
      requestId: "req-done",
    });
    expect(result.saved?.files).toHaveLength(4);
    expect(f.service.cancel(f.project, "req-done")).toBe("finished");
    expect(webFiles(f)).toHaveLength(6);
  });

  it("refuses to reuse a request id", async () => {
    let begin = () => {};
    const running = new Promise<void>((resolve) => (begin = resolve));
    const { f } = setup(hanging(() => begin()));
    const first = f.service.website(f.project, {
      url: "https://www.example.com/",
      requestId: "dup",
    });
    await running;
    expect(
      (
        await failure(
          f.service.website(f.project, { url: "https://www.example.com/", requestId: "dup" }),
        )
      ).code,
    ).toBe("invalid_request");
    f.service.cancel(f.project, "dup");
    await failure(first);
  });
});
