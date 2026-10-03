import { useRef, useState } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select, type SelectOption } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { LANGUAGES, useTranslation, type TranslationKey } from "../../i18n";
import { platformKey } from "../../utils/platform";
import {
  APP_LANGUAGES,
  NEW_PROJECT_FPS,
  useAppPreferences,
  type AppPreferencesPatch,
  type LaunchMode,
  type NewProjectPreferences,
  type NewProjectWorkspace,
} from "./appPreferences";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsUnavailable } from "./settingsLayout";

const WORKSPACE_LABELS: Record<NewProjectWorkspace, TranslationKey> = {
  media: "settings.general.openIn.media",
  story: "settings.general.openIn.story",
  edit: "settings.general.openIn.edit",
};

const WORKSPACES = ["media", "story", "edit"] as const satisfies readonly NewProjectWorkspace[];

const FORMATS: { width: number; height: number; label: string }[] = [
  { width: 1920, height: 1080, label: "1920 × 1080 · 16:9" },
  { width: 3840, height: 2160, label: "3840 × 2160 · 16:9" },
  { width: 1080, height: 1920, label: "1080 × 1920 · 9:16" },
  { width: 1080, height: 1080, label: "1080 × 1080 · 1:1" },
];

const LAUNCH_LABELS: Record<LaunchMode, TranslationKey> = {
  last: "settings.general.onLaunch.last",
  projects: "settings.general.onLaunch.projects",
};

const LAUNCH_MODES = ["last", "projects"] as const satisfies readonly LaunchMode[];

/** A format the file holds that is not one of the presets is still shown, as itself. */
function formatOptions({ width, height }: NewProjectPreferences): SelectOption[] {
  const options = FORMATS.map((format) => ({
    value: `${format.width}x${format.height}`,
    label: format.label,
  }));
  const current = `${width}x${height}`;
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${width} × ${height}` });
  }
  return options;
}

function LocationField({
  location,
  onCommit,
}: {
  location: string;
  onCommit: (location: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  // Set synchronously by the commit that runs on blur, read by the wrapper's blur right after it.
  const rejected = useRef(false);

  if (editing) {
    return (
      <div
        className="flex min-w-0 flex-col items-end gap-1"
        onBlur={() => {
          if (!rejected.current) {
            setInvalid(false);
            setEditing(false);
          }
          rejected.current = false;
        }}
      >
        <Input
          size="md"
          autoFocus
          aria-label={t("settings.studio.general.locationLabel")}
          value={location}
          invalid={invalid}
          spellCheck={false}
          className="w-64 font-mono text-num"
          onCommit={(next) => {
            const path = next.trim();
            // Mirrors the server's `isLocation` shape check: POSIX absolute
            // everywhere, drive-letter/UNC additionally on Windows.
            rejected.current =
              !path.startsWith("/") &&
              !path.startsWith("~") &&
              !/^[A-Za-z]:([\\/]|$)/.test(path) &&
              !path.startsWith("\\\\");
            setInvalid(rejected.current);
            if (rejected.current) return;
            setEditing(false);
            onCommit(path);
          }}
        />
        {invalid && (
          <p role="alert" className="m-0 text-xs text-error">
            {t("settings.studio.general.locationInvalid")}
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      <span
        title={location}
        className="flex h-ctl min-w-0 max-w-60 items-center gap-1.5 rounded-md border border-border bg-bg-0 px-2.5 font-mono text-num text-fg-2"
      >
        <FolderSimple aria-hidden className="size-icon-sm shrink-0 text-fg-3" />
        <span className="truncate">{location}</span>
      </span>
      <Button onClick={() => setEditing(true)}>{t("settings.studio.general.change")}</Button>
    </>
  );
}

/** App-wide defaults from the preferences file the Projects page shares. */
export function GeneralSection() {
  const { t } = useTranslation();
  const preferences = useAppPreferences((state) => state.preferences);
  const loadFailed = useAppPreferences((state) => state.loadFailed);
  const error = useAppPreferences((state) => state.error);
  const load = useAppPreferences((state) => state.load);
  const update = useAppPreferences((state) => state.update);

  if (!preferences) {
    return (
      <SettingsPage title={t("settings.section.general")}>
        <SettingsUnavailable
          message={
            loadFailed
              ? t("settings.studio.general.unavailable")
              : t("settings.loading.preferences")
          }
          action={
            loadFailed ? (
              <Button size="sm" onClick={() => void load()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const { newProject } = preferences;
  const workspaceOptions = WORKSPACES.map((value) => ({
    value,
    label: t(WORKSPACE_LABELS[value]),
  }));
  const fpsOptions: SelectOption[] = NEW_PROJECT_FPS.map((fps) => ({
    value: String(fps),
    label: t("settings.general.fps", { fps }),
  }));
  const launchOptions = LAUNCH_MODES.map((value) => ({ value, label: t(LAUNCH_LABELS[value]) }));
  const save = (patch: AppPreferencesPatch) => void update(patch);
  const saveProject = (patch: Partial<NewProjectPreferences>) => save({ newProject: patch });

  return (
    <SettingsPage title={t("settings.section.general")}>
      <SettingsGroup
        label={t("settings.general.group.newProjects")}
        note={t("settings.general.newProjectsNote")}
      >
        <SettingsRow label={t("settings.general.location")}>
          <LocationField
            location={newProject.location}
            onCommit={(location) => saveProject({ location })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.general.openIn")}>
          <SegmentedControl
            label={t("settings.general.openIn.aria")}
            value={newProject.openIn}
            options={workspaceOptions}
            onChange={(openIn) => saveProject({ openIn })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.general.format")}>
          <Select
            size="md"
            label={t("settings.general.format.aria")}
            className="min-w-[150px]"
            value={`${newProject.width}x${newProject.height}`}
            options={formatOptions(newProject)}
            onCommit={(next) => {
              const [width, height] = next.split("x").map(Number);
              if (width && height) saveProject({ width, height });
            }}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.general.frameRate")}>
          <Select
            size="md"
            label={t("settings.general.frameRate.aria")}
            className="min-w-[150px]"
            value={String(newProject.fps)}
            options={fpsOptions}
            onCommit={(next) => {
              const fps = NEW_PROJECT_FPS.find((choice) => String(choice) === next);
              if (fps) saveProject({ fps });
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label={t("settings.general.group.app")}>
        <SettingsRow label={t("settings.language.label")}>
          <Select
            size="md"
            label={t("settings.language.label")}
            className="min-w-[150px]"
            value={preferences.language}
            options={[
              { value: "system", label: t("settings.language.system") },
              ...LANGUAGES.map(({ code, name }) => ({ value: code, label: name })),
            ]}
            onCommit={(next) => {
              const language = APP_LANGUAGES.find((code) => code === next);
              if (language) save({ language });
            }}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.general.onLaunch")}>
          <Select
            size="md"
            label={t("settings.general.onLaunch")}
            className="min-w-[150px]"
            value={preferences.onLaunch}
            options={launchOptions}
            onCommit={(next) => {
              const onLaunch = LAUNCH_MODES.find((mode) => mode === next);
              if (onLaunch) save({ onLaunch });
            }}
          />
        </SettingsRow>
        <SettingsRow label={t(platformKey("settings.general.confirmTrash"))}>
          <Toggle
            label={t(platformKey("settings.general.confirmTrash"))}
            checked={preferences.confirmTrash}
            onCommit={(confirmTrash) => save({ confirmTrash })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.general.autoUpdate")}>
          <Toggle
            label={t("settings.general.autoUpdate")}
            checked={preferences.updates.autoCheck}
            onCommit={(autoCheck) => save({ updates: { autoCheck } })}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.general.telemetry")}
          hint={t("settings.general.telemetry.hint")}
        >
          <Toggle
            label={t("settings.general.telemetry")}
            checked={preferences.telemetry.enabled}
            onCommit={(enabled) => save({ telemetry: { enabled } })}
          />
        </SettingsRow>
      </SettingsGroup>
      {error && (
        <p role="alert" className="mx-0.5 mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
