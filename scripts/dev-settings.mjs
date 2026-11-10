#!/usr/bin/env node
/* global process */
/**
 * Applies the CONCEPTLENS_* values from .env to the running dev Zotero:
 * endpoints/models/formats/threshold to prefs, API keys to the login manager.
 * Empty values are skipped. Prints what was set (keys masked).
 *
 *   npm run dev:settings              # everything
 *   npm run dev:settings -- llm       # only CONCEPTLENS_LLM_* (or: decision)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8"));

const env = {};
for (const line of readFileSync(resolve(repo, ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

const PREFS = {
  CONCEPTLENS_DECISION_FORMAT: ["decision.format", String],
  CONCEPTLENS_DECISION_ENDPOINT: ["decision.endpoint", String],
  CONCEPTLENS_DECISION_MODEL: ["decision.model", String],
  CONCEPTLENS_DECISION_THRESHOLD: ["decision.threshold", Number],
  CONCEPTLENS_LLM_FORMAT: ["llm.format", String],
  CONCEPTLENS_LLM_ENDPOINT: ["llm.endpoint", String],
  CONCEPTLENS_LLM_MODEL: ["llm.model", String],
};
const SECRETS = {
  CONCEPTLENS_DECISION_API_KEY: "decision",
  CONCEPTLENS_LLM_API_KEY: "llm",
};

const only = process.argv[2]?.toUpperCase();
const wanted = (name) => !only || name.startsWith(`CONCEPTLENS_${only}_`);

const prefs = {};
for (const [name, [key, cast]] of Object.entries(PREFS))
  if (env[name] && wanted(name))
    prefs[`${pkg.config.prefsPrefix}.${key}`] = cast(env[name]);
const secrets = {};
for (const [name, key] of Object.entries(SECRETS))
  if (env[name] && wanted(name)) secrets[key] = env[name];

const code = `
const prefs = ${JSON.stringify(prefs)};
const secrets = ${JSON.stringify(secrets)};
for (const [k, v] of Object.entries(prefs)) Zotero.Prefs.set(k, v, true);
const plugin = Zotero[${JSON.stringify(pkg.config.addonInstance)}];
for (const [k, v] of Object.entries(secrets)) await plugin.api.secrets.setSecret(k, v);
// Free-form LLM values -> provider dropdown (DeepSeek/Anthropic/custom) and
// that provider's key.
const llm = [...Object.keys(prefs), ...Object.keys(secrets)].some((k) => k.includes("llm"));
if (llm) await plugin.api.llmProviders.migrateLlmProvider(true);
const mask = (s) => s.length > 8 ? s.slice(0, 4) + "…" + s.slice(-2) : "set";
return [
  ...Object.keys(prefs).map((k) => k.split(".").slice(-2).join(".") + " = " + Zotero.Prefs.get(k, true)),
  ...Object.keys(secrets).map((k) => k + " API key = " + mask(plugin.api.secrets.getSecret(k))),
  ...(llm ? ["llm.provider = " + plugin.api.llmProviders.currentProvider()] : []),
];
`;

const r = spawnSync("node", [resolve(repo, "scripts/zotero-eval.mjs"), "-"], {
  input: code,
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(r.status ?? 1);
