import { isAbsolute, posix, relative } from "node:path";
import {
  ANALYSIS_LIMITS,
  EDIT_LIMITS,
  parseAnalyzeRequest,
  parseCutPlanRequest,
  parseFramesRequest,
  parseSaveSegmentsRequest,
  parseSaveVisionNotesRequest,
  isRecord,
  type ComputedStage,
  type CutPlan,
  type ParsedAnalysis,
} from "@hyperframes/agent-protocol";
import type { HostToolResult, ToolProgress } from "../backend.js";
import { isBlankArgument } from "../editing/args.js";
import { EditingError, type EditingHost } from "../editing/host.js";
import { formatError } from "../editing/format.js";
import { errorMessage } from "../errors.js";
import {
  ANALYSIS_SECTIONS,
  formatAnalysisError,
  formatBuiltCut,
  formatCutPlan,
  unseenPictureProblems,
  formatFrames,
  formatOverview,
  formatSavedSegments,
  formatSavedVisionNotes,
  formatSection,
  formatShots,
  formatSilence,
  formatTranscript,
} from "./format.js";
import { AnalysisToolError, type AnalysisHost } from "./host.js";
import { JOB_POLL_MS, analyzeAndWait } from "./jobs.js";
import {
  planCaptionCues,
  problemsOnTimeline,
  roughCutBatch,
  type RoughCutCaptions,
} from "./roughCut.js";
import { stageProgressLabel } from "./stageLabel.js";
import {
  ANALYSIS_TOOL_NAMES,
  isAnalysisToolName,
  sourceName,
  type AnalysisToolName,
} from "./tools.js";

export interface TurnAnalysisOptions {
  host: AnalysisHost;
  /** The editing host build_rough_cut writes through; null when the runtime has none. */
  editing: EditingHost | null;
  /** The turn's abort signal: aborting the turn cancels every running analysis job and read. */
  turnSignal: AbortSignal;
  /** How often a running job is polled (default 750 ms). */
  pollMs?: number;
  /** A running analysis that shows no progress for this long is cancelled with an error (default 15 minutes). */
  stallMs?: number;
  /**
   * Most distinct frames `inspect_frames` may extract per source in this turn (the turn's Execution Quality
   * `analysisFramesPerSource`); absent = no cap.
   */
  framesPerSource?: number;
  /** The running agent turn: stamped on the clips of a rough cut. */
  turnId?: string;
  /** The project folder: lets an absolute in-project source path count against the same budget as its relative form. */
  projectDir?: string;
}

/**
 * The project-relative path a source names, spelled as the analysis service resolves it (trimmed, `/` separators,
 * no leading `./`, absolute in-project paths made relative), so one file has one frame budget.
 */
function sourceKey(projectDir: string | undefined, raw: string): string {
  const text = raw.trim().replaceAll("\\", "/");
  const inside = projectDir !== undefined && isAbsolute(text) ? relative(projectDir, text) : text;
  return posix.normalize(inside.replaceAll("\\", "/").replace(/^\.\//, ""));
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

const invalid = (message: string) => new AnalysisToolError("invalid_request", message);

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw invalid("arguments must be a JSON object");
  return args;
}

/**
 * Models send `null`, blank text or an empty `order` for arguments they leave out. `hook: null` (remove the hook) and
 * the other empty lists (`removeIssues: []` cuts no take issue) are real values and stay.
 */
function withoutBlanks(args: unknown): unknown {
  if (!isRecord(args)) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => {
      if (value === null) return key === "hook";
      if (Array.isArray(value)) return key !== "order" || value.length > 0;
      return !isBlankArgument(value);
    }),
  );
}

function checked<T>(parsed: ParsedAnalysis<T>): T {
  if (!parsed.ok) throw new AnalysisToolError(parsed.error.code, parsed.error.message);
  return parsed.value;
}

function sourceOf(record: Record<string, unknown>): string {
  const { source } = record;
  if (typeof source !== "string" || source.trim().length === 0)
    throw invalid("source must be the project-relative path of a media file");
  if (source.length > ANALYSIS_LIMITS.pathChars)
    throw invalid(`source exceeds ${ANALYSIS_LIMITS.pathChars} characters`);
  return source;
}

const CLOCK_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/;

/** Seconds as a number, or as the `mm:ss.s` the transcript prints (models copy those). */
function timeArg(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  let seconds: number | null = null;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") {
    const match = CLOCK_TIME.exec(value.trim());
    seconds = match
      ? Number(match[1] ?? 0) * 3_600 + Number(match[2]) * 60 + Number(match[3])
      : Number(value);
  }
  if (
    seconds === null ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > ANALYSIS_LIMITS.maxTime
  )
    throw invalid(`${field} must be seconds of the source (a number ≥ 0)`);
  return seconds;
}

function planArg(record: Record<string, unknown>): string {
  const { plan } = record;
  if (typeof plan !== "string" || plan.trim().length === 0 || plan.length > ANALYSIS_LIMITS.idChars)
    throw invalid("plan must be a plan id such as cut-1");
  return plan.trim();
}

/**
 * The analysis tools of one running turn, bound to that turn's project and abort signal. Like the editing executor
 * it tracks its in-flight calls so {@link shutdown} can stop the turn's analysis before the checkpoint transaction
 * closes: running jobs are cancelled, a build_rough_cut whose edit already reached Studio is awaited to its end, and
 * no new call is accepted afterwards.
 */
export class TurnAnalysis {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly planRanges = new Map<string, number>();
  /** The distinct frame times `inspect_frames` has extracted this turn, per source. */
  private readonly inspectedFrames = new Map<string, Set<number>>();

  constructor(private readonly options: TurnAnalysisOptions) {}

  /** Ranges (= clips) of a plan this turn has planned or built, for the activity label of build_rough_cut. */
  planClips(plan: string): number | undefined {
    return this.planRanges.get(plan);
  }

  execute(
    name: string,
    args: unknown,
    callSignal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; analysis is closed."));
    if (!isAnalysisToolName(name)) return Promise.resolve(refuse(`Unknown analysis tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal, progress).catch((error: unknown): HostToolResult => {
      if (error instanceof AnalysisToolError) return refuse(formatAnalysisError(error));
      if (error instanceof EditingError) return refuse(formatError(error));
      return refuse(`internal: ${errorMessage(error, "The analysis call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, cancels running jobs and reads, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private async run(
    name: AnalysisToolName,
    args: unknown,
    signal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<HostToolResult> {
    const { host } = this.options;
    switch (name) {
      case ANALYSIS_TOOL_NAMES.analyze: {
        const request = checked(parseAnalyzeRequest(withoutBlanks(args)));
        const job = await analyzeAndWait(host, request, signal, {
          pollMs: this.options.pollMs ?? JOB_POLL_MS,
          ...(this.options.stallMs !== undefined && { stallMs: this.options.stallMs }),
          ...(progress && {
            onProgress: (percent: number, stage: ComputedStage | null) =>
              progress(percent, stageProgressLabel(sourceName(args), stage)),
          }),
        });
        return { text: formatOverview(await host.overview(request.source, signal), job) };
      }
      case ANALYSIS_TOOL_NAMES.read: {
        const record = argsRecord(withoutBlanks(args));
        const source = sourceOf(record);
        const section =
          record.section === undefined
            ? "overview"
            : ANALYSIS_SECTIONS.find((candidate) => candidate === record.section);
        if (!section) throw invalid(`section must be one of ${ANALYSIS_SECTIONS.join(", ")}`);
        const offset = record.offset ?? 0;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
          throw invalid("offset must be a whole number from 0");
        if (section === "silence")
          return { text: formatSilence(await host.artifact(source, "silence", signal), offset) };
        if (section === "shots")
          return { text: formatShots(await host.artifact(source, "shots", signal), offset) };
        const overview = await host.overview(source, signal);
        return {
          text:
            section === "overview"
              ? formatOverview(overview)
              : formatSection(section, overview, offset),
        };
      }
      case ANALYSIS_TOOL_NAMES.transcript: {
        const record = argsRecord(withoutBlanks(args));
        const source = sourceOf(record);
        const from = timeArg(record.from, "from");
        const to = timeArg(record.to, "to");
        if (from !== undefined && to !== undefined && to <= from)
          throw invalid("to must be after from");
        const window = { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
        const [view, issues] = await Promise.all([
          host.transcript(source, window, signal),
          // Marks are a courtesy: a transcript that reads fine must not fail because the overview did.
          host.overview(source, signal).then(
            (overview) => overview.takes?.issues ?? [],
            () => [],
          ),
        ]);
        return { text: formatTranscript(view, issues) };
      }
      case ANALYSIS_TOOL_NAMES.segments: {
        const request = checked(parseSaveSegmentsRequest(args));
        return { text: formatSavedSegments(await host.saveSegments(request, signal)) };
      }
      case ANALYSIS_TOOL_NAMES.frames: {
        const request = checked(parseFramesRequest(withoutBlanks(args)));
        const cap = this.options.framesPerSource;
        // The budget belongs to the file, whichever way the model spells its path.
        const key = sourceKey(this.options.projectDir, request.source);
        const seen = this.inspectedFrames.get(key) ?? new Set<number>();
        this.inspectedFrames.set(key, seen);
        const fresh = new Set(request.times.filter((time) => !seen.has(time)));
        if (cap !== undefined && seen.size + fresh.size > cap) {
          const left = Math.max(0, cap - seen.size);
          return refuse(
            `Frame budget of ${request.source} reached: ${seen.size} of ${cap} frames were already inspected in this turn (the turn's Execution Quality budget) and this call would add ${fresh.size}. ${left > 0 ? `Ask for at most ${left} new ${left === 1 ? "frame" : "frames"}` : "Work from the frames you already saw, the vision notes and the analysis"}; frames at times you already inspected cost nothing.`,
          );
        }
        // Reserved before the await, so parallel calls of one assistant message share the budget.
        for (const time of fresh) seen.add(time);
        let frames;
        try {
          ({ frames } = await host.frames(request, signal));
        } catch (error) {
          for (const time of fresh) seen.delete(time);
          throw error;
        }
        return {
          text: formatFrames(request.source, frames),
          images: frames.map((frame) => ({ mimeType: frame.mimeType, data: frame.data })),
        };
      }
      case ANALYSIS_TOOL_NAMES.vision: {
        const request = checked(parseSaveVisionNotesRequest(args));
        return {
          text: formatSavedVisionNotes(
            request.notes.length,
            await host.saveVisionNotes(request, signal),
          ),
        };
      }
      case ANALYSIS_TOOL_NAMES.plan: {
        const request = checked(parseCutPlanRequest(withoutBlanks(args)));
        const plan = await host.planCut(request, signal);
        this.planRanges.set(plan.id, plan.ranges.length);
        // The planner cannot see pictures: say which detected picture problems stay in this cut unseen by Vision.
        const overview = await host.overview(plan.source, signal).catch(() => null);
        const unseen = unseenPictureProblems(plan.ranges, overview?.visionTargets ?? []);
        return { text: [formatCutPlan(plan), unseen].filter(Boolean).join("\n") };
      }
      case ANALYSIS_TOOL_NAMES.build:
        return this.buildRoughCut(args, signal);
    }
  }

  /**
   * Plan → timeline in one atomic batch through the editing path (so it belongs to the turn's checkpoint and Revert
   * undoes it). Everything that can fail is read before the batch is sent; once it is on its way it is awaited to its
   * end. Whether a plan is on the timeline is derived from the clips it stamped, never recorded separately.
   */
  private async buildRoughCut(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const { host, editing, turnId } = this.options;
    if (!editing)
      throw new AnalysisToolError("unavailable", "Editing is not available in this runtime.");
    const record = argsRecord(withoutBlanks(args));
    const planId = planArg(record);
    const composition =
      typeof record.composition === "string" && record.composition.length > 0
        ? record.composition
        : undefined;
    const { track = 0 } = record;
    if (
      typeof track !== "number" ||
      !Number.isInteger(track) ||
      track < 0 ||
      track > EDIT_LIMITS.maxTrack
    )
      throw invalid(`track must be an integer from 0 to ${EDIT_LIMITS.maxTrack}`);
    const captionPreset = record.captions;
    if (
      captionPreset !== undefined &&
      (typeof captionPreset !== "string" ||
        captionPreset.trim().length === 0 ||
        captionPreset.length > EDIT_LIMITS.idChars)
    )
      throw invalid("captions must be the name of a caption preset from browse_presets");

    const plan = await host.getCut(planId, signal);
    // The ranges are source times of the state the plan was made for; on changed media or a redone transcript they
    // would keep and cut the wrong words and the turn would still report success.
    if (plan.outOfDate !== undefined) {
      throw new AnalysisToolError(
        "stale",
        `Cut plan ${plan.id} is out of date: ${plan.outOfDate}. Nothing was built; plan the cut again with plan_cut.`,
      );
    }
    this.planRanges.set(plan.id, plan.ranges.length);
    const [timeline, overview] = await Promise.all([
      editing.timeline(composition, signal),
      host.overview(plan.source, signal),
    ]);
    const captions =
      typeof captionPreset === "string"
        ? await this.captionsFor(plan, captionPreset.trim(), signal)
        : undefined;
    const batch = roughCutBatch({ plan, timeline, composition, track, turnId, captions });
    if (signal.aborted)
      throw new AnalysisToolError("aborted", "The turn is stopping; the rough cut was not built.");
    const response = await editing.apply(batch.request, signal);

    const built = response.results.find((result) => result.op === "add_sequence");
    const clips = built?.clipIds?.length ?? plan.ranges.length;
    return {
      text: formatBuiltCut({
        plan,
        track,
        clips,
        length: batch.length,
        replacedClips: batch.replacedClips,
        removedPlaceholders: batch.removedPlaceholders,
        keptClips: batch.keptClips,
        captions: captions ? { preset: captions.preset, cues: captions.cues.length } : null,
        timeline: response.timeline,
        problems: problemsOnTimeline(plan, overview.shots?.problems ?? []),
      }),
    };
  }

  /** The caption cues of a plan, from the transcript's words between the plan's first and last kept range. */
  private async captionsFor(
    plan: CutPlan,
    preset: string,
    signal: AbortSignal,
  ): Promise<RoughCutCaptions> {
    const from = Math.min(...plan.ranges.map((range) => range.from));
    const to = Math.max(...plan.ranges.map((range) => range.to));
    const transcript = await this.options.host.transcript(
      plan.source,
      { from, to, words: true },
      signal,
    );
    return { preset, cues: planCaptionCues(plan, transcript) };
  }
}
