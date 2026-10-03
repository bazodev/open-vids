/* Onboarding step 3 — Connect a model. The provider rows, key form and sign-in panel are the Models & Providers
   ones (settings-providers.js / settings-signin.js), drawn here as they are in Settings; this file only decides
   which providers show and what the step says. A model is optional: the manual editor works without one. */
(function () {
  "use strict";
  const { esc, ui, S, CLICK, group, tr } = OVS;
  const { title } = OVOB;

  /* The well-known providers that lead the list; every other one is behind "Show all providers". */
  const FEATURED = ["anthropic", "openai", "google", "openrouter"];

  /* Connected and usable. A local provider (Ollama) answers "connected" with nothing to use, so it counts only
     once it lists models. */
  const connected = () =>
    (S.providers || []).filter((p) => p.status === "connected" && (!p.keyless || p.modelCount > 0));

  function list() {
    const all = OVS.providerList();
    const lead = FEATURED.map((id) => all.find((p) => p.id === id)).filter(Boolean);
    const rest = all.filter((p) => !FEATURED.includes(p.id));
    const showAll = !!ui.flags.showAllProviders;
    const more = rest.length
      ? `<div class="st-sub"><button type="button" class="link" data-act="providers-all" aria-expanded="${showAll}" data-fk="providers-all">${esc(
          showAll
            ? tr("settings.providers.hideOthers")
            : tr("settings.providers.showOthers", { count: rest.length }),
        )}</button></div>`
      : "";
    return group(
      esc(tr("settings.providers.group.providers")),
      lead.map(OVS.providerRow).join("") +
        more +
        (showAll ? rest.map(OVS.providerRow).join("") : ""),
    );
  }

  OVOB.steps.models = {
    label: "onboarding.step.model",
    skipWhenDone: true,
    done: () => (S.providers ? connected().length > 0 : null),
    load: () => {
      OVS.loadProviders();
    },
    enter: () => {
      OVS.signin.onEnter();
    },
    leave: () => OVS.signin.stop(),
    stop: () => OVS.signin.stop(),
    view() {
      const head = title(tr("onboarding.models.title"), tr("onboarding.models.lede"));
      const foot = `<p class="st-foot">${esc(OV.pt("onboarding.models.foot"))}</p>`;
      if (!S.providers)
        return (
          head +
          (S.providersError
            ? OVS.failure("settings.failure.agentRuntime", S.providersError, "ob-providers-retry")
            : OVS.loading("settings.loading.providers")) +
          `<p class="st-foot">${esc(tr("onboarding.models.skipLoading"))}</p>`
        );
      const names = connected().map((p) => p.name);
      const show = names.length === 0 || ui.flags.obMore;
      return (
        head +
        (names.length
          ? group(
              esc(tr("onboarding.models.group.connected")),
              `<div class="st-prov" data-ob-connected><span class="dot ok" aria-hidden="true"></span><div class="st-label"><b>${OVI18N.rich(
                "onboarding.models.connected",
                { names: OVS.list(names) },
                { names: (inner) => `<span class="ob-names">${inner}</span>` },
              )}</b><span>${esc(
                tr("onboarding.models.connected.hint", { count: names.length }),
              )}</span></div>${
                show
                  ? ""
                  : `<div class="st-ctl"><button type="button" class="btn" data-act="ob-more" data-fk="ob-more">${esc(tr("onboarding.models.connectAnother"))}</button></div>`
              }</div>`,
            )
          : "") +
        (show ? list() : "") +
        OVS.noteHtml(ui.flags.providersNote) +
        foot +
        (names.length ? "" : `<p class="st-foot">${esc(tr("onboarding.models.skip"))}</p>`)
      );
    },
    primary: () =>
      connected().length
        ? { label: "common.continue", kind: "primary" }
        : { label: "onboarding.models.continueWithout", kind: "secondary" },
  };
  CLICK["ob-providers-retry"] = () => {
    OVS.loadProviders();
  };
  CLICK["ob-more"] = () => {
    ui.flags.obMore = true;
  };
})();
