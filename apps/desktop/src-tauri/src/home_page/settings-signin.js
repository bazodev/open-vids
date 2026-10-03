/* Settings → Models & Providers: in-app OAuth sign-in. Routes (home → runtime):
   POST /api/agent/providers/:id/oauth/login {flow}   start, or the same running sign-in again
   GET  /api/agent/oauth/logins/:login                poll about once a second while one runs
   POST /api/agent/oauth/logins/:login/input {text}   answer a prompt / paste the code
   POST /api/agent/oauth/logins/:login/cancel
   POST /api/agent/providers/:id/oauth/logout         (in settings-providers.js)
   POST /api/open-external {url}                      open the authorization page in the default browser
   The webview has no IPC and a link from this loopback page doesn't reach the browser, so the page asks the
   shell. Everything the runtime says (instructions, prompts, errors, URLs) is untrusted: escaped, and an
   authUrl is only opened when it parses as https. A pasted code never goes into the markup. */
(function () {
  "use strict";
  const { esc, api, ui, CLICK, INPUT, ENTER, tr, msg, text } = OVS;

  /* A flow this page doesn't know is shown as the runtime names it. */
  const FLOW_KEYS = {
    browser: "settings.signin.flow.browser",
    device: "settings.signin.flow.device",
    paste: "settings.signin.flow.paste",
  };
  const RUNNING = ["pending", "needs_input"];
  const POLL_MS = 1000;
  /* Only open a page the user just asked for: a sign-in older than this is a resumed one. */
  const FRESH_MS = 15000;

  /* provider id → { starting, state: OAuthLoginState|null, error, fails, opened: login id }. In memory only. */
  const L = {};
  const isState = (v) => !!v && typeof v.id === "string" && typeof v.status === "string";
  const running = (pid) => {
    const l = L[pid];
    return !!l && (l.starting || (!!l.state && RUNNING.includes(l.state.status)));
  };
  const enc = encodeURIComponent;
  /* An OAuthLoginState has its own `error` text: its body is data even when it says so. */
  const call = (path, body, method) => api(path, body, method, { plainBody: true });
  const firstLine = (t) =>
    String(t || "")
      .split("\n")[0]
      .trim();

  /* ---------- opening the authorization page ---------- */
  /* https only, no credentials in the address: the same rule the shell applies again. */
  function httpsUrl(value) {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" && !u.username && !u.password && u.hostname ? u.href : null;
    } catch {
      return null;
    }
  }
  function openExternal(pid, value) {
    const url = httpsUrl(value);
    const l = L[pid];
    if (!url) {
      if (l) l.openError = msg("settings.signin.error.notSecure");
      return Promise.resolve();
    }
    return api("/api/open-external", { url })
      .then(() => {
        if (l) l.openError = null;
      })
      .catch((err) => {
        if (l)
          l.openError = msg("settings.signin.error.openFailed", { message: OV.describeError(err) });
      })
      .finally(() => OVS.render(true));
  }

  /* ---------- polling: one timer, only while a sign-in runs, the section shows and the window is visible ---------- */
  let timer = null;
  let polling = false;
  const runningIds = () => Object.keys(L).filter((pid) => running(pid) && L[pid].state);
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function schedule(delay) {
    stop();
    if (runningIds().length === 0 || !OVS.providersVisible() || document.hidden) return;
    timer = setTimeout(tick, delay == null ? POLL_MS : delay);
  }
  function tick() {
    timer = null;
    if (polling) return;
    polling = true;
    Promise.all(runningIds().map(poll)).finally(() => {
      polling = false;
      schedule();
    });
  }
  function poll(pid) {
    const l = L[pid];
    return call(`/api/agent/oauth/logins/${enc(l.state.id)}`)
      .then((st) => {
        if (L[pid] !== l) return;
        l.fails = 0;
        if (isState(st)) apply(pid, st);
      })
      .catch((err) => {
        if (L[pid] !== l) return;
        if (err.status === 404)
          apply(pid, Object.assign({}, l.state, { status: "expired", error: null }));
        else if (++l.fails >= 5)
          apply(
            pid,
            Object.assign({}, l.state, {
              status: "failed",
              error: null,
              lostContact: OV.describeError(err),
            }),
          );
      });
  }
  /* A new state: draw only if something changed (a redraw each second would disturb typing and screen readers). */
  function apply(pid, st) {
    const l = L[pid];
    const changed = JSON.stringify(l.state) !== JSON.stringify(st);
    l.state = st;
    if (st.authUrl && l.opened !== st.id) {
      l.opened = st.id;
      if (Date.now() - Number(st.startedAt || 0) < FRESH_MS) openExternal(pid, st.authUrl);
    }
    if (st.status === "succeeded") signedIn(pid);
    else if (changed) OVS.render(true);
  }
  /* Connected: providers and the model catalog are re-read exactly as after saving a key. */
  function signedIn(pid) {
    const l = L[pid];
    api("/api/agent/providers")
      .then((res) => {
        OVS.setProviders(res);
        ui.open[pid] = true;
        OVS.providersChanged();
      })
      .catch((err) => {
        ui.flags.providersNote = OVS.failMsg("settings.signin.error.reloadFailed", {
          message: OV.describeError(err),
        });
      })
      .finally(() => {
        if (L[pid] === l) delete L[pid];
        delete ui.draft[`oauth:${pid}`];
        OVS.render(true);
      });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule(0);
    else stop();
  });
  window.addEventListener("pagehide", stop);

  /* ---------- starting, answering, cancelling ---------- */
  const flowsOf = (p) => (p.oauth && Array.isArray(p.oauth.flows) ? p.oauth.flows : []);
  function chosenFlow(p) {
    const flows = flowsOf(p).map((f) => f.flow);
    const picked = ui.flags[`flow:${p.id}`];
    return flows.includes(picked) ? picked : flows[0];
  }
  function start(pid) {
    const p = OVS.providerById(pid);
    if (!p || flowsOf(p).length === 0 || running(pid)) return;
    const l = (L[pid] = { starting: true, state: null, error: null, fails: 0, opened: null });
    ui.open[pid] = true;
    ui.pendingFk = `signin-cancel:${pid}`;
    call(`/api/agent/providers/${enc(pid)}/oauth/login`, { flow: chosenFlow(p) })
      .then((st) => {
        if (L[pid] !== l) return;
        l.starting = false;
        if (!isState(st)) l.error = msg("settings.signin.error.unexpectedAnswer");
        else apply(pid, st);
      })
      .catch((err) => {
        if (L[pid] !== l) return;
        l.starting = false;
        l.error = OV.describeError(err);
      })
      .finally(() => {
        OVS.render(true);
        ui.pendingFk = null;
        schedule();
      });
  }
  function submit(pid) {
    const l = L[pid],
      st = l && l.state;
    if (!st || !st.prompt || l.sending) return;
    const key = `oauth:${pid}`,
      text = (ui.draft[key] || "").trim();
    // A required prompt may take a blank answer as its default; the paste fallback needs something to send.
    if (!text && st.prompt.optional) {
      l.inputError = msg("settings.signin.error.pasteFirst");
      return;
    }
    l.inputError = null;
    l.sending = true;
    call(`/api/agent/oauth/logins/${enc(st.id)}/input`, { text })
      .then((next) => {
        if (L[pid] !== l) return;
        delete ui.draft[key];
        if (isState(next)) apply(pid, next);
      })
      .catch((err) => {
        if (L[pid] === l) l.inputError = OV.describeError(err);
      })
      .finally(() => {
        l.sending = false;
        OVS.render(true);
        schedule();
      });
  }
  function cancel(pid) {
    const l = L[pid],
      st = l && l.state;
    if (!st) {
      delete L[pid];
      return;
    }
    l.cancelling = true;
    call(`/api/agent/oauth/logins/${enc(st.id)}/cancel`, undefined, "POST")
      .then((next) => {
        if (L[pid] === l && isState(next)) l.state = next;
      })
      .catch(() => {
        /* unknown or already over: show it as cancelled */
        if (L[pid] === l)
          l.state = Object.assign({}, l.state, { status: "cancelled", error: null });
      })
      .finally(() => {
        l.cancelling = false;
        delete ui.draft[`oauth:${pid}`];
        OVS.render(true);
      });
  }

  /* ---------- markup ---------- */
  const keyId = (pid) => esc(pid);
  /* The "Sign in…" button on a provider row (providers whose `oauth` is non-null only). A provider with more
     than one flow opens its body first, to choose; one flow starts at once. */
  function rowAction(p) {
    if (flowsOf(p).length === 0 || running(p.id)) return "";
    return `<button type="button" class="btn" data-act="signin-start" data-v="${keyId(p.id)}" data-row="1" data-fk="signin:${keyId(p.id)}">${esc(tr("settings.signin.start"))}</button>`;
  }
  function rowState(p) {
    const l = L[p.id];
    if (!l) return null;
    if (l.starting) return tr("settings.signin.state.starting");
    const st = l.state && l.state.status;
    return st === "succeeded"
      ? tr("settings.signin.state.finishing")
      : RUNNING.includes(st)
        ? st === "needs_input"
          ? tr("settings.signin.state.needsInput")
          : tr("settings.signin.state.waitingBrowser")
        : null;
  }
  /* In the body, before a sign-in runs: choice of flow (when more than one) and the button. */
  function startBlock(p) {
    const flows = flowsOf(p);
    if (flows.length === 0) return "";
    const id = keyId(p.id);
    const choice =
      flows.length > 1
        ? OVS.seg(
            flows.map((f) => [f.flow, FLOW_KEYS[f.flow] ? tr(FLOW_KEYS[f.flow]) : f.flow]),
            chosenFlow(p),
            "signin-flow",
            tr("settings.signin.methodAria", { provider: p.name }),
            p.id,
          )
        : "";
    const port = flows.find((f) => f.fixedPort && f.callbackPort);
    const foot =
      port && flows.length > 1
        ? OV.pt("settings.signin.footPort", { provider: p.name, port: String(port.callbackPort) })
        : OV.pt("settings.signin.foot", { provider: p.name });
    return (
      `<div class="st-inline">${choice}<button type="button" class="btn" data-act="signin-start" data-v="${id}" data-fk="signin-go:${id}">${esc(
        tr(L[p.id] ? "common.tryAgain" : "settings.signin.start"),
      )}</button></div>` + `<p class="st-foot">${esc(foot)}</p>`
    );
  }
  function promptBlock(pid, st) {
    const l = L[pid],
      pr = st.prompt,
      id = keyId(pid),
      err = l.inputError;
    return (
      `<label class="st-foot" for="signin-input-${id}">${esc(
        pr.optional ? tr("settings.signin.prompt.optional", { message: pr.message }) : pr.message,
      )}</label>` +
      `<div class="st-inline"><input id="signin-input-${id}" class="input mono${err ? " is-invalid" : ""}" type="${
        pr.secret ? "password" : "text"
      }" autocomplete="off" spellcheck="false" placeholder="${esc(pr.placeholder || "")}" data-act="signin-input" data-draft="oauth:${id}" data-v="${id}" data-fk="signin-input:${id}"${
        err ? ' aria-invalid="true" aria-describedby="err-signin-' + id + '"' : ""
      } /><button type="button" class="btn" data-act="signin-submit" data-v="${id}" data-fk="signin-submit:${id}"${
        l.sending ? " disabled" : ""
      }>${esc(l.sending ? tr("settings.signin.sending") : tr("common.continue"))}</button></div>` +
      (err
        ? `<p class="st-field-err" id="err-signin-${id}" role="alert">${esc(text(err))}</p>`
        : "")
    );
  }
  /* The sign-in in the provider's body: running, or how it ended. */
  function panel(p) {
    const l = L[p.id];
    if (!l) return "";
    const id = keyId(p.id);
    let inner;
    if (l.starting) {
      inner = `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(tr("settings.signin.starting"))}</span>`;
    } else if (!l.state) {
      inner = `<p class="st-field-err" role="alert">${esc(
        tr("settings.signin.startFailed", { reason: firstLine(text(l.error)) }),
      )}</p>`;
    } else {
      const st = l.state;
      if (RUNNING.includes(st.status)) {
        const device = st.flow === "device";
        const url = httpsUrl(st.authUrl);
        const waiting =
          st.status === "needs_input"
            ? ""
            : url
              ? tr(device ? "settings.signin.waiting.device" : "settings.signin.waiting.browser")
              : tr("settings.signin.preparing");
        const code =
          device && st.deviceCode
            ? `<div class="st-code-row"><code class="st-code" aria-label="${esc(tr("settings.signin.deviceCodeAria"))}">${esc(st.deviceCode)}</code><button type="button" class="btn btn-sm" data-act="signin-copy" data-v="${id}" data-fk="signin-copy:${id}">${esc(
                tr(ui.flags[`copied:${p.id}`] ? "common.copied" : "common.copy"),
              )}</button></div>`
            : "";
        /* The provider's own wording shows when there is no code to lift out of it. */
        const note =
          st.instructions && !(device && st.deviceCode)
            ? `<p class="st-foot">${esc(st.instructions)}</p>`
            : "";
        const links = url
          ? `<span class="st-signin-links"><button type="button" class="link" data-act="signin-open" data-v="${id}" data-fk="signin-open:${id}">${esc(
              tr(device ? "settings.signin.openVerification" : "settings.signin.openAgain"),
            )}</button><button type="button" class="link" data-act="signin-copy-link" data-v="${id}" data-fk="signin-copy-link:${id}">${esc(
              tr(
                ui.flags[`copiedLink:${p.id}`]
                  ? "settings.signin.linkCopied"
                  : "settings.signin.copyLink",
              ),
            )}</button></span>`
          : "";
        inner =
          (waiting
            ? `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(waiting)}</span>`
            : "") +
          code +
          note +
          (st.progress ? `<p class="st-foot">${esc(st.progress)}</p>` : "") +
          (st.prompt ? promptBlock(p.id, st) : "") +
          (l.openError
            ? `<p class="st-field-err" role="alert">${esc(text(l.openError))}</p>`
            : "") +
          `<div class="st-actions">${links}<button type="button" class="btn btn-ghost push" data-act="signin-cancel" data-v="${id}" data-fk="signin-cancel:${id}"${
            l.cancelling ? " disabled" : ""
          }>${esc(tr("common.cancel"))}</button></div>`;
      } else if (st.status === "succeeded") {
        inner = `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(tr("settings.signin.succeeded"))}</span>`;
      } else {
        const msgText =
          st.status === "cancelled"
            ? tr("settings.signin.cancelled")
            : st.status === "expired"
              ? tr("settings.signin.expired")
              : st.lostContact
                ? tr("settings.signin.lostContact", { message: st.lostContact })
                : st.error
                  ? tr("settings.signin.failedReason", { reason: firstLine(st.error) })
                  : tr("settings.signin.failed");
        inner = `<p class="${st.status === "failed" ? "st-field-err" : "st-foot"}" role="alert">${esc(msgText)}</p>`;
      }
    }
    return `<div class="st-signin" aria-live="polite">${inner}</div>`;
  }

  /* ---------- actions ---------- */
  CLICK["signin-start"] = (t) => {
    const pid = t.dataset.v,
      p = OVS.providerById(pid);
    if (!p) return;
    /* From the row with a choice to make: open the body first. */
    if (t.dataset.row && flowsOf(p).length > 1 && !ui.open[pid]) {
      ui.open[pid] = true;
      ui.pendingFk = `signin-go:${pid}`;
      return;
    }
    delete L[pid];
    start(pid);
  };
  CLICK["signin-flow"] = (t) => {
    ui.flags[`flow:${t.dataset.key}`] = t.dataset.v;
  };
  CLICK["signin-open"] = (t) => {
    const l = L[t.dataset.v];
    if (l && l.state) openExternal(t.dataset.v, l.state.authUrl);
  };
  function copy(text, flag) {
    const done = (ok) => {
      ui.flags[flag] = ok;
      OVS.render(true);
      setTimeout(() => {
        ui.flags[flag] = false;
        if (OVS.providersVisible()) OVS.render(true);
      }, 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  }
  CLICK["signin-copy"] = (t) => {
    const l = L[t.dataset.v];
    if (l && l.state && l.state.deviceCode) copy(l.state.deviceCode, `copied:${t.dataset.v}`);
  };
  CLICK["signin-copy-link"] = (t) => {
    const l = L[t.dataset.v],
      url = l && l.state && httpsUrl(l.state.authUrl);
    if (url) copy(url, `copiedLink:${t.dataset.v}`);
  };
  CLICK["signin-submit"] = (t) => submit(t.dataset.v);
  CLICK["signin-cancel"] = (t) => cancel(t.dataset.v);
  INPUT["signin-input"] = (t) => {
    ui.draft[t.dataset.draft] = t.value;
  };
  ENTER["signin-input"] = (t) => {
    submit(t.dataset.v);
    OVS.render(true);
  };

  OVS.signin = {
    running,
    rowAction,
    rowState,
    start: startBlock,
    panel,
    /* Back on the section: a sign-in that kept running meanwhile is polled again at once. */
    onEnter: () => schedule(0),
    stop,
  };
  OVS.ON_LEAVE.providers = stop;
})();
