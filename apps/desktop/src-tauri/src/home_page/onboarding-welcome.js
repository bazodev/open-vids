/* Onboarding step 1 — Welcome: what OpenVids is, in three short facts. Nothing to configure. */
(function () {
  "use strict";
  const { ic, esc, tr } = OVS;
  const { OB, title, mark } = OVOB;

  /* name and text are catalog keys; the folder fact takes its platform wording on Windows. */
  const fact = (icon, name, text) =>
    `<div class="st-row">${ic(icon)}<div class="st-label"><b>${esc(OV.pt(name))}</b><span>${esc(OV.pt(text))}</span></div></div>`;

  OVOB.steps.welcome = {
    label: "onboarding.step.welcome",
    /* Done once the user has moved past it. */
    done: () => !!OB.seen.welcome && OB.step !== "welcome",
    view: () =>
      mark +
      title(tr("onboarding.welcome.title"), tr("onboarding.welcome.lede")) +
      `<section class="st-group"><div class="st-box ob-facts">${
        fact("agents", "onboarding.welcome.chat.title", "onboarding.welcome.chat.text") +
        fact("shield", "onboarding.welcome.local.title", "onboarding.welcome.local.text") +
        fact("folder", "onboarding.welcome.folder.title", "onboarding.welcome.folder.text")
      }</div></section>`,
    primary: () => ({ label: "onboarding.welcome.start", kind: "primary" }),
  };
})();
