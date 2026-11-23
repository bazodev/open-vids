import {
  ASSET_KINDS,
  CANVAS_FITS,
  EDIT_LIMITS,
  EDIT_OPERATION_NAMES,
  PRESET_KINDS,
  RIPPLE_SCOPES,
  TEXT_PLACEMENTS,
  TEXT_SIZES,
  isRecord,
  type AgentId,
  type EditOperationName,
  type PresetKind,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity, ToolProgress } from "../backend.js";
import { withInheritedTools } from "../agents/inherit.js";
import { RENDER_QUALITIES } from "./host.js";
import { LONG_RENDER_SECONDS } from "./renderGuard.js";
import { MORE_OPERATION_SCHEMAS } from "./schemaMore.js";
import {
  canvasSide,
  clipId,
  fade,
  fit,
  frame,
  operationSchema,
  str,
  time,
  track,
  volume,
  type OperationSchema,
} from "./schemaParts.js";

export const EDITING_TOOL_NAMES = {
  project: "inspect_project",
  timeline: "inspect_timeline",
  edit: "edit_timeline",
  presets: "browse_presets",
  render: "render_video",
} as const;

export type EditingToolName = (typeof EDITING_TOOL_NAMES)[keyof typeof EDITING_TOOL_NAMES];

export function isEditingToolName(name: string): name is EditingToolName {
  return Object.values<string>(EDITING_TOOL_NAMES).includes(name);
}

type Executor = (
  name: string,
  args: unknown,
  signal: AbortSignal,
  progress?: ToolProgress,
) => Promise<HostToolResult>;

/**
 * Which editing tools an agent gets. A specialist gets what its domain needs; the Director gets its own and, through
 * {@link withInheritedTools}, those of every specialist that is off in this chat (the Editor's `edit_timeline` when no
 * Editor is on). Jev only reads: it sees the project and the timeline, never edits. A story-mode turn that does not
 * build the story never writes the timeline (`timelineWrites` false): nobody gets `edit_timeline` or `render_video`.
 */
export function editingToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  { timelineWrites = true }: { timelineWrites?: boolean } = {},
): EditingToolName[] {
  const { project, timeline, edit, presets, render } = EDITING_TOOL_NAMES;
  const base = (id: AgentId): EditingToolName[] => {
    switch (id) {
      case "director":
        return [project, timeline, presets, render];
      case "editor":
        return [project, timeline, presets, render, edit];
      case "motion":
        return [project, timeline, presets, edit];
      case "audio":
        return [project, timeline, edit];
      case "vision":
      case "research":
        return [project, timeline, presets];
      case "jev":
        return [project, timeline];
      default:
        return [];
    }
  };
  const tools = withInheritedTools(agent, enabled, base);
  return timelineWrites ? tools : tools.filter((tool) => tool !== edit && tool !== render);
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const CONVENTIONS = `Conventions: all times are seconds on the composition timeline (0 = start). Clip ids come from inspect_timeline and from the results of your own edits; assets are project-relative paths from inspect_project. Track 0 is the A-roll: the main story, audible. Higher tracks are B-roll and overlays (their video is muted; they are drawn on top of lower tracks because newer clips get a higher z-index) and titles. Music and sound effects are audio clips on tracks of their own: music at volume about 0.2–0.4 under speech with a 1–2 s fadeIn/fadeOut, sound effects as loud as they need to be.`;

const ADD_CLIP_GUIDE = `- add_clip: asset, start, track; optional duration (default: rest of the media — of the user-picked fragment, when there is one —; 3 s for images), mediaStart (in-point in the source; defaults to the user-picked fragment's start), volume (0–${EDIT_LIMITS.maxVolume}), muted, fit ("contain"|"cover"), frame ({x, y, width, height} in composition pixels, e.g. a logo in a corner; default: a video fills the frame, an image keeps its size, centred), fadeIn/fadeOut (seconds of linear audio/video gain ramp at the clip start/end; use 1–2 s on music beds).`;

/** The same line when the runtime has a voice host. */
const VOICE_ADD_CLIP_GUIDE = `- add_clip: asset (omit it only with voiceLine), start, track; optional voiceLine (the id of a generated voiceover line — the clip takes that line's file, range and length), duration (default: rest of the media — of the user-picked fragment, when there is one —; 3 s for images), mediaStart (in-point in the source; defaults to the user-picked fragment's start), volume (0–${EDIT_LIMITS.maxVolume}), muted, fit ("contain"|"cover"), frame ({x, y, width, height} in composition pixels, e.g. a logo in a corner; default: a video fills the frame, an image keeps its size, centred), fadeIn/fadeOut (seconds of linear audio/video gain ramp at the clip start/end; use 1–2 s on music beds).`;

const CAPTIONS_FROM_TRANSCRIPT_GUIDE = `- captions_from_transcript: preset (caption preset), optional track, clips (only these), maxWords (default 6). Writes the captions from the cached transcripts of the clips on the timeline (words follow each clip's in-point, length and speed; the lower track speaks where clips overlap). Needs analyze_media on the sources first; the answer names sources without a transcript.`;

/** With a voice host the guide also names `captions_from_voiceover`. */
const VOICE_CAPTIONS_GUIDE = `- captions_from_voiceover: optional preset (default: the first caption preset), track, lines (only the clips that speak these voiceover line ids). Writes the captions from the voiceover clips on the timeline (clips placed with add_clip voiceLine): every line shows its own text, timed by the words of the take the clip plays (in-point, length and speed applied). Takes made without word timings are recognised on the spot; the answer says when a clip was skipped.`;

const EDIT_OPERATIONS_GUIDE = `Operations (each has "op" plus):
${ADD_CLIP_GUIDE}
- add_sequence: asset (video/audio), track, ranges [{from, to}] (source in/out points, up to ${EDIT_LIMITS.sequenceRanges}); optional start (default 0), volume, muted, fit, frame, edgeFade (0–${EDIT_LIMITS.maxEdgeFade} s audio ramp at both edges of every clip, e.g. 0.02 against clicks). Places one clip per range back to back with no gaps and returns all their ids; use it for cutting one long recording, not for placing single clips. Refused if a range runs past the end of the source or outside the fragment the user picked.
- add_text: text, start, duration, track; optional placement ("top"|"center"|"bottom"), size ("small"|"medium"|"large"), color.
- add_component: name (a block/component from browse_presets), start, track; optional duration.
- apply_captions: preset (a caption preset from browse_presets), cues [{text, start, end}] spanning the composition; optional track.
- remove_clip: clip, or clips (many ids at once, up to ${EDIT_LIMITS.removeClips}); optional ripple (close the gap by moving later clips on the track) with rippleScope "track" (default) or "all" (later clips on EVERY track move back, so B-roll, music and titles stay in sync with the cut; clips that start before the removed clip ends do not move).
- move_clip: clip; start and/or track.
- trim_clip: clip; new timeline start and/or end (trimming the head of a video/audio clip advances its media in-point; a clip of an asset the user picked a fragment of can be trimmed only inside that fragment).
- split_clip: clip, at (timeline time inside the clip). The result reports the new second half's clip id.
- set_clip: clip; any of volume, muted, fit, zIndex, frame, fadeIn, fadeOut, opacity (0–1, visual clips).
- arrange_track: track, clips (ids in order), optional start (default 0) and gap; lays them end to end.
- set_composition: duration. The length follows the content only upwards: adding or moving clips past the end grows it, trimming or removing clips never shrinks it (a silent outro or music tail stays). To shorten the composition, set it explicitly.
- set_canvas: width, height (even pixels, up to ${EDIT_LIMITS.maxCanvasPixels}); optional fit "keep" (default: placed clips keep their frames — set the canvas BEFORE adding clips when the format is still to be decided), "contain" (re-frame everything already placed so the whole old picture fits inside the new canvas, centred, with bars where the shapes differ) or "cover" (fill the new canvas, cropping). Use contain/cover to turn a finished 16:9 video into 9:16; clips without a pixel frame are reported and left as they are.
- set_speed: clip (video/audio), rate (${EDIT_LIMITS.minRate}–${EDIT_LIMITS.maxRate}); by default the clip keeps the same stretch of source, so 2 → half as long on the timeline; keepDuration keeps the length (plays more or less of the source); ripple/rippleScope move later clips by the difference.
- retime_captions: shift (seconds, may be negative) and/or scale; optional from/to (cues starting inside [from, to) move; the rest stay). Moves the cues of existing captions, e.g. after a cut: { shift: -2.5, from: 40 }. Refused if cues would overlap or leave the captions' length.
${CAPTIONS_FROM_TRANSCRIPT_GUIDE}
- mount_composition: composition (a project .html file, e.g. compositions/intro.html), start, track; optional duration. Mounts an existing composition as a clip, like dropping it in Studio.
- set_color_grade: clip (video/image); preset (see browse_presets kind color_grade) and/or intensity (0–1) and/or adjust { exposure (±2), contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation (±1 each) }; or clear: true. A preset replaces the look; adjust layers over what the clip has.
- set_audio_fx: clip (video/audio), preset (see browse_presets kind audio_fx; re-applying a preset replaces its own effects), optional replace (drop the other effects first); or clear: true.
- set_volume_automation: clip (video/audio), points [{t, v}] (t in seconds from the CLIP's start, v the volume 0–${EDIT_LIMITS.maxVolume}; replaces the volume envelope), or clear: true.
- duck_audio: clip (the music), under [clip ids] or underTrack (the speech); optional reduceDb (default 12), attack (0.3 s), release (0.6 s). Writes a volume envelope that dips under the speech and returns after it (replaces the clip's volume envelope).
- set_locked: clips, locked (true/false). A locked clip refuses every other edit; only locks you set can be lifted (a lock the user set cannot).
Transitions: there is no cut-to-cut transition operation. Use fadeIn/fadeOut on overlapping clips for a dissolve of audio, or add a transition block with add_component (browse_presets kind block, query "transition").
User-picked fragments: inspect_project marks a video/audio asset the user picked a fragment of as "USER-PICKED FRAGMENT start–end s" — the AI may use only that part of the file. add_clip starts mediaStart at the fragment and defaults the duration to its end; add_sequence ranges and trim_clip stay inside it; a placement reaching outside it is refused (out_of_bounds) with the picked range in the message. Plan with the fragment's length — a 33.5 s music bed lasts 33.5 s: place it again or fade it out instead of running past its end.`;

const DESCRIPTIONS: Record<EditingToolName, string> = {
  inspect_project: `List the project's compositions (size, length, clip count), media assets (kind, size, duration, whether video has audio; an asset the user picked a fragment of is marked "USER-PICKED FRAGMENT" — only that part of the file may be used) and existing renders. Call it first to learn what material exists before planning an edit. A long asset list is paged: pass query (text in the path), kind, offset and limit to narrow or page through it.`,
  inspect_timeline: `Show a composition's timeline as a table: clip id, kind, label, start–end, track, source, notes (media in-point, speed, volume, muted, opacity, colour grade, audio FX, automation, locked; "(template placeholder — not user content)" marks the new project's untouched placeholder title, which you may remove or replace in a normal edit), plus the composition's size, length and content version. Also reports the user's playhead, selected clips/asset/time range and active composition as they were when the user sent the message (they may have changed since). Read it before editing and again after a batch to verify the result. Defaults to the main composition. A long timeline is paged: pass track, from/to (seconds; clips that overlap the window), offset and limit to see exactly the part you need. ${CONVENTIONS}`,
  edit_timeline: `Change the timeline of a composition with a batch of operations (up to ${EDIT_LIMITS.operations}). The batch is atomic: if any operation is refused, nothing is applied and the error names the failing operation (operations[N]) so you can fix it and retry. Operations run in order; clips they create get ids that are returned in the result (use them in a later call). After edits the Studio timeline and preview update by themselves, and every edit belongs to this turn's checkpoint, so the user can revert it. The batch is checked against the timeline you last read in this turn (or the baseVersion you pass): if the composition changed since, it is refused with a conflict and you inspect_timeline again. Set dryRun: true to validate a risky batch and see what it WOULD change (clips added, removed, moved) without writing anything. Sending the same batch twice does not apply it twice: Studio answers the second with the stored result. The result can carry warnings (for example clips that now overlap on track 0): act on them. ${CONVENTIONS}\n${EDIT_OPERATIONS_GUIDE}`,
  browse_presets: `Search the built-in presets: caption styles ("caption", used by apply_captions and captions_from_transcript), motion-graphics "block"s (graphics, lower thirds and scene transitions: search "transition") and reusable "component"s (both used by add_component), colour looks ("color_grade", used by set_color_grade) and audio effect chains ("audio_fx", used by set_audio_fx). Returns names with a short description and natural length. Optional query filters by text; long lists are paged with offset and limit.`,
  render_video: `Render a composition to an mp4 file in the project's renders folder and wait until it finishes. Returns the project-relative path, length, resolution and size; report the path to the user. Use "draft" quality for a quick check, "standard" (default) or "high" for the final video. Fails if the render fails or is cancelled. A render takes minutes per minute of video: render only when the user asked for a video file, an export or a render (or for a short draft check), not after every edit of a long timeline — offer it instead. For a composition longer than ${LONG_RENDER_SECONDS / 60} minutes the call asks the user on a card in the chat (once or deny) unless they already asked for a render or an export in this turn; if they decline, the call is refused.`,
};

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * `add_clip`. With a voice host (`voice`) it also takes `voiceLine` and `asset` may then be omitted; without one the
 * schema is exactly the plain one, so agents never hear of voiceover.
 */
function addClipSchema(voice: boolean): OperationSchema {
  return operationSchema(
    "add_clip",
    "Place a project asset (video, image or audio) on the timeline.",
    {
      asset: str(
        voice
          ? "Project-relative asset path from inspect_project. Required unless voiceLine is given."
          : "Project-relative asset path from inspect_project.",
        EDIT_LIMITS.pathChars,
      ),
      start: time("Timeline start in seconds."),
      track: track("Track: 0 = A-roll, higher = B-roll/overlay; audio on its own track."),
      duration: {
        type: "number",
        exclusiveMinimum: 0,
        description:
          "Seconds on the timeline; defaults to the rest of the media, or to the end of the user-picked fragment when there is one.",
      },
      mediaStart: time(
        "In-point in the source media, seconds; defaults to the user-picked fragment's start when there is one.",
      ),
      volume,
      muted: { type: "boolean" },
      fit,
      frame,
      fadeIn: fade("start"),
      fadeOut: fade("end"),
      ...(voice && {
        voiceLine: str(
          "The id of a voiceover line made by generate_voiceover: the clip takes the line's file, in-point and length from its selected take (asset may then be omitted), is marked as that line and joins the voiceover audio group.",
          64,
        ),
      }),
    },
    voice ? ["start", "track"] : ["asset", "start", "track"],
  );
}

const OPERATION_SCHEMAS: Record<EditOperationName, OperationSchema> = {
  ...MORE_OPERATION_SCHEMAS,
  add_clip: addClipSchema(false),
  add_sequence: operationSchema(
    "add_sequence",
    "Place many ranges of ONE video/audio source back to back on a track (a rough cut): one clip per range, no gaps.",
    {
      asset: str("Project-relative video or audio asset path.", EDIT_LIMITS.pathChars),
      track: track("Track: 0 = A-roll."),
      start: time("Timeline position of the first range; default 0."),
      ranges: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.sequenceRanges,
        description: "Source in/out points in seconds, played in this order.",
        items: {
          type: "object",
          properties: {
            from: time(
              "In-point in the source, seconds; inside the user-picked fragment when there is one.",
            ),
            to: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: EDIT_LIMITS.maxTime,
              description:
                "Out-point in the source, seconds; after from and inside the user-picked fragment when there is one.",
            },
          },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
      volume,
      muted: { type: "boolean" },
      fit,
      frame,
      edgeFade: {
        type: "number",
        minimum: 0,
        maximum: EDIT_LIMITS.maxEdgeFade,
        description:
          "Short audio gain ramp (seconds) at both edges of every clip, against clicks at cuts; 0.02 is typical.",
      },
    },
    ["asset", "track", "ranges"],
  ),
  add_text: operationSchema(
    "add_text",
    "Add a text/title clip.",
    {
      text: str("The text to show.", EDIT_LIMITS.textChars),
      start: time("Timeline start in seconds."),
      duration: { type: "number", exclusiveMinimum: 0, description: "Seconds on the timeline." },
      track: track("Use a track above the video it overlays."),
      placement: { type: "string", enum: [...TEXT_PLACEMENTS] },
      size: { type: "string", enum: [...TEXT_SIZES] },
      color: str("Hex (#ffffff) or CSS color name.", 40),
    },
    ["text", "start", "duration", "track"],
  ),
  add_component: operationSchema(
    "add_component",
    "Install a block/component from browse_presets and mount it as a clip.",
    {
      name: str("Preset name from browse_presets.", EDIT_LIMITS.idChars),
      start: time("Timeline start in seconds."),
      track: track("Track for the graphic; above the video it overlays."),
      duration: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Seconds; defaults to its natural length.",
      },
    },
    ["name", "start", "track"],
  ),
  apply_captions: operationSchema(
    "apply_captions",
    "Write captions from cues in a caption preset's style, spanning the whole composition.",
    {
      preset: str("Caption preset name from browse_presets.", EDIT_LIMITS.idChars),
      cues: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.captionCues,
        items: {
          type: "object",
          properties: {
            text: str("The words shown.", EDIT_LIMITS.textChars),
            start: time("Cue start, seconds."),
            end: time("Cue end, seconds; after its start."),
          },
          required: ["text", "start", "end"],
          additionalProperties: false,
        },
      },
      track: track("Optional track for the captions."),
    },
    ["preset", "cues"],
  ),
  remove_clip: operationSchema(
    "remove_clip",
    "Remove one clip (clip) or many at once (clips); give exactly one of the two.",
    {
      clip: clipId,
      clips: {
        type: "array",
        maxItems: EDIT_LIMITS.removeClips,
        items: clipId,
        description: "Clip ids to remove, all at once (for example a previous rough cut).",
      },
      ripple: {
        type: "boolean",
        description: "Close the gaps by moving later clips back.",
      },
      rippleScope: {
        type: "string",
        enum: [...RIPPLE_SCOPES],
        description:
          "With ripple: track (default) moves later clips of the clip's track, all moves later clips of every track.",
      },
    },
    [],
  ),
  move_clip: operationSchema(
    "move_clip",
    "Move a clip in time and/or to another track (give at least one of start, track).",
    { clip: clipId, start: time("New timeline start, seconds."), track: track("New track.") },
    ["clip"],
  ),
  trim_clip: operationSchema(
    "trim_clip",
    "Set new timeline in/out points (give at least one of start, end). A clip of a video/audio asset the user picked a fragment of can be trimmed only inside that fragment.",
    {
      clip: clipId,
      start: time("New timeline start, seconds."),
      end: { type: "number", exclusiveMinimum: 0, description: "New timeline end, seconds." },
    },
    ["clip"],
  ),
  split_clip: operationSchema(
    "split_clip",
    "Split a clip in two at a timeline time inside it.",
    {
      clip: clipId,
      at: { type: "number", exclusiveMinimum: 0, description: "Timeline time, seconds." },
    },
    ["clip", "at"],
  ),
  set_clip: operationSchema(
    "set_clip",
    "Change clip properties (give at least one).",
    {
      clip: clipId,
      volume,
      muted: { type: "boolean" },
      fit,
      zIndex: { type: "integer", description: "Stacking order; higher draws on top." },
      frame,
      fadeIn: fade("start"),
      fadeOut: fade("end"),
      opacity: { type: "number", minimum: 0, maximum: 1, description: "0 invisible, 1 opaque." },
    },
    ["clip"],
  ),
  arrange_track: operationSchema(
    "arrange_track",
    "Lay clips end to end on a track in the given order.",
    {
      track: track("The track."),
      clips: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.arrangeClips,
        items: clipId,
        description: "Clip ids in playing order.",
      },
      start: time("Where the first clip starts; default 0."),
      gap: time("Seconds between clips; default 0."),
    },
    ["track", "clips"],
  ),
  set_composition: operationSchema(
    "set_composition",
    "Set the composition length explicitly.",
    { duration: { type: "number", exclusiveMinimum: 0, description: "Seconds." } },
    ["duration"],
  ),
  set_canvas: operationSchema(
    "set_canvas",
    "Set the composition's canvas (frame) size, optionally re-framing the clips already placed (fit).",
    {
      width: canvasSide,
      height: canvasSide,
      fit: {
        type: "string",
        enum: [...CANVAS_FITS],
        description:
          "keep (default): clips keep their frames; contain: scale and centre the old picture inside the new canvas; cover: fill the new canvas, cropping.",
      },
    },
    ["width", "height"],
  ),
};

const compositionProperty = str(
  "Project-relative composition path; defaults to the main composition.",
  EDIT_LIMITS.pathChars,
);

/** The operation only a runtime with a voice host offers. */
const VOICE_OPERATION: EditOperationName = "captions_from_voiceover";

/** The `edit_timeline` arguments, built from the operation schemas it offers. */
function editTimelineParameters(
  schemas: Record<EditOperationName, OperationSchema>,
  voice: boolean,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      composition: compositionProperty,
      baseVersion: str(
        "Optional: a `version` from inspect_timeline to check against. By default the version you last read this turn is used; the batch is refused with a conflict if the composition changed since.",
        200,
      ),
      dryRun: {
        type: "boolean",
        description: "Validate the batch and report what it would change; nothing is written.",
      },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.operations,
        description: "Operations applied in order, atomically.",
        items: {
          anyOf: EDIT_OPERATION_NAMES.filter((name) => voice || name !== VOICE_OPERATION).map(
            (name) => schemas[name],
          ),
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  };
}

/** `edit_timeline` when the runtime has a voice host: `add_clip` also takes `voiceLine`. */
const VOICE_EDIT_TIMELINE_PARAMETERS = editTimelineParameters(
  {
    ...OPERATION_SCHEMAS,
    add_clip: addClipSchema(true),
  },
  true,
);

const PARAMETERS: Record<EditingToolName, Record<string, unknown>> = {
  inspect_project: {
    type: "object",
    properties: {
      query: str("Only assets whose path contains this text.", 200),
      kind: { type: "string", enum: [...ASSET_KINDS], description: "Only assets of this kind." },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Skip this many matching assets (paging).",
      },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Assets per page." },
    },
    additionalProperties: false,
  },
  inspect_timeline: {
    type: "object",
    properties: {
      composition: compositionProperty,
      track: track("Only the clips of this track."),
      from: time("Only clips that end after this time (seconds)."),
      to: time("Only clips that start before this time (seconds)."),
      offset: {
        type: "integer",
        minimum: 0,
        description: "Skip this many matching clips (paging).",
      },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Clips per page." },
    },
    additionalProperties: false,
  },
  edit_timeline: editTimelineParameters(OPERATION_SCHEMAS, false),
  browse_presets: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...PRESET_KINDS],
        description: "caption, block (graphics/transitions), component, color_grade or audio_fx.",
      },
      query: str("Optional text to filter by name, title or tags.", 200),
      offset: { type: "integer", minimum: 0, description: "Skip this many matches (paging)." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Matches per page (default 40).",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  render_video: {
    type: "object",
    properties: {
      composition: compositionProperty,
      quality: { type: "string", enum: [...RENDER_QUALITIES], description: "Default: standard." },
    },
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const OP_SUMMARY: Record<EditOperationName, string> = {
  add_clip: "add clip",
  add_sequence: "add sequence",
  add_text: "add text",
  add_component: "add component",
  apply_captions: "captions",
  remove_clip: "remove",
  move_clip: "move",
  trim_clip: "trim",
  split_clip: "split",
  set_clip: "adjust",
  arrange_track: "arrange",
  set_composition: "set length",
  set_canvas: "set format",
  set_speed: "speed",
  retime_captions: "retime captions",
  captions_from_transcript: "captions from transcript",
  captions_from_voiceover: "captions from voiceover",
  mount_composition: "mount composition",
  set_color_grade: "colour grade",
  set_audio_fx: "audio effects",
  set_volume_automation: "volume envelope",
  duck_audio: "duck",
  set_locked: "lock",
};

const isOperationName = (value: unknown): value is EditOperationName =>
  EDIT_OPERATION_NAMES.some((name) => name === value);

/** "Editing the timeline · 4 changes (add clip ×3, split)"; never throws on malformed arguments. */
function editLabel(args: unknown): string {
  const operations = isRecord(args) && Array.isArray(args.operations) ? args.operations : [];
  if (operations.length === 0) return "Editing the timeline";
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const name = isRecord(operation) && isOperationName(operation.op) ? operation.op : null;
    const label = name ? OP_SUMMARY[name] : "edit";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const groups = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const shown = groups.length > 3 ? [...groups.slice(0, 3), "…"] : groups;
  const noun = operations.length === 1 ? "change" : "changes";
  return `Editing the timeline · ${operations.length} ${noun} (${shown.join(", ")})`;
}

const PRESET_ACTIVITY: Record<PresetKind, ToolActivity> = {
  caption: {
    category: "search",
    label: "Browsing caption presets",
    labelCode: "browsing_presets_caption",
  },
  block: {
    category: "search",
    label: "Browsing block presets",
    labelCode: "browsing_presets_block",
  },
  component: {
    category: "search",
    label: "Browsing component presets",
    labelCode: "browsing_presets_component",
  },
  color_grade: {
    category: "search",
    label: "Browsing colour grade presets",
    labelCode: "browsing_presets_color_grade",
  },
  audio_fx: {
    category: "search",
    label: "Browsing audio effect presets",
    labelCode: "browsing_presets_audio_fx",
  },
};

const ACTIVITIES: Record<EditingToolName, (args: unknown) => ToolActivity> = {
  inspect_project: () => ({
    category: "inspect",
    label: "Inspecting the project",
    labelCode: "inspecting_project",
  }),
  inspect_timeline: () => ({
    category: "inspect",
    label: "Inspecting the timeline",
    labelCode: "inspecting_timeline",
  }),
  edit_timeline: (args) => {
    const count = isRecord(args) && Array.isArray(args.operations) ? args.operations.length : 0;
    return isRecord(args) && args.dryRun === true
      ? {
          category: "inspect",
          label: `Checking a timeline edit · ${count} ${count === 1 ? "change" : "changes"}`,
          labelCode: "checking_timeline_edit",
          labelParams: { count },
        }
      : {
          category: "edit",
          label: editLabel(args),
          labelCode: "editing_timeline",
          labelParams: { count },
        };
  },
  browse_presets: (args) => {
    const kind = isRecord(args)
      ? PRESET_KINDS.find((candidate) => candidate === args.kind)
      : undefined;
    return kind === undefined
      ? { category: "search", label: "Browsing presets", labelCode: "browsing_presets" }
      : PRESET_ACTIVITY[kind];
  },
  render_video: () => ({
    category: "other",
    label: "Rendering video",
    labelCode: "rendering_video",
  }),
};

/** The editing tools of one agent; every call goes to `execute` (the running turn's editing executor). */
export function buildEditingTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  execute: Executor,
  options: { timelineWrites?: boolean; voice?: boolean } = {},
): HostTool[] {
  const voice = options.voice === true;
  return editingToolsFor(agent, enabled, options).map((name) => ({
    name,
    description:
      voice && name === EDITING_TOOL_NAMES.edit
        ? DESCRIPTIONS[name]
            .replace(ADD_CLIP_GUIDE, VOICE_ADD_CLIP_GUIDE)
            .replace(
              CAPTIONS_FROM_TRANSCRIPT_GUIDE,
              `${CAPTIONS_FROM_TRANSCRIPT_GUIDE}\n${VOICE_CAPTIONS_GUIDE}`,
            )
        : DESCRIPTIONS[name],
    parameters:
      voice && name === EDITING_TOOL_NAMES.edit ? VOICE_EDIT_TIMELINE_PARAMETERS : PARAMETERS[name],
    execute: (args, signal, progress) => execute(name, args, signal, progress),
    activity: (args) => ACTIVITIES[name](args),
  }));
}
