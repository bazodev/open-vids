import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Copy, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { copyTextToClipboard } from "../../utils/clipboard";
import { isMacPlatform } from "../../utils/platform";
import { readOpenvidsHomeOrigin } from "../../utils/openvidsHost";
import type { FfmpegStatus } from "./useFfmpegStatus";
import { useTranslation } from "../../i18n";

const DOWNLOAD_URL = "https://ffmpeg.org/download.html";
const CUE_MS = 1600;

/**
 * Shown above Export when the dev server reports no usable FFmpeg.
 *
 * This exists because the failure it replaces was the single most reported
 * Studio problem: the user built a composition, pressed Export, and got
 * "Server error (503)". The encoder had never been installed, the server knew
 * that, and nothing said so. Saying it before the work starts, with a command
 * they can paste, is the whole point, so the command is the loudest element
 * here and not the apology.
 *
 * Inside the OpenVids desktop shell the install button lives on the Projects
 * page (onboarding's System step and Settings; the home server owns the
 * token-gated `/api/system/install/ffmpeg` route), so on Windows the notice
 * links back there instead of repeating the macOS/Homebrew wording. Studio
 * deliberately builds no second downloader: the link is the whole Windows
 * route.
 */
export const FfmpegRequiredNotice = memo(function FfmpegRequiredNotice({
  status,
  checking,
  onRecheck,
}: {
  status: FfmpegStatus;
  checking: boolean;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const homeOrigin = useMemo(() => readOpenvidsHomeOrigin(), []);
  // The server's command is authoritative: the dev server already maps the
  // platform to its install command, so a Homebrew line never renders from a
  // stale client-side assumption. `isMacPlatform` only decides whether the
  // Projects-page setup link (whose download button the home server owns)
  // applies: never on macOS, where the wording already fits.
  const showSetupLink = homeOrigin !== null && !isMacPlatform();
  // A recheck that finds nothing changes no other pixel on screen, so without
  // this the button reads as broken at the exact moment the user is most
  const [recheckFailed, setRecheckFailed] = useState(false);
  const wasChecking = useRef(false);
  const cueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // Still mounted after a check finished means the answer was "still no":
    // a success unmounts this card entirely.
    if (wasChecking.current && !checking) setRecheckFailed(true);
    wasChecking.current = checking;
  }, [checking]);

  useEffect(() => {
    if (!recheckFailed) return;
    cueTimer.current = setTimeout(() => setRecheckFailed(false), CUE_MS);
    return () => clearTimeout(cueTimer.current);
  }, [recheckFailed]);

  useEffect(() => () => clearTimeout(cueTimer.current), []);

  const copy = async (command: string) => {
    const ok = await copyTextToClipboard(command);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), CUE_MS);
  };

  // The prototype's warning note-box: a soft warning wash, the command as the
  // loudest element, Copy beside it, Check Again under it.
  return (
    <div
      role="alert"
      className="grid gap-1.5 rounded-md border border-warning/35 bg-warning-soft px-2.5 py-2 text-sm text-fg-2"
    >
      <p className="m-0 flex items-center gap-1.5 font-semibold text-fg">
        <WarningCircle size={12} weight="bold" className="shrink-0 text-warning" aria-hidden />
        {status.title ?? t("renders.ffmpeg.notFound")}
      </p>
      <p className="m-0 text-xs text-fg-2 text-pretty">
        {status.detail ?? t("renders.ffmpeg.required")}
      </p>

      {status.command ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="h-ctl-sm min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-sm border border-border-subtle bg-bg-0 px-2 font-mono text-num leading-[22px] text-fg">
            {status.command}
          </code>
          {/* Fixed width so swapping the label to "Copied" cannot shift the
              command block sideways under the pointer. */}
          <Button
            size="sm"
            icon={<Copy size={12} aria-hidden />}
            onClick={() => void copy(status.command ?? "")}
            className="min-w-[76px] justify-center"
          >
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
      ) : (
        status.hint && <p className="m-0 text-xs text-fg-2 text-pretty">{status.hint}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          icon={<ArrowsClockwise size={12} aria-hidden />}
          onClick={onRecheck}
          disabled={checking}
        >
          {checking ? t("renders.ffmpeg.checking") : t("renders.ffmpeg.checkAgain")}
        </Button>
        {showSetupLink && homeOrigin ? (
          <button
            type="button"
            className="rounded-xs text-xs text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            onClick={() => {
              window.location.href = homeOrigin;
            }}
          >
            {t("renders.ffmpeg.openProjectsSetup")}
          </button>
        ) : (
          <a
            href={DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-xs text-xs text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {t("renders.ffmpeg.otherOptions")}
          </a>
        )}
        {/* Last in the row and only ever appended, so appearing and vanishing
            moves nothing that sits before it. */}
        <span aria-live="polite" className="ml-auto text-xs text-fg-2">
          {recheckFailed ? t("renders.ffmpeg.stillNotFound") : ""}
        </span>
      </div>
    </div>
  );
});
