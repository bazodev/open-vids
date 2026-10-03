import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PaperPlaneRight, Stop, TreeStructure, X } from "@phosphor-icons/react";
import { useAgentStore } from "../../agent/agentContext";
import { activeThread, hasNoUsableModel, runningTurn } from "../../agent/agentSelectors";
import { draftChatSummary } from "../../agent/agentDraftChat";
import { NEW_CHAT_DRAFT } from "../../agent/agentStore";
import { useComposerContextStore } from "../../agent/composerContext";
import { isUploading } from "../../agent/composerAttachments";
import { useComposerRequestStore } from "../../agent/composerRequest";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { cn } from "../ui/cn";
import { useTranslation } from "../../i18n";
import { Kbd } from "../ui/Kbd";
import { resolveShortcutKey } from "../../utils/platform";
import { resolveModifierKey } from "../../utils/keyMatch";
import { AgentsMenu } from "./AgentsMenu";
import { ConnectModelButton, MANUAL_EDITOR_NOTE, NO_MODEL_SENTENCE } from "./ConnectModel";
import { chatAgentName } from "./AgentMonogram";
import { ComposerPortalContext, chipIconClass, chipLabelClass } from "./composerParts";
import { useAssetMentions } from "./AssetMentionMenu";
import { AttachmentChips, useDraftAttachments } from "./AttachmentChips";
import { ContextChips } from "./ContextChips";
import { ExecutionQualityMenu } from "./ExecutionQualityMenu";
import { ModeMenu } from "./ModeMenu";
import { ModelEffortMenu } from "./ModelEffortMenu";

const sendClass = cn(
  "inline-flex h-ctl-sm min-w-ctl-sm shrink-0 items-center justify-center gap-[5px] rounded-sm border text-xs font-semibold whitespace-nowrap",
  "outline-hidden transition-colors duration-hover",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
);

/** Frames the composer keeps trying to take the focus after an outside request (the dock reveals the tab). */
const FOCUS_ATTEMPTS = 20;

/**
 * The prompt box (prototype `.ov-chat-composer`): context chips, the prompt, and the controls — Model · Effort,
 * Agents · N, Mode, Execution quality, and Send / Steer / Stop. Idle, Enter starts a turn (in story mode while the
 * Story workspace is shown); while the chat's turn runs, Enter steers it and ⌘. stops it. While another chat holds
 * the project it explains and stays out of the way. It always talks to Main, even from an agent's thread.
 */
export function Composer() {
  const { t } = useTranslation();
  const chatId = useAgentStore((state) => state.chatId);
  const chat = useAgentStore((state) => state.chat);
  const draftChoices = useAgentStore((state) => state.draftChoices);
  const settings = useAgentStore((state) => state.settings);
  const models = useAgentStore((state) => state.models);
  const draft = useAgentStore((state) => state.drafts[state.chatId ?? NEW_CHAT_DRAFT] ?? "");
  const pending = useAgentStore((state) => state.pending);
  const notice = useAgentStore((state) => state.notice);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const setDraft = useAgentStore((state) => state.setDraft);
  const send = useAgentStore((state) => state.send);
  const abort = useAgentStore((state) => state.abort);
  const dismissNotice = useAgentStore((state) => state.dismissNotice);
  const openChat = useAgentStore((state) => state.openChat);
  const chats = useAgentStore((state) => state.chats);
  const thread = useAgentStore((state) => activeThread(state.threads, state.chat));
  // Before the dock mounts every panel counts as visible; only a mounted dock can show the Story workspace.
  const storyShown = useDockLayoutStore(
    (state) => state.controller !== null && state.visiblePanels.has("story"),
  );
  const clearExcluded = useComposerContextStore((state) => state.clear);

  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Grows with the prompt up to eight lines (`field-sizing` is not in every WebView).
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [draft]);
  // Asked from outside (inspector, canvas menu): once the draft shows, the caret goes to its end. The Chat tab
  // may still be hidden behind another tab when this runs, so the focus is retried while the dock reveals it.
  const focusPending = useComposerRequestStore((state) => state.focusPending);
  useEffect(() => {
    const area = areaRef.current;
    if (!focusPending || !area) return;
    let frame = 0;
    let attempts = 0;
    const focusAtEnd = () => {
      area.focus({ preventScroll: true });
      if (area.matches(":focus")) {
        area.setSelectionRange(area.value.length, area.value.length);
      } else if ((attempts += 1) < FOCUS_ATTEMPTS) {
        frame = requestAnimationFrame(focusAtEnd);
        return;
      }
      useComposerRequestStore.getState().focused();
    };
    focusAtEnd();
    return () => cancelAnimationFrame(frame);
  }, [focusPending, draft]);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);

  const running = runningTurn(chat) !== null;
  const blockedBy = activeTurn && activeTurn.chatId !== chatId ? activeTurn : null;
  const blockedTitle = blockedBy ? chats.find((item) => item.id === blockedBy.chatId)?.title : null;
  const busy = pending === "send" || pending === "steer";
  const hasText = draft.trim().length > 0;
  const attachments = useDraftAttachments();
  // The new-chat draft has no chat yet: its first message creates it.
  const isDraft = chatId === null;
  // The runtime lists no usable model: nothing can run, and the panel says how to connect one.
  const noModel = hasNoUsableModel(models);
  // A message goes out with its files: Send waits while one is still being imported.
  const canSubmit =
    hasText &&
    !busy &&
    !blockedBy &&
    !noModel &&
    !isUploading(attachments) &&
    (chat !== null || isDraft);
  // The chips edit the open chat, or in the draft the choices its chat will be created with.
  const summary = chat?.chat ?? (isDraft ? draftChatSummary(draftChoices, settings) : null);

  const submit = async () => {
    if (!canSubmit) return;
    // Steering a live turn keeps its mode; a new turn runs in story mode while the Story workspace is shown.
    const sent = await send(running ? undefined : { mode: storyShown ? "story" : "normal" });
    if (sent) clearExcluded();
  };

  // ⌘. stops the run from anywhere in the chat panel (prototype shortcut).
  const stopRef = useRef({ running, abort });
  useEffect(() => {
    stopRef.current = { running, abort };
  });
  useEffect(() => {
    const panel = portal?.parentElement;
    if (!panel) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || resolveModifierKey(event) !== ".") return;
      if (!stopRef.current.running) return;
      event.preventDefault();
      event.stopPropagation();
      void stopRef.current.abort();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [portal]);

  const fieldDisabled = blockedBy !== null || noModel || (chat === null && !isDraft);
  const mentions = useAssetMentions({ areaRef, draft, disabled: fieldDisabled, setDraft });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.handleKeyDown(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const placeholder = noModel
    ? t("chat.composer.placeholder.noModel")
    : blockedBy
      ? t("chat.composer.placeholder.blocked")
      : running
        ? t("chat.composer.placeholder.steer")
        : storyShown
          ? t("chat.composer.placeholder.story")
          : t("chat.composer.placeholder.edit");

  const mode = running ? (hasText ? "steer" : "stop") : "send";

  return (
    <div
      ref={setPortal}
      className="relative shrink-0 bg-bg-0 @container/composer"
      data-testid="chat-composer"
    >
      <ComposerPortalContext.Provider value={portal}>
        {notice && (
          <div
            role="alert"
            className="mx-2 mb-1.5 flex items-start justify-between gap-2 rounded-md border border-error/30 bg-error-soft px-2 py-1.5 text-sm text-fg"
          >
            <span>{notice.message}</span>
            <button
              type="button"
              aria-label={t("chat.composer.dismiss")}
              onClick={dismissNotice}
              className="shrink-0 rounded-xs text-fg-3 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        )}
        {noModel && chat !== null && chat.messages.length > 0 && (
          <div
            className="mx-3 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3"
            data-testid="composer-no-model"
          >
            <span>
              <span className="font-medium text-fg-2">{t(NO_MODEL_SENTENCE)}</span>{" "}
              {t(MANUAL_EDITOR_NOTE)}
            </span>
            <ConnectModelButton />
          </div>
        )}
        {blockedBy && (
          <p className="mx-3 mb-1.5 text-xs text-fg-3" data-testid="composer-blocked">
            {blockedTitle
              ? t("chat.composer.blockedNamed", { title: blockedTitle })
              : t("chat.composer.blockedOther")}{" "}
            <button
              type="button"
              onClick={() => void openChat(blockedBy.chatId)}
              className="rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
            >
              {t("chat.composer.openBlocking")}
            </button>
          </p>
        )}
        {thread !== "main" && !blockedBy && (
          <p className="mx-3 mb-1 text-xs text-fg-3" data-testid="composer-thread-hint">
            {t("chat.composer.threadHint", {
              viewing: chatAgentName(thread),
              target: chatAgentName("director"),
            })}
          </p>
        )}
        <div
          className={cn(
            "relative mx-2 mb-2 flex flex-col rounded-md border border-border bg-bg-1 transition-colors duration-hover",
            "hover:border-border-strong @min-[440px]/composer:mx-2.5 @min-[440px]/composer:mb-2.5",
            "has-[textarea:focus-visible]:border-border-strong has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-1 has-[textarea:focus-visible]:outline-accent",
          )}
        >
          {mentions.menu}
          <AttachmentChips onRemoved={() => areaRef.current?.focus({ preventScroll: true })} />
          <ContextChips onRemoved={() => areaRef.current?.focus({ preventScroll: true })} />
          <label htmlFor="chat-composer-textarea" className="sr-only">
            {t("chat.composer.label")}
          </label>
          <textarea
            id="chat-composer-textarea"
            ref={areaRef}
            rows={1}
            value={draft}
            disabled={fieldDisabled}
            placeholder={placeholder}
            spellCheck
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
              mentions.trackChange(event.target);
            }}
            onKeyDown={onKeyDown}
            {...mentions.fieldProps}
            className={cn(
              "block max-h-[156px] min-h-row w-full resize-none overflow-y-auto bg-transparent px-2.5 pt-2 pb-1",
              "text-base leading-[18px] text-fg outline-hidden [field-sizing:content] placeholder:text-fg-3",
              "disabled:cursor-not-allowed disabled:text-fg-2",
            )}
          />
          <div
            className="flex min-w-0 items-center gap-0.5 px-1 pt-0.5 pb-1 @min-[440px]/composer:gap-1 @min-[440px]/composer:px-1.5 @min-[440px]/composer:pt-[3px] @min-[440px]/composer:pb-1.5"
            data-testid="composer-controls"
          >
            {summary && <ModelEffortMenu chat={summary} />}
            {summary && <AgentsMenu chat={summary} />}
            {summary && <ModeMenu chat={summary} />}
            {summary && <ExecutionQualityMenu chat={summary} />}
            {storyShown && !running && (
              <span
                className="inline-flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-fg-2"
                title={t("chat.composer.storyChip")}
                data-testid="composer-story-chip"
              >
                <TreeStructure size={12} aria-hidden className={chipIconClass} />
                <span className={chipLabelClass}>Story</span>
              </span>
            )}
            <span aria-hidden className="min-w-0 flex-1" />
            {mode === "stop" ? (
              <button
                key="stop"
                type="button"
                aria-label={t("chat.composer.stopTask")}
                title={t("chat.composer.stopTaskTitle", { key: resolveShortcutKey("⌘.") })}
                disabled={pending === "abort"}
                onClick={() => void abort()}
                className={cn(
                  sendClass,
                  "border-border bg-surface-1 pr-1.5 pl-[5px] text-fg hover:border-border-strong hover:bg-surface-2",
                  "disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
                  "@max-[299px]/composer:px-[5px]",
                )}
              >
                <Stop size={12} weight="fill" aria-hidden />
                <span>{t("chat.composer.stop")}</span>
                <Kbd className="h-3.5 px-[3px] text-2xs @max-[439px]/composer:hidden">
                  {resolveShortcutKey("⌘.")}
                </Kbd>
              </button>
            ) : mode === "steer" ? (
              <button
                key="steer"
                type="button"
                aria-label={t("chat.composer.steerTask")}
                title={t("chat.composer.steerTask")}
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={cn(
                  sendClass,
                  "border-border bg-surface-1 pr-[7px] pl-1.5 text-fg hover:border-border-strong hover:bg-surface-2",
                  "disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
                  "@max-[299px]/composer:px-[5px]",
                )}
              >
                <PaperPlaneRight size={12} aria-hidden />
                <span>{t("chat.composer.steer")}</span>
              </button>
            ) : (
              <button
                key="send"
                type="button"
                aria-label={t("chat.composer.send")}
                title={t("chat.composer.sendTitle", { key: "Enter" })}
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={cn(
                  sendClass,
                  "border-transparent bg-accent px-[5px] text-accent-ink hover:bg-accent-hover active:bg-accent-press",
                  "disabled:border-border-subtle disabled:bg-surface-1 disabled:text-fg-disabled",
                )}
              >
                <PaperPlaneRight size={12} weight="fill" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </ComposerPortalContext.Provider>
    </div>
  );
}
