#!/usr/bin/env node
/**
 * Assemble the production sidecar payload under `apps/desktop/runtime/`.
 *
 * Tauri bundles this directory as app resources. Three pieces end up inside the
 * shipped app:
 *
 *   runtime/hyperframes/
 *     The output of the HyperFrames build — `packages/cli/dist`, whose
 *     `dist/studio` subdirectory is the prebuilt Studio SPA. The CLI's
 *     embedded server (`createStudioServer`) serves that SPA and mounts the
 *     Studio API on the same listener, so a project directory is all it needs
 *     to run. No monorepo path survives into the bundle.
 *
 *   runtime/hyperframes/node_modules/
 *     The CLI's *published* dependencies and nothing else. `packages/cli`
 *     bundles every `@hyperframes/*` workspace package (tsup `noExternal`), so
 *     only its npm dependencies stay external at runtime. The list is derived
 *     from that package.json rather than hand-written so it cannot drift.
 *
 *   runtime/agent-runtime/
 *     The OpenVids Agent Runtime sources, its copied protocol package, and its
 *     published OMP-backed dependencies. Set OPENVIDS_SKIP_AGENT_RUNTIME=1 to
 *     omit this optional chat feature from a staging run.
 *
 * The JS runtime is `bun`, not Node: it is a single self-contained binary, so
 * it copies into the bundle without dragging a package-manager Cellar of
 * libraries along. It is also the runtime that already builds this repo, so
 * dev and production run identical JS. The staged file is `bun` on macOS and
 * `bun.exe` on Windows — the same name `platform::BUN_BIN` uses in Rust and
 * `tauri.prod*.conf.json` bundles, so the three must agree.
 *
 *   runtime/licenses/
 *     OpenVids' LICENSE, NOTICE and CREDITS.md, the texts kept in `apps/desktop/licenses/` (Bun,
 *     LGPL/GPL, libvips) and a generated third-party notice for every staged package
 *     (`licenses.mjs`). The app must not ship without them.
 *
 * Dependencies are installed from the repo `bun.lock` (`installFromRepoLock`):
 * the staged trees contain exactly the `name@version`s the repo lockfile
 * resolves, and staging fails if a range would pull anything else.
 *
 * Platform notes:
 *
 * - `bun install` only installs the optional native prebuilds for the host
 *   platform (on Windows: `@esbuild/win32-x64`, `@img/sharp-win32-x64`,
 *   `lightningcss-win32-x64-msvc`, `@oh-my-pi/pi-natives-win32-x64`; verified
 *   in the staged tree — no darwin/linux variants land). The prune below is
 *   belt-and-braces for packages that ship every platform in one tarball, plus
 *   the heavy lazy engines that are unused on all platforms.
 * - `chmod` is a no-op on Windows and is skipped there; the macOS `0755` (not
 *   whatever the source carries) stays, because `tauri-build` copies resources
 *   with `fs::copy`, which propagates the mode.
 * - On Windows the staged `node_modules` trees are stripped of sourcemaps and
 *   type declarations bun never loads (`*.map`, `*.d.ts` and kin, except the
 *   `declarations.d.ts` files the OMP SDK imports as text — see
 *   `KEPT_RUNTIME_FILES`), and two
 *   version-split families are pinned to one version through `overrides`
 *   (see `STAGED_VERSION_OVERRIDES`): without the pins the OTLP exporters
 *   nest a second copy of `@opentelemetry/resources`/`sdk-metrics`, and
 *   linkedom 0.18.13 nests the old dom stack (`domutils@3` and friends)
 *   under the hoisted copies — each ~60 characters deeper than the hoisted
 *   copy, past what `makensis` (no long-path support) can open. The NSIS
 *   per-user install dir plus the deepest remaining files then keep headroom
 *   under the 260-character `MAX_PATH`. Staging warns (and fails on Windows)
 *   when the longest staged path plus the checkout prefix reaches the budget,
 *   so a too-long checkout fails here instead of in makensis. macOS trees
 *   keep their sourcemaps/declarations, so the macOS bundle is unchanged
 *   apart from resolving the same single versions.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageLicenses } from "./licenses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP, "..", "..");

const RUNTIME = join(DESKTOP, "runtime");
const HF_DIR = join(RUNTIME, "hyperframes");
const CLI_DIST = join(REPO_ROOT, "packages", "cli", "dist");
const AGENT_RUNTIME_SOURCE = join(REPO_ROOT, "packages", "agent-runtime");
const AGENT_PROTOCOL_SOURCE = join(REPO_ROOT, "packages", "agent-protocol");
const AGENT_DIR = join(RUNTIME, "agent-runtime");

function log(message) {
  process.stderr.write(`[openvids:stage] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[openvids:stage] ${message}\n`);
  process.exit(1);
}

/**
 * The staged JS runtime file name: `bun.exe` on Windows, `bun` elsewhere.
 * Must agree with `platform::BUN_BIN` in Rust and the `tauri.prod*.conf.json`
 * resource names.
 */
export function bunFileName(platform = process.platform) {
  return platform === "win32" ? "bun.exe" : "bun";
}

/**
 * Find `name` on `PATH` the way a shell would. Unlike `execFileSync("which",
 * ...)` this works on Windows too: it tries every `PATHEXT` suffix in every
 * `PATH` directory (`bun` therefore resolves to `bun.exe`).
 */
export function lookupOnPath(
  name,
  {
    path = process.env.PATH ?? "",
    platform = process.platform,
    pathext = process.env.PATHEXT,
  } = {},
) {
  const dirs = path.split(platform === "win32" ? ";" : delimiter);
  const suffixes =
    platform === "win32" ? ["", ...(pathext ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; try the next candidate.
      }
    }
  }
  return undefined;
}

function resolveBun() {
  if (process.versions.bun && process.execPath) return realpathSync(process.execPath);
  const found = lookupOnPath("bun");
  if (found === undefined) {
    fail("bun is not on PATH; it is both this repo's package manager and the sidecar runtime");
  }
  return realpathSync(found);
}

/**
 * Heavy engines the Director never enables but the OMP SDK declares as hard
 * dependencies (~500 MB: onnxruntime, sherpa-onnx, huggingface tokenizers, an
 * icon set). They load lazily, so the runtime starts and runs sessions without
 * them (verified with the staged bun). Dropped on every platform.
 */
export const UNUSED_ENGINE_MODULES = [
  "onnxruntime-node",
  "onnxruntime-web",
  "sherpa-onnx-darwin-arm64",
  "sherpa-onnx-darwin-x64",
  "sherpa-onnx-linux-arm64",
  "sherpa-onnx-linux-x64",
  "sherpa-onnx-win-ia32",
  "sherpa-onnx-win-x64",
  "sherpa-onnx-node",
  "@huggingface",
  "lucide-react",
];

/**
 * Prebuilt-native name fragments foreign to `platform`. `bun install` already
 * filters optional native prebuilds to the host (this staging run on Windows
 * carries only `win32-x64` variants), so this only bites when a tree was
 * staged elsewhere and copied, or a package ships every platform
 * unconditionally. The host's own fragment is never listed: win32 prebuilds
 * are KEPT on Windows. Fragments match both `-darwin-`-style infixes and
 * `darwin-`/`-darwin` affixes so scoped names like `@esbuild/darwin-arm64`
 * are caught.
 */
export function foreignPrebuildHints(platform = process.platform) {
  const all = ["darwin", "linux", "win32", "freebsd", "aix", "android"];
  const keep = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  return all.filter((hint) => hint !== keep);
}

/**
 * True when a node_modules entry name refers to `hint`'s platform: any
 * dash/underscore/dot-delimited segment equal to the hint (`darwin-arm64`,
 * `sherpa-onnx-linux-x64`, `lightningcss-win32-x64-msvc`). A bare substring
 * would over-match (`darwin` in unrelated names); this only fires on real
 * platform segments of package directory names.
 */
export function isForeignPrebuildName(name, hint) {
  return name.toLowerCase().split(/[-_.]/).includes(hint);
}

/**
 * Remove top-level (and `@scope/`-nested) `node_modules` entries whose name
 * carries a foreign prebuild hint. Returns the removed directory names.
 */
export function pruneForeignPrebuilds(roots, hints) {
  const removed = [];
  const pruneDir = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(join(dir, entry.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of scoped) {
          if (sub.isDirectory() && hints.some((hint) => isForeignPrebuildName(sub.name, hint))) {
            rmSync(join(dir, entry.name, sub.name), { recursive: true, force: true });
            removed.push(`${entry.name}/${sub.name}`);
          }
        }
      } else if (hints.some((hint) => isForeignPrebuildName(entry.name, hint))) {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
  };
  for (const root of roots) pruneDir(root);
  return removed;
}

/**
 * File extensions bun never loads at runtime. Sourcemaps and type
 * declarations are the longest and most numerous files in the staged trees
 * (thousands of `.map`/`.d.ts` files under `@opentelemetry`); stripping them
 * on Windows buys back the `MAX_PATH` headroom the NSIS install needs (see
 * the header) and shrinks the installer, except the `KEPT_RUNTIME_FILES`
 * below that bun does load. macOS trees keep them, so the macOS
 * bundle is unchanged.
 */
export const STRIPPED_RUNTIME_EXTENSIONS = [".map", ".d.ts", ".d.mts", ".d.cts", ".tsbuildinfo"];

/**
 * `.d.ts` files bun DOES load: `@oh-my-pi/pi-coding-agent` imports its
 * `declarations.d.ts` files as text (`import x from "./declarations.d.ts" with
 * { type: "text" }` in `archive|tools/browser|tools/computer/prelude-definition.ts`),
 * so stripping them makes the agent runtime die at startup with
 * `Cannot find module './declarations.d.ts'`.
 */
export const KEPT_RUNTIME_FILES = ["declarations.d.ts"];

export function shouldStripRuntimeFile(fileName) {
  if (KEPT_RUNTIME_FILES.includes(fileName)) return false;
  return STRIPPED_RUNTIME_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

/** Recursively delete strippable files under `roots`. Returns `{ files, bytes }`. */
export function stripRuntimeFiles(roots) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && shouldStripRuntimeFile(entry.name)) {
        try {
          bytes += statSync(full).size;
        } catch {
          // Size is informational; the delete below still runs.
        }
        rmSync(full, { force: true });
        files += 1;
      }
    }
  };
  for (const root of roots) walk(root);
  return { files, bytes };
}
/**
 * Staged trees resolve two families twice. `@opentelemetry/*`: the OTLP
 * exporter line (`0.220.x`) pins exact `2.9.0` deps (`"resources": "2.9.0"`,
 * no caret), while sibling dependents (`@oh-my-pi/pi-coding-agent`,
 * `@opentelemetry/sdk-trace-node`) float on `^2.9.0` and resolve to the latest
 * 2.x (2.11.0 at the time of writing). `linkedom`: the staged `^0.18.12`
 * resolves to 0.18.13, whose `css-select@^7`/`htmlparser2@^10.1` line nests
 * `domutils@3`/`dom-serializer@2`/`entities@4` under the hoisted v4/v3/v7
 * copies four levels deep. Bun installs the max satisfying version at the top
 * level and nests the pinned one under each dependent, so the same files
 * exist twice — and each nested copy sits ~60 characters deeper, past what
 * `makensis` (no long-path support) can open on a normal-length Windows
 * checkout. Every range involved accepts the pinned version (`^2.9.0` accepts
 * `2.9.0`; the exporters pin `2.9.0` exactly; `^0.18.12` accepts `0.18.12`,
 * whose own `css-select@^5`/`htmlparser2@^10.0` deps flatten with no nesting),
 * and the entry points the staged code actually loads
 * (`OTLP{Metric,Log,Trace}Exporter`, `MeterProvider`, `NodeTracerProvider`,
 * `LoggerProvider`, linkedom's `parseHTML`/`querySelectorAll`) load and run
 * against the pinned graphs under Bun (verified in scratch installs before
 * staging), so exact pins flatten both trees with no nested copies. Exact
 * pins, not carets, so a future `latest` can never re-split either tree.
 */
export const OTEL_DEDUP_VERSIONS = {
  "@opentelemetry/context-async-hooks": "2.9.0",
  "@opentelemetry/core": "2.9.0",
  "@opentelemetry/resources": "2.9.0",
  "@opentelemetry/sdk-metrics": "2.9.0",
  "@opentelemetry/sdk-trace": "2.9.0",
  "@opentelemetry/sdk-trace-base": "2.9.0",
  "@opentelemetry/sdk-trace-node": "2.9.0",
};

export const STAGED_VERSION_OVERRIDES = {
  ...OTEL_DEDUP_VERSIONS,
  linkedom: "0.18.12",
};

/**
 * Add exact `overrides` pins for the version-split families to a staged
 * manifest object (in place) so `bun install` hoists one copy instead of
 * nesting the exporters' pinned 2.9.0 under the hoisted 2.11.0 (and the old
 * dom stack under linkedom's latest). Bun reads `overrides` (npm reads the
 * same field); the root `package.json` already uses it for the React line, so
 * this follows the existing convention. Only Windows staging applies it (the
 * nesting only matters under `makensis`'s path limit), so the macOS app keeps
 * resolving the ranges as before.
 */
export function dedupeOpenTelemetryVersions(manifest) {
  manifest.overrides = { ...(manifest.overrides ?? {}), ...STAGED_VERSION_OVERRIDES };
  return manifest;
}

/**
 * Parse a `bun.lock` (JSONC: JSON with trailing commas) into an object.
 * Commas before a closing bracket are dropped outside string literals.
 */
export function parseBunLock(text) {
  let json = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      json += ch;
      if (ch === "\\") json += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    json += ch;
  }
  return JSON.parse(json);
}

/**
 * The `name@version` of every registry package a parsed `bun.lock` resolves.
 * Workspace, file and link entries are the repo's own code, not downloads.
 */
export function lockedPackageIds(lock) {
  const ids = new Set();
  for (const entry of Object.values(lock.packages ?? {})) {
    const id = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof id !== "string") continue;
    if (/@(?:workspace|file|link):/.test(id)) continue;
    ids.add(id);
  }
  return ids;
}

/**
 * Packages `staged` resolves that `root` (the repo lockfile CI tests) does not:
 * what would ship but was never resolved, installed or tested by the repo.
 * `allowed` lists exact `name@version` ids the staging script itself pins.
 */
export function packagesOutsideLock(staged, root, allowed = []) {
  const pinned = lockedPackageIds(root);
  for (const id of allowed) pinned.add(id);
  return [...lockedPackageIds(staged)].filter((id) => !pinned.has(id)).sort();
}

/**
 * Install a staged manifest's dependencies from the repo lockfile.
 *
 * The staged manifest holds only the ranges of one package, so the repo's
 * `bun.lock` cannot be frozen against it as is. Seeding the staging directory
 * with that lockfile makes `bun install --lockfile-only` keep every version it
 * already resolved (bun reuses locked resolutions for unchanged ranges) and drop
 * the other workspaces. The resulting lockfile is then checked against the repo
 * lockfile — any `name@version` outside it fails staging, so a range can never
 * silently pull a fresh publish into a signed release — and installed frozen,
 * so the tree is exactly the checked lockfile.
 */
function installFromRepoLock(bunPath, dir, label) {
  const rootLockPath = join(REPO_ROOT, "bun.lock");
  if (!existsSync(rootLockPath))
    fail(`${label}: ${rootLockPath} is missing; cannot pin dependencies`);
  const rootLockText = readFileSync(rootLockPath, "utf8");
  const stdio = ["ignore", "inherit", "inherit"];
  writeFileSync(join(dir, "bun.lock"), rootLockText);
  execFileSync(bunPath, ["install", "--lockfile-only"], { cwd: dir, stdio });
  // The Windows dedupe pins are exact versions chosen in this script; they are
  // the only resolutions allowed to differ from the repo lockfile.
  const ownPins =
    process.platform === "win32"
      ? Object.entries(STAGED_VERSION_OVERRIDES).map(([name, version]) => `${name}@${version}`)
      : [];
  const outside = packagesOutsideLock(
    parseBunLock(readFileSync(join(dir, "bun.lock"), "utf8")),
    parseBunLock(rootLockText),
    ownPins,
  );
  if (outside.length > 0) {
    fail(
      `${label}: ${outside.length} package(s) resolve outside the repo bun.lock ` +
        `(${outside.slice(0, 8).join(", ")}${outside.length > 8 ? ", ..." : ""}). ` +
        `Run \`bun install\` in the repo and commit the lockfile, then stage again.`,
    );
  }
  execFileSync(bunPath, ["install", "--frozen-lockfile"], { cwd: dir, stdio });
}

/**
 * The classic Windows `MAX_PATH` (260 characters) minus a small safety
 * margin for the separator and NUL. `makensis` has no long-path support, so
 * any staged file at or past this absolute length fails the installer build
 * with an opaque "failed opening file".
 */
export const WINDOWS_MAX_PATH = 260;
export const WINDOWS_PATH_BUDGET = 255;

/**
 * Walk `dir` and return the longest path relative to it (`{ path, length }`),
 * or `null` when the tree holds no files. The installer and the NSIS
 * per-user install dir both append to this relative path, so staging keeps it
 * short (see `warnOnLongWindowsPaths`).
 */
export function longestStagedRelativePath(dir) {
  let longest = null;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const relative = full.slice(dir.length + 1);
        if (longest === null || relative.length > longest.length) {
          longest = { path: relative, length: relative.length };
        }
      }
    }
  };
  walk(dir);
  return longest;
}

/**
 * Project the absolute staged length from a checkout prefix and a relative
 * length: `prefix + separator + relative`. Returns `null` when the tree is
 * empty so tests can assert on the arithmetic without touching the
 * filesystem.
 */
export function stagedPathLimit(prefixLength, longestLength) {
  if (longestLength === null) return null;
  return prefixLength + 1 + longestLength;
}

export function warnOnLongWindowsPaths(runtimeDir, projectDir = DESKTOP) {
  const longest = longestStagedRelativePath(runtimeDir);
  if (longest === null) return null;
  const prefix = `${projectDir}/runtime/`;
  const absolute = stagedPathLimit(prefix.length, longest.length);
  // The check is about the Windows installer even when staging runs
  // elsewhere, so it warns regardless of host OS.
  if (absolute !== null && absolute >= WINDOWS_PATH_BUDGET) {
    log(
      `WARNING: longest staged path is ${longest.length} characters ` +
        `(${longest.path}); with this checkout at ${prefix} the absolute path reaches ` +
        `${absolute} characters, past the ${WINDOWS_PATH_BUDGET}-character budget ` +
        `(MAX_PATH ${WINDOWS_MAX_PATH}): move the checkout to a shorter path or the ` +
        `makensis installer build will fail opening the file.`,
    );
  } else {
    log(`longest staged path: ${longest.length} characters (${longest.path})`);
  }
  return absolute;
}

/**
 * Packages such as `@opentelemetry/*` ship a third build for bundlers (`"esnext":
 * "build/esnext/index.js"`): neither Bun nor Node resolves that field, and the
 * directory sits at the deepest nesting level of the staged tree, which is what
 * decides whether `makensis` (no long-path support) can open every file. Removes
 * each such directory unless `main`/`module`/`exports` also point into it.
 * Returns the removed directories.
 */
export function pruneBundlerOnlyBuilds(roots) {
  const removed = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pkgFile = join(dir, "package.json");
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        const target = typeof pkg.esnext === "string" ? pkg.esnext : null;
        const buildDir = target?.split("/").filter((part) => part !== "." && part !== "");
        if (buildDir && buildDir.length > 1) {
          const rel = buildDir.slice(0, -1).join("/");
          const others = JSON.stringify([pkg.main, pkg.module, pkg.exports, pkg.types]);
          if (!others.includes(rel)) {
            rmSync(join(dir, ...buildDir.slice(0, -1)), { recursive: true, force: true });
            removed.push(join(dir, ...buildDir.slice(0, -1)));
          }
        }
      } catch {
        // An unreadable manifest is left alone.
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  for (const root of roots) walk(root);
  return removed;
}

/**
 * The manifest of a workspace package vendored as a `file:` dependency. Bun installs the devDependencies of
 * `file:` dependencies too, so copying the source manifest verbatim would ship its build and test tooling
 * (typescript, tsx, vitest, ...) in the app. Only the fields that decide how the package resolves and loads stay.
 */
export function vendoredManifest(manifest) {
  const keep = [
    "name",
    "version",
    "private",
    "type",
    "sideEffects",
    "main",
    "module",
    "types",
    "exports",
    "dependencies",
  ];
  return Object.fromEntries(
    keep.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]),
  );
}

function pruneStagedTree(dir, label, { unusedEngines }) {
  // The CLI tree needs `onnxruntime-node` (background removal, diarization), so
  // only the Agent Runtime tree drops the lazy engines.
  if (unusedEngines) {
    for (const unused of UNUSED_ENGINE_MODULES) {
      rmSync(join(dir, "node_modules", unused), { recursive: true, force: true });
    }
  }
  const foreign = pruneForeignPrebuilds([join(dir, "node_modules")], foreignPrebuildHints());
  if (foreign.length > 0) log(`${label}: pruned foreign prebuilds: ${foreign.join(", ")}`);
  if (process.platform === "win32") {
    const { files, bytes } = stripRuntimeFiles([join(dir, "node_modules")]);
    log(
      `${label}: stripped ${files} sourcemap/declaration files (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
    );
    const bundlerOnly = pruneBundlerOnlyBuilds([join(dir, "node_modules")]);
    if (bundlerOnly.length > 0) {
      log(`${label}: removed ${bundlerOnly.length} bundler-only (esnext) build directories`);
    }
  }
}

function main() {
  // The repo's own `overrides` (the React line) must be in every staged manifest, or bun
  // re-resolves those packages instead of keeping the versions the repo lockfile pins.
  const repoOverrides = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).overrides;
  // The version-family pins only exist for the Windows installer's path budget.
  const stagedManifest = (manifest) => {
    manifest.overrides = { ...repoOverrides, ...(manifest.overrides ?? {}) };
    return process.platform === "win32" ? dedupeOpenTelemetryVersions(manifest) : manifest;
  };

  // ── 1. The Studio + CLI bundle ────────────────────────────────────────────

  if (!existsSync(join(CLI_DIST, "studio", "index.html"))) {
    fail(
      `HyperFrames is not built: ${join(CLI_DIST, "studio", "index.html")} is missing.\n` +
        `  Run \`bun run build\` first (\`bun run build:hyperframes\` in this package does it).`,
    );
  }

  // Resolved once, up front: every `bun install` below uses this absolute
  // path, so staging works even when `bun` is not on `PATH` (e.g. launched
  // from a GUI) and without the POSIX-only `which` helper.
  const bunPath = resolveBun();
  const bunName = bunFileName();

  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(HF_DIR, { recursive: true });
  cpSync(CLI_DIST, HF_DIR, { recursive: true, dereference: true });
  log(`staged ${join(HF_DIR)}`);

  // ── 2. The published runtime dependencies ─────────────────────────────────

  const cliPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8"),
  );
  const runtimeDeps = Object.fromEntries(
    Object.entries(cliPkg.dependencies ?? {}).filter(
      ([, range]) => !String(range).startsWith("workspace:"),
    ),
  );

  // A package.json named `hyperframes` beside the bundle. The render pipeline
  // stamps provenance by walking up from its own module URL looking for a
  // package.json whose name matches /^(?:hyperframes|@hyperframes\/[^/]+)$/; without
  // this it logs "could not resolve the engine version" on every boot.
  // `type: module` is load-bearing: `cli.js` is ESM and this is now the nearest
  // package.json to it.
  writeFileSync(
    join(HF_DIR, "package.json"),
    `${JSON.stringify(
      stagedManifest({
        name: "hyperframes",
        version: cliPkg.version,
        private: true,
        type: "module",
        dependencies: runtimeDeps,
      }),
      null,
      2,
    )}\n`,
  );

  log(`installing ${Object.keys(runtimeDeps).length} runtime dependencies`);
  installFromRepoLock(bunPath, HF_DIR, "hyperframes");
  pruneStagedTree(HF_DIR, "hyperframes", { unusedEngines: false });

  // ── 3. The separate, optional local Agent Runtime ──────────────────────────

  const agentRuntimeStaged = process.env.OPENVIDS_SKIP_AGENT_RUNTIME !== "1";
  if (agentRuntimeStaged) {
    const agentRuntimePackage = JSON.parse(
      readFileSync(join(AGENT_RUNTIME_SOURCE, "package.json"), "utf8"),
    );
    const agentRuntimeDependencies = Object.fromEntries(
      Object.entries(agentRuntimePackage.dependencies ?? {}).filter(
        ([, range]) => !String(range).startsWith("workspace:"),
      ),
    );
    const protocolVendor = join(AGENT_DIR, "vendor", "agent-protocol");
    mkdirSync(AGENT_DIR, { recursive: true });
    // Tests and test fixtures import dev-only packages (vitest, studio-server) that are not staged.
    const runtimeSourceOnly = (path) =>
      !/\.test\.ts$/.test(path) && !/[\\/]testing([\\/]|$)/.test(path);
    cpSync(join(AGENT_RUNTIME_SOURCE, "src"), join(AGENT_DIR, "src"), {
      recursive: true,
      dereference: true,
      filter: runtimeSourceOnly,
    });
    writeFileSync(join(AGENT_DIR, "main.ts"), 'import "./src/main.ts";\n');
    mkdirSync(protocolVendor, { recursive: true });
    writeFileSync(
      join(protocolVendor, "package.json"),
      `${JSON.stringify(
        vendoredManifest(
          JSON.parse(readFileSync(join(AGENT_PROTOCOL_SOURCE, "package.json"), "utf8")),
        ),
        null,
        2,
      )}\n`,
    );
    cpSync(join(AGENT_PROTOCOL_SOURCE, "src"), join(protocolVendor, "src"), {
      recursive: true,
      dereference: true,
    });
    agentRuntimeDependencies["@hyperframes/agent-protocol"] = "file:./vendor/agent-protocol";
    writeFileSync(
      join(AGENT_DIR, "package.json"),
      `${JSON.stringify(
        stagedManifest({
          ...agentRuntimePackage,
          dependencies: agentRuntimeDependencies,
          devDependencies: undefined,
        }),
        null,
        2,
      )}\n`,
    );
    log(`installing ${Object.keys(agentRuntimeDependencies).length} Agent Runtime dependencies`);
    installFromRepoLock(bunPath, AGENT_DIR, "agent-runtime");
    // The Director enables no memory/voice features, but the OMP SDK declares their engines as hard
    // dependencies (~500 MB: onnxruntime, sherpa-onnx, huggingface tokenizers, an icon set). They are
    // loaded lazily, so the runtime starts and runs sessions without them (verified with the staged bun).
    pruneStagedTree(AGENT_DIR, "agent-runtime", { unusedEngines: true });
  } else {
    mkdirSync(AGENT_DIR, { recursive: true });
    cpSync(join(AGENT_RUNTIME_SOURCE, "package.json"), join(AGENT_DIR, "package.json"));
    log("skipping Agent Runtime sources and dependencies (OPENVIDS_SKIP_AGENT_RUNTIME=1)");
  }

  // ── 4. The JS runtime ─────────────────────────────────────────────────────

  cpSync(bunPath, join(RUNTIME, bunName), { dereference: true });
  if (process.platform !== "win32") {
    // 0755, not whatever the source carries. tauri-build copies resources with
    // `fs::copy`, which propagates the mode and then re-copies on the next build —
    // and overwriting a 0555 destination fails with EACCES on macOS, which
    // surfaces as an opaque "Permission denied" from the build script.
    // (`chmod` is a no-op on Windows, so it is skipped there.)
    chmodSync(join(RUNTIME, bunName), 0o755);
  }
  log(`staged bun runtime from ${bunPath}`);
  // The launcher the app spawns instead of `cli.js` directly. See its header for
  // why the parent-death watch has to live in the child.
  cpSync(join(DESKTOP, "sidecar", "serve.mjs"), join(RUNTIME, "serve.mjs"), { dereference: true });

  // ── 4b. License texts and third-party notices ─────────────────────────────

  const licenses = stageLicenses({
    runtimeDir: RUNTIME,
    repoRoot: REPO_ROOT,
    keptDir: join(DESKTOP, "licenses"),
    treeDirs: [HF_DIR, AGENT_DIR],
  });
  log(`staged ${licenses.directory} (${licenses.packages} package notices)`);

  // ── 5. Manifest the Rust side reads at startup ────────────────────────────

  writeFileSync(
    join(RUNTIME, "runtime.json"),
    `${JSON.stringify(
      {
        bun: bunName,
        hyperframes: "hyperframes",
        cli: join("hyperframes", "cli.js"),
        studioIndex: join("hyperframes", "studio", "index.html"),
        agentRuntime: agentRuntimeStaged ? "agent-runtime" : null,
        version: cliPkg.version,
      },
      null,
      2,
    )}\n`,
  );

  log(`runtime ready at ${RUNTIME}`);
  // Fail fast on Windows: the limit binds the `makensis` installer build no
  // matter where staging happened, so a too-long checkout stops here with an
  // actionable message instead of makensis's opaque "failed opening file".
  // Other platforms only get the warning above; their bundles have no such
  // limit, so macOS staging succeeds exactly as before.
  const stagedLength = warnOnLongWindowsPaths(RUNTIME);
  if (
    process.platform === "win32" &&
    stagedLength !== null &&
    stagedLength >= WINDOWS_PATH_BUDGET
  ) {
    fail(
      `staged tree does not fit the Windows path budget (${stagedLength} >= ` +
        `${WINDOWS_PATH_BUDGET} characters): move this checkout to a shorter path ` +
        `(e.g. C:\\ov) and re-run staging, or the installer build will fail.`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
