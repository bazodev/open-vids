import { useRef, useEffect, memo } from "react";
import gsap from "gsap";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { CaretLeft, CaretRight, CornersIn, CornersOut, Repeat } from "@phosphor-icons/react";
import { formatFrameTime, formatTime, stepFrameTime, STUDIO_PREVIEW_FPS } from "../lib/time";
import { liveTime, usePlayerStore } from "../store/playerStore";
import { IconButton, Tooltip, buttonBase, cn } from "../../components/ui";
import { useTranslation } from "../../i18n";
import { resolveShortcutKey } from "../../utils/platform";
import { useMountEffect } from "../../hooks/useMountEffect";
import { ShortcutsPanel } from "./ShortcutsPanel";
import type { ShortcutSection } from "./studioShortcuts";
import { SpeedMenu } from "./SpeedMenu";
import { VolumeControl } from "./VolumeControl";

gsap.registerPlugin(MorphSVGPlugin);

// Play triangle and pause bars share one 0-100 coordinate space so MorphSVG can
// tween one `d` into the other; the svg viewBox frames both.
const PLAY_D = "M58 28L88 49.5L58 71Z";
const PAUSE_BARS_D = "M56 28H67V71H56Z M73 28H84V71H73Z";

// Morph play <-> pause on toggle via GSAP MorphSVG. The initial render matches
// `playing` with no animation, and prefers-reduced-motion snaps instead of tweening.
function PlayPauseMorphIcon({ playing }: { playing: boolean }) {
  const pathRef = useRef<SVGPathElement>(null);
  const isFirstRun = useRef(true);
  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const target = playing ? PAUSE_BARS_D : PLAY_D;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (isFirstRun.current || reduceMotion) {
      isFirstRun.current = false;
      gsap.set(el, { morphSVG: target });
      return;
    }
    const tween = gsap.to(el, { duration: 0.28, ease: "power2.inOut", morphSVG: target });
    return () => {
      tween.kill();
    };
  }, [playing]);
  return (
    <svg width="12" height="12" viewBox="46 21 54 56" fill="currentColor" aria-hidden="true">
      <path ref={pathRef} d={playing ? PAUSE_BARS_D : PLAY_D} />
    </svg>
  );
}

interface PlayerControlsProps {
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  disabled?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Replaces the shortcuts panel's list, e.g. DEFAULT_SHORTCUT_SECTIONS with entries dropped or relabelled. */
  shortcutSections?: readonly ShortcutSection[];
}

/** The viewer's transport bar: timecode, frame step / play / loop, and the playback tools. */
export const PlayerControls = memo(function PlayerControls({
  onTogglePlay,
  onSeek,
  disabled = false,
  isFullscreen = false,
  onToggleFullscreen,
  shortcutSections,
}: PlayerControlsProps) {
  const { t } = useTranslation();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const duration = usePlayerStore((s) => s.duration);
  const timelineReady = usePlayerStore((s) => s.timelineReady);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const audioMuted = usePlayerStore((s) => s.audioMuted);
  const audioVolume = usePlayerStore((s) => s.audioVolume);
  const loopEnabled = usePlayerStore((s) => s.loopEnabled);
  const setPlaybackRate = usePlayerStore.getState().setPlaybackRate;
  const setAudioMuted = usePlayerStore.getState().setAudioMuted;
  const setAudioVolume = usePlayerStore.getState().setAudioVolume;
  const setLoopEnabled = usePlayerStore.getState().setLoopEnabled;
  const inPoint = usePlayerStore((s) => s.inPoint);
  const outPoint = usePlayerStore((s) => s.outPoint);
  const setInPoint = usePlayerStore.getState().setInPoint;
  const setOutPoint = usePlayerStore.getState().setOutPoint;
  const timeDisplayMode = usePlayerStore((s) => s.timeDisplayMode);
  const setTimeDisplayMode = usePlayerStore.getState().setTimeDisplayMode;

  const timeDisplayRef = useRef<HTMLSpanElement>(null);
  const currentTimeRef = useRef(0);
  const timeDisplayModeRef = useRef(timeDisplayMode);
  timeDisplayModeRef.current = timeDisplayMode;

  const durationRef = useRef(duration);
  durationRef.current = duration;
  const controlsDisabled = disabled || !timelineReady;

  useEffect(() => {
    if (!timeDisplayRef.current) return;
    const time = currentTimeRef.current;
    timeDisplayRef.current.textContent =
      timeDisplayMode === "frame" ? formatFrameTime(time, duration) : formatTime(time);
  }, [duration, timeDisplayMode]);

  useMountEffect(() => {
    const updateTime = (time: number) => {
      currentTimeRef.current = time;
      if (!timeDisplayRef.current) return;
      const currentDuration = durationRef.current;
      const text =
        timeDisplayModeRef.current === "frame"
          ? formatFrameTime(time, currentDuration)
          : formatTime(time);
      if (timeDisplayRef.current.textContent !== text) timeDisplayRef.current.textContent = text;
    };
    const unsubscribe = liveTime.subscribe(updateTime);
    updateTime(usePlayerStore.getState().currentTime);
    return unsubscribe;
  });

  return (
    <div
      className="grid h-row-lg grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-t border-border-subtle bg-bg-1 pr-1.5 pl-3"
      aria-disabled={disabled || undefined}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <Tooltip
        label={
          timeDisplayMode === "time"
            ? t("player.controls.showFrames")
            : t("player.controls.showTimecode")
        }
        side="top"
      >
        <button
          type="button"
          onClick={() => setTimeDisplayMode(timeDisplayMode === "time" ? "frame" : "time")}
          disabled={disabled}
          className="-ml-1.5 flex h-ctl max-w-full min-w-0 items-baseline gap-2 justify-self-start overflow-hidden rounded-sm px-1.5 pt-[5px] text-left whitespace-nowrap transition-colors hover:bg-surface-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none [&:hover>span+span]:text-fg-2"
        >
          <span
            ref={timeDisplayRef}
            data-testid="preview-timecode"
            className="font-mono text-tc font-medium tracking-[0.02em] tabular-nums text-fg"
          >
            {formatTime(0)}
          </span>
          {timeDisplayMode === "time" ? (
            <span className="font-mono text-xs tabular-nums text-fg-3">{formatTime(duration)}</span>
          ) : null}
        </button>
      </Tooltip>

      <div
        className="flex items-center gap-0.5"
        role="group"
        aria-label={t("player.controls.transport")}
      >
        <Tooltip label={t("player.controls.prevFrame")} shortcut="←">
          <IconButton
            aria-label={t("player.controls.prevFrame")}
            disabled={controlsDisabled}
            icon={<CaretLeft size={14} />}
            onClick={() => onSeek(stepFrameTime(currentTimeRef.current, -1, STUDIO_PREVIEW_FPS))}
          />
        </Tooltip>
        <Tooltip
          label={isPlaying ? t("player.controls.pause") : t("player.controls.play")}
          shortcut="Space"
        >
          <button
            type="button"
            aria-label={isPlaying ? t("player.controls.pause") : t("player.controls.play")}
            onClick={() => {
              onTogglePlay();
            }}
            disabled={controlsDisabled}
            className={cn(
              buttonBase,
              "mx-0.5 h-ctl w-[38px] rounded-md border-border-strong bg-surface-2 p-0 text-fg",
              "enabled:hover:bg-surface-3 enabled:active:bg-surface-3 disabled:text-fg-disabled",
            )}
          >
            <PlayPauseMorphIcon playing={isPlaying} />
          </button>
        </Tooltip>
        <Tooltip label={t("player.controls.nextFrame")} shortcut="→">
          <IconButton
            aria-label={t("player.controls.nextFrame")}
            disabled={controlsDisabled}
            icon={<CaretRight size={14} />}
            onClick={() => onSeek(stepFrameTime(currentTimeRef.current, 1, STUDIO_PREVIEW_FPS))}
          />
        </Tooltip>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <Tooltip label={t("player.controls.loop")} shortcut={resolveShortcutKey("⇧L")}>
          <IconButton
            aria-label={
              loopEnabled ? t("player.controls.loopDisable") : t("player.controls.loopEnable")
            }
            aria-pressed={loopEnabled}
            disabled={disabled}
            icon={<Repeat size={16} />}
            onClick={() => setLoopEnabled(!loopEnabled)}
          />
        </Tooltip>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-0.5">
        <SpeedMenu
          playbackRate={playbackRate}
          setPlaybackRate={setPlaybackRate}
          disabled={disabled}
        />
        <VolumeControl
          audioMuted={audioMuted}
          audioVolume={audioVolume}
          disabled={controlsDisabled}
          setAudioMuted={setAudioMuted}
          setAudioVolume={setAudioVolume}
        />
        <ShortcutsPanel
          disabled={disabled}
          duration={duration}
          inPoint={inPoint}
          outPoint={outPoint}
          setInPoint={setInPoint}
          setOutPoint={setOutPoint}
          onSeek={onSeek}
          sections={shortcutSections}
        />
        {onToggleFullscreen && (
          <Tooltip
            label={
              isFullscreen ? t("player.controls.fullscreenExit") : t("player.controls.fullscreen")
            }
            shortcut="F"
          >
            <IconButton
              aria-label={
                isFullscreen
                  ? t("player.controls.fullscreenExitAria")
                  : t("player.controls.fullscreenEnterAria")
              }
              aria-pressed={isFullscreen}
              icon={isFullscreen ? <CornersIn size={16} /> : <CornersOut size={16} />}
              onClick={() => onToggleFullscreen()}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
});
