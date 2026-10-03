#!/usr/bin/env bun
/**
 * `tauri build` for the desktop app, with one twist around updater artifacts.
 *
 * `bundle.createUpdaterArtifacts` is true in `src-tauri/tauri.conf.json`, and with it the Tauri
 * CLI fails the build when `TAURI_SIGNING_PRIVATE_KEY` is missing. Local builds without the key
 * therefore turn updater artifacts off with an extra `--config` (the CLI merges configs in order,
 * so the last one wins). A release build — `OPENVIDS_RELEASE=1`, set by the release workflow —
 * fails loudly instead: shipping without updater artifacts would strand installed apps on the
 * previous version.
 *
 * Platform configs (`src-tauri/tauri.windows.conf.json` on Windows,
 * `tauri.macos.conf.json` on macOS) are merged automatically by Tauri 2 over
 * the base config; the Windows one selects the `nsis` bundle target and the
 * `bun.exe` resource, the macOS one keeps `app`+`dmg` and `bun`. This script
 * passes no platform flags itself.
 *
 * All arguments are forwarded to `tauri build` after the `--config` flags, so an explicit
 * `--config` from the caller still overrides both.
 *
 * Usage: bun scripts/tauri-build.mjs [extra tauri build args]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const appDir = join(import.meta.dirname, "..");
const repoRoot = join(appDir, "..", "..");

/**
 * The tauri CLI entry point. On Windows the `.bin/tauri` shim is a `.exe`
 * launcher, not an executable script, so plain `existsSync` misses it: probe
 * every platform executable suffix (`.exe`/`.cmd`/no extension) in both
 * install locations. Falls back to `bun x tauri` when no local install is
 * found (the CLI is a pinned devDependency, so this stays hermetic).
 */
export function findTauriBin(
  candidates = [
    join(repoRoot, "node_modules", ".bin", "tauri"),
    join(appDir, "node_modules", ".bin", "tauri"),
  ],
  platform = process.platform,
) {
  const suffixes = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      if (existsSync(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
    }
  }
  return undefined;
}

const tauriBin = findTauriBin();
// The bundled Bun is the one resource whose file name differs per platform
// (`bun.exe` on Windows, see `platform::BUN_BIN`), and Tauri merges resource maps,
// so it lives in a per-platform overlay rather than in `tauri.prod.conf.json`.
const prodConfigs = [
  "src-tauri/tauri.prod.conf.json",
  process.platform === "win32"
    ? "src-tauri/tauri.prod.windows.conf.json"
    : "src-tauri/tauri.prod.macos.conf.json",
];
const configArgs = prodConfigs.flatMap((config) => ["--config", config]);
let command;
let args;
if (tauriBin === undefined) {
  // `bun x` resolves the pinned @tauri-apps/cli without a local .bin shim.
  command = process.execPath;
  args = ["x", "tauri", "build", ...configArgs];
} else {
  command = tauriBin;
  args = ["build", ...configArgs];
}

const signingKey = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
if (signingKey === "") {
  if (process.env.OPENVIDS_RELEASE === "1") {
    console.error(
      "[desktop-build] TAURI_SIGNING_PRIVATE_KEY is required for a release build (OPENVIDS_RELEASE=1); " +
        "set the updater signing key and its password, or build locally without OPENVIDS_RELEASE",
    );
    process.exit(1);
  }
  args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  const updaterArtifact =
    process.platform === "win32"
      ? "OpenVids_<version>_x64-setup.exe and its .sig"
      : "OpenVids.app.tar.gz and its .sig";
  console.log(
    `[desktop-build] TAURI_SIGNING_PRIVATE_KEY is not set: updater artifacts (${updaterArtifact}) are skipped for this local build`,
  );
}

args.push(...process.argv.slice(2));

const spawnTarget = command === process.execPath ? "bun x tauri" : command;
const result = spawnSync(command, args, { cwd: appDir, stdio: "inherit", env: process.env });
if (result.error !== undefined) {
  console.error(`[desktop-build] could not run ${spawnTarget}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
