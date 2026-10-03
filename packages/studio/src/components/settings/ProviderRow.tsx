import { useId, useState, type ReactNode } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { AgentModelInfo, AgentId, ProviderInfo } from "@hyperframes/agent-protocol";
import { Trans, t, useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { fieldBase, fieldSizes, fieldText } from "../ui/Input";
import { Badge, Spinner, StatusDot, type StatusDotTone, type StatusTone } from "../ui/Status";
import {
  SignInProgress,
  SignInStart,
  signInBusyLabel,
  signInFlows,
  type ProviderSignInControls,
} from "./ProviderSignIn";
import { SettingsLink } from "./settingsLayout";
import { agentName, modelKey } from "./providerStatus";
import { platformKey } from "../../utils/platform";
import { isRunningLogin } from "./useOAuthSignIns";

/** What the row says about a provider, from the status the runtime reported. */
interface RowLook {
  dot: StatusDotTone;
  tone: StatusTone;
  badge: string;
  sub: string;
}

/** Models listed before "Show all N models": the ones agents use always show, then the rest up to this many. */
const MODELS_SHOWN = 8;

function describe(provider: ProviderInfo): RowLook {
  switch (provider.status) {
    case "connected": {
      const via = provider.keyless
        ? t("settings.studio.pv.viaLocal")
        : provider.credentialSource === "api-key"
          ? t("settings.studio.pv.viaKey")
          : provider.credentialSource === "oauth"
            ? t("settings.studio.pv.viaOauth")
            : t("settings.providers.via.omp");
      return {
        dot: "ok",
        tone: "success",
        badge: t("settings.providers.badge.connected"),
        sub: t("settings.providers.sub.connected", { via, count: provider.modelCount }),
      };
    }
    case "signin_required":
      return {
        dot: "warn",
        tone: "warning",
        badge: t("settings.providers.badge.signinRequired"),
        sub: provider.error ?? t("settings.studio.pv.signinExpired"),
      };
    case "error":
      return {
        dot: "error",
        tone: "error",
        badge: t("settings.providers.badge.error"),
        sub: provider.error ?? t("settings.studio.pv.checkFailed"),
      };
    case "not_configured":
      return {
        dot: "off",
        tone: "neutral",
        badge: t("settings.providers.badge.notConfigured"),
        sub: provider.oauth ? t("settings.studio.pv.signinOrKey") : t("settings.studio.pv.addKey"),
      };
  }
}

function KeyForm({
  provider,
  replace,
  note,
  onSave,
}: {
  provider: ProviderInfo;
  /** Whether the key replaces a saved one (the field is then named "Replace API key"). */
  replace: boolean;
  note: ReactNode;
  /** Resolves to the failure message, or null when the key was saved. */
  onSave: (apiKey: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  const ownKeyLabel = replace;
  const label = replace
    ? t("settings.providers.key.replace")
    : t("settings.providers.key.placeholder");

  const submit = async () => {
    const trimmed = key.trim();
    if (!trimmed) return setError(t("settings.key.error.empty"));
    if (/\s/.test(trimmed)) return setError(t("settings.studio.key.spaces"));
    setError(null);
    setSaving(true);
    const failure = await onSave(trimmed);
    setSaving(false);
    // The key leaves this component once it is saved; a refused one stays for another try.
    if (failure === null) setKey("");
    else setError(failure);
  };

  return (
    <div className="grid gap-1.5">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div
          className={cn(fieldBase, fieldSizes.md, "flex-1")}
          aria-invalid={error ? true : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={label}
            aria-label={
              ownKeyLabel
                ? t("settings.providers.key.replaceAria", { provider: provider.name })
                : t("settings.providers.key.aria", { provider: provider.name })
            }
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={saving}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              if (error) setError(null);
            }}
            className={cn(fieldText, "font-mono")}
          />
        </div>
        <Button type="submit" disabled={saving}>
          {t("settings.providers.connect")}
        </Button>
      </form>
      {error && (
        <p id={errorId} role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      )}
      <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">{note}</p>
    </div>
  );
}

/** A model of a connected provider and who runs it: the prototype's `.st-models` row. */
function ProviderModels({
  provider,
  models,
  users,
}: {
  provider: ProviderInfo;
  models: readonly AgentModelInfo[] | null;
  users: ReadonlyMap<string, AgentId[]>;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  if (!models) {
    return <p className="m-0 text-xs text-fg-3">{t("settings.studio.pv.modelsUnavailable")}</p>;
  }
  if (models.length === 0) {
    return <p className="m-0 text-xs text-fg-3">{t("settings.studio.pv.noModels")}</p>;
  }
  const byName = (a: AgentModelInfo, b: AgentModelInfo) => a.name.localeCompare(b.name);
  const used = models.filter((model) => users.has(modelKey(model))).sort(byName);
  const unused = models.filter((model) => !users.has(modelKey(model))).sort(byName);
  const shown = all
    ? [...used, ...unused]
    : [...used, ...unused.slice(0, Math.max(0, MODELS_SHOWN - used.length))];
  return (
    <div className="grid gap-1">
      <dl
        aria-label={t("settings.studio.pv.modelsAria", { provider: provider.name })}
        className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t border-dashed border-border-subtle py-1 text-sm"
      >
        {shown.map((model) => {
          const who = users.get(modelKey(model));
          return (
            <div key={modelKey(model)} className="contents">
              <dt className="truncate py-1 font-mono text-num text-fg" title={model.name}>
                {model.name}
              </dt>
              <dd className="m-0 py-1 text-right text-xs text-fg-3">
                {who ? who.map(agentName).join(", ") : t("settings.providers.models.notUsed")}
              </dd>
            </div>
          );
        })}
      </dl>
      {shown.length < models.length && (
        <div className="text-xs">
          <SettingsLink onClick={() => setAll(true)}>
            {t("settings.providers.models.showAll", { count: models.length })}
          </SettingsLink>
        </div>
      )}
    </div>
  );
}

export interface ProviderRowProps {
  provider: ProviderInfo;
  open: boolean;
  onToggle: () => void;
  /** What the row is busy with ("Connecting…"), shown in place of its badge and action. */
  busy: string | null;
  /** The provider's usable models; null when the catalog could not be read. */
  models: readonly AgentModelInfo[] | null;
  /** Who runs each model by default, by `provider/modelId`. */
  users: ReadonlyMap<string, AgentId[]>;
  onSaveKey: (apiKey: string) => Promise<string | null>;
  onRemoveKey: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  /** The provider's in-app sign-in; null when the runtime offers none for it. */
  signIn: ProviderSignInControls | null;
  onSignOut: () => void;
}

/** One provider of the list (prototype `.st-prov`): state, what it needs, and its details when opened. */
export function ProviderRow({
  provider,
  open,
  onToggle,
  busy,
  models,
  users,
  onSaveKey,
  onRemoveKey,
  onRetry,
  onRefresh,
  signIn,
  onSignOut,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const look = describe(provider);
  const keyStorageNote = t(platformKey("settings.studio.pv.keyStorageNote"));
  const bodyId = useId();
  const ownKey = provider.credentialSource === "api-key";
  const setUp = provider.status === "not_configured";

  const flows = signInFlows(provider);
  const canSignIn = signIn !== null && flows.length > 0 && !provider.keyless;
  const signedHere = provider.credentialSource === "oauth";
  const running =
    signIn !== null && (isRunningLogin(signIn.view.login) || signIn.view.busy !== null);
  const ended = signIn?.view.login && !isRunningLogin(signIn.view.login) ? signIn.view.login : null;
  const rowBusy = (signIn && signInBusyLabel(signIn.view)) ?? busy;

  // "Sign in…" starts the default flow, or opens the row to choose when there are several.
  const signInButton = canSignIn ? (
    <Button onClick={() => (flows.length > 1 ? onToggle() : signIn.start(null))}>
      {t("settings.signin.start")}
    </Button>
  ) : null;
  const keyButton = <Button onClick={onToggle}>{t("settings.providers.useKey")}</Button>;

  let action: ReactNode = null;
  if (provider.status === "error") action = <Button onClick={onRetry}>{t("common.retry")}</Button>;
  else if (provider.status === "signin_required" && !open && !provider.keyless) {
    action = (
      <>
        {signInButton}
        {keyButton}
      </>
    );
  } else if (setUp && !open && !provider.keyless) {
    action = canSignIn ? (
      <>
        {signInButton}
        {keyButton}
      </>
    ) : (
      <Button onClick={onToggle}>{t("settings.providers.setUp")}</Button>
    );
  }

  let body: ReactNode = null;
  if (open) {
    const removeLink = ownKey ? (
      <div>
        <SettingsLink onClick={onRemoveKey}>{t("settings.studio.pv.removeKey")}</SettingsLink>
      </div>
    ) : null;
    const replaceNote = ownKey
      ? keyStorageNote
      : t("settings.studio.pv.keyReplaceNote", { note: keyStorageNote });
    // A sign-in under way takes the body; one that ended shows its reason above the usual options.
    const signInStart =
      canSignIn && !ended ? <SignInStart provider={provider} controls={signIn} /> : null;
    const progress =
      signIn && signIn.view.login && (running || provider.status !== "connected") ? (
        <SignInProgress provider={provider} controls={signIn} />
      ) : null;
    let status: ReactNode = null;
    switch (provider.status) {
      case "connected":
        status = (
          <>
            <ProviderModels provider={provider} models={models} users={users} />
            {removeLink}
            {signedHere && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                <Trans
                  i18nKey="settings.studio.pv.signedHere"
                  values={{ provider: provider.name }}
                  components={{ action: <SettingsLink onClick={onSignOut}>{null}</SettingsLink> }}
                />
              </p>
            )}
            {!provider.keyless && !ownKey && !signedHere && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                {t("settings.studio.pv.fromOmp")}
              </p>
            )}
            {!provider.keyless && !provider.verified && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                <Trans
                  i18nKey="settings.studio.pv.notChecked"
                  values={{ provider: provider.name }}
                  components={{ action: <SettingsLink onClick={onRefresh}>{null}</SettingsLink> }}
                />
              </p>
            )}
          </>
        );
        break;
      case "error":
        status = (
          <>
            <pre className="m-0 whitespace-pre-wrap rounded-sm border border-border-subtle bg-bg-0 px-2 py-1.5 font-mono text-xs leading-[15px] text-fg-2">
              {provider.error ?? t("settings.studio.pv.lastCheckFailed")}
            </pre>
            {signInStart}
            {!provider.keyless && (
              <KeyForm provider={provider} replace={ownKey} note={replaceNote} onSave={onSaveKey} />
            )}
            {removeLink}
          </>
        );
        break;
      case "signin_required":
        status = (
          <>
            <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
              {canSignIn ? (
                t("settings.studio.pv.expiredHere", { provider: provider.name })
              ) : (
                <Trans
                  i18nKey="settings.studio.pv.expiredOmp"
                  values={{ provider: provider.name }}
                  components={{ action: <SettingsLink onClick={onRefresh}>{null}</SettingsLink> }}
                />
              )}
            </p>
            {signInStart}
            {!provider.keyless && (
              <KeyForm provider={provider} replace={false} note={replaceNote} onSave={onSaveKey} />
            )}
          </>
        );
        break;
      case "not_configured":
        status = provider.keyless ? (
          <p className="m-0 text-xs text-fg-3">
            {t("settings.studio.pv.needsNoKey", { provider: provider.name })}
          </p>
        ) : (
          <>
            {signInStart}
            <KeyForm provider={provider} replace={false} note={keyStorageNote} onSave={onSaveKey} />
          </>
        );
        break;
    }
    body = (
      <>
        {progress}
        {running ? null : status}
      </>
    );
  }

  const expandable = !(setUp && !open);
  return (
    <div data-provider={provider.id} data-status={provider.status}>
      <div className="grid min-h-row-lg grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-row-pad">
        <StatusDot tone={look.dot} />
        <div className="grid min-w-0 gap-px">
          <span className="text-base leading-4 font-medium text-fg">{provider.name}</span>
          <span className="truncate text-xs leading-[14px] text-fg-3" title={look.sub}>
            {look.sub}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {rowBusy ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-3"
            >
              <Spinner />
              {rowBusy}
            </span>
          ) : (
            <>
              <Badge tone={look.tone}>{look.badge}</Badge>
              {action}
            </>
          )}
          {expandable && (
            <IconButton
              aria-label={t(
                open ? "settings.providers.hideDetails" : "settings.providers.showDetails",
                {
                  provider: provider.name,
                },
              )}
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              icon={
                <CaretRight
                  aria-hidden
                  className={cn(
                    "size-icon-md transition-transform duration-hover",
                    open && "rotate-90",
                  )}
                />
              }
              onClick={onToggle}
            />
          )}
        </div>
      </div>
      {body && (
        <div id={bodyId} className="grid gap-2 pt-0.5 pr-3 pb-3 pl-[30px]">
          {body}
        </div>
      )}
    </div>
  );
}
