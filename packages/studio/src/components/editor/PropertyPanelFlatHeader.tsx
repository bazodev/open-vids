import { Eye, EyeSlash, Waveform } from "@phosphor-icons/react";
import { ClipboardList, Film, Square, Type, X } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import { resolveShortcutKey } from "../../utils/platform";
import { IconButton } from "../ui";

export type InspectorElementKind = "text" | "media" | "audio" | "other";

const ICON_BY_KIND = { text: Type, media: Film, audio: Waveform, other: Square } as const;

/** The type chip wears the clip kind's timeline hue, as in the prototype's `.type-ic`. */
const CHIP_BY_KIND: Record<InspectorElementKind, string> = {
  text: "bg-k-caption-h border-k-caption-l",
  media: "bg-k-video-h border-k-video-l",
  audio: "bg-k-audio-h border-k-audio-l",
  other: "bg-k-motion-h border-k-motion-l",
};

function UngroupGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
      <rect x="7.5" y="7.5" width="7" height="7" rx="1" />
    </svg>
  );
}

export function PropertyPanelFlatHeader({
  name,
  meta,
  elementKind,
  hidden,
  onToggleHidden,
  copied,
  onCopy,
  onClear,
  onUngroup,
  showUngroup,
}: {
  name: string;
  meta: string;
  elementKind: InspectorElementKind;
  hidden: boolean;
  onToggleHidden?: () => void;
  copied: boolean;
  onCopy: () => void;
  onClear: () => void;
  onUngroup?: () => void;
  showUngroup: boolean;
}) {
  const { t } = useTranslation();
  const Icon = ICON_BY_KIND[elementKind];
  const visibilityLabel = hidden
    ? t("inspector.header.showElement")
    : t("inspector.header.hideElement");

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
      <span
        data-flat-header-icon="true"
        data-kind={elementKind}
        className={`flex size-7 shrink-0 items-center justify-center rounded-sm border ${
          hidden
            ? "border-dashed border-border bg-transparent text-fg-3"
            : `${CHIP_BY_KIND[elementKind]} text-clip-ink`
        }`}
      >
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-md font-semibold tracking-[-0.005em] text-fg">{name}</div>
        <div className="mt-px truncate font-mono text-num text-fg-3">{meta}</div>
      </div>
      <div className="-mr-1 flex shrink-0 items-center gap-0.5">
        {showUngroup && (
          <IconButton
            size="sm"
            aria-label={t("inspector.header.ungroup")}
            title={t("inspector.header.ungroupHint", { key: resolveShortcutKey("⌘⇧G") })}
            icon={<UngroupGlyph />}
            onClick={() => {
              onUngroup?.();
            }}
          />
        )}
        {onToggleHidden && (
          <IconButton
            size="sm"
            aria-label={visibilityLabel}
            aria-pressed={hidden}
            title={visibilityLabel}
            icon={hidden ? <EyeSlash size={14} /> : <Eye size={14} />}
            onClick={() => {
              onToggleHidden();
            }}
          />
        )}
        <IconButton
          size="sm"
          aria-label={t("inspector.header.copyInfo")}
          title={copied ? t("inspector.header.copied") : t("inspector.header.copyInfoHint")}
          className={copied ? "text-success" : undefined}
          icon={<ClipboardList size={14} />}
          onClick={() => {
            onCopy();
          }}
        />
        <IconButton
          size="sm"
          aria-label={t("inspector.header.clearSelection")}
          title={t("inspector.header.clearSelection")}
          icon={<X size={14} />}
          onClick={() => {
            onClear();
          }}
        />
      </div>
    </div>
  );
}
