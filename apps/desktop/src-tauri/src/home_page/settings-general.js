/* Settings → General and Appearance: the shared app preferences file (GET/PUT /api/preferences).
   Theme and density are applied at once to this window and (by message) to the Projects page underneath. */
(function () {
  "use strict";
  const { ic, esc, api, S, PAGES, CLICK, CHANGE, tr, row, group, sw, seg, select, opts, head } =
    OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

  /* Sizes are data (width × height · ratio); every word around them is a message. */
  const FORMATS = [
    ["1920x1080", "1920 × 1080 · 16:9"],
    ["3840x2160", "3840 × 2160 · 16:9"],
    ["1080x1920", "1080 × 1920 · 9:16"],
    ["1080x1080", "1080 × 1080 · 1:1"],
    ["1080x1350", "1080 × 1350 · 4:5"],
  ];
  /* 23.976 and 29.97 are deliberately absent: Studio preview and export cannot honour them. */
  const FPS = [24, 25, 30, 60];

  /* Preference saves are queued so a late answer never replaces a newer one. */
  let queue = Promise.resolve();
  function savePrefs(patch, rollback) {
    queue = queue.then(() =>
      api("/api/preferences", patch, "PUT")
        .then((next) => {
          S.prefs = next;
          S.prefsNote = "";
          OVS.post({ type: "ov-prefs", prefs: next });
        })
        .catch((err) => {
          S.prefsNote = OVS.failMsg("settings.note.saveFailed", { message: OV.describeError(err) });
          if (rollback) rollback();
        })
        .finally(() => OVS.render(true)),
    );
  }
  function loadPrefs() {
    S.prefsError = null;
    return api("/api/preferences")
      .then((p) => {
        S.prefs = p;
        OV.applyDensity(p.density);
      })
      .catch((err) => {
        S.prefsError = OV.describeError(err);
      })
      .finally(() => OVS.render(true));
  }

  /* ---------- Updates: the home server's /api/update/* (status, check, install) ---------- */
  /* Polled phases; "ready" only while the app is restarting (otherwise the update waits parked for the user). */
  const isActive = (st) =>
    st.phase === "checking" ||
    st.phase === "downloading" ||
    (st.phase === "ready" && st.restarting !== false);
  const POLL_MS = 700;
  /* Phases in which a "Restart anyway?" question no longer applies. */
  const SETTLED = ["idle", "checking", "upToDate", "downloading", "failed"];
  let pollTimer = 0,
    pollFails = 0,
    statusInFlight = false,
    loadFailed = false;
  S.update = null;
  S.updateError = null;
  S.updateBusy = null;
  S.updatePending = false;

  function stopPoll() {
    clearTimeout(pollTimer);
    pollTimer = 0;
  }
  function schedulePoll() {
    stopPoll();
    if (OVS.section() !== "general" || !S.update || !isActive(S.update)) return;
    pollTimer = setTimeout(loadUpdate, POLL_MS);
  }
  /* A fresh status: redraw only when it differs, so a select the user has open is not closed by every poll. */
  function applyUpdate(st) {
    if (!st || typeof st.phase !== "string") return;
    const same = JSON.stringify(st) === JSON.stringify(S.update);
    S.update = st;
    pollFails = 0;
    if (SETTLED.includes(st.phase)) S.updateBusy = null;
    if (!same) OVS.render(true);
    schedulePoll();
  }
  function loadUpdate() {
    if (statusInFlight) return Promise.resolve();
    statusInFlight = true;
    /* A failed status carries its own `error` text: it is data here, not a refused request. */
    return api("/api/update/status", undefined, undefined, { plainBody: true })
      .then((st) => {
        if (loadFailed) S.updateError = null;
        loadFailed = false;
        applyUpdate(st);
      })
      .catch((err) => {
        /* The app restarts itself after "ready": a few unanswered polls are expected, a long silence is shown. */
        pollFails += 1;
        if (!S.update || pollFails >= 5) {
          S.updateError = err;
          loadFailed = true;
          stopPoll();
          OVS.render(true);
        } else schedulePoll();
      })
      .finally(() => {
        statusInFlight = false;
      });
  }
  /* A request the user started (check / install): its answer is the new status; a refusal carries one too. */
  function updateRequest(path, body) {
    S.updateError = null;
    S.updatePending = true;
    return api(path, body, undefined, { plainBody: true })
      .then(applyUpdate)
      .catch((err) => {
        const st = err.data && err.data.status;
        if (st) applyUpdate(st);
        if (err.code === "update_busy") S.updateBusy = err.params || {};
        else {
          S.updateError = err;
          if (!st) loadUpdate();
        }
      })
      .finally(() => {
        S.updatePending = false;
        OVS.render(true);
        schedulePoll();
      });
  }

  /* The status line of the Updates group, by phase. */
  function updateRows(st) {
    const phase = st ? st.phase : "idle";
    const btn = (act, label, primary, disabled) =>
      `<button type="button" class="btn${primary ? " btn-primary" : ""}" data-act="${act}" data-fk="${act}"${
        disabled || S.updatePending ? " disabled" : ""
      }>${te(label)}</button>`;
    const spin = '<i class="spinner"></i>';
    const install = (disabled) =>
      btn("update-install", "settings.general.updates.install", true, disabled);
    if (phase === "checking")
      return row(
        spin + te("settings.general.updates.checking"),
        null,
        btn("update-check", "settings.general.updates.check", false, true),
      );
    if (phase === "upToDate")
      return row(
        te("settings.general.updates.upToDate"),
        null,
        btn("update-check", "settings.general.updates.checkAgain"),
      );
    if (phase === "available") {
      const date = st.date ? new Date(st.date) : null;
      const released =
        date && !Number.isNaN(date.getTime())
          ? te("settings.general.updates.released", {
              date: new Intl.DateTimeFormat(OVI18N.language(), { dateStyle: "medium" }).format(
                date,
              ),
            })
          : null;
      const notes =
        typeof st.notes === "string" && st.notes.trim()
          ? `<div class="st-sub"><div class="st-notes" tabindex="0" role="region" aria-label="${te(
              "settings.general.updates.notes.aria",
            )}">${esc(st.notes.trim())}</div></div>`
          : "";
      return (
        row(
          te("settings.general.updates.available", { version: st.version }),
          released,
          install(false),
        ) + notes
      );
    }
    if (phase === "downloading") {
      const total = typeof st.total === "number" && st.total > 0 ? st.total : 0;
      const done = Math.max(0, Number(st.downloaded) || 0);
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const label = total
        ? te("settings.general.updates.downloading", {
            downloaded: OV.formatBytes(done),
            total: OV.formatBytes(total),
          })
        : te("settings.general.updates.downloadingUnknown", { downloaded: OV.formatBytes(done) });
      const bar = total
        ? `<div class="st-bar" role="progressbar" aria-label="${te(
            "settings.general.updates.progress.aria",
          )}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`
        : `<div class="st-bar is-indeterminate" role="progressbar" aria-label="${te(
            "settings.general.updates.progress.aria",
          )}"><i></i></div>`;
      return row(label, null, install(true)) + `<div class="st-sub">${bar}</div>`;
    }
    if (phase === "ready" && st.restarting === false)
      return row(
        te("settings.general.updates.downloaded", { version: st.version }),
        null,
        btn("update-install", "settings.general.updates.restart", true),
      );
    if (phase === "ready")
      return row(spin + te("settings.general.updates.installing"), null, install(true));
    if (phase === "failed")
      return row(
        `<span class="st-upd-err">${esc(OV.describeError(st))}</span>`,
        null,
        btn("update-check", "settings.failure.tryAgain"),
      );
    return row(
      te("settings.general.updates.idle"),
      null,
      btn("update-check", "settings.general.updates.check"),
    );
  }
  /* An install refused because the open project is busy: ask, then re-send with force. */
  function busyConfirm() {
    return `<div class="st-sub st-upd-busy" role="alert"><p>${te(
      "settings.general.updates.busy",
    )}</p><div class="st-actions"><button type="button" class="btn btn-primary" data-act="update-force" data-fk="update-force"${
      S.updatePending ? " disabled" : ""
    }>${te("settings.general.updates.busy.restart")}</button><button type="button" class="btn" data-act="update-busy-cancel" data-fk="update-busy-cancel">${te(
      "common.cancel",
    )}</button></div></div>`;
  }
  function updateNote() {
    const err = S.updateError;
    if (!err) return "";
    return OVS.noteHtml(
      err.code
        ? "!" + OV.describeError(err)
        : OVS.failMsg("settings.general.updates.requestFailed", {
            message: OV.describeError(err) || String(err),
          }),
    );
  }
  function updatesGroup(prefs) {
    const st = S.update;
    return (
      group(
        te("settings.general.group.updates"),
        row(
          te("settings.general.updates.version"),
          null,
          `<span class="mono st-upd-ver">${esc(st ? st.currentVersion : "—")}</span>`,
        ) +
          row(
            te("settings.general.autoUpdate"),
            null,
            sw(
              prefs.updates && prefs.updates.autoCheck,
              "auto-update",
              tr("settings.general.autoUpdate"),
            ),
          ) +
          row(
            te("settings.general.telemetry"),
            te("settings.general.telemetry.hint"),
            sw(
              prefs.telemetry && prefs.telemetry.enabled,
              "telemetry",
              tr("settings.general.telemetry"),
            ),
          ) +
          updateRows(st) +
          (S.updateBusy ? busyConfirm() : ""),
      ) + updateNote()
    );
  }

  PAGES.general = function () {
    const title = tr("settings.section.general");
    if (!S.prefs)
      return (
        head(title) +
        (S.prefsError
          ? OVS.failure("settings.failure.preferences", S.prefsError, "prefs-retry")
          : OVS.loading("settings.loading.preferences"))
      );
    const prefs = S.prefs,
      np = prefs.newProject,
      fmt = np.width + "x" + np.height;
    const formats = FORMATS.some((f) => f[0] === fmt)
      ? FORMATS
      : FORMATS.concat([
          [
            fmt,
            tr("settings.general.format.custom", {
              width: String(np.width),
              height: String(np.height),
            }),
          ],
        ]);
    const fpsOptions = FPS.map((n) => [n, tr("settings.general.fps", { fps: n })]);
    return (
      head(title) +
      OVS.noteHtml(S.prefsNote) +
      group(
        te("settings.general.group.newProjects"),
        row(
          te("settings.general.location"),
          null,
          `<div class="loc"><span class="path" title="${esc(np.location)}">${ic("folder")}${esc(
            np.location,
          )}</span></div><button type="button" class="btn" data-act="choose-location" data-fk="choose-location">${te(
            "settings.general.chooseLocation",
          )}</button>`,
        ) +
          row(
            te("settings.general.openIn"),
            null,
            seg(
              [
                ["media", tr("settings.general.openIn.media")],
                ["story", tr("settings.general.openIn.story")],
                ["edit", tr("settings.general.openIn.edit")],
              ],
              np.openIn,
              "np",
              tr("settings.general.openIn.aria"),
              "openIn",
            ),
          ) +
          row(
            te("settings.general.format"),
            null,
            select(opts(formats, fmt), "np-format", tr("settings.general.format.aria")),
          ) +
          row(
            te("settings.general.frameRate"),
            null,
            select(opts(fpsOptions, np.fps), "np-fps", tr("settings.general.frameRate.aria")),
          ),
        `<span class="note">${te("settings.general.newProjectsNote")}</span>`,
      ) +
      group(
        te("settings.general.group.app"),
        row(
          OVI18N.t("settings.language.label"),
          null,
          select(
            opts(
              [["system", OVI18N.t("settings.language.system")]].concat(
                OVI18N.languages().map((l) => [l.code, l.name]),
              ),
              prefs.language || "system",
            ),
            "language",
            OVI18N.t("settings.language.label"),
          ),
        ) +
          row(
            te("settings.general.onLaunch"),
            null,
            select(
              opts(
                [
                  ["last", tr("settings.general.onLaunch.last")],
                  ["projects", tr("settings.general.onLaunch.projects")],
                ],
                prefs.onLaunch,
              ),
              "launch",
              tr("settings.general.onLaunch"),
            ),
          ) +
          row(
            esc(OV.pt("settings.general.confirmTrash")),
            null,
            sw(prefs.confirmTrash, "confirm-trash", esc(OV.pt("settings.general.confirmTrash"))),
          ),
      ) +
      updatesGroup(prefs)
    );
  };

  PAGES.appearance = function () {
    /* What is on screen now (applied before the save returns), not the last saved value. */
    const theme = OV.themePref(),
      density = OV.densityPref();
    const tiles = ["system", "dark", "light"]
      .map(
        (id) =>
          `<button type="button" class="st-theme" data-v="${id}" aria-pressed="${theme === id}" data-act="theme" data-fk="theme:${id}">${
            id === "system"
              ? '<i class="theme-dark"><span class="theme-light"></span></i>'
              : `<i class="theme-${id}"></i>`
          }${te(`settings.appearance.theme.${id}`)}</button>`,
      )
      .join("");
    return (
      head(tr("settings.section.appearance")) +
      OVS.noteHtml(S.prefsNote) +
      group(
        te("settings.appearance.group.interface"),
        row(
          te("settings.appearance.theme"),
          null,
          `<div class="st-themes" role="group" aria-label="${te("settings.appearance.theme")}">${tiles}</div>`,
        ) +
          row(
            te("settings.appearance.density"),
            density === "compact"
              ? te("settings.appearance.density.hint.compact")
              : te("settings.appearance.density.hint.default"),
            seg(
              [
                ["compact", tr("settings.appearance.density.compact")],
                ["default", tr("settings.appearance.density.default")],
              ],
              density,
              "density",
              tr("settings.appearance.density.aria"),
            ),
          ),
      )
    );
  };

  CLICK["prefs-retry"] = () => {
    loadPrefs();
  };
  CLICK.np = (t) => savePrefs({ newProject: { [t.dataset.key]: t.dataset.v } });
  CLICK["confirm-trash"] = () => {
    if (S.prefs) savePrefs({ confirmTrash: !S.prefs.confirmTrash });
  };
  CLICK["auto-update"] = () => {
    if (S.prefs)
      savePrefs({ updates: { autoCheck: !(S.prefs.updates && S.prefs.updates.autoCheck) } });
  };
  CLICK.telemetry = () => {
    if (S.prefs)
      savePrefs({ telemetry: { enabled: !(S.prefs.telemetry && S.prefs.telemetry.enabled) } });
  };
  CLICK["update-check"] = () => {
    S.updateBusy = null;
    updateRequest("/api/update/check", {});
  };
  CLICK["update-install"] = () => {
    updateRequest("/api/update/install", {});
  };
  CLICK["update-force"] = () => {
    S.updateBusy = null;
    updateRequest("/api/update/install", { force: true });
  };
  CLICK["update-busy-cancel"] = () => {
    S.updateBusy = null;
  };
  CLICK["choose-location"] = () => {
    api("/api/pick-parent", {})
      .then((r) => {
        if (!r.cancelled) savePrefs({ newProject: { location: r.path } });
      })
      .catch((err) => {
        S.prefsNote = "!" + OV.describeError(err);
        OVS.render(true);
      });
  };
  CLICK.theme = (t) => {
    const prev = OV.themePref(),
      next = t.dataset.v;
    if (next === prev) return;
    OV.applyTheme(next);
    OVS.post({ type: "ov-theme", pref: next });
    savePrefs({ theme: next }, () => {
      OV.applyTheme(prev);
      OVS.post({ type: "ov-theme", pref: prev });
    });
  };
  CLICK.density = (t) => {
    const prev = OV.densityPref(),
      next = t.dataset.v;
    if (next === prev) return;
    OV.applyDensity(next);
    OVS.post({ type: "ov-density", pref: next });
    savePrefs({ density: next }, () => {
      OV.applyDensity(prev);
      OVS.post({ type: "ov-density", pref: prev });
    });
  };
  CHANGE["np-format"] = (t) => {
    const [w, h] = t.value.split("x").map(Number);
    savePrefs({ newProject: { width: w, height: h } });
  };
  CHANGE["np-fps"] = (t) => savePrefs({ newProject: { fps: Number(t.value) } });
  CHANGE.launch = (t) => savePrefs({ onLaunch: t.value });
  CHANGE.language = (t) => {
    const prev = (S.prefs && S.prefs.language) || "system";
    if (t.value === prev) return;
    OVI18N.setLanguage(t.value);
    OVS.post({ type: "ov-language", pref: t.value });
    savePrefs({ language: t.value }, () => {
      OVI18N.setLanguage(prev);
      OVS.post({ type: "ov-language", pref: prev });
    });
  };
  /* The catalog loaded or the language changed: the General page's language row follows. */
  window.addEventListener("ov-language", () => OVS.render(true));

  OVS.loadPrefs = loadPrefs;
  OVS.ON_ENTER.general = () => {
    loadUpdate();
  };
  OVS.ON_LEAVE.general = stopPoll;
})();
