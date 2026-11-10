/**
 * API keys are kept in the Mozilla login manager (like Zotero's own sync
 * credentials), not in prefs.js where they would sit in plain text.
 */
import { config } from "../../package.json";
import { log } from "./log";

/** "llm" is the custom LLM endpoint's key; presets have their own. */
export type SecretName =
  "decision" | "llm" | "llm-deepseek" | "llm-anthropic" | "llm-openrouter";

const ORIGIN = `chrome://${config.addonRef}`;
const realm = (name: SecretName) => `${config.addonName} ${name} API key`;

function logins(): any {
  return (Services as any).logins;
}

function findLogin(name: SecretName): any | undefined {
  return logins().findLogins(ORIGIN, null, realm(name))[0];
}

export function getSecret(name: SecretName): string {
  try {
    return findLogin(name)?.password ?? "";
  } catch (e) {
    log("getSecret failed", e);
    return "";
  }
}

export async function setSecret(name: SecretName, value: string) {
  const existing = findLogin(name);
  if (existing) logins().removeLogin(existing);
  if (!value) return;
  const LoginInfo = Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    Components.interfaces.nsILoginInfo,
    "init",
  ) as any;
  const login = new LoginInfo(ORIGIN, null, realm(name), name, value, "", "");
  const lm = logins();
  if (typeof lm.addLoginAsync === "function") await lm.addLoginAsync(login);
  else lm.addLogin(login);
}
