/**
 * LLM fallback providers. DeepSeek, Anthropic and OpenRouter are presets
 * (fixed endpoint and format, a short model list, their own API key);
 * "custom" uses the free-form llm.format / llm.endpoint / llm.model prefs.
 * OpenRouter falls back to the decision model's key when the decision model
 * runs on OpenRouter too.
 */
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getSecret, setSecret, SecretName } from "../utils/secrets";

export type LlmProvider = "deepseek" | "anthropic" | "openrouter" | "custom";
export type LlmFormat = "openai" | "anthropic";

export interface PresetModel {
  id: string;
  label: string;
}

export interface Preset {
  label: string;
  format: LlmFormat;
  endpoint: string;
  host: string;
  secret: SecretName;
  modelPref: "llm.deepseekModel" | "llm.anthropicModel" | "llm.openrouterModel";
  /** First entry is the default */
  models: PresetModel[];
  /** Retired or alternative names that map onto a preset model */
  aliases?: Record<string, string>;
  /** Without its own key, use the decision model's key if that runs here. */
  sharesDecisionKey?: boolean;
}

// Model IDs: api-docs.deepseek.com/quick_start/pricing, Anthropic's current
// model list, and openrouter.ai/api/v1/models (all checked 2026-11-10).
export const PRESETS: Record<Exclude<LlmProvider, "custom">, Preset> = {
  deepseek: {
    label: "DeepSeek",
    format: "openai",
    endpoint: "https://api.deepseek.com",
    host: "api.deepseek.com",
    secret: "llm-deepseek",
    modelPref: "llm.deepseekModel",
    models: [
      { id: "deepseek-flash", label: "DeepSeek Flash" },
      { id: "deepseek-v4-pro", label: "DeepSeek Pro" },
    ],
    aliases: { "deepseek-v4-flash": "deepseek-flash" },
  },
  anthropic: {
    label: "Anthropic",
    format: "anthropic",
    endpoint: "https://api.anthropic.com",
    host: "api.anthropic.com",
    secret: "llm-anthropic",
    modelPref: "llm.anthropicModel",
    models: [
      { id: "claude-haiku-5-5", label: "Claude Haiku" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet" },
      { id: "claude-opus-5-5", label: "Claude Opus" },
    ],
  },
  openrouter: {
    label: "OpenRouter",
    format: "openai",
    endpoint: "https://openrouter.ai/api/v1",
    host: "openrouter.ai",
    secret: "llm-openrouter",
    modelPref: "llm.openrouterModel",
    models: [
      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek Flash" },
      { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku" },
      { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet" },
      { id: "google/gemini-3.8-flash", label: "Gemini Flash" },
      { id: "openai/gpt-6-luna", label: "GPT-6 Luna" },
    ],
    sharesDecisionKey: true,
  },
};

export const PROVIDERS: LlmProvider[] = [
  "deepseek",
  "anthropic",
  "openrouter",
  "custom",
];

export function currentProvider(): LlmProvider {
  const p = getPref("llm.provider") as LlmProvider;
  return PROVIDERS.includes(p) ? p : "deepseek";
}

/** The preset model for `model`, or undefined if it is not one of them. */
export function presetModel(
  provider: Exclude<LlmProvider, "custom">,
  model: string,
): string | undefined {
  const preset = PRESETS[provider];
  const id = preset.aliases?.[model] ?? model;
  return preset.models.some((m) => m.id === id) ? id : undefined;
}

export function secretFor(provider: LlmProvider): SecretName {
  return provider === "custom" ? "llm" : PRESETS[provider].secret;
}

/**
 * The decision model's key, for a preset that shares it, when the decision
 * endpoint is on the same host; else "".
 */
export function inheritedKey(provider: LlmProvider): string {
  if (provider === "custom" || !PRESETS[provider].sharesDecisionKey) return "";
  const decisionHost = hostOf(getPref("decision.endpoint") || "");
  return decisionHost === PRESETS[provider].host ? getSecret("decision") : "";
}

/** The provider's own key, else the key it inherits. */
export function keyFor(provider: LlmProvider): string {
  return getSecret(secretFor(provider)) || inheritedKey(provider);
}

export function modelFor(provider: Exclude<LlmProvider, "custom">): string {
  const preset = PRESETS[provider];
  return (
    presetModel(provider, getPref(preset.modelPref) || "") ??
    preset.models[0].id
  );
}

/** Endpoint, format and model for a provider, from its prefs. */
export function providerSettings(provider: LlmProvider) {
  if (provider === "custom")
    return {
      format: (getPref("llm.format") as LlmFormat) || "openai",
      endpoint: getPref("llm.endpoint") || "",
      model: getPref("llm.model") || "",
    };
  const preset = PRESETS[provider];
  return {
    format: preset.format,
    endpoint: preset.endpoint,
    model: modelFor(provider),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Which provider the free-form settings describe: a preset when endpoint,
 * format and model all fit one, else "custom"; undefined when no endpoint
 * is set at all.
 */
export function detectProvider(
  format: string,
  endpoint: string,
  model: string,
): LlmProvider | undefined {
  if (!endpoint.trim()) return undefined;
  const host = hostOf(endpoint);
  for (const [name, preset] of Object.entries(PRESETS) as [
    Exclude<LlmProvider, "custom">,
    Preset,
  ][]) {
    if (
      host === preset.host &&
      format === preset.format &&
      (!model || presetModel(name, model))
    )
      return name;
  }
  return "custom";
}

/**
 * Settings from before the provider dropdown (free-form endpoint/model and
 * one "llm" key) become a provider choice. Runs once unless `force`d (the
 * dev-settings script forces it after writing the free-form values).
 */
export async function migrateLlmProvider(force = false) {
  const services = Services as any;
  const key = `${config.prefsPrefix}.llm.provider`;
  if (!force && services.prefs.prefHasUserValue(key)) return;
  const format = getPref("llm.format") || "openai";
  const model = getPref("llm.model") || "";
  const provider = detectProvider(format, getPref("llm.endpoint") || "", model);
  if (!provider) return;
  setPref("llm.provider", provider);
  if (provider === "custom") return;
  const preset = PRESETS[provider];
  const id = presetModel(provider, model);
  if (id) setPref(preset.modelPref, id);
  const secret = getSecret("llm");
  if (secret && (force || !getSecret(preset.secret)))
    await setSecret(preset.secret, secret);
}
