import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadOptions } from "../utils/httpsDownload.js";

const sherpa = vi.hoisted(() => ({
  unsupported: null as string | null,
  installRuntime: vi.fn(async (_options?: unknown) => false),
}));
vi.mock("./sherpa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sherpa.js")>()),
  sherpaUnsupportedReason: () => sherpa.unsupported,
  installSherpaRuntime: sherpa.installRuntime,
}));

import {
  DIARIZATION_MODEL_FILES,
  diarizationConfig,
  diarizationModelsInstalled,
  installDiarization,
  isDiarizationUnavailable,
  parseTurns,
  type DiarizationModelFile,
} from "./diarize.js";

const pin = (name: string, content: string): DiarizationModelFile => ({
  name,
  url: `https://example.test/models/${name}`,
  bytes: Buffer.byteLength(content),
  sha256: createHash("sha256").update(content).digest("hex"),
});

/** A downloader serving `served[name]` for any URL ending in that name. */
function fakeDownload(served: Record<string, string>) {
  return vi.fn(async (url: string, dest: string, opts?: DownloadOptions) => {
    const content = served[url.split("/").at(-1)!]!;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    opts?.onProgress?.(Buffer.byteLength(content), undefined);
    return { path: dest, bytes: Buffer.byteLength(content) };
  });
}

describe("pinned diarization models", () => {
  it("pins both files with an exact size and a sha256, from https, under flat names", () => {
    expect(DIARIZATION_MODEL_FILES.map((f) => f.name)).toEqual([
      "pyannote-segmentation-3-0.onnx",
      "nemo_en_titanet_small.onnx",
    ]);
    for (const file of DIARIZATION_MODEL_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(1_000_000);
      expect(new URL(file.url).protocol).toBe("https:");
      expect(file.name).not.toMatch(/[\\/]/);
    }
    // The Hugging Face mirror must be pinned to a commit, never a moving branch.
    expect(DIARIZATION_MODEL_FILES[0]!.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });
});

describe("installDiarization", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-diarize-models-"));
    sherpa.unsupported = null;
    sherpa.installRuntime.mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const files = [pin("seg.onnx", "segmentation-bytes"), pin("emb.onnx", "embedding-bytes")];

  it("downloads what is missing, verifies it and then reports nothing left to do", async () => {
    const download = fakeDownload({
      "seg.onnx": "segmentation-bytes",
      "emb.onnx": "embedding-bytes",
    });
    expect(diarizationModelsInstalled(dir, files)).toBe(false);
    await expect(installDiarization({ dir, files, download })).resolves.toBe(true);
    expect(diarizationModelsInstalled(dir, files)).toBe(true);
    expect(download).toHaveBeenCalledTimes(2);

    await expect(installDiarization({ dir, files, download })).resolves.toBe(false);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("discards a download whose bytes do not match the pin, even when the size does", async () => {
    // Same length as the pinned "segmentation-bytes", different content.
    const download = fakeDownload({
      "seg.onnx": "segmentation-BYTES",
      "emb.onnx": "embedding-bytes",
    });
    await expect(installDiarization({ dir, files, download })).rejects.toThrow(
      "seg.onnx did not match its pinned size and sha256",
    );
    expect(existsSync(join(dir, "seg.onnx"))).toBe(false);
    expect(diarizationModelsInstalled(dir, files)).toBe(false);
    // No staging directory is left behind either.
    expect(
      readdirSync(dirname(dir)).filter((n) => n.startsWith(`${dir.split("/").at(-1)}.tmp-`)),
    ).toEqual([]);
  });

  it("replaces an installed file that no longer verifies", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "seg.onnx"), "segmentation-BYTES");
    writeFileSync(join(dir, "emb.onnx"), "embedding-bytes");
    const download = fakeDownload({
      "seg.onnx": "segmentation-bytes",
      "emb.onnx": "embedding-bytes",
    });
    await expect(installDiarization({ dir, files, download })).resolves.toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("is unavailable, not failed, on an unsupported platform and never touches the network", async () => {
    sherpa.unsupported = "Parakeet runs on darwin-arm64; this system is freebsd-x64.";
    const download = fakeDownload({});
    const err = await installDiarization({ dir, files, download }).catch((e: unknown) => e);
    expect(isDiarizationUnavailable(err)).toBe(true);
    expect(sherpa.installRuntime).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("is unavailable when the runtime install fails for lack of a network", async () => {
    sherpa.installRuntime.mockRejectedValue(
      new Error("npm error code ENOTFOUND registry.npmjs.org"),
    );
    const err = await installDiarization({ dir, files, download: fakeDownload({}) }).catch(
      (e: unknown) => e,
    );
    expect(isDiarizationUnavailable(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error && err.message).toContain("ENOTFOUND");
  });

  it("is unavailable when a model download cannot connect, but a hash mismatch stays a failure", async () => {
    const offline = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    });
    const err = await installDiarization({ dir, files, download: offline }).catch(
      (e: unknown) => e,
    );
    expect(isDiarizationUnavailable(err)).toBe(true);

    const bad = fakeDownload({ "seg.onnx": "segmentation-BYTES", "emb.onnx": "embedding-bytes" });
    const mismatch = await installDiarization({ dir, files, download: bad }).catch(
      (e: unknown) => e,
    );
    expect(isDiarizationUnavailable(mismatch)).toBe(false);
  });

  it("does not turn a cancel into an offline condition", async () => {
    const abort = new AbortController();
    abort.abort();
    const err = await installDiarization({
      dir,
      files,
      download: fakeDownload({}),
      signal: abort.signal,
    }).catch((e: unknown) => e);
    expect(isDiarizationUnavailable(err)).toBe(false);
  });
});

describe("parseTurns", () => {
  it("orders turns by time and rounds to milliseconds", () => {
    expect(
      parseTurns([
        { start: 9.0254, end: 14.7799, speaker: 1 },
        { start: 0.8071, end: 8.0629, speaker: 0 },
      ]),
    ).toEqual([
      { speaker: 0, start: 0.807, end: 8.063 },
      { speaker: 1, start: 9.025, end: 14.78 },
    ]);
  });

  it("accepts an empty result (silence)", () => {
    expect(parseTurns([])).toEqual([]);
  });

  it.each([
    ["not a list", { turns: [] }],
    ["an inverted turn", [{ speaker: 0, start: 4, end: 3 }]],
    ["a zero-length turn", [{ speaker: 0, start: 4, end: 4 }]],
    ["a negative start", [{ speaker: 0, start: -1, end: 3 }]],
    ["a fractional speaker", [{ speaker: 0.5, start: 1, end: 3 }]],
    ["a non-finite time", [{ speaker: 0, start: 1, end: null }]],
    ["a non-object row", [7]],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseTurns(raw)).toThrow();
  });
});

describe("diarizationConfig", () => {
  it("lets the clustering threshold pick the speaker count unless one is given", () => {
    expect(diarizationConfig("/m")).toMatchObject({
      clustering: { numClusters: -1, threshold: expect.any(Number) },
    });
    expect(diarizationConfig("/m", 2)).toMatchObject({ clustering: { numClusters: 2 } });
  });

  it("points segmentation and embedding at the pinned files in order", () => {
    // join() yields OS-native separators, so build the expectation the same way.
    expect(diarizationConfig("/m")).toMatchObject({
      segmentation: { pyannote: { model: join("/m", "pyannote-segmentation-3-0.onnx") } },
      embedding: { model: join("/m", "nemo_en_titanet_small.onnx") },
    });
  });
});
