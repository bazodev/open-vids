import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  parseApplyEditsRequest,
  type ApplyEditsRequest,
  type AgentId,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import type { WriteLeases } from "../writeLeases.js";
import { withoutBlankArguments } from "./args.js";
import { formatDryRun } from "./dryRun.js";
import { formatEditResult } from "./format.js";
import { EditingError, type EditingHost } from "./host.js";

/** The main composition's path: what an edit without `composition` writes. */
const MAIN_COMPOSITION = "index.html";
const DEFAULT_KEY = "\0main";

/** The key a composition is remembered under: the main composition is one key however it was named (`index.html`, `./index.html`, `/index.html`, none). */
const keyOf = (composition: string | undefined) => {
  if (composition === undefined) return DEFAULT_KEY;
  const path = posix.normalize(composition.replaceAll("\\", "/")).replace(/^\/+/, "");
  return path === MAIN_COMPOSITION ? DEFAULT_KEY : path;
};

/**
 * The composition version each timeline read or applied batch of the turn reported, so an edit that names no
 * `baseVersion` is still checked against what the agent last saw: a change made behind its back (another run, a raw
 * file edit) becomes a crisp `conflict` instead of an edit built on a stale picture.
 */
export class SeenVersions {
  private readonly versions = new Map<string, string>();

  note(composition: string | undefined, snapshot: TimelineSnapshot): void {
    this.versions.set(keyOf(snapshot.composition.path), snapshot.version);
    this.versions.set(keyOf(composition), snapshot.version);
  }

  baseFor(composition: string | undefined): string | undefined {
    return this.versions.get(keyOf(composition));
  }
}

export interface EditTimelineDeps {
  host: EditingHost;
  seen: SeenVersions;
  /** The running turn: stamped on the batch so the service attributes the edits to it. */
  turnId?: string | undefined;
  leases?: WriteLeases | undefined;
  runIdOf?: ((caller: AgentId) => string | null) | undefined;
  /** A batch the service accepted set the canvas: the format is decided now. */
  onCanvasSet?: (() => void) | undefined;
}

/**
 * The id a batch is applied under. It is a hash of the turn, the composition and the operations, so the same batch
 * sent again (a call that timed out, a model that repeats itself) is recognised by the service, which answers it
 * instead of applying twice as long as nothing else has changed the composition since.
 */
function requestIdFor(
  turnId: string | undefined,
  composition: string | undefined,
  request: ApplyEditsRequest,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([turnId ?? "", composition ?? "", request.operations]))
    .digest("base64url");
  return `ov-${digest.slice(0, 32)}`;
}

/** `edit_timeline`: validates the batch, fills what the runtime owns (turn, base version, request id), applies or dry-runs it. */
export async function runEditTimeline(
  args: unknown,
  signal: AbortSignal,
  caller: AgentId,
  deps: EditTimelineDeps,
): Promise<HostToolResult> {
  const parsed = parseApplyEditsRequest(withoutBlankArguments(args));
  if (!parsed.ok) {
    throw new EditingError(parsed.error.code, parsed.error.message, parsed.error.opIndex);
  }
  const { host, seen, turnId, leases } = deps;
  // The turn, the version and the request id are the runtime's to name: whatever the model sent is replaced.
  const { turnId: _turn, requestId: _id, baseVersion: given, ...request } = parsed.value;
  const filled = given === undefined ? seen.baseFor(request.composition) : undefined;
  const baseVersion = given ?? filled;

  if (leases) {
    const writer = { agent: caller, runId: deps.runIdOf?.(caller) ?? null };
    const files = [request.composition ?? MAIN_COMPOSITION];
    const refused = request.dryRun ? leases.check(writer, files) : leases.claim(writer, files);
    if (refused) return { text: refused, isError: true };
  }

  const batch: ApplyEditsRequest = {
    ...request,
    ...(baseVersion !== undefined && { baseVersion }),
    ...(turnId !== undefined && { turnId }),
    ...(!request.dryRun && { requestId: requestIdFor(turnId, request.composition, request) }),
  };

  try {
    if (request.dryRun) {
      const before = await host.timeline(request.composition, signal);
      seen.note(request.composition, before);
      const simulated = await host.apply(batch, signal);
      return { text: formatDryRun(before, simulated) };
    }
    const applied = await host.apply(batch, signal);
    seen.note(request.composition, applied.timeline);
    if (batch.operations.some((operation) => operation.op === "set_canvas")) deps.onCanvasSet?.();
    return { text: formatEditResult(applied) };
  } catch (error) {
    if (filled !== undefined && error instanceof EditingError && error.code === "conflict") {
      throw new EditingError(
        "conflict",
        `${error.message} (no baseVersion was given, so your last read of this turn was used: inspect_timeline to see the current timeline, then repeat the edit)`,
        error.opIndex,
      );
    }
    throw error;
  }
}
