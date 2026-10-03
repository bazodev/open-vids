import { useState, useCallback, useEffect, useRef } from "react";
import { Info, X } from "@phosphor-icons/react";
import { Trans, useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { resolveShortcutKey } from "../../utils/platform";
import { useDialogBehavior } from "../ui/useDialogBehavior";

export function PromptPreviewModal({
  title,
  prompt,
  onClose,
}: {
  title: string;
  prompt: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(prompt);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [entered, setEntered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Escape / focus trap / focus restore. A dirty draft vetoes Escape and
  // backdrop close so a stray click can't discard edits (the X still closes).
  const { requestClose } = useDialogBehavior({
    open: true,
    onClose,
    containerRef,
    canClose: () => valueRef.current === prompt,
  });

  useEffect(() => {
    requestAnimationFrame(() => {
      setEntered(true);
      textareaRef.current?.focus();
    });
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(valueRef.current);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-100 flex items-center justify-center bg-scrim px-6 py-12 transition-opacity duration-150 ease-out ${
        entered ? "opacity-100" : "opacity-0"
      }`}
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.prompt.dialogLabel", { title })}
        tabIndex={-1}
        className="flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pl-3 pr-1">
          <h3 className="m-0 shrink-0 text-sm font-semibold">{t("sidebar.prompt.title")}</h3>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{title}</span>
          <IconButton
            size="sm"
            aria-label={t("common.close")}
            onClick={onClose}
            icon={<X size={12} aria-hidden />}
          />
        </div>
        <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-3">
          <p className="m-0 grid grid-cols-[14px_minmax(0,1fr)] gap-1.5 text-xs leading-[15px] text-fg-3">
            <Info size={12} className="mt-px" aria-hidden />
            {t("sidebar.prompt.hint")}
          </p>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleCopy();
            }}
            className="min-h-[240px] w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] font-mono text-num leading-[17px] text-fg-2 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
        </div>
        <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-t border-border-subtle py-2 pl-3 pr-2.5">
          <span className="mr-auto flex items-center gap-1 text-xs text-fg-3">
            <Trans
              i18nKey="shell.askAgent.copyShortcut"
              components={{
                shortcut: <Kbd>{resolveShortcutKey("⌘↵")}</Kbd>,
              }}
            />
          </span>
          {copyState === "failed" && (
            <span role="alert" className="text-xs text-error">
              {t("sidebar.prompt.copyFailed")}
            </span>
          )}
          <Button variant="primary" size="sm" onClick={() => void handleCopy()}>
            {copyState === "copied" ? t("sidebar.prompt.copied") : t("shell.askAgent.copyPrompt")}
          </Button>
        </div>
      </div>
    </div>
  );
}
