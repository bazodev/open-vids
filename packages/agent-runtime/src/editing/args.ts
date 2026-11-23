import { isRecord, type AssetKind, ASSET_KINDS } from "@hyperframes/agent-protocol";
import { EditingError } from "./host.js";

const invalid = (message: string) => new EditingError("invalid_request", message);

/** Reads an optional string argument; anything else is a refusal the model can correct. */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

/** Reads an optional whole-number argument within `[min, max]`. */
export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${key} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** Reads an optional number of seconds argument (0 up to a day). */
export function optionalSeconds(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400) {
    throw invalid(`${key} must be a number of seconds from 0 to 86400`);
  }
  return value;
}

export function optionalAssetKind(
  args: Record<string, unknown>,
  key: string,
): AssetKind | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const kind = ASSET_KINDS.find((candidate) => candidate === value);
  if (!kind) throw invalid(`${key} must be one of ${ASSET_KINDS.join(", ")}`);
  return kind;
}

/** What a model sends for an argument it leaves out: `null`, blank text or an empty list. */
export function isBlankArgument(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The arguments without those a model left blank, at every depth. No editing argument takes a blank value (its reader
 * refuses one), so this cannot change a valid call. Entries of a list stay: dropping one would silently change what
 * a batch acts on, so a blank entry is still refused.
 */
export function withoutBlankArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBlankArguments);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => !isBlankArgument(entry))
      .map(([key, entry]) => [key, withoutBlankArguments(entry)]),
  );
}

export function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  const cleaned = withoutBlankArguments(args);
  if (!isRecord(cleaned)) throw invalid("arguments must be a JSON object");
  return cleaned;
}

export { invalid };
