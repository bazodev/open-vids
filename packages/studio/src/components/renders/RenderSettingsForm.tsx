import { useState, type ReactNode } from "react";
import { Sliders } from "@phosphor-icons/react";
import { CANVAS_DIMENSIONS } from "@hyperframes/parsers";
import { Select, type SelectOption } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { usePreviewVariablesStore } from "../../hooks/previewVariablesStore";
import type { ResolutionPreset } from "./useRenderQueue";
import {
  getPersistedRenderSettings,
  persistRenderSettings,
  type PersistedRenderSettings,
} from "./renderSettings";
import { Trans, t, useTranslation, type TranslationKey } from "../../i18n";

export interface CompositionDimensions {
  width: number;
  height: number;
}

export type RenderFormat = PersistedRenderSettings["format"];
export type RenderQuality = PersistedRenderSettings["quality"];
export type RenderFps = PersistedRenderSettings["fps"];

// Orientation is derived from the composition's authored aspect ratio,
// not chosen by the user — picking "1080p portrait" for a landscape comp
// would just produce a wrong-aspect render.
type RenderScale = "auto" | "1080p" | "4k";

const SCALE_OPTION_ORDER: RenderScale[] = ["auto", "1080p", "4k"];

/** Auto is a word; the sized presets are names and stay as they are. */
function scaleLabel(scale: RenderScale): string {
  if (scale === "auto") return t("renders.settings.scale.auto");
  return scale === "1080p" ? "1080p" : "4K";
}

type CompAspect = "landscape" | "portrait" | "square";

function compAspect(dims: CompositionDimensions | null | undefined): CompAspect {
  // Missing dims fall through to landscape (legacy default — "landscape" was
  // the first preset). Studio shows resolved dims inline, so the user can see
  // when this fallback is in effect.
  if (dims == null) return "landscape";
  if (dims.width === dims.height) return "square";
  return dims.height > dims.width ? "portrait" : "landscape";
}

/** The preset the producer receives for a scale: the composition's own aspect at that size. */
export function resolveResolution(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): ResolutionPreset | "auto" {
  if (scale === "auto") return "auto";
  const aspect = compAspect(dims);
  if (scale === "1080p") return aspect;
  return aspect === "landscape"
    ? "landscape-4k"
    : aspect === "portrait"
      ? "portrait-4k"
      : "square-4k";
}

function resolvedDimensions(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): CompositionDimensions | null {
  if (scale === "auto") return dims ?? null;
  const preset = resolveResolution(scale, dims);
  return preset === "auto" ? null : CANVAS_DIMENSIONS[preset];
}

// Mirrors the producer's resolveDeviceScaleFactor validation
// (renderOrchestrator.ts:608): the chosen preset must match the comp's aspect
// ratio exactly (cross-multiplied), can't downsample, and must be an integer
// scale factor. Without this guard the user can pick a preset that throws at
// render time — e.g. 1080p on a 1080×1080 square or 1080p on a 1280×720 comp
// (1.5× isn't integer).
function scaleApplies(scale: RenderScale, dims: CompositionDimensions | null | undefined): boolean {
  if (scale === "auto" || dims == null) return true;
  const preset = resolveResolution(scale, dims);
  if (preset === "auto") return true;
  const target = CANVAS_DIMENSIONS[preset];
  if (target.width * dims.height !== target.height * dims.width) return false;
  if (target.width < dims.width) return false;
  return Number.isInteger(target.width / dims.width);
}

function scaleOptionLabel(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): string {
  const resolved = resolvedDimensions(scale, dims);
  const base = resolved
    ? `${resolved.width} × ${resolved.height} · ${scaleLabel(scale)}`
    : scaleLabel(scale);
  // Explain *why* an option is disabled instead of greying it silently:
  // the preset must be an exact integer upscale of the authored size.
  if (dims && !scaleApplies(scale, dims)) {
    return t("renders.settings.scale.notInteger", {
      base,
      width: dims.width,
      height: dims.height,
    });
  }
  return base;
}

// Option order is the persisted contract's order: MP4, MOV, WebM.
const FORMAT_OPTIONS: Array<SelectOption & { value: RenderFormat }> = [
  { value: "mp4", label: "MP4 · H.264" },
  { value: "mov", label: "MOV · ProRes 4444" },
  { value: "webm", label: "WebM · VP9" },
];

const FORMAT_NOTE_KEYS = {
  mp4: "renders.settings.formatNote.mp4",
  mov: "renders.settings.formatNote.mov",
  webm: "renders.settings.formatNote.webm",
} as const satisfies Record<RenderFormat, TranslationKey>;

const QUALITY_VALUES: RenderQuality[] = ["draft", "standard", "high"];

const QUALITY_KEYS = {
  draft: "renders.settings.quality.draft",
  standard: "renders.settings.quality.standard",
  high: "renders.settings.quality.high",
} as const satisfies Record<RenderQuality, TranslationKey>;

const FPS_VALUES: RenderFps[] = [24, 30, 60];

function isFormat(value: string): value is RenderFormat {
  return FORMAT_OPTIONS.some((option) => option.value === value);
}

function isScale(value: string): value is RenderScale {
  return SCALE_OPTION_ORDER.some((scale) => scale === value);
}

function toFps(value: string): RenderFps | null {
  const fps = Number(value);
  return fps === 24 || fps === 30 || fps === 60 ? fps : null;
}

/** What the Render button submits: the persisted format/quality/fps plus this session's scale. */
export interface RenderSettings {
  format: RenderFormat;
  quality: RenderQuality;
  fps: RenderFps;
  scale: RenderScale;
}

export interface RenderSettingsState {
  settings: RenderSettings;
  update: (patch: Partial<RenderSettings>) => void;
}

export function useRenderSettings(): RenderSettingsState {
  const [settings, setSettings] = useState<RenderSettings>(() => ({
    ...getPersistedRenderSettings(),
    scale: "auto",
  }));
  const update = (patch: Partial<RenderSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    // Resolution follows the composition, so only the portable three persist.
    if (patch.format || patch.quality || patch.fps) {
      persistRenderSettings(next.format, next.quality, next.fps);
    }
  };
  return { settings, update };
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-ctl-sm grid-cols-[72px_minmax(0,1fr)] items-center gap-2 [&:lang(ru)]:grid-cols-[92px_minmax(0,1fr)]">
      <span className="whitespace-nowrap text-sm text-fg-3">{label}</span>
      {children}
    </div>
  );
}

/** "Uses current variable values · 1 overridden": what the render injects, with a way to edit it. */
function VariablesLine({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const overridden = usePreviewVariablesStore((state) =>
    state.values ? Object.keys(state.values).length : 0,
  );
  return (
    <div className="flex min-h-5 min-w-0 items-center gap-2 pl-20 [&:lang(ru)]:items-start [&:lang(ru)]:pl-[100px]">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-3 [&:lang(ru)]:items-start">
        <Sliders size={12} className="shrink-0" aria-hidden />
        <span className="truncate [&:lang(ru)]:overflow-visible [&:lang(ru)]:whitespace-normal">
          {overridden > 0 ? (
            <Trans
              i18nKey="renders.settings.variablesOverridden"
              values={{ count: overridden }}
              components={{ mono: <span className="font-mono text-num text-fg-2" /> }}
            />
          ) : (
            t("renders.settings.variablesDefault")
          )}
        </span>
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => useDockLayoutStore.getState().activatePanel("variables")}
        className="shrink-0 rounded-xs text-xs text-fg-2 underline decoration-border-strong underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-3 disabled:no-underline"
      >
        {t("renders.settings.editVariables")}
      </button>
    </div>
  );
}

/** The export form: resolution, frame rate, format and quality, on the prototype's label column. */
export function RenderSettingsForm({
  state,
  disabled,
  compositionDimensions,
}: {
  state: RenderSettingsState;
  disabled: boolean;
  compositionDimensions?: CompositionDimensions | null;
}) {
  const { t } = useTranslation();
  const { settings, update } = state;
  // MOV (ProRes) is a fixed-quality codec — the quality choice has no effect.
  const showQuality = settings.format !== "mov";

  return (
    <div className="grid gap-1.5 py-2.5">
      <FieldRow label={t("renders.settings.resolution")}>
        <Select
          label={t("renders.settings.resolution")}
          value={settings.scale}
          options={SCALE_OPTION_ORDER.map((value) => ({
            value,
            label: scaleOptionLabel(value, compositionDimensions),
            disabled: !scaleApplies(value, compositionDimensions),
          }))}
          disabled={disabled}
          onCommit={(next) => {
            if (isScale(next)) update({ scale: next });
          }}
        />
      </FieldRow>
      <FieldRow label={t("renders.settings.frameRate")}>
        <Select
          label={t("renders.settings.frameRate")}
          value={String(settings.fps)}
          options={FPS_VALUES.map((fps) => ({
            value: String(fps),
            label: t("renders.settings.fps", { fps }),
          }))}
          disabled={disabled}
          onCommit={(next) => {
            const fps = toFps(next);
            if (fps) update({ fps });
          }}
        />
      </FieldRow>
      <FieldRow label={t("renders.settings.format")}>
        <Select
          label={t("renders.settings.format")}
          value={settings.format}
          options={FORMAT_OPTIONS}
          disabled={disabled}
          onCommit={(next) => {
            if (isFormat(next)) update({ format: next });
          }}
        />
      </FieldRow>
      <p className="m-0 pl-20 text-xs text-fg-3 text-pretty [&:lang(ru)]:pl-[100px]">
        {t(FORMAT_NOTE_KEYS[settings.format])}
      </p>
      {showQuality && (
        <FieldRow label={t("renders.settings.quality")}>
          <SegmentedControl
            label={t("renders.settings.quality")}
            value={settings.quality}
            options={QUALITY_VALUES.map((value) => ({ value, label: t(QUALITY_KEYS[value]) }))}
            disabled={disabled}
            onChange={(quality) => update({ quality })}
            className="justify-self-start [&:lang(ru)]:w-full [&:lang(ru)>button]:min-w-0 [&:lang(ru)>button]:flex-1 [&:lang(ru)>button]:px-1.5"
          />
        </FieldRow>
      )}
      <VariablesLine disabled={disabled} />
    </div>
  );
}
