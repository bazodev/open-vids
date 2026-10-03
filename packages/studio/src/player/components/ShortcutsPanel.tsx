import { useState, useCallback, useEffect, useId, useRef, memo } from "react";
import { Keyboard, X } from "@phosphor-icons/react";
import { formatTime, frameToSeconds, secondsToFrame } from "../lib/time";
import { Button, IconButton, Kbd, Tooltip } from "../../components/ui";
import { useContextMenuDismiss } from "../../hooks/useContextMenuDismiss";
import { formatNumber, isTranslationKey, useTranslation, type TranslationKey } from "../../i18n";
import { DEFAULT_SHORTCUT_SECTIONS, type ShortcutSection } from "./studioShortcuts";
import { platformKey, resolveShortcutKey } from "../../utils/platform";

const SECTION_HEADING = "mx-3 mt-3 mb-1 text-xs font-semibold text-fg-3";

interface ShortcutsPanelProps {
  disabled: boolean;
  duration: number;
  inPoint: number | null;
  outPoint: number | null;
  setInPoint: (v: number | null) => void;
  setOutPoint: (v: number | null) => void;
  onSeek: (time: number) => void;
  sections?: readonly ShortcutSection[];
}

export const ShortcutsPanel = memo(function ShortcutsPanel({
  disabled,
  duration,
  inPoint,
  outPoint,
  setInPoint,
  setOutPoint,
  onSeek,
  sections = DEFAULT_SHORTCUT_SECTIONS,
}: ShortcutsPanelProps) {
  const { t } = useTranslation();
  const text = (value: string) =>
    isTranslationKey(value) ? t(platformKey(value)) : resolveShortcutKey(value);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [jumpFrame, setJumpFrame] = useState("");
  const shortcutsPanelId = useId();
  const closeShortcuts = useCallback(() => setShowShortcuts(false), []);
  const shortcutsPanelRef = useContextMenuDismiss(closeShortcuts);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Move focus into the panel on open so keyboard users can scroll and read
  // it; hand focus back to the trigger on close.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!showShortcuts) return;
    const trigger = triggerRef.current;
    panelBodyRef.current?.focus();
    return () => {
      trigger?.focus();
    };
  }, [showShortcuts]);

  const commitJumpFrame = useCallback(() => {
    if (disabled) return;
    const frame = Number.parseInt(jumpFrame, 10);
    if (!Number.isFinite(frame) || duration <= 0) return;
    onSeek(Math.min(duration, frameToSeconds(Math.max(0, frame))));
  }, [disabled, duration, jumpFrame, onSeek]);

  const handleJumpSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      commitJumpFrame();
    },
    [commitJumpFrame],
  );

  const handleJumpKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commitJumpFrame();
    },
    [commitJumpFrame],
  );

  return (
    <div ref={shortcutsPanelRef} className="relative shrink-0">
      <Tooltip label={t("player.shortcuts.tooltip")} shortcut="?">
        <IconButton
          ref={triggerRef}
          onClick={() => setShowShortcuts((v) => !v)}
          aria-label={t("player.shortcuts.trigger")}
          aria-expanded={showShortcuts}
          aria-controls={shortcutsPanelId}
          className={showShortcuts ? "bg-surface-2 text-fg" : undefined}
          icon={<Keyboard size={16} />}
        />
      </Tooltip>
      {showShortcuts && (
        <div
          id={shortcutsPanelId}
          ref={panelBodyRef}
          tabIndex={-1}
          role="dialog"
          aria-label={t("player.shortcuts.dialog")}
          // Deliberately NOT aria-modal. This is a non-modal disclosure: focus is
          // not trapped and the rest of the editor stays operable, so claiming
          // modality would make assistive tech treat the whole app as inert.
          className="absolute right-0 bottom-[calc(100%+8px)] z-50 flex max-h-[min(440px,calc(100vh-96px))] w-[300px] flex-col overflow-hidden rounded-lg border border-border bg-menu-bg/94 shadow-pop outline-hidden backdrop-blur-md"
        >
          <div className="flex h-head shrink-0 items-center gap-2 border-b border-border-subtle pr-1 pl-3">
            <p className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-fg">
              {t("player.shortcuts.tooltip")}
            </p>
            <IconButton
              size="xs"
              aria-label={t("player.shortcuts.close")}
              icon={<X size={12} />}
              onClick={() => setShowShortcuts(false)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="border-b border-border-subtle pb-2">
              <p className={SECTION_HEADING}>{t("player.shortcuts.jumpHeading")}</p>
              <form
                onSubmit={handleJumpSubmit}
                className="flex min-h-row-sm items-center gap-1.5 px-3"
              >
                <input
                  value={jumpFrame}
                  onChange={(e) => setJumpFrame(e.target.value)}
                  disabled={disabled}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label={t("player.shortcuts.jumpLabel")}
                  placeholder={t("player.shortcuts.framePlaceholder")}
                  className="h-ctl-sm w-24 rounded-sm border border-border bg-surface-1 px-2 font-mono text-num tabular-nums text-fg outline-hidden transition-colors placeholder:text-fg-3 focus-visible:border-accent"
                  onKeyDown={handleJumpKeyDown}
                  onBlur={commitJumpFrame}
                />
                <span className="min-w-0 flex-1 font-mono text-num tabular-nums text-fg-3">
                  {t("player.shortcuts.frameCount", {
                    count: formatNumber(secondsToFrame(duration)),
                  })}
                </span>
                <Button type="submit" size="sm" variant="secondary" disabled={disabled}>
                  {t("player.shortcuts.go")}
                </Button>
              </form>
              <p className={SECTION_HEADING}>{t("player.shortcuts.workAreaHeading")}</p>
              <WorkAreaRow
                label="player.shortcuts.in"
                keyHint="I"
                value={inPoint}
                clearLabel="player.shortcuts.clearIn"
                onClear={() => setInPoint(null)}
              />
              <WorkAreaRow
                label="player.shortcuts.out"
                keyHint="O"
                value={outPoint}
                clearLabel="player.shortcuts.clearOut"
                onClear={() => setOutPoint(null)}
              />
            </div>
            <div className="pb-1.5">
              {sections.map((section, sectionIndex) => (
                <div key={sectionIndex}>
                  <p className={SECTION_HEADING}>{text(section.title)}</p>
                  <dl className="m-0">
                    {section.hints.map((hint, hintIndex) => (
                      <div
                        key={hintIndex}
                        className="flex items-center justify-between gap-3 px-3 py-[3px] text-sm"
                      >
                        <dt className="min-w-0 text-fg-2">{text(hint.label)}</dt>
                        <dd className="m-0 shrink-0">
                          <Kbd>{text(hint.key)}</Kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function WorkAreaRow({
  label,
  keyHint,
  value,
  clearLabel,
  onClear,
}: {
  label: TranslationKey;
  keyHint: string;
  value: number | null;
  clearLabel: TranslationKey;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-row-sm items-center gap-1.5 px-3">
      <span className="w-7 text-sm text-fg-3">{t(label)}</span>
      <span className="min-w-0 flex-1 font-mono text-num tabular-nums text-fg">
        {value !== null ? formatTime(value) : "—"}
      </span>
      {value !== null ? (
        <Button size="sm" variant="secondary" aria-label={t(clearLabel)} onClick={onClear}>
          {t("player.shortcuts.clear")}
        </Button>
      ) : (
        <Kbd>{keyHint}</Kbd>
      )}
    </div>
  );
}
