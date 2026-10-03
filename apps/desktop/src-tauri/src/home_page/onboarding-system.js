/* Onboarding step 4 — System check. GET /api/system/check lists Chrome, FFmpeg and ffprobe; a missing tool with
   `canInstall` gets an Install button driven by GET/POST /api/system/install/<tool> (+ /cancel), polled while it
   runs. The tool row is generic: it lights up for any tool whose check says canInstall and whose install state
   arrives in `install[<tool>]`. FFmpeg is installed through Homebrew on macOS and through an official-build
   download on Windows, and provides ffprobe too, so the two are one install (ffprobe has no button of its own).
   Every string from the check or the installer is escaped. */
(function () {
  "use strict";
  const { ic, esc, api, CLICK, group, tr } = OVS;
  const { title } = OVOB;

  /* Tool names are proper nouns; why is a catalog key. `with`: the tool whose installer provides this one. */
  const TOOLS = [
    { id: "chrome", name: "Chrome", why: "onboarding.system.tool.chrome.why" },
    { id: "ffmpeg", name: "FFmpeg", why: "onboarding.system.tool.ffmpeg.why" },
    {
      id: "ffprobe",
      name: "ffprobe",
      why: "onboarding.system.tool.ffprobe.why",
      with: "ffmpeg",
    },
  ];
  /* What to run by hand when the page can't install (macOS: Homebrew). */
  const COMMANDS = { ffmpeg: "brew install ffmpeg" };
  const SOURCES = {
    openvids: "onboarding.system.source.openvids",
    env: "onboarding.system.source.env",
    system: "onboarding.system.source.system",
  };
  const RUNNING = ["checking", "downloading", "installing"];
  const POLL_MS = 500;

  /* check: the last answer · inst: install state per tool · error: why the check couldn't run. */
  const Y = { check: null, error: null, loading: false, inst: {}, copied: null };
  const running = (key) => !!Y.inst[key] && RUNNING.includes(Y.inst[key].phase);
  /* An install state has its own `error` text: its body is data even when it says so. */
  const call = (path, method) => api(path, undefined, method, { plainBody: true });
  const route = (key) => `/api/system/install/${encodeURIComponent(key)}`;

  /* ---------- data ---------- */
  function check() {
    if (Y.loading) return;
    Y.loading = true;
    Y.error = null;
    OVS.render(true);
    api("/api/system/check")
      .then((res) => {
        Y.check = res;
        const inst = (res && res.install) || {};
        Object.keys(inst).forEach((k) => {
          Y.inst[k] = inst[k];
        });
      })
      .catch((err) => {
        Y.error = OV.describeError(err);
      })
      .finally(() => {
        Y.loading = false;
        OVS.render(true);
        schedule(0);
      });
  }

  /* ---------- polling: one timer, only while an install runs, this step shows and the window is visible ---------- */
  let timer = null,
    polling = false;
  const runningKeys = () => Object.keys(Y.inst).filter(running);
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function schedule(delay) {
    stop();
    if (!runningKeys().length || !OVOB.isStep("system") || document.hidden) return;
    timer = setTimeout(tick, delay == null ? POLL_MS : delay);
  }
  function tick() {
    timer = null;
    if (polling) return;
    polling = true;
    let finished = false;
    Promise.all(
      runningKeys().map((key) =>
        call(route(key), "GET")
          .then((st) => {
            const before = Y.inst[key] && Y.inst[key].phase;
            Y.inst[key] = st;
            if (RUNNING.includes(before) && st.phase === "done") finished = true;
          })
          .catch((err) => {
            Y.inst[key] = {
              phase: "failed",
              error: null,
              lostContact: OV.describeError(err),
            };
          }),
      ),
    ).finally(() => {
      polling = false;
      OVS.render(true);
      /* Installed: look again, so the row shows the path and version it found. */
      if (finished) {
        Y.loading = false;
        check();
      } else schedule();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule(0);
    else stop();
  });
  window.addEventListener("pagehide", stop);

  function install(key) {
    if (running(key)) return;
    Y.inst[key] = { phase: "checking", downloaded: null, total: null, error: null, detail: null };
    call(route(key), "POST")
      .then((st) => {
        Y.inst[key] = st;
      })
      .catch((err) => {
        Y.inst[key] = { phase: "failed", error: err.message, code: err.code, params: err.params };
      })
      .finally(() => {
        OVS.render(true);
        schedule(0);
      });
  }
  function cancel(key) {
    call(`${route(key)}/cancel`, "POST")
      .then((st) => {
        Y.inst[key] = st;
      })
      .catch(() => {
        Y.inst[key] = { phase: "cancelled", error: null };
      })
      .finally(() => OVS.render(true));
  }

  /* ---------- markup ---------- */
  const loaderSrc = () =>
    document.documentElement.dataset.theme === "light"
      ? "/assets/mark-loader-light.svg"
      : "/assets/mark-loader.svg";
  function phaseText(st) {
    if (st.phase === "checking") return tr("onboarding.system.phase.checking");
    if (st.phase === "installing") return tr("onboarding.system.phase.installing");
    if (st.phase === "downloading") {
      const d = Number(st.downloaded),
        t = Number(st.total);
      if (t > 0 && d >= 0)
        return tr("onboarding.system.phase.downloadingOf", {
          downloaded: OV.formatBytes(d),
          total: OV.formatBytes(t),
        });
      if (d > 0)
        return tr("onboarding.system.phase.downloadingSome", { downloaded: OV.formatBytes(d) });
      return tr("onboarding.system.phase.downloading");
    }
    return "";
  }
  function runBlock(st) {
    const t = Number(st.total),
      d = Number(st.downloaded);
    const pct = t > 0 && d >= 0 ? Math.min(100, Math.round((d / t) * 100)) : null;
    return `<div class="ob-run" role="status"><img class="ob-loader" src="${loaderSrc()}" alt="" /><span class="st-preset-note">${esc(
      phaseText(st),
    )}</span></div>${
      pct == null
        ? ""
        : `<div class="ob-bar" role="progressbar" aria-label="${esc(tr("onboarding.system.progressAria"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`
    }${st.detail ? `<p class="ob-detail" title="${esc(st.detail)}">${esc(st.detail)}</p>` : ""}`;
  }
  /* The check says what Homebrew would run and what to tell the user; the constants are only a fallback. */
  const brew = () => (Y.check && Y.check.homebrew) || {};
  const commandFor = (key) =>
    key === "ffmpeg" ? brew().installCommand || COMMANDS.ffmpeg : COMMANDS[key];
  const copyRow = (cmd, key) =>
    `<div class="st-inline"><code class="ob-cmd">${esc(cmd)}</code><button type="button" class="btn btn-sm" data-act="ob-copy" data-v="${esc(
      cmd,
    )}" data-fk="ob-copy:${esc(key)}">${esc(tr(Y.copied === cmd ? "common.copied" : "common.copy"))}</button></div>`;
  /* A message with <tag>…</tag> markup, escaped; wrappers build the HTML of each tag. */
  const rich = (key, params, wrappers) => OVI18N.rich(key, params, wrappers);

  function toolRow(t) {
    const c = Y.check[t.id] || {},
      key = t.with || t.id,
      parent = t.with ? Y.check[t.with] || {} : null,
      st = Y.inst[key];
    const label = `<div class="st-label"><b>${esc(t.name)}</b><span>${esc(tr(t.why))}</span>`;
    if (c.found) {
      const bits = [
        c.version && tr("onboarding.system.version", { version: c.version }),
        c.source && SOURCES[c.source] && tr(SOURCES[c.source]),
      ].filter(Boolean);
      return `<div class="ob-tool">${label}${c.path ? `<span class="mono" title="${esc(c.path)}">${esc(c.path)}</span>` : ""}${
        bits.length ? `<span>${esc(bits.join(" · "))}</span>` : ""
      }</div><div class="st-ctl"><span class="status success">${ic("check")}${esc(tr("onboarding.system.found"))}</span></div></div>`;
    }
    /* Missing: what is happening, or what can be done. */
    let ctl = "",
      extra = "",
      sub = "";
    const own = !t.with || (parent && parent.found); /* ffprobe installs through FFmpeg's button */
    const canInstall = own && !!c.canInstall;
    if (t.with && !own) {
      sub = `<span>${esc(tr("onboarding.system.comesWith", { tool: TOOLS.find((x) => x.id === t.with).name }))}</span>`;
    }
    if (c.systemPath && !c.found)
      sub += `<span>${rich(
        "onboarding.system.chromeAt",
        { path: c.systemPath },
        { path: (inner) => `<span class="mono">${inner}</span>` },
      )}</span>`;
    if (st && RUNNING.includes(st.phase)) {
      ctl = own
        ? `<button type="button" class="btn" data-act="ob-sys-cancel" data-v="${esc(key)}" data-fk="ob-sys-cancel:${esc(key)}">${esc(tr("common.cancel"))}</button>`
        : `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(tr("onboarding.system.phase.installing"))}</span>`;
      if (own) extra = runBlock(st);
    } else {
      const failed = own && !!st && st.phase === "failed",
        cancelled = own && !!st && st.phase === "cancelled";
      const button = canInstall
        ? `<button type="button" class="btn" data-act="ob-sys-install" data-v="${esc(key)}" data-fk="ob-sys-install:${esc(key)}">${esc(
            failed
              ? tr("common.tryAgain")
              : tr(
                  c.installer === "homebrew"
                    ? "onboarding.system.installHomebrew"
                    : c.installer === "download"
                      ? "onboarding.system.installDownload"
                      : "onboarding.system.install",
                ),
          )}</button>`
        : "";
      ctl = `<span class="status ${failed ? "error" : "warning"}">${ic("alert")}${esc(
        tr(
          failed
            ? "onboarding.system.installFailed"
            : cancelled
              ? "onboarding.system.cancelled"
              : "onboarding.system.missing",
        ),
      )}</span>${button}`;
      if (failed)
        extra += `<p class="st-field-err" role="alert">${esc(
          st && st.lostContact
            ? tr("onboarding.system.lostContact", { message: st.lostContact })
            : String(OV.describeError(st) || tr("onboarding.system.installFailedMessage")),
        )}</p>`;
      if (canInstall && c.installer === "homebrew" && !failed)
        extra += `<p class="st-foot">${
          brew().note
            ? esc(brew().note).replace(/`([^`]*)`/g, '<code class="mono">$1</code>')
            : rich(
                "onboarding.system.brewRuns",
                { command: commandFor("ffmpeg") },
                { code: (inner) => `<code class="mono">${inner}</code>` },
              )
        }</p>`;
      if (canInstall && c.installer === "download" && !failed)
        extra += `<p class="st-foot">${rich(
          "onboarding.system.downloadRuns",
          { size: "115 MB" },
          {
            link: (inner) =>
              `<button type="button" class="link" data-act="ob-open-ffmpeg" data-fk="ob-open-ffmpeg">${inner}</button>`,
          },
        )}</p>`;
      /* By hand: no installer here, or the installer failed. */
      const cmd = own && Y.check.platform === "macos" ? commandFor(key) : null;
      if (cmd && (!canInstall || failed)) {
        const noBrew = c.installer == null && !canInstall && key === "ffmpeg";
        extra +=
          copyRow(cmd, key) +
          `<p class="st-foot">${rich(
            noBrew
              ? failed
                ? "onboarding.system.orRunItNoBrew"
                : "onboarding.system.runItNoBrew"
              : failed
                ? "onboarding.system.orRunIt"
                : "onboarding.system.runIt",
            {},
            {
              action: (inner) =>
                `<button type="button" class="link" data-act="ob-open-brew" data-fk="ob-open-brew">${inner}</button>`,
            },
          )}</p>`;
      } else if (own && !canInstall && !cmd && !t.with)
        extra += `<p class="st-foot">${esc(tr("onboarding.system.installYourself", { tool: t.name }))}</p>`;
    }
    return `<div class="ob-tool">${label}${sub}</div><div class="st-ctl">${ctl}</div>${
      extra ? `<div class="ob-tool-extra">${extra}</div>` : ""
    }</div>`;
  }

  const allFound = () => TOOLS.every((t) => Y.check && Y.check[t.id] && Y.check[t.id].found);

  OVOB.steps.system = {
    label: "onboarding.step.system",
    skipWhenDone: true,
    done: () => (Y.check ? allFound() : Y.error ? false : null),
    load: () => check(),
    enter: () => {
      if (!Y.loading) check();
    },
    leave: stop,
    stop,
    view() {
      const head = title(tr("onboarding.system.title"), tr("onboarding.system.lede"));
      const speech = `<p class="st-foot">${esc(tr("onboarding.system.speech"))}</p>`;
      const meta = `<button type="button" class="btn btn-sm push" data-act="ob-sys-check" data-fk="ob-sys-check"${
        Y.loading ? " disabled" : ""
      }>${
        Y.loading
          ? `<i class="spinner" aria-hidden="true"></i>${esc(tr("onboarding.system.phase.checking"))}`
          : esc(tr("onboarding.system.checkAgain"))
      }</button>`;
      if (!Y.check)
        return (
          head +
          (Y.error
            ? OVS.failure("onboarding.failure.systemCheck", Y.error, "ob-sys-check") +
              `<p class="st-foot">${esc(tr("onboarding.system.continueAnyway"))}</p>`
            : OVS.loading("onboarding.loading.systemCheck")) +
          speech
        );
      return (
        head +
        OVS.noteHtml(
          Y.error ? OVS.failMsg("onboarding.system.checkAgainFailed", { message: Y.error }) : "",
        ) +
        group(esc(tr("onboarding.system.group.tools")), TOOLS.map(toolRow).join(""), meta) +
        speech
      );
    },
    primary: () => ({
      label: "common.continue",
      kind: Y.check && allFound() ? "primary" : "secondary",
    }),
  };

  CLICK["ob-sys-check"] = () => {
    check();
    return false;
  };
  CLICK["ob-sys-install"] = (t) => install(t.dataset.v);
  CLICK["ob-sys-cancel"] = (t) => cancel(t.dataset.v);
  CLICK["ob-open-brew"] = () => {
    /* Opened by the shell only if it is an https address. */
    api("/api/open-external", { url: brew().url || "https://brew.sh" }).catch(() => {});
  };
  CLICK["ob-open-ffmpeg"] = () => {
    api("/api/open-external", { url: "https://www.gyan.dev/ffmpeg/builds/" }).catch(() => {});
  };
  CLICK["ob-copy"] = (t) => {
    const cmd = t.dataset.v;
    const done = (ok) => {
      Y.copied = ok ? cmd : null;
      OVS.render(true);
      setTimeout(() => {
        Y.copied = null;
        if (OVOB.isStep("system")) OVS.render(true);
      }, 1500);
    };
    try {
      navigator.clipboard.writeText(cmd).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  };
})();
