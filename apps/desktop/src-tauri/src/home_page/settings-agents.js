/* Settings → Agents: the global defaults for new chats (GET/PUT /api/agent/settings: director, specialists)
   against the model catalog (GET /api/agent/models). A model whose provider is not usable gets the provider's
   own warning with a Fix link (the provider list, GET /api/agent/providers, is loaded by Models & Providers). */
(function () {
  "use strict";
  const { ic, esc, S, PAGES, CLICK, CHANGE, AGENTS, tr, sw, seg, select, head } = OVS;

  /* null is a real state ("Default": the model's own effort), "off" switches thinking off. Labels are
     settings.agents.effort.<name> (read when drawn); a level this page doesn't know shows as it is. */
  const EFFORTS = [
    ["", "default"],
    ["off", "off"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ];
  const EXTRA_EFFORTS = { minimal: "minimal", xhigh: "xhigh", max: "max" };
  const effortLabel = (name) => tr(`settings.agents.effort.${name}`);

  function modelOptions(value, inherit) {
    const sel = (on) => (on ? " selected" : "");
    let html = `<option value=""${sel(!value)}>${esc(
      tr(inherit ? "settings.agents.model.inherit" : "settings.agents.model.runtimeDefault"),
    )}</option>`;
    const models = (S.catalog && S.catalog.models) || [];
    [...new Set(models.map((m) => m.provider))].forEach((p) => {
      html += `<optgroup label="${esc(OVS.providerName(p))}">${models
        .filter((m) => m.provider === p)
        .map(
          (m) =>
            `<option value="${esc(OVS.modelKey(m))}"${sel(OVS.sameModel(m, value))}>${esc(m.name)}</option>`,
        )
        .join("")}</optgroup>`;
    });
    if (value && !models.some((m) => OVS.sameModel(m, value)))
      html += `<optgroup label="${esc(
        tr("settings.agents.model.unavailableGroup", {
          provider: OVS.providerName(value.provider),
        }),
      )}"><option value="${esc(
        OVS.modelKey(value),
      )}" selected>${esc(value.modelId)}</option></optgroup>`;
    return html;
  }
  /* [value, label] pairs, the label read now. */
  const efforts = (current) =>
    (current && !EFFORTS.some((e) => e[0] === current)
      ? EFFORTS.concat([[current, EXTRA_EFFORTS[current] || null]])
      : EFFORTS
    ).map((e) => [e[0], e[1] ? effortLabel(e[1]) : e[0]]);

  PAGES.agents = function () {
    if (!S.agents)
      return (
        head(tr("settings.section.agents")) +
        (S.agentsError
          ? OVS.failure("settings.failure.agentRuntime", S.agentsError, "agents-retry")
          : OVS.loading("settings.loading.agentDefaults"))
      );
    const rows = AGENTS.map((ag) => {
      const dir = ag.id === "director",
        cfg = dir ? S.agents.director : S.agents.specialists[ag.id],
        on = dir || cfg.enabledByDefault;
      const provider = cfg.model ? OVS.providerById(cfg.model.provider) : null;
      const missing =
        cfg.model && S.catalog && !S.catalog.models.some((m) => OVS.sameModel(m, cfg.model));
      /* The provider's state names the problem; without it the model is just gone from the catalog. */
      const bad = OVS.providerBad(provider);
      const warn = bad
        ? OVS.providerWarn(provider)
        : missing
          ? `<span class="status warning">${ic("alert")}${esc(tr("settings.agents.modelUnavailable"))}</span>`
          : "";
      return `<div class="st-row${on ? "" : " is-off"}"><div class="st-agent"><span class="st-mono" aria-hidden="true">${
        ag.mono
      }</span><div class="st-label"><b>${esc(ag.name)}</b><span>${esc(ag.role)}</span></div></div><div class="st-model-cell">${select(
        modelOptions(cfg.model, !dir),
        "agent-model",
        tr("settings.agents.modelAria", { agent: ag.name }),
        ag.id,
        bad || missing ? "is-warn" : "",
      )}${warn}</div>${seg(efforts(cfg.thinking), cfg.thinking || "", "agent-effort", tr("settings.agents.effortAria", { agent: ag.name }), ag.id)}${
        dir
          ? `<span class="st-always" data-tip="${esc(tr("settings.agents.director.alwaysOn.tip"))}" data-tip-align="end">${esc(tr("settings.agents.director.alwaysOn.text"))}</span>`
          : sw(
              cfg.enabledByDefault,
              "agent-on",
              tr("settings.agents.onByDefaultAria", { agent: ag.name }),
              ag.id,
            )
      }</div>`;
    }).join("");
    return (
      head(tr("settings.section.agents")) +
      OVS.noteHtml(S.agentsNote) +
      `<section class="st-group st-agents"><div class="sect-label"><span>${esc(tr("settings.agents.group.defaults"))}</span><button type="button" class="link push" data-act="agents-reset" data-fk="agents-reset">${esc(tr("settings.agents.reset"))}</button></div><div class="st-box"><div class="st-row st-th list-head" aria-hidden="true"><span>${esc(tr("settings.agents.col.agent"))}</span><span>${esc(tr("settings.agents.col.model"))}</span><span>${esc(tr("settings.agents.col.effort"))}</span><span>${esc(tr("settings.agents.col.on"))}</span></div>${rows}</div><p class="st-foot">${esc(tr("settings.agents.foot"))}</p></section>`
    );
  };

  /* Patches are built from the settings as they are when the save runs (see OVS.saveAgents). */
  const specialistPatch = (a, id, change) => ({
    specialists: { [id]: Object.assign({}, a.specialists[id], change) },
  });
  const configPatch = (a, id, change) =>
    id === "director"
      ? { director: Object.assign({}, a.director, change) }
      : specialistPatch(a, id, change);
  function parseModel(value) {
    const m = ((S.catalog && S.catalog.models) || []).find((x) => OVS.modelKey(x) === value);
    return m ? { provider: m.provider, modelId: m.modelId } : null;
  }

  CLICK["agents-retry"] = () => {
    S.agentsError = null;
    OVS.loadAgents();
  };
  CLICK["agent-effort"] = (t) => {
    const v = t.dataset.v || null,
      id = t.dataset.key;
    OVS.saveAgents((a) => configPatch(a, id, { thinking: v }));
  };
  CLICK["agent-on"] = (t) => {
    const id = t.dataset.key;
    OVS.saveAgents((a) =>
      specialistPatch(a, id, { enabledByDefault: !a.specialists[id].enabledByDefault }),
    );
  };
  CLICK["agents-reset"] = () => {
    OVS.saveAgents((a) => {
      const specialists = {};
      AGENTS.slice(1).forEach((ag) => {
        specialists[ag.id] = Object.assign({}, a.specialists[ag.id], {
          model: null,
          thinking: null,
          allowedModels: [],
          enabledByDefault: true,
        });
      });
      return { director: { model: null, thinking: null }, specialists };
    }, OVS.msg("settings.agents.notice.reset"));
  };
  CHANGE["agent-model"] = (t) => {
    const model = t.value ? parseModel(t.value) : null,
      id = t.dataset.key;
    /* An unavailable model keeps its option only to show the current value; picking it again changes nothing. */
    if (t.value && !model) return;
    OVS.saveAgents((a) => configPatch(a, id, { model }));
  };
})();
