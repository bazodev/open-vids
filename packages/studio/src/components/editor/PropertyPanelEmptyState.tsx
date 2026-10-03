import { CursorClick, EyeSlash, Selection, SquaresFour, Waveform } from "@phosphor-icons/react";
import { Eye, Film, Layers, Square, Type, X } from "../../icons/SystemIcons";
import type { DomEditSelection } from "./domEditingTypes";
import { canHideSelections, isAudioDomElement } from "../../utils/timelineInspector";
import { Button, IconButton } from "../ui";
import { Trans, useTranslation } from "../../i18n";
import { shiftKeyLabel } from "../../utils/platform";
import { InspectorCompositionFacts } from "./PropertyPanelCompositionFacts";
import type { InspectorElementKind } from "./PropertyPanelFlatHeader";

function FlatEmptyState() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg-0 text-sm text-fg">
      <InspectorCompositionFacts />
      <div className="flex items-start gap-2 px-3 py-3 text-sm leading-[17px] text-fg-3">
        <CursorClick size={14} className="mt-px shrink-0" aria-hidden="true" />
        <p className="m-0 text-pretty">
          <Trans
            i18nKey="inspector.empty.nothingSelected"
            components={{ b: <span className="font-medium text-fg-2" /> }}
          />
        </p>
      </div>
    </div>
  );
}

const KIND_ICON = { media: Film, audio: Waveform, text: Type, other: Square } as const;
const KIND_CHIP: Record<InspectorElementKind, string> = {
  text: "bg-k-caption-h border-k-caption-l",
  media: "bg-k-video-h border-k-video-l",
  audio: "bg-k-audio-h border-k-audio-l",
  other: "bg-k-motion-h border-k-motion-l",
};

function selectionKind(element: DomEditSelection): InspectorElementKind {
  if (isAudioDomElement(element.element)) return "audio";
  if (element.tagName === "video" || element.tagName === "img") return "media";
  return element.textFields?.length > 0 ? "text" : "other";
}

function FlatMultiSelectState({
  multiSelectCount,
  multiSelectedElements = [],
  onGroupSelection,
  onHideAllSelected,
  onClearSelection,
}: {
  multiSelectCount: number;
  multiSelectedElements?: DomEditSelection[];
  onGroupSelection?: () => void;
  onHideAllSelected?: () => void;
  onClearSelection?: () => void;
}) {
  const { t } = useTranslation();
  // One predicate for both actions and for the handler's own refusal, so the
  // button and the refusal cannot disagree about what audio is.
  const hasAudio = !canHideSelections(multiSelectedElements);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg-0 text-sm text-fg">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-1 text-fg-2">
          <Selection size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-md font-semibold text-fg">
            {t("inspector.empty.multi.title", { count: multiSelectCount })}
          </div>
          <div className="mt-px truncate text-xs text-fg-3">
            {t("inspector.empty.multi.hint", { key: shiftKeyLabel() })}
          </div>
        </div>
        <IconButton
          size="sm"
          data-flat-multiselect-clear="true"
          aria-label={t("inspector.empty.multi.clear")}
          title={t("inspector.empty.multi.clear")}
          icon={<X size={14} />}
          className="-mr-1"
          onClick={onClearSelection}
        />
      </div>
      <div className="border-b border-border-subtle">
        <div className="flex h-[30px] items-center gap-1 pl-2 pr-2.5 text-sm font-semibold">
          <SquaresFour size={12} className="text-fg-3" aria-hidden="true" />
          {t("inspector.empty.multi.selection")}
        </div>
        <div className="grid gap-1.5 px-3 pb-3 pt-0.5">
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {multiSelectedElements.map((element) => {
              const kind = selectionKind(element);
              const Icon = KIND_ICON[kind];
              return (
                <li
                  key={`${element.id ?? element.selector ?? ""}:${element.selectorIndex ?? 0}`}
                  className="grid h-row-sm grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1.5 hover:bg-surface-1"
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-xs border text-clip-ink ${KIND_CHIP[kind]}`}
                  >
                    <Icon size={12} />
                  </span>
                  <span className="min-w-0 truncate">{element.label}</span>
                  <span className="whitespace-nowrap font-mono text-num text-fg-3">
                    {element.id ? `#${element.id}` : element.selector}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* Neither action applies to audio, so the row goes rather than showing
              an empty frame. Grouping is the LAYOUT grouper — a positioned wrapper
              around a bounding box, and an <audio> clip has none (grouping two
              produced a 0x0 div with inline left/top on elements that are never
              laid out). Hiding is visibility, which for audio doubles as mute; the
              timeline already withholds the eye on an audio track
              (`visible={!isAudioTrack}`) and this panel was the way back to the
              same write. Both handlers refuse it too — they own keyboard paths no
              hidden button can gate. */}
          {!hasAudio && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                data-flat-multiselect-group="true"
                icon={<Layers size={12} />}
                onClick={onGroupSelection}
              >
                {t("inspector.empty.multi.group")}
              </Button>
              <Button
                size="sm"
                data-flat-multiselect-hide-all="true"
                icon={<EyeSlash size={12} />}
                onClick={onHideAllSelected}
              >
                {t("inspector.empty.multi.hideAll")}
              </Button>
            </div>
          )}
          <p className="m-0 text-xs text-fg-3">{t("inspector.empty.multi.selectOne")}</p>
        </div>
      </div>
    </div>
  );
}

export function PropertyPanelEmptyState({
  multiSelectCount,
  flat,
  multiSelectedElements,
  onGroupSelection,
  onHideAllSelected,
  onClearSelection,
}: {
  multiSelectCount: number;
  flat?: boolean;
  multiSelectedElements?: DomEditSelection[];
  onGroupSelection?: () => void;
  onHideAllSelected?: () => void;
  onClearSelection?: () => void;
}) {
  const { t } = useTranslation();
  if (flat) {
    return multiSelectCount > 1 ? (
      <FlatMultiSelectState
        multiSelectCount={multiSelectCount}
        multiSelectedElements={multiSelectedElements}
        onGroupSelection={onGroupSelection}
        onHideAllSelected={onHideAllSelected}
        onClearSelection={onClearSelection}
      />
    ) : (
      <FlatEmptyState />
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-0">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        {multiSelectCount > 1 ? (
          <>
            <Layers size={18} className="mb-3 text-fg-disabled" />
            <p className="text-sm font-medium text-fg">
              {t("inspector.empty.classic.multiTitle", { count: multiSelectCount })}
            </p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-fg-3">
              {t("inspector.empty.classic.multiHint")}
            </p>
          </>
        ) : (
          <>
            <Eye size={18} className="mb-3 text-fg-disabled" />
            <p className="text-sm font-medium text-fg">{t("inspector.empty.classic.title")}</p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-fg-3">
              {t("inspector.empty.classic.hint")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
