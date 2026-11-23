import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { OAuthFlow, OAuthFlowInfo, ProviderOAuthInfo } from "@hyperframes/agent-protocol";

/**
 * Which providers OpenVids can sign in to, and how, read from the SDK's compiled auth policies (the same table OMP's
 * `/login` menu is built from). A pasted-API-key login is not a sign-in (the API-key route covers it), and neither are
 * the providers whose login the SDK cannot run without a terminal or an OS-level hook.
 */

/**
 * Login flows written as code instead of data (`login.kind === "custom"`) that are real sign-ins a UI can drive with
 * a URL and a code. The rest of the custom ones ask for API keys, account ids or an e-mail address, or need a browser
 * session the host must own, so they are not offered.
 */
const CUSTOM_DEVICE_LOGINS: ReadonlySet<string> = new Set([
  "github-copilot",
  "cursor",
  "kilo",
  "openai-codex-device",
]);

export interface OAuthLoginOption extends OAuthFlowInfo {
  /** The SDK's id of this login (`openai-codex-device`), which can differ from the provider it stores under. */
  loginId: string;
}

function optionFor(
  policy: ReturnType<typeof authProviders>[number],
): { flow: OAuthFlow; callbackPort: number | null; fixedPort: boolean } | null {
  const login = policy.login;
  if (!login || policy.available === false || policy.showInLoginList === false) return null;
  // A paused provider refuses the login, and a login with an account-risk warning needs a consent step this UI lacks.
  if (policy.disabled !== undefined || policy.loginWarning !== undefined) return null;
  switch (login.kind) {
    case "oauth-code": {
      const callback = login.callback;
      // A custom-scheme redirect needs the OS to hand the URL to this process (`nativeScheme`): not available here.
      if (callback.nativeScheme) return null;
      if (callback.manualOnly) return { flow: "paste", callbackPort: null, fixedPort: false };
      return {
        flow: "browser",
        callbackPort: callback.port > 0 ? callback.port : null,
        fixedPort: !callback.portFallback,
      };
    }
    case "device-code":
      return { flow: "device", callbackPort: null, fixedPort: false };
    case "custom":
      return CUSTOM_DEVICE_LOGINS.has(policy.id)
        ? { flow: "device", callbackPort: null, fixedPort: false }
        : null;
    default:
      return null;
  }
}

/** The sign-ins that store a credential under `provider`, the provider's own first. */
export function oauthLoginOptions(provider: string): OAuthLoginOption[] {
  const options: OAuthLoginOption[] = [];
  for (const policy of authProviders()) {
    if ((policy.storeAs ?? policy.id) !== provider) continue;
    const option = optionFor(policy);
    if (option) options.push({ loginId: policy.id, ...option });
  }
  return options.sort(
    (left, right) => Number(right.loginId === provider) - Number(left.loginId === provider),
  );
}

/** What `ProviderInfo.oauth` says about a provider; null when it offers no in-app sign-in. */
export function providerOAuthInfo(provider: string): ProviderOAuthInfo | null {
  const options = oauthLoginOptions(provider);
  if (options.length === 0) return null;
  return {
    flows: options.map(({ flow, callbackPort, fixedPort }) => ({ flow, callbackPort, fixedPort })),
  };
}
