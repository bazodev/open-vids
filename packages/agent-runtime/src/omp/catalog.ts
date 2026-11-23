import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
  clampThinkingLevelForModel,
  getSupportedEfforts,
} from "@oh-my-pi/pi-catalog/model-thinking";
import {
  Settings,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type {
  AgentModelCatalog,
  ModelSelection,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import {
  createModelCatalog,
  isAgentProvider,
  isThinkingEffort,
  parseModelRole,
  preferredStartModel,
  type ModelCatalogSource,
} from "./model-mapping.ts";

export const EMPTY_CATALOG: AgentModelCatalog = {
  models: [],
  defaultThinking: null,
  defaultModel: null,
};

export type RefreshStrategy = NonNullable<Parameters<ModelRegistry["refresh"]>[0]>;

export type OmpModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type UserThinkingSetting = "auto" | Effort;
export type OmpThinking = Effort | "off";

export type CatalogServices = {
  authStorage: AuthStorage;
  registry: ModelRegistry;
  settings: Settings;
  defaultRole: string | undefined;
  defaultThinking: Exclude<ThinkingEffort, "off">;
  catalog: AgentModelCatalog;
  /** When the last refresh (successful or not) started; paces the background refresh. */
  lastRefreshAt: number;
  lastRefreshError: string | null;
  /** When a live refresh last succeeded; null before the first one. */
  syncedAt: number | null;
  /** The OpenVids-stored keys currently applied to `authStorage` as runtime overrides, by provider. */
  appliedKeys: Map<string, string>;
  /**
   * `authStorage` reads OMP's credentials and OpenVids' own sign-ins through a {@link LayeredAuthCredentialStore}.
   * False when it could not be set up (OMP uses an auth broker, an XDG layout, or no OpenVids auth path was given):
   * then OMP's credentials are used exactly as before and in-app sign-in is unavailable.
   */
  layered: boolean;
  /** The user's full-context-windows setting as applied to `settings` (an in-memory override) and the registry. */
  extendedContext: boolean;
  /** The refresh in flight (they run one after another); null when idle. */
  refreshing: Promise<void> | null;
};

export class OmpCatalogUnavailableError extends Error {
  readonly catalog = EMPTY_CATALOG;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OmpCatalogUnavailableError";
  }
}

export function toOmpEffort(effort: Exclude<ThinkingEffort, "off">): Effort {
  switch (effort) {
    case "minimal":
      return Effort.Minimal;
    case "low":
      return Effort.Low;
    case "medium":
      return Effort.Medium;
    case "high":
      return Effort.High;
    case "xhigh":
      return Effort.XHigh;
    case "max":
      return Effort.Max;
  }
}

export function toProtocolEffort(effort: unknown): ThinkingEffort | null {
  return isThinkingEffort(effort) ? effort : null;
}

export function defaultEffort(setting: UserThinkingSetting): Exclude<ThinkingEffort, "off"> {
  if (setting === "auto") return "high";
  const effort = toProtocolEffort(setting);
  return effort && effort !== "off" ? effort : "high";
}

/** Settings of one isolated agent session; nothing is read from or written to the user's OMP config. */
export function createSessionSettings(defaultThinkingLevel: Effort): Settings {
  return Settings.isolated({
    defaultThinkingLevel,
    // A path-based edit form: `{path, old_string, new_string}`. The default hashline/apply_patch
    // forms hide their target files inside free text, which the project-boundary guard cannot check.
    "edit.mode": "replace",
    // `read` fetches web and loopback URLs when this is on, which would bypass the Websites
    // permission and the download prompt; research goes through the runtime's own host tools.
    "fetch.enabled": false,
    // With intent tracing the SDK adds an `i` ("intent") argument to every tool and names it in the system prompt.
    // The runtime labels its own activity rows and never reads it, and models were seen gluing it onto tool names
    // (`i_inspect_timeline`), so a call failed before it ran.
    "tools.intentTracing": false,
  });
}

export function sameOmpModel(left: OmpModel | undefined, right: OmpModel | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.id === right.id
  );
}

export function isAvailableModel(
  registry: ModelRegistry,
  model: OmpModel | undefined,
): model is OmpModel {
  return (
    model !== undefined &&
    isAgentProvider(model.provider) &&
    registry.hasConfiguredAuth(model) &&
    registry.getAvailable().some((available) => sameOmpModel(available, model))
  );
}

export function availableModels(registry: ModelRegistry): OmpModel[] {
  return registry
    .getAvailable()
    .filter((model) => isAgentProvider(model.provider) && registry.hasConfiguredAuth(model));
}

export function resolveRoleDefault(
  registry: ModelRegistry,
  role: string | undefined,
): { model: OmpModel | undefined; thinking: ThinkingEffort | null } {
  const parsed = parseModelRole(role);
  const model = parsed ? registry.find(parsed.model.provider, parsed.model.modelId) : undefined;
  if (!isAvailableModel(registry, model)) return { model: undefined, thinking: null };
  if (!parsed || parsed.thinking === null) return { model, thinking: null };
  if (parsed.thinking === "off") return { model, thinking: "off" };

  const clamped = clampThinkingLevelForModel(model, toOmpEffort(parsed.thinking));
  return { model, thinking: toProtocolEffort(clamped) };
}

export function catalogSources(models: readonly OmpModel[]): ModelCatalogSource[] {
  return models.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? { contextWindow: model.contextWindow }
      : {}),
    supportedEfforts: getSupportedEfforts(model),
  }));
}

/**
 * The model to start on when no default is configured: OMP's default for the connected provider, or OpenVids' own
 * where OMP's does not suit a new user. Never simply the first model listed: that order is the provider's, and its
 * first entry can be a model the provider has already retired.
 */
export function pickStartModel(registry: ModelRegistry): OmpModel | undefined {
  const models = availableModels(registry);
  const picked = pickDefaultAvailableModel(models, (provider) =>
    registry.hasConcreteAuth(provider),
  );
  return picked && preferredStartModel(picked, models);
}

export function chooseBackendModel(
  registry: ModelRegistry,
  catalog: CatalogServices["catalog"],
): OmpModel | undefined {
  if (catalog.defaultModel) {
    const configured = registry.find(catalog.defaultModel.provider, catalog.defaultModel.modelId);
    if (isAvailableModel(registry, configured)) return configured;
  }
  return pickStartModel(registry);
}

export function toModelSelection(model: OmpModel): ModelSelection {
  return { provider: model.provider, modelId: model.id };
}

export function createCatalog(
  registry: ModelRegistry,
  settings: Settings,
): CatalogServices["catalog"] {
  const models = availableModels(registry);
  const defaultRole = settings.getModelRole("default");
  const roleDefault = resolveRoleDefault(registry, defaultRole);
  const start = pickStartModel(registry);
  return createModelCatalog(
    catalogSources(models),
    defaultRole,
    roleDefault.thinking,
    start ? toModelSelection(start) : null,
  );
}
