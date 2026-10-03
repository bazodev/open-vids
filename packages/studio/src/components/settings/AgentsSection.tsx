import {
  SPECIALIST_IDS,
  isThinkingEffort,
  type AgentModelCatalog,
  type ModelConfig,
  type ModelSelection,
  type SpecialistDefaults,
  type ProviderInfo,
  type SpecialistId,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { useEffect, type ReactNode } from "react";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation, type TranslationKey } from "../../i18n";
import { effortChoices, resolveModel } from "../../agent/agentSelectors";
import { AllowedModels } from "../chat/AgentConfigFields";
import { EFFORT_LABELS, type ConfigDefaults } from "../chat/agentLabels";
import { ModelPicker } from "../chat/ModelPicker";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { Tooltip } from "../ui/Tooltip";
import { ProviderFix } from "./ProviderFix";
import { providerIssue } from "./providerStatus";
import {
  SaveStatus,
  SettingsGroup,
  SettingsLink,
  SettingsPage,
  SettingsRow,
  SettingsUnavailable,
} from "./settingsLayout";
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

/** How each agent shows in a row: name, monogram and one line, as short as the prototype's so it fits untruncated. */
const AGENT_TEXT: Record<
  "director" | SpecialistId,
  { name: TranslationKey; mono: TranslationKey; blurb: TranslationKey }
> = {
  director: {
    name: "settings.agent.director.name",
    mono: "settings.agent.director.mono",
    blurb: "settings.agent.director.role",
  },
  editor: {
    name: "settings.agent.editor.name",
    mono: "settings.agent.editor.mono",
    blurb: "settings.agent.editor.role",
  },
  vision: {
    name: "settings.agent.vision.name",
    mono: "settings.agent.vision.mono",
    blurb: "settings.agent.vision.role",
  },
  motion: {
    name: "settings.agent.motion.name",
    mono: "settings.agent.motion.mono",
    blurb: "settings.agent.motion.role",
  },
  research: {
    name: "settings.agent.research.name",
    mono: "settings.agent.research.mono",
    blurb: "settings.studio.ag.blurbResearch",
  },
  audio: {
    name: "settings.agent.audio.name",
    mono: "settings.agent.audio.mono",
    blurb: "settings.agent.audio.role",
  },
};

/** Agent, Model, Thinking effort, On — the prototype's `.st-agents` columns. The last column sizes to its
    content (`auto`, not a fixed toggle width) so the Director's "Always on" text fits while every row's
    right edge still lines up: switches and the header cell stay `justify-self-end`. */
const AGENT_GRID =
  "grid grid-cols-[minmax(0,1fr)_152px_144px_auto] items-center gap-3 px-3 [&:lang(ru)]:grid-cols-[minmax(0,1fr)_184px_192px_auto]";

/** ModelPicker in the prototype's 28 px window-form `.sel` look, caret at the right edge. */
const MODEL_TRIGGER =
  "h-ctl w-full rounded-md bg-bg-0 px-2.5 text-sm text-fg [&>span:first-child]:flex-1 [&>span:first-child]:text-left";

/** The picker of a model whose provider has a problem wears the prototype's warning edge (`.sel.is-warn`). */
const MODEL_TRIGGER_WARN = "border-warning/55";

/** The provider a model runs on, when the runtime lists it. */
function providerOf(
  providers: readonly ProviderInfo[] | null,
  config: ModelConfig,
  catalog: AgentModelCatalog | null,
  fallback: ModelSelection | null,
): ProviderInfo | undefined {
  const selection = resolveModel(config.model, catalog, fallback).selection;
  return providers?.find((provider) => provider.id === selection?.provider);
}

/** A model change drops a thinking effort the new model cannot take, as the chat header does. */
function withModel<T extends ModelConfig>(
  config: T,
  model: ModelSelection | null,
  catalog: AgentModelCatalog | null,
  fallback: ModelSelection | null,
): T {
  const next = resolveModel(model, catalog, fallback).info;
  const effort = config.thinking;
  const drop = next && effort && effort !== "off" && !next.efforts.includes(effort);
  return { ...config, model, thinking: drop ? null : effort };
}

function EffortSelect({
  name,
  config,
  catalog,
  defaults,
  onChange,
}: {
  name: string;
  config: ModelConfig;
  catalog: AgentModelCatalog | null;
  defaults: ConfigDefaults;
  onChange: (thinking: ModelConfig["thinking"]) => void;
}) {
  const { t } = useTranslation();
  const { info } = resolveModel(config.model, catalog, defaults.model);
  const efforts = effortChoices(info);
  const options = [
    {
      value: "default",
      label: defaults.thinking
        ? t("chat.effort.defaultWith", { effort: t(EFFORT_LABELS[defaults.thinking]) })
        : t("settings.agents.effort.default"),
    },
    ...efforts.map((effort) => ({ value: effort, label: t(EFFORT_LABELS[effort]) })),
  ];
  if (config.thinking && !efforts.includes(config.thinking)) {
    options.push({ value: config.thinking, label: t(EFFORT_LABELS[config.thinking]) });
  }
  return (
    <Select
      size="md"
      label={t("settings.agents.effortAria", { agent: name })}
      className="w-full min-w-0"
      disabled={efforts.length === 0}
      value={config.thinking ?? "default"}
      options={
        efforts.length === 0
          ? [{ value: "default", label: t("settings.studio.ag.notAdjustable") }]
          : options
      }
      onCommit={(next) => onChange(isThinkingEffort(next) ? next : null)}
    />
  );
}

function AgentCell({
  name,
  mono,
  blurb,
  off,
}: {
  name: string;
  mono: string;
  blurb: string;
  off?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          "inline-flex size-ctl-xs flex-none select-none items-center justify-center rounded-xs border border-border font-mono text-2xs font-semibold uppercase leading-none",
          off ? "bg-transparent text-fg-3" : "bg-surface-2 text-fg-2",
        )}
      >
        {mono}
      </span>
      <div className="grid min-w-0 gap-px">
        <span className={cn("text-base font-medium leading-4", off ? "text-fg-2" : "text-fg")}>
          {name}
        </span>
        <span className="truncate text-xs leading-[14px] text-fg-3" title={blurb}>
          {blurb}
        </span>
      </div>
    </div>
  );
}

/** A model picker with, under it, what is wrong with the provider that model runs on and a Fix link. */
function ModelCell({
  provider,
  children,
}: {
  provider: ProviderInfo | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-[3px]">
      {children}
      <ProviderFix provider={provider} />
    </div>
  );
}

function SpecialistRow({
  id,
  value,
  catalog,
  catalogFailed,
  defaults,
  provider,
  onCommit,
}: {
  id: SpecialistId;
  value: SpecialistDefaults;
  catalog: AgentModelCatalog | null;
  catalogFailed: boolean;
  defaults: ConfigDefaults;
  provider: ProviderInfo | undefined;
  onCommit: (next: SpecialistDefaults) => void;
}) {
  const { t } = useTranslation();
  const name = t(AGENT_TEXT[id].name);
  return (
    <div className={cn(AGENT_GRID, "min-h-row-lg py-row-pad")} data-agent-row={id}>
      <AgentCell
        name={name}
        mono={t(AGENT_TEXT[id].mono)}
        blurb={t(AGENT_TEXT[id].blurb)}
        off={!value.enabledByDefault}
      />
      <ModelCell provider={provider}>
        <ModelPicker
          name={t("settings.agents.modelAria", { agent: name })}
          catalog={catalog}
          catalogFailed={catalogFailed}
          explicit={value.model}
          fallback={defaults.model}
          disabled={false}
          className={cn(MODEL_TRIGGER, provider && providerIssue(provider) && MODEL_TRIGGER_WARN)}
          onSelect={(model) => onCommit(withModel(value, model, catalog, defaults.model))}
        />
      </ModelCell>
      <EffortSelect
        name={name}
        config={value}
        catalog={catalog}
        defaults={defaults}
        onChange={(thinking) => onCommit({ ...value, thinking })}
      />
      <Toggle
        label={t("settings.studio.ag.onNew", { agent: name })}
        checked={value.enabledByDefault}
        className="justify-self-end"
        onCommit={(enabledByDefault) => onCommit({ ...value, enabledByDefault })}
      />
    </div>
  );
}

/** What the Director and each specialist run in new chats, and whether a specialist starts enabled. */
export function AgentsSection() {
  const { t } = useTranslation();
  const directorName = t(AGENT_TEXT.director.name);
  const editor = useAgentSettingsEditor();
  const { settings, catalog, catalogFailed, runtimeDefaults, commit } = editor;
  const providers = useAgentStore((state) => state.providers);
  const loadProviders = useAgentStore((state) => state.loadProviders);
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);
  const providerList = providers?.status === "ready" ? providers.value : null;

  if (!settings) {
    return (
      <SettingsPage title={t("settings.section.agents")}>
        <SettingsUnavailable
          message={
            editor.settingsFailed
              ? t("settings.studio.ag.unavailable")
              : t("settings.studio.ag.loading")
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const commitSpecialist = (id: SpecialistId, next: SpecialistDefaults) => {
    const specialists: NonNullable<UpdateAgentSettingsRequest["specialists"]> = {};
    specialists[id] = next;
    commit({ specialists });
  };
  const director = settings.director;
  // The defaults of a user who never changed them: every model and effort on Default, every specialist on.
  const resettable =
    director.model !== null ||
    director.thinking !== null ||
    SPECIALIST_IDS.some((id) => {
      const value = settings.specialists[id];
      return value.model !== null || value.thinking !== null || !value.enabledByDefault;
    });
  const resetAll = () => {
    const specialists: NonNullable<UpdateAgentSettingsRequest["specialists"]> = {};
    for (const id of SPECIALIST_IDS) {
      specialists[id] = {
        ...settings.specialists[id],
        model: null,
        thinking: null,
        enabledByDefault: true,
      };
    }
    commit({ director: { model: null, thinking: null }, specialists });
  };
  const directorProvider = providerOf(providerList, director, catalog, runtimeDefaults.model);

  return (
    <SettingsPage
      title={t("settings.section.agents")}
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup
        label={t("settings.agents.group.defaults")}
        action={
          <SettingsLink disabled={!resettable} onClick={resetAll}>
            {t("settings.agents.reset")}
          </SettingsLink>
        }
        footer={t("settings.agents.foot")}
      >
        <div
          aria-hidden
          className={cn(
            AGENT_GRID,
            "h-list-head rounded-t-md bg-bg-0 text-xs text-fg-3 [&>:last-child]:justify-self-end",
          )}
        >
          <span>{t("settings.agents.col.agent")}</span>
          <span>{t("settings.agents.col.model")}</span>
          <span>{t("settings.agents.col.effort")}</span>
          <span>{t("settings.agents.col.on")}</span>
        </div>
        <div className={cn(AGENT_GRID, "min-h-row-lg py-row-pad")} data-agent-row="director">
          <AgentCell
            name={directorName}
            mono={t(AGENT_TEXT.director.mono)}
            blurb={t(AGENT_TEXT.director.blurb)}
          />
          <ModelCell provider={directorProvider}>
            <ModelPicker
              name={t("settings.agents.modelAria", { agent: directorName })}
              catalog={catalog}
              catalogFailed={catalogFailed}
              explicit={director.model}
              fallback={runtimeDefaults.model}
              disabled={false}
              className={cn(
                MODEL_TRIGGER,
                directorProvider && providerIssue(directorProvider) && MODEL_TRIGGER_WARN,
              )}
              onSelect={(model) => {
                const next = withModel(director, model, catalog, runtimeDefaults.model);
                commit({ director: { model: next.model, thinking: next.thinking } });
              }}
            />
          </ModelCell>
          <EffortSelect
            name={directorName}
            config={director}
            catalog={catalog}
            defaults={runtimeDefaults}
            onChange={(thinking) => commit({ director: { model: director.model, thinking } })}
          />
          <Tooltip label={t("settings.studio.ag.alwaysOnTip")} side="left">
            <span
              className="justify-self-end text-xs whitespace-nowrap text-fg-3"
              data-testid="director-always-on"
            >
              {t("settings.studio.ag.alwaysOn")}
            </span>
          </Tooltip>
        </div>
        {SPECIALIST_IDS.map((id) => (
          <SpecialistRow
            key={id}
            id={id}
            value={settings.specialists[id]}
            catalog={catalog}
            catalogFailed={catalogFailed}
            defaults={runtimeDefaults}
            provider={providerOf(
              providerList,
              settings.specialists[id],
              catalog,
              runtimeDefaults.model,
            )}
            onCommit={(next) => commitSpecialist(id, next)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        label={t("settings.studio.ag.mayUse")}
        note={t("settings.studio.ag.mayUseNote")}
        footer={t("settings.studio.ag.mayUseFoot")}
      >
        {SPECIALIST_IDS.map((id) => {
          const value = settings.specialists[id];
          const name = t(AGENT_TEXT[id].name);
          return (
            <SettingsRow
              key={id}
              label={name}
              hint={
                value.allowedModels.length === 0
                  ? t("settings.studio.ag.noneAllowed", { agent: name })
                  : t("settings.studio.ag.someAllowed", { agent: name })
              }
            >
              <AllowedModels
                bare
                name={name}
                value={value.allowedModels}
                catalog={catalog}
                disabled={false}
                onChange={(allowedModels) => commitSpecialist(id, { ...value, allowedModels })}
              />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </SettingsPage>
  );
}
