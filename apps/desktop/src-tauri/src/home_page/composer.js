/* The "Start a new project" composer — the prototype Chat panel's intake form (OVChat.mount with
   opts.intake), on real data: the model catalog and agent defaults come from the agent runtime
   (/api/agent/*), files are real paths (native picker, or an OS drop resolved by Rust), and Start
   hands everything to the page, which creates the project. */
(function () {
  "use strict";
  const { ic, esc, api, describeError, formatBytes, formatClock } = OV;
  const T = (key, params) => OVI18N.t(key, params);

  /* Agent names, monograms, roles, modes, efforts and file kinds are message keys, translated when they are drawn. */
  const lead = () => T("home.composer.lead.name");
  const AGENTS = Object.freeze([
    {
      id: "editor",
      name: "home.composer.agent.editor.name",
      monogram: "home.composer.agent.editor.mono",
      role: "home.composer.agent.editor.role",
    },
    {
      id: "vision",
      name: "home.composer.agent.vision.name",
      monogram: "home.composer.agent.vision.mono",
      role: "home.composer.agent.vision.role",
    },
    {
      id: "motion",
      name: "home.composer.agent.motion.name",
      monogram: "home.composer.agent.motion.mono",
      role: "home.composer.agent.motion.role",
    },
    {
      id: "research",
      name: "home.composer.agent.research.name",
      monogram: "home.composer.agent.research.mono",
      role: "home.composer.agent.research.role",
    },
    {
      id: "audio",
      name: "home.composer.agent.audio.name",
      monogram: "home.composer.agent.audio.mono",
      role: "home.composer.agent.audio.role",
    },
  ]);
  const agentName = (a) => T(a.name);
  /* Low / Medium / High always (as the prototype); extra efforts only when the model supports them (as Chat does). */
  const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const BASE_EFFORTS = ["low", "medium", "high"];
  const EFFORT_LABEL = {
    minimal: "home.composer.effort.minimal",
    low: "home.composer.effort.low",
    medium: "home.composer.effort.medium",
    high: "home.composer.effort.high",
    xhigh: "home.composer.effort.xhigh",
    max: "home.composer.effort.max",
  };
  /* The effort buttons share one row of a 320 px popover with up to seven choices: short labels there, full names
     in the chip, tooltips and aria-labels. */
  const EFFORT_SHORT = {
    minimal: "home.composer.effort.short.minimal",
    medium: "home.composer.effort.short.medium",
    xhigh: "home.composer.effort.short.xhigh",
  };
  /* `name` is the mode's id (it travels with the start request); `label` / `description` are what the user reads. */
  const MODES = Object.freeze([
    {
      name: "Edit",
      intent: "edit",
      label: "home.composer.mode.edit",
      description: "home.composer.mode.editDescription",
    },
    {
      name: "Ask",
      intent: "ask",
      label: "home.composer.mode.ask",
      description: "home.composer.mode.askDescription",
    },
  ]);
  const KIND_ICON = {
    video: "film",
    audio: "audio",
    image: "image",
    subtitle: "subtitle",
    document: "file",
    font: "text",
    file: "file",
  };
  const KIND_NAME = {
    video: "home.composer.kind.video",
    audio: "home.composer.kind.audio",
    image: "home.composer.kind.image",
    subtitle: "home.composer.kind.subtitle",
    document: "home.composer.kind.document",
    font: "home.composer.kind.font",
    file: "home.composer.kind.file",
  };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const effortLabel = (e) =>
    e ? (EFFORT_LABEL[e] ? T(EFFORT_LABEL[e]) : cap(e)) : T("home.composer.effort.default");
  const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
  const modelKey = (m) => (m ? m.provider + "/" + m.modelId : "");
  /* "Claude Sonnet 4.5" → "Sonnet", "Gemini 2.5 Pro" → "Gemini Pro": the prototype's short chip label. */
  function shortName(name) {
    const words = String(name || "")
      .replace(/^Claude\s+/i, "")
      .split(/\s+/)
      .filter(Boolean);
    const kept = words.filter((w) => !/^v?\d+(\.\d+)*$/i.test(w));
    return (kept.length ? kept : words).join(" ") || name;
  }

  function mount(panelEl, opts) {
    const state = {
      files: [],
      busy: null,
      dropExternal: false,
      dropHover: false,
      overlay: null,
      popoverAgent: "editor",
      trigger: null,
      mode: "Edit",
      catalog: null,
      catalogError: null,
      model: null,
      effort: null,
      agents: {},
      agentPrefs: {},
      dirty: {},
    };
    AGENTS.forEach((a) => {
      state.agents[a.id] = a.id !== "research" && a.id !== "audio";
      state.agentPrefs[a.id] = { model: null, effort: null };
    });
    const refs = {};
    const node = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };
    const icon = (name) => {
      const h = document.createElement("span");
      h.innerHTML = ic(name);
      return h.firstElementChild;
    };
    const button = (cls, label, iconName) => {
      const b = node("button", cls);
      b.type = "button";
      if (label) b.setAttribute("aria-label", label);
      if (iconName) b.appendChild(icon(iconName));
      return b;
    };
    const setTip = (el, text) => {
      el.dataset.tip = text;
      el.title = text;
    };

    /* ---------- shell ---------- */
    panelEl.classList.add("ov-chat", "is-intake");
    const pane = node("div", "pane ov-chat-pane");
    pane.setAttribute("role", "group");
    refs.composer = node("div", "ov-chat-composer");
    pane.appendChild(refs.composer);
    if (opts.footer) pane.appendChild(opts.footer);
    refs.suggestions = node("div", "ov-chat-suggestions ov-chat-intake-suggestions");
    (opts.suggestions || []).forEach((key) => {
      const s = button("sel-item ov-chat-suggestion", null, "film");
      s.dataset.action = "suggestion";
      s.dataset.promptKey = key;
      s.appendChild(node("span"));
      refs.suggestions.appendChild(s);
    });
    pane.appendChild(refs.suggestions);
    panelEl.appendChild(pane);

    const label = node("label", "sr-only");
    refs.promptLabel = label;
    refs.attach = node("div", "ov-chat-ctx-list ov-chat-attach");
    refs.attach.setAttribute("role", "list");
    refs.attach.hidden = true;
    refs.textarea = node("textarea", "ov-chat-textarea");
    refs.textarea.rows = 1;
    refs.textarea.id = "startPrompt";
    refs.textarea.setAttribute("autocomplete", "off");
    refs.textarea.spellcheck = true;
    label.htmlFor = refs.textarea.id;
    refs.drop = node("div", "ov-chat-drop");
    refs.drop.setAttribute("aria-hidden", "true");
    refs.dropText = node("span");
    refs.drop.append(icon("import"), refs.dropText);
    /* No model connected (the catalog came back empty): say so here, with the way to fix it, rather than let
       Start fail later inside the new project's chat. */
    refs.noModel = node("div", "ov-chat-nomodel");
    refs.noModel.hidden = true;
    refs.noModel.setAttribute("role", "status");
    refs.noModelButton = button("btn btn-sm", null);
    refs.noModelButton.dataset.action = "connect-model";
    refs.noModelText = node("span", "ov-chat-nomodel-text");
    refs.noModel.append(icon("alert"), refs.noModelText, refs.noModelButton);
    refs.composer.append(label, refs.attach, refs.textarea, refs.drop, refs.noModel);

    const controls = node("div", "ov-chat-controls");
    const chip = (kind, iconName, haspopup) => {
      const b = button("tool-btn ov-chat-chip ov-chat-" + kind + "-chip", null, iconName);
      b.dataset.action = kind;
      b.dataset.chip = kind;
      b.setAttribute("aria-haspopup", haspopup);
      b.setAttribute("aria-expanded", "false");
      const l = node("span", "ov-chat-chip-label");
      b.appendChild(l);
      b.appendChild(icon("chevron-down")).classList.add("ov-chat-chip-caret");
      return [b, l];
    };
    [refs.modelButton, refs.modelLabel] = chip("model", "settings", "dialog");
    [refs.agentsButton, refs.agentsLabel] = chip("agents", "agents", "dialog");
    [refs.modeButton, refs.modeLabel] = chip("mode", "chat", "menu");
    refs.attachButton = button("icon-btn sm ov-chat-attach-btn", null, "paperclip");
    refs.attachButton.dataset.action = "attach";
    refs.send = button("btn btn-sm ov-chat-send", null, "send");
    refs.send.dataset.action = "send";
    refs.sendLabel = node("span", "ov-chat-send-label");
    refs.sendKbd = node("span", "kbd", "↵");
    refs.send.append(refs.sendLabel, refs.sendKbd);
    const spacer = node("span", "ov-chat-spacer");
    spacer.setAttribute("aria-hidden", "true");
    refs.controls = controls;
    controls.append(
      refs.modelButton,
      refs.agentsButton,
      refs.modeButton,
      refs.attachButton,
      ...(opts.controls || []),
      spacer,
      refs.send,
    );
    refs.composer.appendChild(controls);
    /* The static texts; drawn at mount and again by relocalize() when the language changes. */
    function paintStatic() {
      panelEl.setAttribute("aria-label", T("home.start.title"));
      refs.promptLabel.textContent = T("home.composer.promptLabel");
      refs.attach.setAttribute("aria-label", T("home.composer.filesLabel"));
      refs.textarea.setAttribute("aria-label", T("home.composer.promptLabel"));
      refs.textarea.placeholder = T(opts.placeholder || "home.start.placeholder");
      refs.dropText.textContent = T("home.composer.drop");
      refs.noModelText.textContent = T("home.composer.noModel.text");
      refs.noModelButton.textContent = T("home.composer.noModel.connect");
      const add = T("home.composer.addFiles");
      refs.attachButton.setAttribute("aria-label", add);
      setTip(refs.attachButton, add);
      refs.suggestions.querySelectorAll("[data-prompt-key]").forEach((s) => {
        const text = T(s.dataset.promptKey);
        s.setAttribute("aria-label", text);
        s.lastElementChild.textContent = text;
      });
    }
    paintStatic();

    /* ---------- data: model catalog + agent defaults ---------- */
    function currentModel() {
      const models = (state.catalog && state.catalog.models) || [];
      return models.find((m) => sameModel(m, state.model)) || null;
    }
    function effortsFor(model) {
      return model && model.reasoning
        ? EFFORTS.filter((e) => (model.efforts || []).includes(e))
        : [];
    }
    function loadAgents() {
      Promise.all([api("/api/agent/models"), api("/api/agent/settings")])
        .then(([catalog, settings]) => {
          state.catalog = catalog;
          state.catalogError = null;
          const director = (settings && settings.director) || {};
          state.model =
            director.model ||
            catalog.defaultModel ||
            (catalog.models[0]
              ? { provider: catalog.models[0].provider, modelId: catalog.models[0].modelId }
              : null);
          state.effort =
            director.thinking && EFFORTS.includes(director.thinking) ? director.thinking : null;
          const specialists = (settings && settings.specialists) || {};
          AGENTS.forEach((a) => {
            const d = specialists[a.id];
            if (!d) return;
            state.agents[a.id] = !!d.enabledByDefault;
            state.agentPrefs[a.id] = {
              model: d.model || null,
              effort: d.thinking && EFFORTS.includes(d.thinking) ? d.thinking : null,
            };
          });
          state.dirty = {};
          renderPopover();
          update();
        })
        .catch((err) => {
          state.catalogError = err || {};
          renderPopover();
          update();
        });
    }

    /* ---------- composer state ---------- */
    const noModel = () => !!state.catalog && state.catalog.models.length === 0;
    const catalogDetail = () => describeError(state.catalogError) || T("home.composer.unavailable");
    function modelChipText() {
      if (!state.catalog && !state.catalogError) return T("home.composer.model.loading");
      if (noModel()) return T("home.composer.model.none");
      const m = currentModel();
      return T("home.composer.model.chip", {
        model: m ? shortName(m.name) : T("home.composer.model.default"),
        effort: effortLabel(state.effort),
      });
    }
    const agentCount = () => 1 + AGENTS.filter((a) => state.agents[a.id]).length;
    const modeOf = () => MODES.find((m) => m.name === state.mode) || MODES[0];

    function update() {
      const m = currentModel();
      refs.modelLabel.textContent = modelChipText();
      const modelTip = state.catalogError
        ? T("home.composer.model.tipError", { error: catalogDetail() })
        : T("home.composer.model.tip", {
            model: m ? m.name : T("home.composer.model.default"),
            effort: effortLabel(state.effort),
          });
      refs.modelButton.setAttribute(
        "aria-label",
        T("home.composer.model.aria", { agent: lead(), detail: modelTip }),
      );
      setTip(refs.modelButton, modelTip);
      const count = agentCount();
      refs.agentsLabel.textContent = T("home.composer.agents.chip", { count });
      refs.agentsButton.setAttribute("aria-label", T("home.composer.agents.aria", { count }));
      setTip(refs.agentsButton, T("home.composer.agents.chip", { count }));
      const mode = modeOf(),
        modeName = T(mode.label),
        modeDescription = T(mode.description);
      refs.modeLabel.textContent = modeName;
      refs.modeButton.setAttribute(
        "aria-label",
        T("home.composer.mode.aria", { mode: modeName, description: modeDescription }),
      );
      setTip(
        refs.modeButton,
        T("home.composer.mode.tip", { mode: modeName, description: modeDescription }),
      );
      const hasText = !!refs.textarea.value.trim(),
        busy = !!state.busy,
        ready = !busy && !noModel() && (hasText || state.files.length > 0);
      refs.noModel.hidden = !noModel();
      const glyph = refs.send.firstElementChild;
      if (busy !== glyph.classList.contains("spinner"))
        glyph.replaceWith(busy ? node("i", "spinner") : icon("send"));
      refs.send.dataset.mode = busy ? "busy" : "start";
      const busyText = busy ? T(state.busy) : "";
      refs.sendLabel.textContent = busy ? busyText : T("home.composer.send.label");
      refs.sendKbd.textContent = busy ? "" : "↵";
      refs.send.setAttribute("aria-label", busy ? busyText : T("home.composer.send.aria"));
      refs.send.setAttribute("aria-busy", String(busy));
      setTip(
        refs.send,
        busy
          ? busyText
          : ready
            ? T("home.composer.send.tipReady", { key: "Enter" })
            : noModel()
              ? T("home.composer.send.tipNoModel")
              : T("home.composer.send.tipEmpty"),
      );
      refs.send.disabled = !ready;
      refs.send.classList.toggle("btn-primary", ready);
      refs.composer.classList.toggle("is-busy", busy);
      refs.composer.classList.toggle("is-drop", !busy && (state.dropExternal || state.dropHover));
      refs.suggestions.hidden = hasText || state.files.length > 0;
      refs.modelButton.setAttribute("aria-expanded", String(state.overlay === "model"));
      refs.agentsButton.setAttribute(
        "aria-expanded",
        String(state.overlay === "agents" || state.overlay === "settings"),
      );
      refs.modeButton.setAttribute("aria-expanded", String(state.overlay === "mode"));
    }
    function autoGrow() {
      const t = refs.textarea;
      t.style.height = "auto";
      const line = parseFloat(getComputedStyle(t).lineHeight) || 18,
        max = Math.ceil(line * 8 + 12);
      t.style.height = Math.min(t.scrollHeight, max) + "px";
      t.style.overflowY = t.scrollHeight > max ? "auto" : "hidden";
    }
    function snapshot() {
      return { prompt: refs.textarea.value, files: state.files.map((f) => Object.assign({}, f)) };
    }
    function notify() {
      if (opts.onChange) opts.onChange(snapshot());
    }

    /* ---------- files ---------- */
    function fileDetail(f) {
      return [formatBytes(f.size), f.duration > 0 ? formatClock(f.duration) : ""]
        .filter(Boolean)
        .join(" · ");
    }
    function renderFiles() {
      refs.attach.replaceChildren();
      refs.attach.hidden = !state.files.length;
      state.files.forEach((f, i) => {
        const c = node("span", "ov-chat-ctx");
        c.setAttribute("role", "listitem");
        c.dataset.kind = f.kind;
        const detail = f.name + " · " + fileDetail(f);
        c.dataset.tip = detail;
        c.title = f.path;
        c.dataset.tipAlign = "start";
        c.append(
          icon(KIND_ICON[f.kind] || "file"),
          node("span", "ov-chat-ctx-label", f.name),
          node(
            "span",
            "sr-only",
            " " +
              T("home.composer.file.sr", {
                kind: T(KIND_NAME[f.kind] || KIND_NAME.file),
                detail: fileDetail(f),
              }),
          ),
        );
        const x = button(
          "icon-btn xs ov-chat-ctx-x",
          T("home.composer.file.remove", { name: f.name }),
          "x",
        );
        x.dataset.action = "file-remove";
        x.dataset.index = String(i);
        x.disabled = !!state.busy;
        c.appendChild(x);
        refs.attach.appendChild(c);
      });
    }
    /* Descriptors from Rust ({path, name, size, kind, duration}); the same path is never added twice. */
    function addFiles(list) {
      if (state.busy || !Array.isArray(list)) return 0;
      let added = 0;
      list.forEach((f) => {
        if (!f || !f.path || state.files.some((x) => x.path === f.path)) return;
        state.files.push({
          path: f.path,
          name: f.name,
          size: f.size || 0,
          kind: f.kind || "file",
          duration: f.duration || null,
        });
        added += 1;
      });
      if (added) {
        renderFiles();
        update();
        notify();
      }
      return added;
    }
    function removeFile(index, stayInPrompt) {
      if (state.busy || !(index >= 0 && index < state.files.length)) return;
      state.files.splice(index, 1);
      renderFiles();
      update();
      notify();
      const next = stayInPrompt
        ? null
        : refs.attach.querySelectorAll(".ov-chat-ctx-x")[Math.min(index, state.files.length - 1)];
      (next || refs.textarea).focus({ preventScroll: true });
    }
    function reportSkipped(res) {
      const skipped = (res.skipped || []).concat(res.unresolved || []);
      if (skipped.length)
        OVH.toast(
          esc(
            skipped.length === 1
              ? T("home.composer.skipped.one", { name: skipped[0] })
              : T("home.composer.skipped.many", { count: skipped.length }),
          ),
        );
    }
    function pickFiles() {
      if (state.busy) return;
      api("/api/files/pick", {})
        .then((res) => {
          addFiles(res.files || []);
          reportSkipped(res);
          refs.textarea.focus({ preventScroll: true });
        })
        .catch((err) =>
          OVH.toast(
            esc(T("home.composer.error.addFiles", { message: describeError(err) })),
            null,
            "error",
          ),
        );
    }
    /* An OS drop: the webview gives names only; Rust reads the real paths off the drag pasteboard. */
    function dropNames(names) {
      if (state.busy || !names.length) return;
      api("/api/files/dropped", { names })
        .then((res) => {
          addFiles(res.files || []);
          reportSkipped(res);
        })
        .catch((err) =>
          OVH.toast(
            esc(T("home.composer.error.drop", { message: describeError(err) })),
            null,
            "error",
          ),
        );
    }

    /* ---------- popovers ---------- */
    function closePopover(restore) {
      if (!state.overlay) return;
      const trigger = state.trigger;
      if (refs.popover) refs.popover.remove();
      refs.popover = null;
      state.overlay = null;
      state.trigger = null;
      update();
      if (restore && trigger && trigger.isConnected) trigger.focus();
    }
    function openPopover(type, trigger, agentId, focusFirst) {
      if (refs.popover) refs.popover.remove();
      state.overlay = type;
      state.trigger = trigger;
      if (agentId) state.popoverAgent = agentId;
      renderPopover();
      update();
      if (focusFirst && refs.popover) {
        const first = refs.popover.querySelector("[data-nav]:not([disabled])");
        if (first) first.focus();
      }
    }
    function modelSelect(value, agentId) {
      const sel = node("select", "sel");
      sel.dataset.nav = "true";
      sel.setAttribute(
        "aria-label",
        T("home.composer.pop.model", {
          agent: agentId ? agentName(AGENTS.find((a) => a.id === agentId)) : lead(),
        }),
      );
      if (agentId) {
        sel.dataset.agentModel = agentId;
        const o = node("option", "", T("home.composer.inheritFrom", { agent: lead() }));
        o.value = "";
        sel.appendChild(o);
      } else sel.dataset.mainModel = "true";
      const models = (state.catalog && state.catalog.models) || [];
      const providers = [...new Set(models.map((m) => m.provider))];
      providers.forEach((p) => {
        const g = node("optgroup");
        g.label = p;
        models
          .filter((m) => m.provider === p)
          .forEach((m) => {
            const o = node("option", "", m.name);
            o.value = modelKey(m);
            g.appendChild(o);
          });
        sel.appendChild(g);
      });
      sel.value = value ? modelKey(value) : "";
      sel.disabled = !models.length;
      return sel;
    }
    function effortGroup(selected, agentId, model) {
      const g = node("div", "seg text sm ov-chat-effort");
      g.setAttribute("role", "group");
      g.setAttribute("aria-label", T("home.composer.thinkingEffort"));
      const supported = effortsFor(model);
      [null]
        .concat(EFFORTS.filter((e) => BASE_EFFORTS.includes(e) || supported.includes(e)))
        .forEach((e) => {
          const b = button("", T("home.composer.effort.aria", { effort: effortLabel(e) }));
          b.textContent = (e && EFFORT_SHORT[e] && T(EFFORT_SHORT[e])) || effortLabel(e);
          setTip(b, effortLabel(e));
          b.dataset.action = "effort";
          b.dataset.effort = e || "";
          if (agentId) b.dataset.agent = agentId;
          b.dataset.nav = "true";
          b.setAttribute("aria-pressed", String((selected || null) === e));
          b.disabled = !!e && !!model && !supported.includes(e);
          g.appendChild(b);
        });
      return g;
    }
    function field(labelText, control) {
      const f = node("div", "ov-chat-field");
      const l = node("span", "ov-chat-field-label", labelText);
      f.append(l, control);
      return f;
    }
    function catalogNote(content) {
      if (state.catalog) return false;
      const p = node("p", "ov-chat-pop-note");
      if (state.catalogError)
        p.textContent = T("home.composer.runtimeUnavailable", { error: catalogDetail() });
      else {
        p.appendChild(node("i", "spinner"));
        p.appendChild(document.createTextNode(T("home.composer.loadingModels")));
      }
      content.appendChild(p);
      return true;
    }
    function monogram(text) {
      const m = node("span", "ov-chat-mono", text);
      m.setAttribute("aria-hidden", "true");
      return m;
    }
    function renderPopover() {
      if (!state.overlay) return;
      if (refs.popover) refs.popover.remove();
      const agent = AGENTS.find((a) => a.id === state.popoverAgent) || AGENTS[0];
      const titles = {
        agents: T("home.composer.pop.agents"),
        settings: T("home.composer.pop.settings", { agent: agentName(agent) }),
        model: T("home.composer.pop.model", { agent: lead() }),
        mode: T("home.composer.pop.mode"),
      };
      const pop = node("section", "popover ov-chat-popover");
      pop.dataset.kind = state.overlay;
      pop.setAttribute("role", state.overlay === "mode" ? "menu" : "dialog");
      pop.setAttribute("aria-label", titles[state.overlay]);
      const head = node("div", "float-head ov-chat-pop-head");
      if (state.overlay === "settings") {
        const back = button(
          "icon-btn sm ov-chat-pop-back",
          T("home.composer.pop.back"),
          "chevron-left",
        );
        back.dataset.action = "settings-back";
        back.dataset.nav = "true";
        head.appendChild(back);
      }
      head.appendChild(node("span", "float-title ov-chat-pop-title", titles[state.overlay]));
      const content = node("div", "ov-chat-pop-body");
      if (state.overlay === "model") {
        if (!catalogNote(content)) {
          content.append(
            field(T("home.composer.field.model"), modelSelect(state.model, null)),
            field(
              T("home.composer.thinkingEffort"),
              effortGroup(state.effort, null, currentModel()),
            ),
          );
        }
        const help = node("p", "ov-chat-help");
        help.innerHTML = OVI18N.rich(
          "home.composer.modelHelp",
          {},
          {
            link: (inner) =>
              '<button class="link" type="button" aria-label="' +
              esc(T("home.composer.openAgentDefaults")) +
              '" data-action="agent-defaults" data-nav="true">' +
              inner +
              "</button>",
          },
        );
        content.appendChild(help);
      } else if (state.overlay === "agents") {
        content.setAttribute("role", "group");
        content.setAttribute("aria-label", T("home.composer.agents.group"));
        const main = node("div", "sel-item ov-chat-agent-row is-main");
        const info = node("div", "ov-chat-agent-info");
        info.append(
          node("span", "ov-chat-agent-name", lead()),
          node("span", "ov-chat-agent-role", T("home.composer.lead.role")),
        );
        main.append(
          monogram(T("home.composer.lead.mono")),
          info,
          node("span", "ov-chat-agent-always", T("home.composer.lead.alwaysOn")),
        );
        content.appendChild(main);
        AGENTS.forEach((a) => {
          const row = node(
            "div",
            "sel-item ov-chat-agent-row" + (state.agents[a.id] ? "" : " is-off"),
          );
          const inf = node("div", "ov-chat-agent-info");
          inf.append(
            node("span", "ov-chat-agent-name", agentName(a)),
            node("span", "ov-chat-agent-role", T(a.role)),
          );
          const gear = button(
            "icon-btn sm ov-chat-agent-gear",
            T("home.composer.agent.settingsAria", { agent: agentName(a) }),
            "sliders",
          );
          gear.dataset.action = "agent-settings";
          gear.dataset.agent = a.id;
          gear.dataset.nav = "true";
          setTip(gear, T("home.composer.agent.settingsTip", { agent: agentName(a) }));
          const sw = button("sw", T("home.composer.agent.switchAria", { agent: agentName(a) }));
          sw.setAttribute("role", "switch");
          sw.setAttribute("aria-checked", String(state.agents[a.id]));
          sw.dataset.action = "agent-switch";
          sw.dataset.agent = a.id;
          sw.dataset.nav = "true";
          row.append(monogram(T(a.monogram)), inf, gear, sw);
          content.appendChild(row);
        });
      } else if (state.overlay === "settings") {
        const prefs = state.agentPrefs[agent.id];
        if (!catalogNote(content)) {
          const model = prefs.model
            ? state.catalog.models.find((m) => sameModel(m, prefs.model)) || null
            : currentModel();
          content.append(
            field(T("home.composer.field.model"), modelSelect(prefs.model, agent.id)),
            field(T("home.composer.thinkingEffort"), effortGroup(prefs.effort, agent.id, model)),
          );
        }
        content.appendChild(
          node("p", "ov-chat-help", T("home.composer.settings.help", { lead: lead() })),
        );
      } else {
        MODES.forEach((m) => {
          const modeName = T(m.label),
            modeDescription = T(m.description);
          const b = button(
            "sel-item ov-chat-mode-item",
            T("home.composer.mode.itemAria", { mode: modeName, description: modeDescription }),
          );
          b.dataset.action = "mode-choice";
          b.dataset.mode = m.name;
          b.dataset.nav = "true";
          b.setAttribute("role", "menuitemradio");
          b.setAttribute("aria-checked", String(state.mode === m.name));
          const mark = node("span", "ov-chat-mode-check");
          mark.appendChild(icon("check"));
          mark.setAttribute("aria-hidden", "true");
          b.append(
            mark,
            node("span", "ov-chat-mode-name", modeName),
            node("span", "ov-chat-mode-desc", modeDescription),
          );
          content.appendChild(b);
        });
      }
      pop.append(head, content);
      panelEl.appendChild(pop);
      refs.popover = pop;
      place();
    }
    /* Open up or down — whichever fits inside the scrolling page, else the roomier side (prototype placeIntakePopover). */
    function place() {
      const pop = refs.popover;
      if (!pop) return;
      const trigger = state.trigger || refs.agentsButton;
      const panelRect = panelEl.getBoundingClientRect(),
        tr = trigger.getBoundingClientRect();
      const width = Math.min(
        state.overlay === "mode" ? 248 : 280,
        Math.max(0, panelEl.clientWidth - 16),
      );
      pop.style.width = width + "px";
      let clip = panelEl.parentElement;
      while (
        clip &&
        clip !== document.body &&
        !/(auto|scroll|hidden|clip)/.test(getComputedStyle(clip).overflowY)
      )
        clip = clip.parentElement;
      const bounds =
        clip && clip !== document.body
          ? clip.getBoundingClientRect()
          : { top: 0, bottom: innerHeight };
      const above = tr.top - bounds.top - 14,
        below = bounds.bottom - tr.bottom - 14;
      pop.style.maxHeight = "none";
      const height = pop.getBoundingClientRect().height;
      const up = above >= height || (below < height && above >= below);
      pop.style.maxHeight = Math.max(160, up ? above : below) + "px";
      pop.style.left =
        Math.max(0, Math.min(panelEl.clientWidth - width, tr.left - panelRect.left - 4)) + "px";
      pop.style.top = up ? "auto" : tr.bottom - panelRect.top + 6 + "px";
      pop.style.bottom = up ? panelRect.bottom - tr.top + 6 + "px" : "auto";
      pop.dataset.side = up ? "top" : "bottom";
    }
    function parseModel(value) {
      const models = (state.catalog && state.catalog.models) || [];
      const m = models.find((x) => modelKey(x) === value);
      return m ? { provider: m.provider, modelId: m.modelId } : null;
    }

    /* ---------- events ---------- */
    panelEl.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t || !panelEl.contains(t) || t.disabled) return;
      const a = t.dataset.action;
      if (a === "send") submit();
      else if (a === "attach") pickFiles();
      else if (a === "file-remove") removeFile(Number(t.dataset.index), false);
      else if (a === "model" || a === "agents" || a === "mode") {
        if (state.overlay === a) closePopover(false);
        else openPopover(a, t, null, true);
      } else if (a === "suggestion") {
        refs.textarea.value = T(t.dataset.promptKey);
        autoGrow();
        update();
        refs.textarea.focus();
        notify();
      } else if (a === "agent-switch") {
        state.agents[t.dataset.agent] = !state.agents[t.dataset.agent];
        renderPopover();
        update();
        const sw =
          refs.popover &&
          refs.popover.querySelector(
            '[data-action="agent-switch"][data-agent="' + t.dataset.agent + '"]',
          );
        if (sw) sw.focus();
      } else if (a === "agent-settings")
        openPopover("settings", refs.agentsButton, t.dataset.agent, true);
      else if (a === "settings-back") {
        const id = state.popoverAgent;
        openPopover("agents", refs.agentsButton, null, false);
        const g = refs.popover.querySelector(
          '[data-action="agent-settings"][data-agent="' + id + '"]',
        );
        if (g) g.focus();
      } else if (a === "effort") {
        const value = t.dataset.effort || null;
        if (t.dataset.agent) {
          state.agentPrefs[t.dataset.agent].effort = value;
          state.dirty[t.dataset.agent] = true;
        } else state.effort = value;
        renderPopover();
        update();
        const f = refs.popover.querySelector(
          '[data-action="effort"][data-effort="' + (value || "") + '"]',
        );
        if (f) f.focus();
      } else if (a === "mode-choice") {
        state.mode = t.dataset.mode;
        update();
        closePopover(true);
        notify();
      } else if (a === "connect-model") {
        closePopover(false);
        if (opts.onConnectModel) opts.onConnectModel(refs.noModelButton);
      } else if (a === "agent-defaults") {
        closePopover(false);
        if (opts.onAgentDefaults) opts.onAgentDefaults(refs.modelButton);
      }
    });
    panelEl.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.mainModel) {
        state.model = parseModel(t.value);
        const supported = effortsFor(currentModel());
        if (state.effort && !supported.includes(state.effort)) state.effort = null;
        renderPopover();
        update();
      } else if (t.dataset.agentModel) {
        state.agentPrefs[t.dataset.agentModel].model = t.value ? parseModel(t.value) : null;
        state.dirty[t.dataset.agentModel] = true;
        renderPopover();
      }
    });
    panelEl.addEventListener("input", (e) => {
      if (e.target === refs.textarea) {
        autoGrow();
        update();
        notify();
      }
    });
    panelEl.addEventListener("keydown", (e) => {
      if (
        e.target === refs.textarea &&
        e.key === "Backspace" &&
        !refs.textarea.value &&
        state.files.length
      ) {
        e.preventDefault();
        removeFile(state.files.length - 1, true);
        return;
      }
      if (e.key === "Escape") {
        if (state.overlay) {
          e.preventDefault();
          e.stopPropagation();
          closePopover(true);
        } else if (e.target === refs.textarea) {
          e.preventDefault();
          refs.textarea.blur();
        }
        return;
      }
      if (e.target === refs.textarea && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
        return;
      }
      if (
        state.overlay &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.target.matches("select, input, textarea")
      ) {
        const c = [...refs.popover.querySelectorAll("[data-nav]:not([disabled])")],
          i = c.indexOf(e.target);
        if (c.length && i !== -1) {
          e.preventDefault();
          c[Math.max(0, Math.min(c.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
        }
      }
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!state.overlay || !refs.popover || refs.popover.contains(e.target)) return;
        if (state.trigger && state.trigger.contains(e.target)) return;
        closePopover(false);
      },
      true,
    );
    /* The composer is a drop target of its own (hover highlight); the page handles drops anywhere else. */
    const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    panelEl.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = state.busy ? "none" : "copy";
      if (!state.busy && !state.dropHover) {
        state.dropHover = true;
        update();
      }
    });
    panelEl.addEventListener("dragleave", (e) => {
      if (!state.dropHover || (e.relatedTarget && panelEl.contains(e.relatedTarget))) return;
      state.dropHover = false;
      update();
    });
    panelEl.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      state.dropHover = false;
      state.dropExternal = false;
      update();
      dropNames([...e.dataTransfer.files].map((f) => f.name));
    });

    function submit() {
      const prompt = refs.textarea.value.trim();
      if (state.busy || (!prompt && !state.files.length)) return;
      if (noModel()) {
        refs.noModelButton.focus();
        return;
      }
      closePopover(false);
      const overrides = {};
      Object.keys(state.dirty).forEach((id) => {
        const p = state.agentPrefs[id];
        overrides[id] = { model: p.model, thinking: p.effort, allowedModels: [] };
      });
      opts.onSubmit({
        prompt,
        intent: modeOf().intent,
        mode: state.mode,
        model: state.model,
        thinking: state.effort,
        agents: AGENTS.filter((a) => state.agents[a.id]).map((a) => a.id),
        agentOverrides: Object.keys(overrides).length ? overrides : null,
        files: state.files.map((f) => f.path),
      });
    }
    function setBusy(text) {
      state.busy = text || null;
      closePopover(false);
      if (state.busy) {
        state.dropExternal = false;
        state.dropHover = false;
      }
      refs.textarea.disabled = !!state.busy;
      [refs.modelButton, refs.agentsButton, refs.modeButton, refs.attachButton].forEach((c) => {
        c.disabled = !!state.busy;
      });
      refs.busyDisabled = refs.busyDisabled || [];
      if (state.busy) {
        [...refs.controls.children, ...refs.suggestions.children].forEach((c) => {
          if (c === refs.send || !("disabled" in c) || c.disabled) return;
          c.disabled = true;
          refs.busyDisabled.push(c);
        });
      } else
        refs.busyDisabled.splice(0).forEach((c) => {
          c.disabled = false;
        });
      panelEl.setAttribute("aria-busy", String(!!state.busy));
      renderFiles();
      update();
    }

    autoGrow();
    update();
    loadAgents();
    return {
      el: panelEl,
      addFiles,
      dropNames,
      setBusy,
      setDropActive(active) {
        state.dropExternal = !!active && !state.busy;
        if (!active) state.dropHover = false;
        update();
      },
      setPrompt(text) {
        if (state.busy) return;
        refs.textarea.value = text == null ? "" : String(text);
        autoGrow();
        update();
        notify();
      },
      getState: snapshot,
      isBusy: () => !!state.busy,
      focus() {
        refs.textarea.focus();
      },
      reloadAgents: loadAgents,
      /* The language changed: redraw every text the composer built once. */
      relocalize() {
        paintStatic();
        renderFiles();
        update();
        renderPopover();
      },
      repositionPopover: place,
    };
  }

  window.OVComposer = { mount };
})();
