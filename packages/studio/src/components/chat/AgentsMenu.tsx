import { useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal, UsersThree } from "@phosphor-icons/react";
import {
  SPECIALIST_IDS,
  type AgentSettings,
  type ChatSummary,
  type ModelSelection,
  type SpecialistConfig,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { resolveModel, runningTurn, sameModel } from "../../agent/agentSelectors";
import { Trans, useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { Toggle } from "../ui/Toggle";
import { AgentConfigDialog } from "./AgentConfigDialog";
import { AgentMonogram, chatAgentName } from "./AgentMonogram";
import { AGENT_BLURBS } from "./agentLabels";
import {
  ChipCaret,
  ComposerPopover,
  EffortField,
  LOCKED_REASON,
  ModelChoice,
  ModelFieldButton,
  PopoverField,
  PopoverHelp,
  chipClass,
  chipIconClass,
  chipLabelClass,
  linkClass,
  modelFieldLabel,
} from "./composerParts";

type View = { kind: "list" } | { kind: "settings" | "model"; agent: SpecialistId };

const EMPTY: SpecialistConfig = { model: null, thinking: null, allowedModels: [] };

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === right || sameModel(left, right);

/** The specialist's global default as a config, or empty when settings are unknown. */
function globalConfig(settings: AgentSettings | null, id: SpecialistId): SpecialistConfig {
  if (!settings) return EMPTY;
  const { model, thinking, allowedModels } = settings.specialists[id];
  return { model, thinking, allowedModels };
}

function sameConfig(left: SpecialistConfig, right: SpecialistConfig): boolean {
  return (
    sameSelection(left.model, right.model) &&
    left.thinking === right.thinking &&
    left.allowedModels.length === right.allowedModels.length &&
    left.allowedModels.every((model, index) => sameModel(model, right.allowedModels[index] ?? null))
  );
}

const rowClass =
  "grid min-h-row-lg grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md border border-transparent py-1 pr-1 pl-1.5 hover:border-border-subtle hover:bg-surface-1";

/**
 * The Agents · N chip: which specialists Main may hand work to in this chat (switches), each one's model and
 * thinking (its settings view), and the advanced per-chat config (allowed models) behind "More settings…".
 */
export function AgentsMenu({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation();
  const settings = useAgentStore((state) => state.settings);
  const catalog = useAgentStore((state) => state.models);
  const catalogFailed = useAgentStore((state) => state.modelsFailed);
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setEnabledAgents = useAgentStore((state) => state.setEnabledAgents);
  const setAgentOverride = useAgentStore((state) => state.setAgentOverride);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [advanced, setAdvanced] = useState<SpecialistId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const enabled = chat.enabledAgents;
  const count = enabled.length + 1;

  const run = async (action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) setError(result.message);
  };

  const toggle = (id: SpecialistId, next: boolean) =>
    run(() => setEnabledAgents(next ? [...enabled, id] : enabled.filter((known) => known !== id)));

  /** A change to one field: the chat keeps its own config only while it differs from the default. */
  const change = (id: SpecialistId, patch: Partial<SpecialistConfig>) => {
    const global = globalConfig(settings, id);
    const next = { ...(chat.agentOverrides?.[id] ?? global), ...patch };
    return run(() => setAgentOverride(id, sameConfig(next, global) ? null : next));
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setView({ kind: "list" });
      setError(null);
    }
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-chip="agents"
      aria-label={t("chat.agents.chipAria", { count })}
      title={t("chat.agents.chip", { count })}
      className={chipClass}
    >
      <UsersThree size={12} aria-hidden className={chipIconClass} />
      <span className={chipLabelClass}>{t("chat.agents.chip", { count })}</span>
      <ChipCaret />
    </button>
  );

  const agent = view.kind === "list" ? null : view.agent;
  const title = agent
    ? view.kind === "model"
      ? t("chat.agents.modelTitle", { name: chatAgentName(agent) })
      : t("chat.agents.settingsTitle", { name: chatAgentName(agent) })
    : t("chat.agents.title");
  const back = agent
    ? {
        label:
          view.kind === "model"
            ? t("chat.agents.backToSettings", { name: chatAgentName(agent) })
            : t("chat.agents.backToAgents"),
        onBack: () =>
          setView(view.kind === "model" ? { kind: "settings", agent } : { kind: "list" }),
      }
    : undefined;

  let body: ReactNode;
  if (agent) {
    const global = globalConfig(settings, agent);
    const override = chat.agentOverrides?.[agent] ?? null;
    const current = override ?? global;
    const runtimeModel = catalog?.defaultModel ?? null;
    const modelFallback = global.model ?? runtimeModel;
    const ownModel =
      override && !sameSelection(override.model, global.model) ? override.model : null;
    const ownEffort = override && override.thinking !== global.thinking ? override.thinking : null;
    body =
      view.kind === "model" && catalog ? (
        <ModelChoice
          catalog={catalog}
          explicit={ownModel}
          fallback={modelFallback}
          onSelect={(model) => {
            setView({ kind: "settings", agent });
            void change(agent, { model: model ?? global.model });
          }}
        />
      ) : (
        <>
          <PopoverField label={t("chat.field.model")}>
            <ModelFieldButton
              name={t("chat.agents.modelName", { name: chatAgentName(agent) })}
              label={modelFieldLabel(catalog, catalogFailed, ownModel, modelFallback)}
              disabled={locked || pending || !catalog || catalog.models.length === 0}
              onOpen={() => setView({ kind: "model", agent })}
            />
          </PopoverField>
          <EffortField
            model={resolveModel(current.model, catalog, runtimeModel).info}
            value={ownEffort}
            defaultEffort={global.thinking ?? catalog?.defaultThinking ?? null}
            disabled={locked || pending}
            onChange={(effort) => void change(agent, { thinking: effort ?? global.thinking })}
          />
          <PopoverHelp>
            <Trans
              i18nKey="chat.agents.defaultHelp"
              components={{
                action: (
                  <button
                    type="button"
                    className={linkClass}
                    onClick={() => {
                      onOpenChange(false);
                      setAdvanced(agent);
                    }}
                  />
                ),
              }}
            />
          </PopoverHelp>
        </>
      );
  } else {
    body = (
      <div role="group" aria-label={t("chat.agents.available")} className="grid gap-px">
        <div className={rowClass} data-agent="director">
          <AgentMonogram agent="director" />
          <AgentInfo name={chatAgentName("director")} role={t("chat.agents.directorRole")} />
          <span className="col-span-2 col-start-3 justify-self-end pr-1 text-xs whitespace-nowrap text-fg-3">
            {t("chat.agents.alwaysOn")}
          </span>
        </div>
        {SPECIALIST_IDS.map((id) => {
          const on = enabled.includes(id);
          const name = chatAgentName(id);
          return (
            <div key={id} className={rowClass} data-agent={id}>
              <AgentMonogram agent={id} off={!on} />
              <AgentInfo name={name} role={t(AGENT_BLURBS[id])} off={!on} />
              <IconButton
                size="sm"
                aria-label={t("chat.agents.settingsFor", { name })}
                title={t("chat.agents.settingsTooltip", { name })}
                icon={<SlidersHorizontal size={12} aria-hidden />}
                onClick={() => setView({ kind: "settings", agent: id })}
              />
              <Toggle
                label={t("chat.agents.toggle", { name })}
                checked={on}
                disabled={locked || pending}
                onCommit={(next) => void toggle(id, next)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <ComposerPopover
        trigger={trigger}
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        back={back}
      >
        {body}
        {(locked || error) && view.kind !== "model" && (
          <PopoverHelp tone={error ? "error" : "warning"}>{error ?? t(LOCKED_REASON)}</PopoverHelp>
        )}
      </ComposerPopover>
      {advanced && (
        <AgentConfigDialog
          key={advanced}
          agent={advanced}
          chat={chat}
          finalFocus={triggerRef}
          onClose={() => setAdvanced(null)}
        />
      )}
    </>
  );
}

function AgentInfo({ name, role, off = false }: { name: string; role: string; off?: boolean }) {
  return (
    <span className="grid min-w-0 gap-px" title={role}>
      <span
        className={cn(
          "truncate text-sm leading-4 font-medium whitespace-nowrap",
          off ? "text-fg-2" : "text-fg",
        )}
      >
        {name}
      </span>
      <span className="truncate text-xs leading-[14px] whitespace-nowrap text-fg-3">{role}</span>
    </span>
  );
}
