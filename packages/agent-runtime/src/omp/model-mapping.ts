import type {
  AgentModelCatalog,
  AgentModelInfo,
  ModelSelection,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { THINKING_EFFORTS } from "@hyperframes/agent-protocol";

export interface ModelCatalogSource extends ModelSelection {
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  supportedEfforts: readonly unknown[];
}

export interface ParsedModelRole {
  model: ModelSelection;
  thinking: ThinkingEffort | null;
}

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  if (typeof value !== "string") return false;
  return THINKING_EFFORTS.some((effort) => effort === value);
}

export function mapSupportedEfforts(efforts: readonly unknown[]): ThinkingEffort[] {
  return efforts.filter(
    (effort): effort is ThinkingEffort => isThinkingEffort(effort) && effort !== "off",
  );
}

export function mapModelInfo(source: ModelCatalogSource): AgentModelInfo {
  return {
    provider: source.provider,
    modelId: source.modelId,
    name: source.name,
    reasoning: source.reasoning,
    efforts: mapSupportedEfforts(source.supportedEfforts),
    ...(typeof source.contextWindow === "number" && Number.isFinite(source.contextWindow)
      ? { contextWindow: source.contextWindow }
      : {}),
  };
}

export function parseModelRole(value: string | undefined): ParsedModelRole | null {
  if (!value) return null;
  const selector = value.trim();
  const slashIndex = selector.indexOf("/");
  if (slashIndex < 1 || slashIndex === selector.length - 1) return null;

  const provider = selector.slice(0, slashIndex).trim();
  let modelId = selector.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;

  let thinking: ThinkingEffort | null = null;
  const suffixIndex = modelId.lastIndexOf(":");
  if (suffixIndex > 0) {
    const suffix = modelId.slice(suffixIndex + 1);
    if (isThinkingEffort(suffix)) {
      thinking = suffix;
      modelId = modelId.slice(0, suffixIndex);
    }
  }

  if (!modelId) return null;
  return { model: { provider, modelId }, thinking };
}

/**
 * Apple's on-device model is listed on every macOS 27 Mac with nothing connected, and its 8K context cannot hold an
 * agent's prompt. Counted as a model, it would stand in for the "connect a model" prompt a new user needs.
 */
const PROVIDERS_NOT_FOR_AGENTS: ReadonlySet<string> = new Set(["apple"]);

export function isAgentProvider(provider: string): boolean {
  return !PROVIDERS_NOT_FOR_AGENTS.has(provider);
}

/**
 * The model to start on for a provider where OMP's own default does not suit a new user. The first turn has to work
 * on the account they just created.
 */
const START_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  // OMP's default is a preview with no free tier, so a free key fails on its first turn. Google's current Flash has
  // one, and it is the model Google's own retirement errors point to.
  google: "gemini-3.8-flash",
};

/** `picked`, or OpenVids' own start model of the same provider when one is set and available. */
export function preferredStartModel<T extends { provider: string; id: string }>(
  picked: T,
  available: readonly T[],
): T {
  const preferredId = START_MODEL_BY_PROVIDER[picked.provider];
  if (preferredId === undefined) return picked;
  return (
    available.find((model) => model.provider === picked.provider && model.id === preferredId) ??
    picked
  );
}

/**
 * `startModel` is what the runtime starts on when the user's OMP config names no usable default, so that the app shows
 * the model a turn will really use. Thinking comes from the role alone.
 */
export function createModelCatalog(
  sources: readonly ModelCatalogSource[],
  defaultRole: string | undefined,
  defaultThinking: ThinkingEffort | null,
  startModel: ModelSelection | null = null,
): AgentModelCatalog {
  const models = sources.map(mapModelInfo);
  const listed = (selection: ModelSelection): boolean =>
    models.some(
      (model) => model.provider === selection.provider && model.modelId === selection.modelId,
    );
  const role = parseModelRole(defaultRole);
  const roleModel = role && listed(role.model) ? role.model : null;

  return {
    models,
    defaultModel: roleModel ?? (startModel && listed(startModel) ? startModel : null),
    defaultThinking: roleModel ? defaultThinking : null,
  };
}

export function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.provider === right.provider &&
    left.modelId === right.modelId
  );
}
