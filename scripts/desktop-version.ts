/**
 * Single source of truth for the desktop app version: the `[package] version` in
 * `apps/desktop/src-tauri/Cargo.toml`.
 *
 * Tauri reads the bundle version from there (`tauri.conf.json` must NOT set one), but two mirrors
 * have to agree with it:
 *
 * - `version` in `apps/desktop/package.json`
 * - the `openvids-desktop` `[[package]]` version in `apps/desktop/src-tauri/Cargo.lock`
 *
 * Usage:
 *
 *   bun scripts/desktop-version.ts 1.2.3      write the version everywhere (Cargo.toml + mirrors)
 *   bun scripts/desktop-version.ts --check    verify the mirrors; exit 1 with the mismatch
 *   bun scripts/desktop-version.ts --print    print the version (for release scripts)
 *
 * Versions are bare semver (`1.2.3`, `1.2.0-rc.1`). A leading `v` is rejected: the git tag
 * (`v1.2.3`) and the version it represents (`1.2.3`) are deliberately different strings.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");

export const PATHS = {
  cargoToml: "apps/desktop/src-tauri/Cargo.toml",
  cargoLock: "apps/desktop/src-tauri/Cargo.lock",
  packageJson: "apps/desktop/package.json",
  tauriConf: "apps/desktop/src-tauri/tauri.conf.json",
  tauriWindowsConf: "apps/desktop/src-tauri/tauri.windows.conf.json",
  tauriMacosConf: "apps/desktop/src-tauri/tauri.macos.conf.json",
  tauriProdConf: "apps/desktop/src-tauri/tauri.prod.conf.json",
} as const;

/** The `[[package]]` entry in Cargo.lock that mirrors the app version. */
export const LOCK_PACKAGE_NAME = "openvids-desktop";

/** Official semver.org regex: major.minor.patch, optional prerelease and build metadata. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const VERSION_LINE = /^(\s*version\s*=\s*)"[^"]*"/;
const VERSION_VALUE = /^\s*version\s*=\s*"([^"]*)"/;
const LOCK_PACKAGE_HEADER = /^\s*\[\[package\]\]\s*$/;

/** Validates a bare semantic version and returns it trimmed. Throws with the offending input. */
export function parseVersion(raw: string): string {
  const value = raw.trim();
  if (!SEMVER.test(value)) {
    throw new Error(
      `invalid version ${JSON.stringify(raw.trim())}: expected a bare semantic version like "1.2.3" or "1.2.0-rc.1" (no leading "v")`,
    );
  }
  return value;
}

/**
 * Reads `version` from the `[package]` table of a Cargo.toml (never from a dependency line or
 * another table such as `[package.metadata]`).
 */
export function readCargoTomlVersion(toml: string): string {
  let inPackage = false;
  for (const line of toml.split("\n")) {
    const table = line.match(/^\s*\[(.*)\]\s*$/);
    if (table) {
      inPackage = table[1] === "package";
      continue;
    }
    if (!inPackage) continue;
    const match = line.match(VERSION_VALUE);
    const value = match?.[1];
    if (value !== undefined) return value;
  }
  throw new Error('Cargo.toml has no `version = "..."` line in its [package] table');
}

/** Rewrites only that line, preserving the rest of the file byte for byte. */
export function rewriteCargoTomlVersion(toml: string, version: string): string {
  const lines = toml.split("\n");
  let inPackage = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const table = line.match(/^\s*\[(.*)\]\s*$/);
    if (table) {
      inPackage = table[1] === "package";
      continue;
    }
    if (!inPackage || !VERSION_LINE.test(line)) continue;
    lines[index] = line.replace(VERSION_LINE, `$1"${version}"`);
    return lines.join("\n");
  }
  throw new Error('Cargo.toml has no `version = "..."` line in its [package] table');
}

/**
 * Index of the `version` line inside the `[[package]]` block named `name`, or -1. The version
 * must follow the name in the block, which is how Cargo.lock is written.
 */
function lockVersionLineIndex(lines: string[], name: string): number {
  let start = -1;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = index === lines.length ? "[[package]]" : (lines[index] ?? "");
    if (!LOCK_PACKAGE_HEADER.test(line)) continue;
    if (start >= 0) {
      const found = lockBlockVersionLine(lines, start, index, name);
      if (found >= 0) return found;
    }
    start = index + 1;
  }
  return -1;
}

function lockBlockVersionLine(lines: string[], start: number, end: number, name: string): number {
  let blockName: string | null = null;
  let versionLine = -1;
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (blockName === null) {
      const nameMatch = line.match(/^\s*name\s*=\s*"([^"]*)"/);
      const value = nameMatch?.[1];
      if (value !== undefined) {
        blockName = value;
        continue;
      }
    }
    if (versionLine < 0 && VERSION_VALUE.test(line)) versionLine = index;
  }
  return blockName === name ? versionLine : -1;
}

export function readCargoLockVersion(lock: string, name: string = LOCK_PACKAGE_NAME): string {
  const lines = lock.split("\n");
  const index = lockVersionLineIndex(lines, name);
  const match = (index >= 0 ? lines[index] : undefined)?.match(VERSION_VALUE);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`Cargo.lock has no [[package]] entry named "${name}" with a version`);
  }
  return value;
}

/** Rewrites only the version line of that one entry, preserving the rest of the lock file. */
export function rewriteCargoLockVersion(
  lock: string,
  version: string,
  name: string = LOCK_PACKAGE_NAME,
): string {
  const lines = lock.split("\n");
  const index = lockVersionLineIndex(lines, name);
  const line = lines[index];
  if (index < 0 || line === undefined) {
    throw new Error(`Cargo.lock has no [[package]] entry named "${name}" with a version`);
  }
  lines[index] = line.replace(VERSION_LINE, `$1"${version}"`);
  return lines.join("\n");
}

export function readPackageJsonVersion(json: string): string {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not a JSON object");
  }
  const version = "version" in parsed ? parsed.version : undefined;
  if (typeof version !== "string") throw new Error('package.json has no "version" string');
  return version;
}

/**
 * Re-serializes package.json with only `version` changed. JSON.stringify(.., null, 2) reproduces
 * the file's existing formatting (insertion order, two-space indent); the trailing newline of the
 * original is kept.
 */
export function rewritePackageJsonVersion(json: string, version: string): string {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not a JSON object");
  }
  const next = { ...parsed, version };
  return `${JSON.stringify(next, null, 2)}${json.endsWith("\n") ? "\n" : ""}`;
}

/** True when tauri.conf.json sets a top-level `version` (it must not; Tauri reads Cargo.toml). */
export function tauriConfSetsVersion(json: string): boolean {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("tauri.conf.json is not a JSON object");
  }
  return "version" in parsed;
}

export interface VersionSources {
  cargoToml: string;
  cargoLock: string;
  packageJson: string;
  tauriConf: string;
  tauriWindowsConf?: string;
  tauriMacosConf?: string;
  tauriProdConf?: string;
}

export interface VersionCheckResult {
  version: string;
  problems: string[];
}

/**
 * Compares the mirrors against `[package] version` in Cargo.toml. Pure; throws only when the
 * baseline itself is unreadable or not a valid version.
 */
export function checkVersionMirrors(sources: VersionSources): VersionCheckResult {
  const version = parseVersion(readCargoTomlVersion(sources.cargoToml));
  const problems: string[] = [];

  const lockVersion = readCargoLockVersion(sources.cargoLock);
  if (lockVersion !== version) {
    problems.push(
      `${PATHS.cargoLock}: the ${LOCK_PACKAGE_NAME} entry is ${lockVersion}, expected ${version} (from ${PATHS.cargoToml})`,
    );
  }

  const packageVersion = readPackageJsonVersion(sources.packageJson);
  if (packageVersion !== version) {
    problems.push(
      `${PATHS.packageJson}: "version" is ${packageVersion}, expected ${version} (from ${PATHS.cargoToml})`,
    );
  }

  if (tauriConfSetsVersion(sources.tauriConf)) {
    problems.push(
      `${PATHS.tauriConf}: remove "version" so Tauri reads the version from ${PATHS.cargoToml}`,
    );
  }

  // The platform overlays (`tauri.windows.conf.json`, `tauri.macos.conf.json`)
  // and the prod resource map (`tauri.prod.conf.json`) are merged over the
  // base config: none of them may set a version either. Missing files (a
  // fresh checkout before they exist) are not a problem; a stray version is.
  const overlays: Array<[path: string, json: string | undefined]> = [
    [PATHS.tauriWindowsConf, sources.tauriWindowsConf],
    [PATHS.tauriMacosConf, sources.tauriMacosConf],
    [PATHS.tauriProdConf, sources.tauriProdConf],
  ];
  for (const [path, json] of overlays) {
    if (json === undefined) continue;
    if (tauriConfSetsVersion(json)) {
      problems.push(`${path}: remove "version" so Tauri reads the version from ${PATHS.cargoToml}`);
    }
  }

  return { version, problems };
}

const USAGE = [
  "Usage: bun scripts/desktop-version.ts <x.y.z>|--check|--print",
  "  <x.y.z>   write the version to Cargo.toml and its mirrors (Cargo.lock, package.json)",
  "  --check   verify the mirrors against Cargo.toml; exit 1 on any mismatch",
  "  --print   print the current version",
].join("\n");

async function main(): Promise<void> {
  const [argument, ...rest] = process.argv.slice(2);
  if (argument === undefined || argument === "--help" || argument === "-h") {
    console.log(USAGE);
    process.exitCode = argument === undefined ? 1 : 0;
    return;
  }
  if (rest.length > 0) {
    console.error(`unexpected argument(s): ${rest.join(" ")}`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const cargoTomlPath = join(ROOT, PATHS.cargoToml);
  const cargoLockPath = join(ROOT, PATHS.cargoLock);
  const packageJsonPath = join(ROOT, PATHS.packageJson);
  const tauriConfPath = join(ROOT, PATHS.tauriConf);
  const tauriWindowsConfPath = join(ROOT, PATHS.tauriWindowsConf);
  const tauriMacosConfPath = join(ROOT, PATHS.tauriMacosConf);
  const tauriProdConfPath = join(ROOT, PATHS.tauriProdConf);

  if (argument === "--print") {
    console.log(readCargoTomlVersion(readFileSync(cargoTomlPath, "utf8")));
    return;
  }

  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const cargoLock = readFileSync(cargoLockPath, "utf8");
  const packageJson = readFileSync(packageJsonPath, "utf8");
  const tauriConf = readFileSync(tauriConfPath, "utf8");
  // Overlays may not exist yet on a fresh checkout; missing reads as undefined (not a problem).
  const tauriWindowsConf = existsSync(tauriWindowsConfPath)
    ? readFileSync(tauriWindowsConfPath, "utf8")
    : undefined;
  const tauriMacosConf = existsSync(tauriMacosConfPath)
    ? readFileSync(tauriMacosConfPath, "utf8")
    : undefined;
  const tauriProdConf = existsSync(tauriProdConfPath)
    ? readFileSync(tauriProdConfPath, "utf8")
    : undefined;
  if (argument === "--check") {
    const { version, problems } = checkVersionMirrors({
      cargoToml,
      cargoLock,
      packageJson,
      tauriConf,
      tauriWindowsConf,
      tauriMacosConf,
      tauriProdConf,
    });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`ERROR ${problem}`);
      console.error(`Desktop version check FAILED. Run: bun run desktop:version ${version}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Desktop version ${version} is in sync (Cargo.toml, Cargo.lock, package.json; ${PATHS.tauriConf} sets no version).`,
    );
    return;
  }

  const version = parseVersion(argument);
  const nextToml = rewriteCargoTomlVersion(cargoToml, version);
  const nextLock = rewriteCargoLockVersion(cargoLock, version);
  const nextPackage = rewritePackageJsonVersion(packageJson, version);

  const changed: string[] = [];
  if (nextToml !== cargoToml) {
    changed.push(`${PATHS.cargoToml}: ${readCargoTomlVersion(cargoToml)} -> ${version}`);
    writeFileSync(cargoTomlPath, nextToml);
  }
  if (nextLock !== cargoLock) {
    changed.push(`${PATHS.cargoLock}: ${readCargoLockVersion(cargoLock)} -> ${version}`);
    writeFileSync(cargoLockPath, nextLock);
  }
  if (nextPackage !== packageJson) {
    changed.push(`${PATHS.packageJson}: ${readPackageJsonVersion(packageJson)} -> ${version}`);
    writeFileSync(packageJsonPath, nextPackage);
  }
  console.log(changed.length > 0 ? changed.join("\n") : `Already at ${version}; nothing to write.`);

  const after = checkVersionMirrors({
    cargoToml: nextToml,
    cargoLock: nextLock,
    packageJson: nextPackage,
    tauriConf,
    tauriWindowsConf,
    tauriMacosConf,
    tauriProdConf,
  });
  for (const problem of after.problems) console.error(`WARNING ${problem}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
