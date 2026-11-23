import {
  COLOR_ADJUST_KEYS,
  EDIT_LIMITS,
  RIPPLE_SCOPES,
  type EditOperationName,
} from "@hyperframes/agent-protocol";
import { clipId, operationSchema, str, time, track, type OperationSchema } from "./schemaParts.js";

const rippleScope = {
  type: "string",
  enum: [...RIPPLE_SCOPES],
  description:
    "track (default): later clips on the clip's own track; all: later clips on every track.",
};

const adjustProperties = Object.fromEntries(
  COLOR_ADJUST_KEYS.map((key) => {
    const limit = key === "exposure" ? 2 : 1;
    return [key, { type: "number", minimum: -limit, maximum: limit }];
  }),
);

/** The operations added after the first set; merged into the `edit_timeline` schema. */
export const MORE_OPERATION_SCHEMAS = {
  set_speed: operationSchema(
    "set_speed",
    "Change a video/audio clip's playback speed. By default the clip keeps the same stretch of source (2 → half as long).",
    {
      clip: clipId,
      rate: {
        type: "number",
        minimum: EDIT_LIMITS.minRate,
        maximum: EDIT_LIMITS.maxRate,
        description: "1 = normal, 2 = twice as fast, 0.5 = half speed.",
      },
      keepDuration: {
        type: "boolean",
        description: "Keep the timeline length; the clip then plays more or less of the source.",
      },
      ripple: { type: "boolean", description: "Move later clips by the length difference." },
      rippleScope,
    },
    ["clip", "rate"],
  ),
  retime_captions: operationSchema(
    "retime_captions",
    "Shift and/or stretch the cues of the composition's existing captions (give shift and/or scale).",
    {
      shift: {
        type: "number",
        description: "Seconds to add to every affected cue; may be negative.",
      },
      scale: {
        type: "number",
        minimum: 0.1,
        maximum: 10,
        description: "Stretch factor around from (default 0).",
      },
      from: time("Only cues starting at or after this time are affected."),
      to: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Only cues starting before this time.",
      },
    },
    [],
  ),
  captions_from_transcript: operationSchema(
    "captions_from_transcript",
    "Write the composition's captions from the cached transcripts of the clips on the timeline.",
    {
      preset: str("Caption preset name from browse_presets.", EDIT_LIMITS.idChars),
      track: track("Optional track for the captions."),
      clips: {
        type: "array",
        maxItems: 200,
        items: clipId,
        description:
          "Caption only these clips (default: every video/audio clip with a transcript).",
      },
      maxWords: {
        type: "integer",
        minimum: 1,
        maximum: 12,
        description: "Longest cue, in words (default 6).",
      },
    },
    ["preset"],
  ),
  captions_from_voiceover: operationSchema(
    "captions_from_voiceover",
    "Write the composition's captions from the voiceover clips on the timeline (clips placed with add_clip voiceLine): each line's own text timed by the words of its take.",
    {
      preset: str(
        "Caption preset name from browse_presets (default: the first one).",
        EDIT_LIMITS.idChars,
      ),
      track: track("Optional track for the captions."),
      lines: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 64 },
        description: "Caption only the clips that speak these voiceover line ids (default: all).",
      },
    },
    [],
  ),
  mount_composition: operationSchema(
    "mount_composition",
    "Mount an existing composition file of the project as a clip.",
    {
      composition: str("Project-relative .html composition file.", EDIT_LIMITS.pathChars),
      start: time("Timeline start in seconds."),
      track: track("Track for the clip; a free track near it is used if it is taken."),
      duration: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Seconds; default: the composition's own length.",
      },
    },
    ["composition", "start", "track"],
  ),
  set_color_grade: operationSchema(
    "set_color_grade",
    "Colour-grade a video/image clip: a preset and/or tonal adjustments, or clear the grade.",
    {
      clip: clipId,
      preset: str("Preset name from browse_presets kind color_grade.", 80),
      intensity: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How strongly the look applies.",
      },
      adjust: {
        type: "object",
        description: "Tonal adjustments, 0 = unchanged (exposure ±2, the others ±1).",
        properties: adjustProperties,
        additionalProperties: false,
      },
      clear: { type: "boolean", description: "Remove the clip's colour grade." },
    },
    ["clip"],
  ),
  set_audio_fx: operationSchema(
    "set_audio_fx",
    "Apply an audio effect preset to a video/audio clip, or clear its effects (give exactly one of preset, clear).",
    {
      clip: clipId,
      preset: str("Preset name from browse_presets kind audio_fx.", 80),
      replace: { type: "boolean", description: "Drop the clip's other effects first." },
      clear: { type: "boolean", description: "Remove the clip's audio effects." },
    },
    ["clip"],
  ),
  set_volume_automation: operationSchema(
    "set_volume_automation",
    "Set a video/audio clip's volume envelope (give exactly one of points, clear).",
    {
      clip: clipId,
      points: {
        type: "array",
        maxItems: EDIT_LIMITS.automationPoints,
        description: "Breakpoints; the volume moves in straight lines between them.",
        items: {
          type: "object",
          properties: {
            t: time("Seconds from the CLIP's start."),
            v: {
              type: "number",
              minimum: 0,
              maximum: EDIT_LIMITS.maxVolume,
              description: "Volume at t (1 = source level).",
            },
          },
          required: ["t", "v"],
          additionalProperties: false,
        },
      },
      clear: { type: "boolean", description: "Remove the volume envelope." },
    },
    ["clip"],
  ),
  duck_audio: operationSchema(
    "duck_audio",
    "Lower a (music) clip's volume while other clips play over it (give exactly one of under, underTrack).",
    {
      clip: clipId,
      under: {
        type: "array",
        maxItems: EDIT_LIMITS.duckClips,
        items: clipId,
        description: "The clips that speak (their start–end spans are ducked under).",
      },
      underTrack: track("Duck under every clip of this track."),
      reduceDb: {
        type: "number",
        minimum: 1,
        maximum: EDIT_LIMITS.maxDuckDb,
        description: "How far the music drops, in dB (default 12).",
      },
      attack: {
        type: "number",
        minimum: 0,
        maximum: 10,
        description: "Seconds of ramp down before the speech (default 0.3).",
      },
      release: {
        type: "number",
        minimum: 0,
        maximum: 10,
        description: "Seconds of ramp up after the speech (default 0.6).",
      },
    },
    ["clip"],
  ),
  set_locked: operationSchema(
    "set_locked",
    "Lock or unlock clips: a locked clip refuses every other edit.",
    {
      clips: {
        type: "array",
        minItems: 1,
        maxItems: EDIT_LIMITS.lockClips,
        items: clipId,
      },
      locked: { type: "boolean" },
    },
    ["clips", "locked"],
  ),
} satisfies Partial<Record<EditOperationName, OperationSchema>>;
