import languagesJson from "../../../../locales/index.json";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";

/**
 * App preferences shared by the desktop's Projects home and Studio: one JSON file,
 * `~/.openvids/app/preferences.json` (directory overridable with `OPENVIDS_APP_DIR`). The desktop
 * (`apps/desktop/src-tauri/src/prefs.rs`) reads and writes the same file under the same rules:
 *
 * - a missing or unreadable file means the defaults;
 * - on read, a known key with an invalid value falls back to its default;
 * - unknown keys (another side's, a newer app's) are kept: an update is a deep merge into the stored document;
 * - writes are atomic (temp file + rename).
 *
 * Known top-level keys: `version`, `theme`, `language`, `onLaunch`, `confirmTrash`, `density`,
 * `newProject`, `updates`, `telemetry`, `onboarding`. `language` is `"system"` or a code from
 * `locales/index.json`.
 *
 * The file is re-read on every request: the desktop may have changed it since.
 */
export const APP_THEMES = ["system", "dark", "light"] as const;
export const NEW_PROJECT_WORKSPACES = ["media", "story", "edit"] as const;
export const LAUNCH_MODES = ["projects", "last"] as const;
export const APP_DENSITIES = ["default", "compact"] as const;
export const NEW_PROJECT_FPS = [24, 25, 30, 60] as const;
export const MAX_FRAME_SIZE = 8192;
const MAX_LOCATION_LENGTH = 1024;
const PREFERENCES_FILE = "preferences.json";

interface LocaleIndexEntry {
  code: string;
  name: string;
}

function isLocaleIndexEntry(value: unknown): value is LocaleIndexEntry {
  return isRecord(value) && typeof value.code === "string" && typeof value.name === "string";
}

function localeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes: string[] = [];
  for (const entry of value) {
    if (isLocaleIndexEntry(entry)) codes.push(entry.code);
  }
  return codes;
}

export const APP_LANGUAGES: readonly string[] = ["system", ...localeCodes(languagesJson)];

export type AppTheme = (typeof APP_THEMES)[number];
export type NewProjectWorkspace = (typeof NEW_PROJECT_WORKSPACES)[number];
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type AppDensity = (typeof APP_DENSITIES)[number];
export type NewProjectFps = (typeof NEW_PROJECT_FPS)[number];

export interface NewProjectPreferences {
  location: string;
  openIn: NewProjectWorkspace;
  width: number;
  height: number;
  fps: NewProjectFps;
}

/** Update behaviour. Only the choice is stored: the updater itself does not exist yet. */
export interface UpdatePreferences {
  autoCheck: boolean;
}

/** Anonymous usage statistics, sent by the desktop shell only (`apps/desktop/src-tauri/src/telemetry.rs`). */
export interface TelemetryPreferences {
  enabled: boolean;
}

/** First-run onboarding: when it was finished (ms since the epoch), `null` while it has not been. */
export interface OnboardingPreferences {
  completedAt: number | null;
}

/** The effective preferences. Unknown keys of the stored document ride along in responses. */
export interface AppPreferences {
  version: 1;
  theme: AppTheme;
  language: string;
  newProject: NewProjectPreferences;
  confirmTrash: boolean;
  onLaunch: LaunchMode;
  density: AppDensity;
  updates: UpdatePreferences;
  telemetry: TelemetryPreferences;
  onboarding: OnboardingPreferences;
}

/** Windows' Documents-based default; other platforms retain their Movies default. */
export function defaultProjectLocation(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "~/Documents/OpenVids" : "~/Movies/OpenVids";
}

/** Maps only the previous Windows default to the current Windows default. */
export function migrateLegacyProjectLocation(
  location: string,
  platform: NodeJS.Platform,
  home: string,
): string | undefined {
  if (platform !== "win32") return undefined;
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  const normalized = normalize(location);
  const expanded = normalize(join(home, "Movies", "OpenVids"));
  return normalized === "~/movies/openvids" || normalized === expanded
    ? "~/Documents/OpenVids"
    : undefined;
}

/**
 * The default New Projects folder is `~/Documents/OpenVids` on Windows and
 * `~/Movies/OpenVids` elsewhere.
 */
export function defaultAppPreferences(
  platform: NodeJS.Platform = process.platform,
): AppPreferences {
  return {
    version: 1,
    theme: "system",
    language: "system",
    newProject: {
      location: defaultProjectLocation(platform),
      openIn: "media",
      width: 1920,
      height: 1080,
      fps: 24,
    },
    confirmTrash: true,
    onLaunch: "projects",
    density: "default",
    updates: { autoCheck: true },
    telemetry: { enabled: true },
    onboarding: { completedAt: null },
  };
}

export function defaultAppDir(): string {
  return process.env.OPENVIDS_APP_DIR || join(homedir(), ".openvids", "app");
}

/** A PUT body that names a known key with a value outside its contract. `code` is the `errors.<code>` key Studio uses. */
export class InvalidPreferencesError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number> | undefined;

  constructor(
    message: string,
    code = "invalid_preferences.value",
    params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "InvalidPreferencesError";
    this.code = code;
    this.params = params;
  }
}

const oneOf =
  <T extends string | number>(choices: readonly T[]) =>
  (value: unknown): value is T =>
    choices.some((choice) => choice === value);

const isTheme = oneOf(APP_THEMES);
const isLanguage = oneOf(APP_LANGUAGES);
const isWorkspace = oneOf(NEW_PROJECT_WORKSPACES);
const isLaunchMode = oneOf(LAUNCH_MODES);
const isDensity = oneOf(APP_DENSITIES);
const isFps = oneOf(NEW_PROJECT_FPS);
const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isFrameSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_FRAME_SIZE;
const isWindowsAbsolute = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
const isLocation = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > MAX_LOCATION_LENGTH) return false;
  // POSIX absolute (`/...`, `~...`) everywhere; drive-letter (`C:\...`, `C:/...`),
  // UNC (`\\server\share`) and tilde-backslash (`~\...`) additionally on Windows.
  // This is a shape check only — the desktop shell resolves the path.
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
  if (process.platform !== "win32") return false;
  return isWindowsAbsolute(trimmed) || /^[A-Za-z]:$/.test(trimmed);
};

function migrateStoredLocation(stored: Document, platform: NodeJS.Platform, home: string): boolean {
  if (!isRecord(stored.newProject) || typeof stored.newProject.location !== "string") return false;
  const location = migrateLegacyProjectLocation(stored.newProject.location, platform, home);
  if (!location) return false;
  stored.newProject.location = location;
  return true;
}
type Document = Record<string, unknown>;

/** The stored document with every known key validated (invalid or missing → default), unknown keys kept. */
function normalize(
  stored: Document,
  platform: NodeJS.Platform = process.platform,
): Document & AppPreferences {
  const base = defaultAppPreferences(platform);
  const project = isRecord(stored.newProject) ? stored.newProject : {};
  const newProject: Document & NewProjectPreferences = {
    ...project,
    location: isLocation(project.location) ? project.location.trim() : base.newProject.location,
    openIn: isWorkspace(project.openIn) ? project.openIn : base.newProject.openIn,
    width: isFrameSize(project.width) ? project.width : base.newProject.width,
    height: isFrameSize(project.height) ? project.height : base.newProject.height,
    fps: isFps(project.fps) ? project.fps : base.newProject.fps,
  };
  const updates = isRecord(stored.updates) ? stored.updates : {};
  const telemetry = isRecord(stored.telemetry) ? stored.telemetry : {};
  const onboarding = isRecord(stored.onboarding) ? stored.onboarding : {};
  return {
    ...stored,
    version: 1,
    theme: isTheme(stored.theme) ? stored.theme : base.theme,
    language: isLanguage(stored.language) ? stored.language : base.language,
    onLaunch: isLaunchMode(stored.onLaunch) ? stored.onLaunch : base.onLaunch,
    confirmTrash:
      typeof stored.confirmTrash === "boolean" ? stored.confirmTrash : base.confirmTrash,
    density: isDensity(stored.density) ? stored.density : base.density,
    updates: {
      ...updates,
      autoCheck:
        typeof updates.autoCheck === "boolean" ? updates.autoCheck : base.updates.autoCheck,
    },
    telemetry: {
      ...telemetry,
      enabled: typeof telemetry.enabled === "boolean" ? telemetry.enabled : base.telemetry.enabled,
    },
    onboarding: {
      ...onboarding,
      completedAt: isTimestamp(onboarding.completedAt) ? onboarding.completedAt : null,
    },
    newProject,
  };
}

const KNOWN_TOP: Record<string, (value: unknown) => boolean> = {
  theme: isTheme,
  language: isLanguage,
  onLaunch: isLaunchMode,
  confirmTrash: (value) => typeof value === "boolean",
  density: isDensity,
  version: (value) => value === 1,
};

const KNOWN_NEW_PROJECT: Record<string, (value: unknown) => boolean> = {
  location: isLocation,
  openIn: isWorkspace,
  width: isFrameSize,
  height: isFrameSize,
  fps: isFps,
};

const KNOWN_UPDATES: Record<string, (value: unknown) => boolean> = {
  autoCheck: (value) => typeof value === "boolean",
};

const KNOWN_TELEMETRY: Record<string, (value: unknown) => boolean> = {
  enabled: (value) => typeof value === "boolean",
};

const KNOWN_ONBOARDING: Record<string, (value: unknown) => boolean> = {
  completedAt: (value) => value === null || isTimestamp(value),
};

/** Refuses a patch whose known keys carry invalid values; unknown keys pass untouched. */
export function validatePreferencesPatch(patch: unknown): Document {
  if (!isRecord(patch))
    throw new InvalidPreferencesError(
      "Preferences must be a JSON object",
      "invalid_preferences.body",
    );
  for (const [key, check] of Object.entries(KNOWN_TOP)) {
    if (key in patch && !check(patch[key])) {
      throw new InvalidPreferencesError(`Invalid value for "${key}"`, undefined, { key });
    }
  }
  if ("newProject" in patch) {
    const project = patch.newProject;
    if (!isRecord(project))
      throw new InvalidPreferencesError(
        `"newProject" must be an object`,
        "invalid_preferences.object",
        { key: "newProject" },
      );
    for (const [key, check] of Object.entries(KNOWN_NEW_PROJECT)) {
      if (key in project && !check(project[key])) {
        throw new InvalidPreferencesError(`Invalid value for "newProject.${key}"`, undefined, {
          key: `newProject.${key}`,
        });
      }
    }
  }
  if ("updates" in patch) {
    const updates = patch.updates;
    if (!isRecord(updates))
      throw new InvalidPreferencesError(
        `"updates" must be an object`,
        "invalid_preferences.object",
        {
          key: "updates",
        },
      );
    for (const [key, check] of Object.entries(KNOWN_UPDATES)) {
      if (key in updates && !check(updates[key])) {
        throw new InvalidPreferencesError(`Invalid value for "updates.${key}"`, undefined, {
          key: `updates.${key}`,
        });
      }
    }
  }
  if ("telemetry" in patch) {
    const telemetry = patch.telemetry;
    if (!isRecord(telemetry))
      throw new InvalidPreferencesError(
        `"telemetry" must be an object`,
        "invalid_preferences.object",
        { key: "telemetry" },
      );
    for (const [key, check] of Object.entries(KNOWN_TELEMETRY)) {
      if (key in telemetry && !check(telemetry[key])) {
        throw new InvalidPreferencesError(`Invalid value for "telemetry.${key}"`, undefined, {
          key: `telemetry.${key}`,
        });
      }
    }
  }
  if ("onboarding" in patch) {
    const onboarding = patch.onboarding;
    if (!isRecord(onboarding))
      throw new InvalidPreferencesError(
        `"onboarding" must be an object`,
        "invalid_preferences.object",
        { key: "onboarding" },
      );
    for (const [key, check] of Object.entries(KNOWN_ONBOARDING)) {
      if (key in onboarding && !check(onboarding[key])) {
        throw new InvalidPreferencesError(`Invalid value for "onboarding.${key}"`, undefined, {
          key: `onboarding.${key}`,
        });
      }
    }
  }
  return patch;
}

/** Deep merge: objects merge key by key, any other value replaces. */
function merge(target: Document, patch: Document): Document {
  const out: Document = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? merge(existing, value) : value;
  }
  return out;
}

export class AppPreferencesStore {
  readonly path: string;

  constructor(options: { dir?: string } = {}) {
    this.path = join(options.dir ?? defaultAppDir(), PREFERENCES_FILE);
  }

  private readRaw(): Document {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  read(): Document & AppPreferences {
    const stored = this.readRaw();
    if (migrateStoredLocation(stored, process.platform, homedir())) {
      const migrated = normalize(stored);
      mkdirSync(dirname(this.path), { recursive: true });
      replaceFileAtomically(this.path, `${JSON.stringify(migrated, null, 2)}\n`, 0o644);
      return migrated;
    }
    return normalize(stored);
  }

  /** Validates `patch`, deep-merges it into the stored document and writes the effective result atomically. */
  update(patch: unknown): Document & AppPreferences {
    const valid = validatePreferencesPatch(patch);
    const stored = merge(this.readRaw(), valid);
    migrateStoredLocation(stored, process.platform, homedir());
    const next = normalize(stored);
    mkdirSync(dirname(this.path), { recursive: true });
    replaceFileAtomically(this.path, `${JSON.stringify(next, null, 2)}\n`, 0o644);
    return next;
  }
}
