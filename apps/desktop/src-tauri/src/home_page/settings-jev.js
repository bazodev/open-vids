/* Settings → Jev: the shared fast worker. Its fields are agents.jev in the global agent settings
   (GET/PUT /api/agent/settings: enabled, provider, modelId, thinking, credentials "provider-login" | "api-key"),
   its own API key (POST /api/agent/jev/api-key {apiKey|null}; the key is never returned, only apiKeyConfigured)
   and a live check (POST /api/agent/jev/test). Models of the chosen provider: GET /api/agent/providers/:id/models. */
(function () {
  "use strict";
  const { ic, esc, api, S, ui, PAGES, CLICK, CHANGE, tr, msg, text, row, group } = OVS;
  const { sw, select, opts, head, lede } = OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

  /* Labels are settings.jev.effort.<level> (read when drawn); a level this page doesn't know shows as it is. */
  const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effortLabel = (level) =>
    EFFORT_LEVELS.includes(level) ? tr(`settings.jev.effort.${level}`) : level;
  /* Jev runs short jobs: when a provider is picked, start from its quick model rather than leave Jev without one. */
  const FAST_MODEL = /(^|[-_/.: ])(haiku|mini|flash|lite|nano|small|instant)([-_/.: ]|$)/i;

  const jevModels = (id) => (id ? S.provModels[id] : null);
  const jevModelInfo = (j) => {
    const m = jevModels(j.provider);
    return m && m.status === "ready" ? m.models.find((x) => x.modelId === j.modelId) || null : null;
  };
  const clearTest = () => {
    ui.flags.jevTest = null;
  };

  function providerOptions(j, keyMode) {
    const list = OVS.providerList();
    const items = list.map((p) => {
      const label =
        p.status === "connected"
          ? p.name
          : p.status === "signin_required"
            ? tr("settings.jev.provider.needsSignin", { provider: p.name })
            : p.status === "error"
              ? tr("settings.jev.provider.error", { provider: p.name })
              : tr("settings.jev.provider.notSetUp", { provider: p.name });
      /* With Jev's own key any provider will do; with the agents' connection only a connected one can. */
      return [p.id, label, !keyMode && !p.authenticated && p.id !== j.provider];
    });
    if (j.provider && !list.some((p) => p.id === j.provider))
      items.unshift([j.provider, j.provider]);
    if (!j.provider) items.unshift(["", tr("settings.jev.provider.choose"), true]);
    return opts(items, j.provider || "");
  }

  function modelRow(j) {
    const m = jevModels(j.provider);
    let ctl,
      sub = null;
    if (!j.provider) {
      ctl = select(
        opts([["", tr("settings.jev.model.chooseProviderFirst"), true]], ""),
        "jev-model",
        tr("settings.jev.modelAria"),
        null,
        "",
        true,
      );
    } else if (!m || m.status === "loading") {
      ctl = select(
        opts([["", tr("settings.providers.models.loading"), true]], ""),
        "jev-model",
        tr("settings.jev.modelAria"),
        null,
        "",
        true,
      );
    } else if (m.status === "failed") {
      ctl = select(
        opts([["", tr("settings.jev.model.unavailable"), true]], ""),
        "jev-model",
        tr("settings.jev.modelAria"),
        null,
        "",
        true,
      );
      sub = `<span class="status error">${ic("alert")}${esc(m.error)} · <button type="button" class="link" data-act="jev-models-retry" data-fk="jev-models-retry">${te("common.retry")}</button></span>`;
    } else if (m.models.length === 0) {
      ctl = select(
        opts([["", tr("settings.jev.model.none"), true]], ""),
        "jev-model",
        tr("settings.jev.modelAria"),
        null,
        "",
        true,
      );
    } else {
      const items = m.models.map((x) => [x.modelId, x.name || x.modelId]);
      if (!j.modelId) items.unshift(["", tr("settings.jev.model.choose"), true]);
      else if (!m.models.some((x) => x.modelId === j.modelId))
        items.push([j.modelId, tr("settings.jev.model.unavailableItem", { model: j.modelId })]);
      ctl = select(opts(items, j.modelId || ""), "jev-model", tr("settings.jev.modelAria"));
    }
    return row(te("settings.jev.model"), sub, ctl);
  }

  function thinkingRow(j) {
    const info = jevModelInfo(j);
    if (!info || !info.efforts || info.efforts.length === 0) return "";
    const values = ["off"].concat(info.efforts.filter((e) => e !== "off"));
    if (j.thinking && !values.includes(j.thinking)) values.push(j.thinking);
    return row(
      te("settings.jev.thinking"),
      null,
      select(
        opts(
          [["", tr("settings.jev.effort.default")]].concat(values.map((e) => [e, effortLabel(e)])),
          j.thinking || "",
        ),
        "jev-thinking",
        tr("settings.jev.thinkingAria"),
      ),
    );
  }

  function credentialBlock(j, prov) {
    const name = prov ? prov.name : j.provider || tr("settings.jev.providerFallback");
    if (prov && prov.keyless && j.credentials !== "api-key")
      return row(
        te("settings.jev.key"),
        te("settings.jev.key.notNeededHint"),
        `<span class="status success">${ic("check")}${te("settings.jev.key.notNeeded")}</span>`,
      );
    const radio = (mode, label, hint) =>
      `<button type="button" class="st-radio" role="radio" aria-checked="${j.credentials === mode}" data-act="jev-cred" data-v="${mode}" data-fk="jev-cred:${mode}"><span class="st-label"><b>${label}</b><span>${hint}</span></span></button>`;
    const radios = `<div class="st-choice" role="radiogroup" aria-label="${te("settings.jev.credentialAria")}">${radio(
      "provider-login",
      te("settings.jev.credential.provider", { provider: name }),
      te("settings.jev.credential.providerHint"),
    )}${radio("api-key", te("settings.jev.credential.key"), te("settings.jev.credential.keyHint"))}</div>`;
    if (j.credentials !== "api-key") return radios;
    const busy = ui.busy.jev;
    if (j.apiKeyConfigured && !ui.flags.jevReplace) {
      const status = busy
        ? `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(text(busy))}</span>`
        : `<span class="status success">${ic("check")}${te("settings.jev.key.saved")}</span>`;
      return (
        radios +
        row(
          te("settings.jev.key"),
          `<span class="mono">••••••••••••</span> · ${te("settings.jev.key.savedHint")}`,
          `${status}<button type="button" class="btn" data-act="jev-replace" data-fk="jev-replace"${
            busy ? " disabled" : ""
          }>${te("settings.jev.key.replace")}</button><button type="button" class="btn btn-ghost" data-act="jev-remove" data-fk="jev-remove"${
            busy ? " disabled" : ""
          }>${te("common.remove")}</button>`,
        )
      );
    }
    const err = ui.err.jev;
    return (
      radios +
      `<div class="st-sub"><div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="password" autocomplete="off" spellcheck="false" placeholder="${te(
        "settings.jev.key.placeholder",
        { provider: name },
      )}" aria-label="${te("settings.jev.key.aria")}" data-act="key-input" data-v="jev" data-draft="jev" data-fk="key:jev"${
        err ? ' aria-invalid="true" aria-describedby="err-jev"' : ""
      } /><button type="button" class="btn" data-act="jev-save" data-fk="jev-save"${busy ? " disabled" : ""}>${
        busy ? esc(text(busy)) : te("common.save")
      }</button>${
        j.apiKeyConfigured
          ? `<button type="button" class="btn btn-ghost" data-act="jev-replace-cancel" data-fk="jev-replace-cancel">${te("common.cancel")}</button>`
          : ""
      }</div>${err ? `<p class="st-field-err" id="err-jev" role="alert">${esc(text(err))}</p>` : ""}<p class="st-foot">${esc(OV.pt("settings.key.foot"))}</p></div>`
    );
  }

  function checkBlock() {
    const t = ui.flags.jevTest,
      busy = !!(t && t.busy);
    const seconds = new Intl.NumberFormat(OVI18N.language(), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format((Number(t && t.elapsedMs) || 0) / 1000);
    const status = busy
      ? `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${te("settings.jev.test.running")}</span>`
      : t && t.ok
        ? `<span class="status success">${ic("check")}${te("settings.jev.test.replied", { seconds })}</span>`
        : t
          ? `<span class="status error">${ic("alert")}${te("settings.jev.test.failed")}</span>`
          : "";
    const detail =
      t && t.ok
        ? `<div class="st-sub"><pre class="st-err-log">${esc(t.model && t.model.modelId)}\n${esc(t.reply)}</pre></div>`
        : t && !busy
          ? `<div class="st-sub"><p class="st-field-err" role="alert">${esc(t.message || tr("settings.jev.test.failedMessage"))}</p></div>`
          : "";
    return (
      row(
        te("settings.jev.test"),
        te("settings.jev.test.hint"),
        `<span aria-live="polite">${status}</span><button type="button" class="btn" data-act="jev-test" data-fk="jev-test"${
          busy ? " disabled" : ""
        }>${te("settings.jev.test.button")}</button>`,
      ) + detail
    );
  }

  PAGES.jev = function () {
    const intro = lede("settings.jev.lede");
    const title = tr("settings.section.jev");
    if (!S.agents)
      return (
        head(title) +
        intro +
        (S.agentsError
          ? OVS.failure("settings.failure.agentRuntime", S.agentsError, "agents-retry")
          : OVS.loading("settings.loading.jev"))
      );
    const j = S.agents.jev,
      prov = OVS.providerById(j.provider),
      keyMode = j.credentials === "api-key";
    const warn = !keyMode && OVS.providerBad(prov) ? OVS.providerWarn(prov) : null;
    return (
      head(title) +
      intro +
      OVS.noteHtml(S.agentsNote) +
      group(
        te("settings.jev.group.worker"),
        row(
          te("settings.jev.use"),
          te("settings.jev.use.hint"),
          sw(j.enabled, "jev-on", tr("settings.jev.use")),
        ) +
          row(
            te("settings.jev.provider"),
            warn,
            select(
              providerOptions(j, keyMode),
              "jev-provider",
              tr("settings.jev.providerAria"),
              null,
              warn ? "is-warn" : "",
            ),
          ) +
          modelRow(j) +
          thinkingRow(j),
      ) +
      group(te("settings.jev.group.credential"), credentialBlock(j, prov)) +
      group(te("settings.jev.group.check"), checkBlock())
    );
  };

  /* ---------- actions ---------- */
  const patchJev = (jev) => {
    clearTest();
    return OVS.saveAgents({ jev });
  };
  CLICK["jev-on"] = () => {
    const next = !S.agents.jev.enabled;
    patchJev({ enabled: next });
  };
  CLICK["jev-cred"] = (t) => {
    if (S.agents.jev.credentials === t.dataset.v) return;
    ui.flags.jevReplace = false;
    patchJev({ credentials: t.dataset.v });
  };
  CLICK["jev-models-retry"] = () => {
    if (S.agents.jev.provider) OVS.loadModels(S.agents.jev.provider);
  };
  CLICK["jev-replace"] = () => {
    ui.flags.jevReplace = true;
    ui.pendingFk = "key:jev";
  };
  CLICK["jev-replace-cancel"] = () => {
    ui.flags.jevReplace = false;
    delete ui.draft.jev;
    delete ui.err.jev;
    ui.pendingFk = "jev-replace";
  };
  CLICK["jev-save"] = () => jevSave();
  CLICK["jev-remove"] = () => {
    ui.busy.jev = msg("settings.jev.busy.removing");
    delete ui.err.jev;
    ui.pendingFk = "key:jev";
    clearTest();
    api("/api/agent/jev/api-key", { apiKey: null })
      .then(applyKeyResult)
      .catch((err) => {
        ui.err.jev = OV.describeError(err);
        ui.flags.jevReplace = false;
      })
      .finally(() => {
        delete ui.busy.jev;
        OVS.render(true);
        ui.pendingFk = null;
      });
  };
  CLICK["jev-test"] = () => {
    if (ui.flags.jevTest && ui.flags.jevTest.busy) return;
    ui.flags.jevTest = { busy: true };
    api("/api/agent/jev/test", {})
      .then((r) => {
        ui.flags.jevTest = r;
      })
      .catch((err) => {
        ui.flags.jevTest = { ok: false, message: OV.describeError(err) };
      })
      .finally(() => OVS.render(true));
  };
  function applyKeyResult(next) {
    S.agents = next;
    delete ui.draft.jev;
    delete ui.err.jev;
    ui.flags.jevReplace = false;
    OVS.post({ type: "ov-agents" });
  }
  /* The key leaves the page in this one request: once the runtime has it, the draft is dropped and only
     apiKeyConfigured is ever shown again. */
  function jevSave() {
    const v = (ui.draft.jev || "").trim();
    if (!v) ui.err.jev = msg("settings.key.error.empty");
    else if (/\s/.test(v)) ui.err.jev = msg("settings.key.error.spaces");
    else if (v.length > 4096) ui.err.jev = msg("settings.key.error.tooLong");
    else {
      delete ui.err.jev;
      ui.busy.jev = msg("settings.jev.busy.saving");
      ui.pendingFk = "jev-replace";
      clearTest();
      api("/api/agent/jev/api-key", { apiKey: v })
        .then(applyKeyResult)
        .catch((err) => {
          ui.err.jev = OV.describeError(err);
        })
        .finally(() => {
          delete ui.busy.jev;
          OVS.render(true);
          ui.pendingFk = null;
        });
    }
  }
  OVS.jevSave = jevSave;

  CHANGE["jev-provider"] = (t) => {
    const id = t.value,
      p = OVS.providerById(id);
    if (!id) return;
    OVS.saveAgents((a) => {
      const jev = { provider: id, modelId: null, thinking: null };
      /* A local provider takes no key: leave "Separate API key" so Jev isn't left waiting for one. */
      if (p && p.keyless && a.jev.credentials === "api-key") jev.credentials = "provider-login";
      return { jev };
    })
      .then((ok) => {
        if (!ok) return null;
        const m = S.provModels[id];
        return m && m.status === "ready" ? null : OVS.loadModels(id);
      })
      .then(() => {
        const m = S.provModels[id],
          j = S.agents.jev;
        if (!m || m.status !== "ready" || m.models.length === 0 || j.provider !== id || j.modelId)
          return null;
        const pick = m.models.find((x) => FAST_MODEL.test(x.modelId)) || m.models[0];
        return OVS.saveAgents({ jev: { provider: id, modelId: pick.modelId } });
      });
    clearTest();
  };
  CHANGE["jev-model"] = (t) => {
    const j = S.agents.jev,
      m = jevModels(j.provider),
      info = m && m.status === "ready" ? m.models.find((x) => x.modelId === t.value) : null;
    if (!info || t.value === j.modelId) return;
    /* An effort the new model doesn't accept is dropped (null = its default). */
    const drop = j.thinking && j.thinking !== "off" && !(info.efforts || []).includes(j.thinking);
    patchJev(
      Object.assign(
        { provider: j.provider, modelId: info.modelId },
        drop ? { thinking: null } : {},
      ),
    );
  };
  CHANGE["jev-thinking"] = (t) => patchJev({ thinking: t.value || null });

  OVS.ON_ENTER.jev = () => {
    if (!S.providers && !S.providersError) OVS.loadProviders();
    if (S.agents && S.agents.jev.provider) OVS.ensureModels(S.agents.jev.provider);
  };
})();
