/**
 * Runs OMP's real path helpers; only Bun can load them. `path-forms.parity.test.ts` starts this
 * file with `bun` and compares the output with the guards' readings.
 *
 * Usage: bun path-forms.probe.ts <cwd> <json array of path spellings>
 */
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { parseReadUrlTarget } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { normalizePathLikeInput, resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/hashline-header-path";
import { cfgFetchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { createSessionSettings } from "./catalog.ts";

const [cwd, spellingsJson] = process.argv.slice(2);
if (cwd === undefined || spellingsJson === undefined) throw new Error("usage: <cwd> <spellings>");
const spellings: unknown = JSON.parse(spellingsJson);
if (!Array.isArray(spellings)) throw new Error("spellings must be an array");

function landing(read: () => string): string | null {
  try {
    return read();
  } catch {
    // an internal scheme: OMP routes it to a handler instead of the filesystem
    return null;
  }
}

const results = spellings.map((spelling) => {
  if (typeof spelling !== "string") throw new Error("spellings must be strings");
  return {
    spelling,
    // read / grep / find: unquote, then resolve
    read: landing(() => resolveToCwd(normalizePathLikeInput(spelling), cwd)),
    // write / edit: unwrap a hashline header, then resolve
    write: landing(() => resolveToCwd(unwrapHashlineHeaderPath(spelling), cwd)),
    // write / edit with a quoted spelling
    writeQuoted: landing(() =>
      resolveToCwd(unwrapHashlineHeaderPath(normalizePathLikeInput(spelling)), cwd),
    ),
    url: parseReadUrlTarget(spelling) !== null,
  };
});

process.stdout.write(
  JSON.stringify({
    results,
    fetchEnabled: cfgFetchEnabled.get(createSessionSettings(Effort.High)),
  }),
);
