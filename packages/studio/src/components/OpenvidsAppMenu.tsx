import { useState } from "react";
import {
  ArrowClockwise,
  DownloadSimple,
  Flag,
  FolderOpen,
  GearSix,
  House,
  Info,
  Power,
} from "@phosphor-icons/react";
import { useTranslation } from "../i18n";
import { openSettings } from "./settings/settingsStore";
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  OpenvidsMark,
  Tooltip,
} from "./ui";
import { invokeHomeMenuAction, readHomeAbout, type HomeAboutInfo } from "../utils/openvidsHost";
import { resolveShortcutKey } from "../utils/platform";

/**
 * The app menu button for the Windows frameless frame (`openvidsFrame=custom`).
 * The hidden native menu has no mouse path there, so this dropdown carries the
 * same actions: Open Project, Show All Projects, Settings, Reload, Welcome,
 * Check for Updates, About, Quit. Each row takes the same path as its native
 * / shortcut twin — project-scoped rows navigate or reload the document like
 * the back button and the shortcuts hook do, the rest go through
 * `POST /api/menu/:action` (the shared `menu_action` in Rust), and About reads
 * `GET /api/menu/about` into a page-level sheet (the webview cannot show the
 * native About dialog). Rendered only on the custom frame: macOS keeps its
 * real menu bar, the system-frame fallback keeps the native bar too.
 */
export function OpenvidsAppMenu({ homeOrigin }: { homeOrigin: string }) {
  const { t } = useTranslation();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [about, setAbout] = useState<HomeAboutInfo | null>(null);

  const goHome = () => {
    window.location.href = homeOrigin;
  };
  const openAbout = () => {
    void readHomeAbout(homeOrigin).then((info) => {
      setAbout(info);
      setAboutOpen(true);
    });
  };

  return (
    <>
      {/* Same 52 px slot as the macOS traffic-light inset, without its class: the overlay test
        asserts the inset is gone on the custom frame, and this button is what replaces it. */}
      <span className="mr-3 flex shrink-0 items-center justify-center" style={{ width: 52 }}>
        <Tooltip label={t("menu.app.menu")} side="bottom">
          <Menu
            align="start"
            aria-label={t("menu.app.menu")}
            trigger={
              <IconButton
                aria-label={t("menu.app.menu")}
                data-testid="openvids-app-menu"
                icon={<OpenvidsMark height={16} />}
              />
            }
          >
            <MenuItem
              icon={<FolderOpen size={14} aria-hidden />}
              shortcut={resolveShortcutKey("⌘O")}
              onClick={() => void invokeHomeMenuAction(homeOrigin, "open_project")}
            >
              {t("menu.file.openProject")}
            </MenuItem>
            <MenuItem
              icon={<House size={14} aria-hidden />}
              shortcut={resolveShortcutKey("⇧⌘O")}
              onClick={goHome}
            >
              {t("menu.file.showAllProjects")}
            </MenuItem>
            <MenuItem
              icon={<GearSix size={14} />}
              shortcut={resolveShortcutKey("⌘,")}
              onClick={() => openSettings()}
            >
              {t("menu.file.settings")}
            </MenuItem>
            <MenuItem
              icon={<ArrowClockwise size={14} aria-hidden />}
              shortcut={resolveShortcutKey("⌘R")}
              onClick={() => window.location.reload()}
            >
              {t("menu.view.reload")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Flag size={14} aria-hidden />}
              onClick={() => void invokeHomeMenuAction(homeOrigin, "welcome")}
            >
              {t("menu.help.welcome")}
            </MenuItem>
            <MenuItem
              icon={<DownloadSimple size={14} aria-hidden />}
              onClick={() => void invokeHomeMenuAction(homeOrigin, "check_updates")}
            >
              {t("menu.app.checkForUpdates")}
            </MenuItem>
            <MenuItem icon={<Info size={14} aria-hidden />} onClick={openAbout}>
              {t("menu.app.about")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Power size={14} aria-hidden />}
              onClick={() => void invokeHomeMenuAction(homeOrigin, "quit")}
            >
              {t("menu.app.quit")}
            </MenuItem>
          </Menu>
        </Tooltip>
      </span>
      <Dialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title={about?.name ?? "OpenVids"}
        description={about?.version ? t("menu.app.version", { version: about.version }) : undefined}
        footer={
          <Button variant="primary" size="sm" onClick={() => setAboutOpen(false)}>
            {t("common.close")}
          </Button>
        }
      >
        {about?.comment ? <p className="m-0 text-sm text-fg-2">{about.comment}</p> : null}
        {about?.credits ? (
          <p className="m-0 text-xs whitespace-pre-line text-fg-3">{about.credits}</p>
        ) : null}
        {about?.website ? (
          <p className="m-0 text-sm">
            <a
              href={about.website}
              target="_blank"
              rel="noreferrer"
              className="rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {about.websiteLabel ?? about.website}
            </a>
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
