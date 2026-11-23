import type { ThinkingConfig, ThinkingLevel } from "@google/genai";

/**
 * What short image descriptions run on, on the Gemini API and on Vertex AI alike: Google's current Flash-Lite, the
 * upgrade it names for the retired models these defaults used to point at.
 */
export const GEMINI_VISION_MODEL = "gemini-3.5-flash-lite";

/** Vertex serves {@link GEMINI_VISION_MODEL} from `global` and multi-regions, not from single regions like us-central1. */
export const VERTEX_VISION_LOCATION = "global";

/** The models whose lowest thinking level is `minimal` (Google's thinking-levels table); the others start at `low`. */
const HAS_MINIMAL_THINKING = /^gemini-(3-flash|3\.1-flash-lite|3\.5-flash-lite|3\.6-flash)/;

/**
 * The least thinking `model` accepts, for a request that only describes a picture. Thinking tokens are drawn from
 * `maxOutputTokens`, so a model left free to think can spend the whole budget and answer with empty text. A level the
 * model does not list is a request error, and Gemini 2 takes a budget instead; a non-Gemini override gets no setting.
 */
export function leastThinking(
  model: string,
  levels: typeof ThinkingLevel,
): ThinkingConfig | undefined {
  const id = model.slice(model.lastIndexOf("/") + 1);
  if (!id.startsWith("gemini-")) return undefined;
  if (id.startsWith("gemini-2.")) return { thinkingBudget: 0 };
  return { thinkingLevel: HAS_MINIMAL_THINKING.test(id) ? levels.MINIMAL : levels.LOW };
}
