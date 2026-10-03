import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunFileName,
  dedupeOpenTelemetryVersions,
  foreignPrebuildHints,
  longestStagedRelativePath,
  lookupOnPath,
  OTEL_DEDUP_VERSIONS,
  pruneBundlerOnlyBuilds,
  pruneForeignPrebuilds,
  shouldStripRuntimeFile,
  stagedPathLimit,
  STAGED_VERSION_OVERRIDES,
  stripRuntimeFiles,
  WINDOWS_PATH_BUDGET,
} from "../apps/desktop/scripts/stage-runtime.mjs";

describe("bunFileName", () => {
  it("stages bun.exe on Windows and bun elsewhere", () => {
    assert.equal(bunFileName("win32"), "bun.exe");
    assert.equal(bunFileName("darwin"), "bun");
    assert.equal(bunFileName("linux"), "bun");
  });

  it("agrees with platform::BUN_BIN", () => {
    // platform.rs: `bun.exe` on Windows, `bun` elsewhere. This mirror must
    // not drift: the staged file, the Tauri resource map and the Rust lookup
    // all name it.
    assert.equal(bunFileName("win32"), "bun.exe");
  });
});

describe("lookupOnPath", () => {
  it("finds bun.exe for a bare bun on Windows (PATHEXT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-lookup-"));
    try {
      writeFileSync(join(dir, "bun.exe"), "fake");
      const found = lookupOnPath("bun", {
        path: dir,
        platform: "win32",
        pathext: ".COM;.EXE;.BAT;.CMD",
      });
      assert.ok(found !== undefined, "bun must be found via PATHEXT");
      assert.match(found.toLowerCase(), /bun\.exe$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a bare binary on POSIX without extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-lookup-"));
    try {
      writeFileSync(join(dir, "bun"), "fake");
      const found = lookupOnPath("bun", { path: dir, platform: "darwin" });
      assert.equal(found, join(dir, "bun"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the binary is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-lookup-"));
    try {
      assert.equal(lookupOnPath("bun", { path: dir, platform: "win32" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("foreignPrebuildHints", () => {
  it("keeps win32 prebuilds on Windows, drops darwin/linux", () => {
    const hints = foreignPrebuildHints("win32");
    assert.ok(!hints.includes("win32"));
    assert.ok(hints.includes("darwin"));
    assert.ok(hints.includes("linux"));
  });

  it("keeps darwin prebuilds on macOS", () => {
    const hints = foreignPrebuildHints("darwin");
    assert.ok(hints.includes("win32"));
    assert.ok(!hints.includes("darwin"));
  });
});

describe("pruneForeignPrebuilds", () => {
  it("removes foreign prebuilds but keeps the host's", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-prune-"));
    const nm = join(dir, "node_modules");
    try {
      const keep = ["real-pkg", "@esbuild/win32-x64"];
      const drop = ["sherpa-onnx-darwin-arm64", "sherpa-onnx-linux-x64", "@esbuild/darwin-arm64"];
      for (const name of [...keep, ...drop]) {
        mkdirSync(join(nm, name), { recursive: true });
        writeFileSync(join(nm, name, "package.json"), "{}");
      }
      const removed = pruneForeignPrebuilds([nm], foreignPrebuildHints("win32"));
      assert.deepEqual(removed.sort(), drop.sort());
      for (const name of keep) {
        assert.ok(existsSync(join(nm, name)), `${name} must be kept`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stripRuntimeFiles", () => {
  it("removes sourcemaps and declarations, keeps runtime code", () => {
    assert.equal(shouldStripRuntimeFile("index.js.map"), true);
    assert.equal(shouldStripRuntimeFile("index.d.ts"), true);
    assert.equal(shouldStripRuntimeFile("index.d.mts"), true);
    assert.equal(shouldStripRuntimeFile("index.js"), false);
    assert.equal(shouldStripRuntimeFile("binding.node"), false);
  });

  it("strips a nested tree and reports counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-strip-"));
    try {
      mkdirSync(join(dir, "node_modules", "pkg", "build"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg", "build", "index.js"), "code".repeat(100));
      writeFileSync(join(dir, "node_modules", "pkg", "build", "index.js.map"), "map".repeat(100));
      writeFileSync(join(dir, "node_modules", "pkg", "build", "index.d.ts"), "types".repeat(100));
      const { files, bytes } = stripRuntimeFiles([join(dir, "node_modules")]);
      assert.equal(files, 2);
      assert.ok(bytes > 0);
      assert.ok(existsSync(join(dir, "node_modules", "pkg", "build", "index.js")));
      assert.ok(!existsSync(join(dir, "node_modules", "pkg", "build", "index.js.map")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneBundlerOnlyBuilds", () => {
  it("removes the esnext build that no runtime resolves and keeps main/module builds", () => {
    const root = mkdtempSync(join(tmpdir(), "ov-esnext-"));
    try {
      const pkg = join(root, "node_modules", "pkg");
      for (const dir of ["src", "esm", "esnext"]) {
        mkdirSync(join(pkg, "build", dir), { recursive: true });
        writeFileSync(join(pkg, "build", dir, "index.js"), "x");
      }
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "pkg",
          main: "build/src/index.js",
          module: "build/esm/index.js",
          esnext: "build/esnext/index.js",
        }),
      );
      const kept = join(root, "node_modules", "kept");
      mkdirSync(join(kept, "build", "esm"), { recursive: true });
      writeFileSync(join(kept, "build", "esm", "index.js"), "x");
      writeFileSync(
        join(kept, "package.json"),
        JSON.stringify({
          name: "kept",
          module: "build/esm/index.js",
          esnext: "build/esm/index.js",
        }),
      );
      const removed = pruneBundlerOnlyBuilds([join(root, "node_modules")]);
      assert.deepEqual(removed, [join(pkg, "build", "esnext")]);
      assert.equal(existsSync(join(pkg, "build", "esnext")), false);
      assert.equal(existsSync(join(pkg, "build", "esm", "index.js")), true);
      assert.equal(existsSync(join(kept, "build", "esm", "index.js")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dedupeOpenTelemetryVersions", () => {
  it("pins the whole otel family to the one exact version every range accepts", () => {
    // The OTLP exporters pin 2.9.0 exactly while pi-coding-agent and
    // sdk-trace-node float on ^2.9.0: every entry must therefore be the
    // exporters' pinned version, or the tree splits again.
    for (const version of Object.values(OTEL_DEDUP_VERSIONS)) {
      assert.equal(version, "2.9.0");
    }
    assert.ok("@opentelemetry/resources" in OTEL_DEDUP_VERSIONS);
    assert.ok("@opentelemetry/sdk-metrics" in OTEL_DEDUP_VERSIONS);
    assert.ok("@opentelemetry/sdk-trace-base" in OTEL_DEDUP_VERSIONS);
    // linkedom 0.18.13 nests the old dom stack; 0.18.12 (still in the
    // staged ^0.18.12 range) flattens it. The staged manifests pin both.
    assert.equal(STAGED_VERSION_OVERRIDES.linkedom, "0.18.12");
    const manifest = dedupeOpenTelemetryVersions({ dependencies: {} });
    assert.deepEqual(manifest.overrides, STAGED_VERSION_OVERRIDES);
  });

  it("keeps caller overrides it does not own", () => {
    const manifest = dedupeOpenTelemetryVersions({ overrides: { react: "^19.0.0" } });
    assert.equal(manifest.overrides.react, "^19.0.0");
    assert.equal(manifest.overrides["@opentelemetry/resources"], "2.9.0");
    assert.equal(manifest.overrides.linkedom, "0.18.12");
  });
});

describe("stagedPathLimit", () => {
  it("projects prefix + separator + relative, and null for an empty tree", () => {
    assert.equal(stagedPathLimit(10, 5), 16);
    assert.equal(stagedPathLimit(null, null), null);
  });

  it("flags the old nested layout and passes the deduped one", () => {
    // The old deepest file: 188 characters relative; a normal checkout
    // prefix (`C:\Users\<name>\...\runtime/`) is ~70 characters, so the
    // absolute path reaches ~259 — past the budget.
    const prefix = "C:/Users/some-long-name/Desktop/OpenSource/open-vids/apps/desktop/runtime/";
    assert.ok(stagedPathLimit(prefix.length, 188) >= WINDOWS_PATH_BUDGET);
    // The deduped tree's deepest relative path must stay well under ~150 so
    // the same checkout keeps headroom.
    assert.ok(stagedPathLimit(prefix.length, 120) < WINDOWS_PATH_BUDGET);
  });
});

describe("longestStagedRelativePath", () => {
  it("reports the longest relative file path, or null when empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-longest-"));
    try {
      assert.equal(longestStagedRelativePath(dir), null);
      mkdirSync(join(dir, "a", "deep"), { recursive: true });
      writeFileSync(join(dir, "a", "x.js"), "x");
      writeFileSync(join(dir, "a", "deep", "y.js"), "y");
      const longest = longestStagedRelativePath(dir);
      assert.equal(longest.path, join("a", "deep", "y.js"));
      assert.equal(longest.length, join("a", "deep", "y.js").length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
