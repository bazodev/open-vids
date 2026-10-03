import { memo, useCallback, useState } from "react";
import { useTranslation } from "../../i18n";
import { shiftKeyLabel } from "../../utils/platform";
import { useCaptionStore } from "../store";
import type { CaptionSegment, CaptionStyle } from "../types";
import { CaptionAnimationPanel } from "./CaptionAnimationPanel";
import { Section, Row, NumberField } from "./shared";
import { INSP_CHIP } from "../../components/editor/inspectorStyles";

/** A `.seg` segment: neutral, the selected one lifts to surface-3. */
const CAPTION_TAB =
  "h-[22px] rounded-sm text-sm text-fg-3 transition-colors hover:bg-surface-1 hover:text-fg-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent aria-selected:bg-surface-3 aria-selected:text-fg";

/** True when the given style key differs across the selected segments. */
function isMixedValue(
  model: { segments: Map<string, { style: Partial<CaptionStyle> }> } | null,
  selectedSegmentIds: Set<string>,
  key: "x" | "y" | "scaleX" | "rotation",
  fallback: number,
): boolean {
  if (!model || selectedSegmentIds.size < 2) return false;
  let first: number | undefined;
  let seen = false;
  for (const segId of selectedSegmentIds) {
    const v = model.segments.get(segId)?.style[key] ?? fallback;
    if (!seen) {
      first = v;
      seen = true;
    } else if (v !== first) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface CaptionPropertyPanelProps {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

export const CaptionPropertyPanel = memo(function CaptionPropertyPanel({
  iframeRef,
}: CaptionPropertyPanelProps) {
  const { t } = useTranslation();
  const model = useCaptionStore((s) => s.model);
  const selectedSegmentIds = useCaptionStore((s) => s.selectedSegmentIds);
  const selectedGroupId = useCaptionStore((s) => s.selectedGroupId);
  const updateSelectedStyle = useCaptionStore((s) => s.updateSelectedStyle);
  const updateGroupStyle = useCaptionStore((s) => s.updateGroupStyle);
  const selectSegment = useCaptionStore((s) => s.selectSegment);

  const [activeTab, setActiveTab] = useState<"style" | "animation">("style");

  // Resolve effective style for the first selected segment
  const firstSegmentId = selectedSegmentIds.size > 0 ? [...selectedSegmentIds][0] : undefined;
  const firstSegment = model?.segments.get(firstSegmentId ?? "");

  // Find the group that owns the first segment
  let ownerGroupId: string | null = null;
  if (model && firstSegmentId) {
    for (const gid of model.groupOrder) {
      const group = model.groups.get(gid);
      if (group && group.segmentIds.includes(firstSegmentId)) {
        ownerGroupId = gid;
        break;
      }
    }
  }

  const groupStyle = ownerGroupId ? model?.groups.get(ownerGroupId)?.style : undefined;
  const segmentOverrides = firstSegment?.style ?? {};
  // The words of the line being edited, as chips: click selects one, ⇧-click adds.
  const ownerWords: CaptionSegment[] = [];
  for (const id of ownerGroupId ? (model?.groups.get(ownerGroupId)?.segmentIds ?? []) : []) {
    const segment = model?.segments.get(id);
    if (segment) ownerWords.push(segment);
  }

  // Merge group style with segment overrides for display
  const effectiveStyle: Partial<CaptionStyle> = {
    ...groupStyle,
    ...segmentOverrides,
  };

  /**
   * Apply a CSS style change to selected word elements in the iframe DOM in real time.
   * Maps CaptionStyle property names to CSS properties.
   */
  const applyToIframeDom = useCallback(
    (updates: Partial<CaptionStyle>) => {
      const iframe = iframeRef.current;
      if (!iframe || !model) return;
      let doc: Document | null = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        return;
      }
      if (!doc) return;

      const groupEls = doc.querySelectorAll<HTMLElement>(".caption-group");

      // Build list of word elements to update
      const targetEls: HTMLElement[] = [];
      for (const segId of selectedSegmentIds) {
        for (let gi = 0; gi < model.groupOrder.length; gi++) {
          const group = model.groups.get(model.groupOrder[gi]);
          if (!group) continue;
          const wi = group.segmentIds.indexOf(segId);
          if (wi < 0) continue;
          const groupEl = groupEls[gi];
          if (!groupEl) continue;
          // Resolve word span, handling wrappers
          const children = groupEl.children;
          let idx = 0;
          for (const child of children) {
            const c = child as HTMLElement;
            if (c.dataset.captionWrapper === "true") {
              const inner = c.querySelector<HTMLElement>(":scope > span");
              if (inner && idx === wi) {
                targetEls.push(inner);
                break;
              }
            } else if (c.tagName === "SPAN") {
              if (idx === wi) {
                targetEls.push(c);
                break;
              }
            }
            idx++;
          }
          break;
        }
      }

      // Apply transform updates via gsap.set on the WRAPPER (not the word span)
      const hasTransform =
        updates.x !== undefined ||
        updates.y !== undefined ||
        updates.scaleX !== undefined ||
        updates.scaleY !== undefined ||
        updates.rotation !== undefined;

      if (hasTransform) {
        try {
          const iframeGsap = (
            iframeRef.current?.contentWindow as unknown as {
              gsap?: {
                set: (el: HTMLElement, props: Record<string, unknown>) => void;
                getProperty: (el: HTMLElement, prop: string) => number;
              };
            }
          )?.gsap;
          if (iframeGsap) {
            for (const el of targetEls) {
              // Get or create wrapper
              let wrapper = el.parentElement;
              if (!wrapper || wrapper.dataset.captionWrapper !== "true") {
                wrapper = doc.createElement("span") as HTMLElement;
                wrapper.style.display = "inline-block";
                wrapper.dataset.captionWrapper = "true";
                el.parentNode?.insertBefore(wrapper, el);
                wrapper.appendChild(el);
              }
              // Read current wrapper state and merge with updates
              const curX = iframeGsap.getProperty(wrapper, "x") || 0;
              const curY = iframeGsap.getProperty(wrapper, "y") || 0;
              const curScale = iframeGsap.getProperty(wrapper, "scale") || 1;
              const curRotation = iframeGsap.getProperty(wrapper, "rotation") || 0;
              iframeGsap.set(wrapper, {
                x: updates.x ?? curX,
                y: updates.y ?? curY,
                scale: updates.scaleX ?? curScale,
                rotation: updates.rotation ?? curRotation,
              });
            }
          }
        } catch {
          /* cross-origin */
        }
      }
    },
    [iframeRef, model, selectedSegmentIds],
  );

  // All hooks must be called before any early return
  const handleStyleChange = useCallback(
    (updates: Partial<CaptionStyle>) => {
      if (selectedGroupId) {
        updateGroupStyle(selectedGroupId, updates);
      } else {
        updateSelectedStyle(updates);
      }
      applyToIframeDom(updates);
    },
    [selectedGroupId, updateGroupStyle, updateSelectedStyle, applyToIframeDom],
  );

  // Empty state — after all hooks
  if (selectedSegmentIds.size === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="m-0 text-sm text-fg-3">{t("captions.panel.empty")}</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Derived style values with fallbacks
  // ---------------------------------------------------------------------------

  const x = effectiveStyle.x ?? 0;
  const y = effectiveStyle.y ?? 0;
  const rotation = effectiveStyle.rotation ?? 0;
  const scaleX = effectiveStyle.scaleX ?? 1;

  const xMixed = isMixedValue(model, selectedSegmentIds, "x", 0);
  const yMixed = isMixedValue(model, selectedSegmentIds, "y", 0);
  const scaleMixed = isMixedValue(model, selectedSegmentIds, "scaleX", 1);
  const rotationMixed = isMixedValue(model, selectedSegmentIds, "rotation", 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="grid shrink-0 gap-1.5 border-b border-border-subtle px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-1.5 text-xs font-semibold text-fg-2">
          {t("captions.panel.words")}
          <span className="truncate font-normal text-fg-3">
            {t("captions.panel.selectionHint", {
              count: selectedSegmentIds.size,
              key: shiftKeyLabel(),
            })}
          </span>
        </div>
        {ownerWords.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1" data-caption-word-chips="true">
            {ownerWords.map((segment) => (
              <button
                key={segment.id}
                type="button"
                aria-pressed={selectedSegmentIds.has(segment.id)}
                data-edited={
                  segment.style && Object.keys(segment.style).length > 0 ? "" : undefined
                }
                onClick={(event) => selectSegment(segment.id, event.shiftKey)}
                className={`${INSP_CHIP} data-edited:after:absolute data-edited:after:top-[3px] data-edited:after:right-[3px] data-edited:after:size-1 data-edited:after:rounded-full data-edited:after:bg-fg-3`}
              >
                {segment.text}
              </button>
            ))}
          </div>
        )}
        {/* Tab switcher */}
        <div
          className="grid grid-cols-2 gap-px rounded-md border border-border bg-bg-1 p-0.5"
          role="tablist"
          aria-label={t("captions.panel.tabs")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "style"}
            onClick={() => setActiveTab("style")}
            className={CAPTION_TAB}
          >
            {t("captions.panel.tab.style")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "animation"}
            onClick={() => setActiveTab("animation")}
            className={CAPTION_TAB}
          >
            {t("captions.panel.tab.animation")}
          </button>
        </div>
      </div>

      {/* Animation tab */}
      {activeTab === "animation" && <CaptionAnimationPanel />}

      {/* Style tab — Transform only */}
      {activeTab === "style" && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <Section label={t("captions.panel.section.position")}>
            <Row label="X">
              <NumberField
                value={x}
                mixed={xMixed}
                ariaLabel={t("captions.panel.aria.x")}
                onCommit={(v) => handleStyleChange({ x: v })}
              />
            </Row>
            <Row label="Y">
              <NumberField
                value={y}
                mixed={yMixed}
                ariaLabel={t("captions.panel.aria.y")}
                onCommit={(v) => handleStyleChange({ y: v })}
              />
            </Row>
          </Section>

          <Section label={t("captions.panel.section.transform")}>
            <Row label={t("captions.panel.row.scale")}>
              <NumberField
                value={scaleX}
                mixed={scaleMixed}
                step={0.1}
                ariaLabel={t("captions.panel.aria.scale")}
                onCommit={(v) => handleStyleChange({ scaleX: v, scaleY: v })}
              />
            </Row>
            <Row label={t("captions.panel.row.rotation")}>
              <NumberField
                value={rotation}
                mixed={rotationMixed}
                ariaLabel={t("captions.panel.aria.rotation")}
                onCommit={(v) => handleStyleChange({ rotation: v })}
              />
            </Row>
          </Section>
        </div>
      )}
    </div>
  );
});
