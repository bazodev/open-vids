import { useEffect, type KeyboardEvent, type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  CircleHalf,
  Gauge,
  ImageSquare,
  Lightning,
  Plug,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useStore } from "zustand";
import { AgentStoreProvider } from "../../agent/agentContext";
import { useTranslation, type TranslationKey } from "../../i18n";
import type { AgentStore } from "../../agent/agentStore";
import { AssetSearchPolicyView } from "../../research/AssetSearchPolicyView";
import { cn } from "../ui/cn";
import { Pill } from "../ui/Status";
import { StudioGear } from "../ui/StudioGear";
import { AgentsSection } from "./AgentsSection";
import { AppearanceSection } from "./AppearanceSection";
import { ExecutionSection } from "./ExecutionSection";
import { GeneralSection } from "./GeneralSection";
import { JevSection } from "./JevSection";
import { providerIssueCount } from "./providerStatus";
import { ProvidersSection } from "./ProvidersSection";
import { SettingsPage, SettingsUnavailable } from "./settingsLayout";
import { SETTINGS_SECTIONS, useSettingsDialog, type SettingsSection } from "./settingsStore";
import "./settings.css";

const SECTION_META: Record<
  SettingsSection,
  { group: TranslationKey; label: TranslationKey; icon: ReactNode }
> = {
  general: {
    group: "settings.nav.group.app",
    label: "settings.section.general",
    icon: <StudioGear />,
  },
  appearance: {
    group: "settings.nav.group.app",
    label: "settings.section.appearance",
    icon: <CircleHalf />,
  },
  agents: {
    group: "settings.nav.group.ai",
    label: "settings.section.agents",
    icon: <UsersThree />,
  },
  providers: {
    group: "settings.nav.group.ai",
    label: "settings.section.providers",
    icon: <Plug />,
  },
  jev: { group: "settings.nav.group.ai", label: "settings.section.jev", icon: <Lightning /> },
  assets: {
    group: "settings.nav.group.workflow",
    label: "settings.section.assets",
    icon: <ImageSquare />,
  },
  execution: {
    group: "settings.nav.group.workflow",
    label: "settings.section.execution",
    icon: <Gauge />,
  },
};

/** How many providers need the user (a failed check, an expired sign-in); nothing while that is unknown. */
function IssueBadge({ store }: { store: AgentStore }) {
  const { t } = useTranslation();
  const providers = useStore(store, (state) => state.providers);
  const count = providers?.status === "ready" ? providerIssueCount(providers.value) : 0;
  if (count === 0) return null;
  return (
    <Pill tone="warning" aria-label={t("settings.nav.needAttention", { count })}>
      {count}
    </Pill>
  );
}

function SettingsNav({
  section,
  agentStore,
  onSelect,
}: {
  section: SettingsSection;
  agentStore: AgentStore | null;
  onSelect: (section: SettingsSection) => void;
}) {
  const { t } = useTranslation();
  // Up and Down walk the sections, as in the prototype; Tab leaves the list.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = SETTINGS_SECTIONS.indexOf(section);
    const step = event.key === "ArrowDown" ? 1 : SETTINGS_SECTIONS.length - 1;
    const next = SETTINGS_SECTIONS[(index + step) % SETTINGS_SECTIONS.length];
    onSelect(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
  };

  return (
    <nav
      aria-label={t("settings.nav.label")}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-px overflow-y-auto border-r border-border-subtle bg-bg-1 p-2"
    >
      {SETTINGS_SECTIONS.map((id, index) => {
        const meta = SECTION_META[id];
        const first =
          index === 0 || SECTION_META[SETTINGS_SECTIONS[index - 1]].group !== meta.group;
        const current = id === section;
        return (
          <div key={id} className="contents">
            {first && (
              <div
                className={cn(
                  "px-2 pb-1 text-xs font-semibold leading-[14px] text-fg-3",
                  index === 0 ? "pt-1" : "pt-3",
                )}
              >
                {t(meta.group)}
              </div>
            )}
            <button
              type="button"
              data-section={id}
              aria-current={current || undefined}
              onClick={() => onSelect(id)}
              className={cn(
                "flex h-nav w-full flex-none items-center gap-2 rounded-md px-2 text-left text-sm",
                "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
                "[&_svg]:size-icon-md [&_svg]:flex-none",
                current
                  ? "bg-surface-3 text-fg [&_svg]:text-fg"
                  : "text-fg-2 hover:bg-surface-1 hover:text-fg [&_svg]:text-fg-3",
              )}
            >
              {meta.icon}
              <span className="min-w-0 flex-1 truncate">{t(meta.label)}</span>
              {id === "providers" && agentStore && <IssueBadge store={agentStore} />}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function AgentSettingsGate({ store, children }: { store: AgentStore | null; children: ReactNode }) {
  const { t } = useTranslation();
  if (!store) return <SettingsUnavailable message={t("settings.studio.connecting")} />;
  return <AgentStoreProvider store={store}>{children}</AgentStoreProvider>;
}

function SectionBody({
  section,
  agentStore,
}: {
  section: SettingsSection;
  agentStore: AgentStore | null;
}) {
  const { t } = useTranslation();
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "appearance":
      return <AppearanceSection />;
    case "agents":
      return (
        <AgentSettingsGate store={agentStore}>
          <AgentsSection />
        </AgentSettingsGate>
      );
    case "providers":
      return (
        <AgentSettingsGate store={agentStore}>
          <ProvidersSection />
        </AgentSettingsGate>
      );
    case "jev":
      return (
        <AgentSettingsGate store={agentStore}>
          <JevSection />
        </AgentSettingsGate>
      );
    case "assets":
      return (
        <SettingsPage title={t("settings.section.assets")} lede={t("settings.studio.assetsLede")}>
          <AssetSearchPolicyView variant="settings" className="mt-5 p-0" />
        </SettingsPage>
      );
    case "execution":
      return (
        <AgentSettingsGate store={agentStore}>
          <ExecutionSection />
        </AgentSettingsGate>
      );
  }
}

/**
 * The Settings window (prototype openvids-settings.html, embedded): a category sidebar and one section at a time.
 * Opened from anywhere with `openSettings(section?)`. Agent sections read and write the global agent settings
 * through the open project's agent store; General and Appearance edit the app preferences file.
 */
export function SettingsDialog({ agentStore }: { agentStore: AgentStore | null }) {
  const { t } = useTranslation();
  const open = useSettingsDialog((state) => state.open);
  const section = useSettingsDialog((state) => state.section);
  const returnFocus = useSettingsDialog((state) => state.returnFocus);
  const setSection = useSettingsDialog((state) => state.setSection);
  const close = useSettingsDialog((state) => state.close);
  const label = t(SECTION_META[section].label);

  // The sidebar's issue badge needs the provider list before Models & Providers is ever opened.
  useEffect(() => {
    if (open) void agentStore?.getState().loadProviders();
  }, [open, agentStore]);

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-100 bg-scrim transition-opacity duration-open data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup
          // Focus the section content on open (prototype `.st-main tabindex=-1`), so no control starts ringed.
          initialFocus={() =>
            document.querySelector<HTMLElement>(
              '[data-testid="settings-dialog"] [data-settings-section]',
            ) ?? true
          }
          finalFocus={() => returnFocus ?? true}
          data-testid="settings-dialog"
          className={cn(
            "fixed left-1/2 top-1/2 z-100 grid -translate-x-1/2 -translate-y-1/2 grid-rows-[44px_minmax(0,1fr)] overflow-hidden",
            "h-[min(640px,calc(100vh-48px))] w-[min(900px,calc(100vw-48px))]",
            "rounded-window bg-bg-0 text-sm text-fg shadow-pop outline-hidden ring-1 ring-inset ring-edge-hi",
            "transition-[opacity,scale] duration-open ease-out-quint data-[ending-style]:duration-close data-[ending-style]:ease-in",
            "data-[starting-style]:[opacity:var(--popup-enter-opacity)] data-[starting-style]:[scale:var(--popup-enter-scale)] data-[ending-style]:opacity-0",
          )}
        >
          <header className="group/tl relative flex select-none items-center border-b border-border-subtle bg-bg-1 px-5">
            <div className="flex items-center gap-2">
              <BaseDialog.Close
                aria-label={t("settings.window.close")}
                className="grid size-3 place-items-center rounded-full bg-error p-0 text-accent-ink outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <X
                  aria-hidden
                  weight="bold"
                  className="size-2 opacity-0 group-hover/tl:opacity-100 group-focus-within/tl:opacity-100"
                />
              </BaseDialog.Close>
              <span aria-hidden className="size-3 rounded-full bg-surface-3" />
              <span aria-hidden className="size-3 rounded-full bg-surface-3" />
            </div>
            <BaseDialog.Title className="pointer-events-none absolute left-1/2 m-0 -translate-x-1/2 text-md font-semibold text-fg">
              <span aria-hidden>{label}</span>
              <span className="sr-only">{t("settings.studio.titleSr", { section: label })}</span>
            </BaseDialog.Title>
          </header>
          <div className="grid min-h-0 grid-cols-[196px_minmax(0,1fr)]">
            <SettingsNav section={section} agentStore={agentStore} onSelect={setSection} />
            <main
              key={section}
              tabIndex={-1}
              data-settings-section={section}
              className="min-h-0 overflow-y-auto overflow-x-hidden px-6 pb-8 pt-5 outline-hidden"
            >
              <SectionBody section={section} agentStore={agentStore} />
            </main>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
