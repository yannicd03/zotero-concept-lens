/**
 * HTTP clients for the two configurable models:
 *  - the decision model (yes/no and pick-one questions, no text generation)
 *  - the LLM fallback (writes a short definition)
 * Endpoints, models and formats come from the prefs; keys from the login manager.
 */
import { getPref } from "../utils/prefs";
import { getSecret } from "../utils/secrets";
import {
  LlmProvider,
  currentProvider,
  keyFor,
  providerSettings,
} from "./llmProviders";

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

// Some gateways (e.g. self-hosted OpenAI-compatible ones) report hiccups with
// non-5xx statuses; worth one retry.
const TRANSIENT =
  /temporarily unavailable|server connection error|overloaded|try again/i;

async function postJSON(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeout = 60_000,
): Promise<any> {
  if (!url) throw new ApiError("No endpoint configured");
  for (let attempt = 0; ; attempt++) {
    let xhr: XMLHttpRequest;
    try {
      xhr = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...headers },
        responseType: "json",
        timeout,
        successCodes: false,
      });
    } catch (e: any) {
      // Timeouts and connection failures
      if (attempt === 0) continue;
      throw new ApiError(String(e?.message ?? e));
    }
    const data = xhr.response;
    if (xhr.status === 402)
      throw new ApiError("Out of credits (HTTP 402)", xhr.status);
    if (xhr.status >= 200 && xhr.status < 300) return data;
    const detail = String(
      data?.error?.message ??
        data?.error ??
        JSON.stringify(data)?.slice(0, 300),
    );
    const quota = /quota|budget/i.test(detail);
    // Status 0: no response at all (e.g. a reused keep-alive connection the
    // server had already closed); Zotero.HTTP reports it instead of throwing.
    const retry =
      !quota &&
      (xhr.status === 0 ||
        xhr.status === 429 ||
        xhr.status >= 500 ||
        TRANSIENT.test(detail));
    if (attempt === 0 && retry) {
      await Zotero.Promise.delay(xhr.status === 0 ? 300 : 2000);
      continue;
    }
    if (xhr.status === 0)
      throw new ApiError("No response from the server (network error)", 0);
    throw new ApiError(`HTTP ${xhr.status}: ${detail}`, xhr.status);
  }
}

function authHeader(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// ---------------------------------------------------------------------------
// Decision model

export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> };

export interface DecisionSettings {
  format: "systemone" | "chat";
  endpoint: string;
  model: string;
  key: string;
}

export function decisionSettings(): DecisionSettings {
  return {
    format: (getPref("decision.format") as any) || "systemone",
    endpoint: getPref("decision.endpoint") || "",
    model: getPref("decision.model") || "",
    key: getSecret("decision"),
  };
}

/** Ask all questions about one `state` in a single request. */
export async function decide(
  state: string,
  questions: Record<string, DecisionQuestion>,
  s: DecisionSettings = decisionSettings(),
): Promise<Record<string, DecisionAnswer>> {
  if (s.format === "chat") return decideViaChat(state, questions, s);
  const data = await postJSON(
    s.endpoint,
    { model: s.model, state, questions },
    authHeader(s.key),
  );
  const answers = data?.answers ?? data?.result?.answers;
  if (!answers) throw new ApiError("Response has no answers");
  const missing = Object.keys(questions).filter((k) => !(k in answers));
  if (missing.length)
    throw new ApiError(`Response lacks answers for: ${missing.join(", ")}`);
  return answers;
}

/**
 * Fallback for endpoints without a /systemone route: ask an
 * OpenAI-compatible chat model for the answers as JSON.
 */
async function decideViaChat(
  state: string,
  questions: Record<string, DecisionQuestion>,
  s: DecisionSettings,
): Promise<Record<string, DecisionAnswer>> {
  const spec = Object.entries(questions).map(([k, q]) =>
    q.type === "noul"
      ? `"${k}": probability 0-1 that the answer is yes. Question: ${q.instructions}`
      : `"${k}": one of ${JSON.stringify(Object.keys(q.criteria))}. Question: ${q.instructions}`,
  );
  const text = await chatComplete(
    {
      format: "openai",
      endpoint: s.endpoint,
      model: s.model,
      key: s.key,
    },
    "Answer every question about the given text. Reply with one JSON object only, no prose.",
    `Text:\n${state}\n\nQuestions (JSON keys):\n${spec.join("\n")}`,
  );
  const json = JSON.parse(
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );
  const out: Record<string, DecisionAnswer> = {};
  for (const [k, q] of Object.entries(questions)) {
    if (!(k in json)) throw new ApiError(`Response lacks answer for ${k}`);
    out[k] =
      q.type === "noul"
        ? { type: "noul", noul: Number(json[k]) }
        : { type: "choice", choice: String(json[k]), probabilities: {} };
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM fallback

export interface LlmSettings {
  format: "openai" | "anthropic";
  endpoint: string;
  model: string;
  key: string;
}

export function llmSettings(
  provider: LlmProvider = currentProvider(),
): LlmSettings {
  return { ...providerSettings(provider), key: keyFor(provider) };
}

function chatURL(endpoint: string, format: LlmSettings["format"]): string {
  const base = endpoint.replace(/\/+$/, "");
  if (format === "anthropic") {
    if (base.endsWith("/messages")) return base;
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/**
 * After a quota/budget error, LLM calls pause until the reset time the
 * server names ("resets at 2026-11-11 00:00 UTC"), or for an hour.
 */
let llmPausedUntil = 0;
let llmPauseReason = "";
let llmPausedFor = "";

export function llmPause(
  s: LlmSettings = llmSettings(),
): { until: number; reason: string } | undefined {
  return Date.now() < llmPausedUntil && llmPausedFor === s.endpoint + s.model
    ? { until: llmPausedUntil, reason: llmPauseReason }
    : undefined;
}

function pauseFromError(e: ApiError, s: LlmSettings) {
  if (!/quota|budget/i.test(e.message)) return;
  const m =
    /resets? at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*UTC/i.exec(
      e.message,
    );
  const reset = m ? Date.parse(m[1].replace(" ", "T") + "Z") : NaN;
  llmPausedUntil = Number.isFinite(reset) ? reset : Date.now() + 3_600_000;
  llmPauseReason = e.message;
  llmPausedFor = s.endpoint + s.model;
}

export async function chatComplete(
  s: LlmSettings,
  system: string,
  user: string,
  maxTokens = 300,
): Promise<string> {
  const paused = llmPause(s);
  if (paused) throw new ApiError(paused.reason, 429);
  try {
    return await chatCompleteOnce(s, system, user, maxTokens);
  } catch (e) {
    if (e instanceof ApiError) pauseFromError(e, s);
    throw e;
  }
}

async function chatCompleteOnce(
  s: LlmSettings,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  if (!s.model) throw new ApiError("No model configured");
  const url = chatURL(s.endpoint, s.format);
  if (s.format === "anthropic")
    return anthropicMessages(s, url, system, user, maxTokens);
  const data = await postJSON(
    url,
    {
      model: s.model,
      max_tokens: tokenLimit(s, url, maxTokens),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    authHeader(s.key),
    LLM_TIMEOUT,
  );
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new ApiError(
      choice?.finish_reason === "length"
        ? "Response hit max_tokens before any text"
        : "Response has no text",
    );
  return cleanCompletion(text);
}

/**
 * Models that think before answering spend part of max_tokens on reasoning,
 * so a short answer still needs a generous limit. DeepSeek's API thinks by
 * default (api-docs.deepseek.com/guides/thinking_mode), in both formats.
 * Through OpenRouter, reasoning tokens also count against max_tokens, and
 * most of its current models reason.
 */
export function tokenLimit(
  s: Pick<LlmSettings, "model">,
  url: string,
  maxTokens: number,
): number {
  const host = hostOf(url);
  const thinks =
    host === "api.deepseek.com" ||
    host === "openrouter.ai" ||
    (host === "api.anthropic.com" && CLAUDE_WITH_EFFORT.test(s.model));
  return thinks ? Math.max(maxTokens, THINKING_TOKENS) : maxTokens;
}

const THINKING_TOKENS = 8192;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// --- Anthropic Messages API ------------------------------------------------

/**
 * Current Claude models think by default and can't all switch it off
 * (`thinking: {type: "disabled"}` is a 400 on Opus 5.5 and Sonnet 5.5), so
 * short answers ask for low effort instead. Older models (Haiku 4.5,
 * Sonnet 4.5, ...) reject `effort`, so it is only sent to these families.
 */
const CLAUDE_WITH_EFFORT =
  /^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-5|opus-4-[678]|sonnet-4-6)/;

async function anthropicMessages(
  s: LlmSettings,
  url: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const official = hostOf(url) === "api.anthropic.com";
  const effort = official && CLAUDE_WITH_EFFORT.test(s.model);
  const data = await postJSON(
    url,
    {
      model: s.model,
      max_tokens: tokenLimit(s, url, maxTokens),
      system,
      messages: [{ role: "user", content: user }],
      ...(effort ? { output_config: { effort: "low" } } : {}),
    },
    {
      "x-api-key": s.key,
      // Anthropic-compatible third-party endpoints may only know the
      // original version; nothing here depends on the newer one.
      "anthropic-version": official ? "2026-10-21" : "2023-06-01",
    },
    LLM_TIMEOUT,
  );
  if (data?.stop_reason === "refusal")
    throw new ApiError(
      `The model declined${data?.stop_details?.category ? ` (${data.stop_details.category})` : ""}`,
    );
  // Skip thinking blocks; only text blocks are the answer.
  const text = (data?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("");
  if (!text.trim())
    throw new ApiError(
      data?.stop_reason === "max_tokens"
        ? "Response hit max_tokens before any text"
        : "Response has no text",
    );
  return cleanCompletion(text);
}

/** Hosted models are slow at times (KIT: 1-47 s observed). */
const LLM_TIMEOUT = 180_000;

/** Drop reasoning/safety tags some hosted models leak into the content. */
export function cleanCompletion(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<ds_safety>[\s\S]*?<\/ds_safety>\s*(Safe|Unsafe)?/g, "")
    .trim();
}

/** Short definition of a concept for readers of the given paper. */
export async function llmDefinition(
  concept: string,
  context: string,
  s: LlmSettings = llmSettings(),
): Promise<string> {
  return chatComplete(
    s,
    "You explain technical concepts to researchers reading a paper. " +
      "Use the paper's title, abstract and passages to pick the sense of the " +
      "term used in that field; do not guess a different field. Give a " +
      "definition in at most two sentences, then one sentence on why it " +
      "matters in this paper. Plain text, no preamble.",
    `Concept: ${concept}\n\n${context.slice(0, 4000)}`,
  );
}
