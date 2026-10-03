import { Eye, EyeSlash } from "@phosphor-icons/react";
import { X } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import { resolveShortcutKey } from "../../utils/platform";
import type { DomEditSelection } from "./domEditingTypes";

/** The action buttons in the inspector header: visibility, Ungroup (groups only), copy, clear. */
export function InspectorHeaderActions({
  element,
  copied,
  onCopy,
  onClear,
  onUngroup,
  selectedElementId,
  selectedElementHidden,
  visibilityLabel,
  onToggleHidden,
}: {
  element: DomEditSelection;
  copied: boolean;
  onCopy: () => void;
  onClear: () => void;
  onUngroup?: () => void;
  selectedElementId?: string | null;
  selectedElementHidden?: boolean;
  visibilityLabel?: string;
  onToggleHidden?: (id: string, hidden: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      {selectedElementId && onToggleHidden && (
        <button
          type="button"
          aria-label={visibilityLabel}
          title={visibilityLabel}
          onClick={() => {
            void onToggleHidden(selectedElementId, !selectedElementHidden);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-2"
        >
          {selectedElementHidden ? (
            <EyeSlash size={13} weight="bold" aria-hidden="true" />
          ) : (
            <Eye size={13} weight="bold" aria-hidden="true" />
          )}
        </button>
      )}
      {onUngroup && element.dataAttributes["hf-group"] != null && (
        <button
          type="button"
          onClick={() => {
            onUngroup();
          }}
          title={t("editor.inspector.ungroupTitle", { shortcut: resolveShortcutKey("⌘⇧G") })}
          className="flex h-6 items-center rounded-sm px-2 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {t("editor.inspector.ungroup")}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onCopy();
        }}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          copied ? "text-studio-accent" : "text-fg-3 hover:bg-surface-2 hover:text-fg-2"
        }`}
        title={copied ? t("editor.inspector.copied") : t("editor.inspector.copyInfo")}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t("editor.inspector.clearSelection")}
        onClick={() => {
          onClear();
        }}
        className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-2"
      >
        <X size={13} />
      </button>
    </div>
  );
}
