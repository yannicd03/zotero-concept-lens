/**
 * Spending tracker: every successful API call is counted per local day and
 * per service/host/model, with its tokens and cost. OpenRouter reports the
 * exact cost of each request (usage.cost); DeepSeek and Anthropic only
 * report tokens, so their cost is estimated from the price lists below.
 * Other endpoints are counted without a cost. Kept in
 * <Zotero data directory>/conceptlens/usage.json.
 */
import { readJSON, writeJSON } from "../utils/store";
import { log } from "../utils/log";

export type Service = "decision" | "llm";

export interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, summed over the requests with a known cost */
  cost: number;
  /** Requests whose cost is unknown (custom endpoints) */
  unpriced: number;
  /** Requests whose cost is a price-list estimate, not reported */
  estimated: number;
}

interface UsageFile {
  version: 1;
  /** "YYYY-MM-DD" (local) → "service|host|model" → totals */
  days: Record<string, Record<string, Totals>>;
}

const FILE = "usage.json";
const SAVE_DELAY = 2000;

let data: UsageFile | undefined;
let loading: Promise<UsageFile> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function empty(): Totals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    unpriced: 0,
    estimated: 0,
  };
}

async function load(): Promise<UsageFile> {
  if (data) return data;
  loading ??= readJSON<UsageFile>(FILE).then((d) => {
    data = d?.version === 1 && d.days ? d : { version: 1, days: {} };
    return data;
  });
  return loading;
}

function scheduleSave() {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    if (data) writeJSON(data, FILE).catch((e) => log("saving usage failed", e));
  }, SAVE_DELAY);
}

/** Writes pending counts now (e.g. on shutdown). */
export async function flush() {
  if (saveTimer === undefined || !data) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  await writeJSON(data, FILE);
}

export function dayKey(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- cost -------------------------------------------------------------------

/** Token counts of a response, in either API format. */
export interface TokenUsage {
  input: number;
  /** Part of `input` read from the provider's prompt cache */
  cachedInput: number;
  /** Part of `input` written to the prompt cache (Anthropic) */
  cacheWrite: number;
  output: number;
  /** Cost the provider reported (OpenRouter), USD */
  reportedCost?: number;
}

/** Reads OpenAI-style (prompt_tokens) and Anthropic-style (input_tokens) usage. */
export function readUsage(usage: any): TokenUsage {
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  if (!usage || typeof usage !== "object")
    return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  const reportedCost =
    typeof usage.cost === "number" && usage.cost >= 0 ? usage.cost : undefined;
  if ("prompt_tokens" in usage)
    return {
      input: num(usage.prompt_tokens),
      cachedInput:
        num(usage.prompt_cache_hit_tokens) ||
        num(usage.prompt_tokens_details?.cached_tokens),
      cacheWrite: 0,
      output: num(usage.completion_tokens),
      reportedCost,
    };
  // Anthropic: input_tokens excludes cache reads and writes.
  const cachedInput = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  return {
    input: num(usage.input_tokens) + cachedInput + cacheWrite,
    cachedInput,
    cacheWrite,
    output: num(usage.output_tokens),
    reportedCost,
  };
}

/** USD per million tokens. */
interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

// api-docs.deepseek.com/quick_start/pricing (2026-11-10): peak prices;
// off-peak is half.
const DEEPSEEK: Record<string, Price> = {
  "deepseek-flash": { input: 0.3, cachedInput: 0.006, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cachedInput: 0.044, output: 3.96 },
};
// Retired names, billed as Flash
DEEPSEEK["deepseek-v4-flash"] = DEEPSEEK["deepseek-flash"];

// Anthropic's model list (2026-11-10); Haiku's price is for prompts of up
// to 100K tokens, which covers every request this plugin makes.
const ANTHROPIC: [RegExp, Price][] = [
  [/^claude-haiku-5-5/, { input: 0.1, cachedInput: 0.01, output: 0.5 }],
  [/^claude-sonnet-5-5/, { input: 2, cachedInput: 0.1, output: 10 }],
  [/^claude-opus-5-5/, { input: 4, cachedInput: 0.2, output: 20 }],
];
/** 5-minute cache writes cost 1.25x the input price. */
const CACHE_WRITE_FACTOR = 1.25;

/** DeepSeek peak hours: 01-04 and 06-10 UTC, Monday to Friday. */
export function deepseekPeak(time: number): boolean {
  const d = new Date(time);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/**
 * Cost of one request in USD and whether it is an estimate; undefined when
 * neither the response nor a price list gives one.
 */
export function costOf(
  host: string,
  model: string,
  u: TokenUsage,
  time: number,
): { cost: number; estimated: boolean } | undefined {
  if (u.reportedCost !== undefined)
    return { cost: u.reportedCost, estimated: false };
  let price: Price | undefined;
  let factor = 1;
  if (host === "api.deepseek.com") {
    price = DEEPSEEK[model];
    if (!deepseekPeak(time)) factor = 0.5;
  } else if (host === "api.anthropic.com") {
    price = ANTHROPIC.find(([re]) => re.test(model))?.[1];
  }
  if (!price) return undefined;
  const fresh = u.input - u.cachedInput - u.cacheWrite;
  const cost =
    (fresh * price.input +
      u.cachedInput * price.cachedInput +
      u.cacheWrite * price.input * CACHE_WRITE_FACTOR +
      u.output * price.output) /
    1e6;
  return { cost: cost * factor, estimated: true };
}

// --- recording --------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Counts one successful request. Never throws. */
export async function record(
  service: Service,
  url: string,
  model: string,
  usage: any,
  time = Date.now(),
) {
  try {
    const host = hostOf(url);
    const u = readUsage(usage);
    const c = costOf(host, model, u, time);
    const d = await load();
    const day = (d.days[dayKey(time)] ??= {});
    const t = (day[`${service}|${host}|${model}`] ??= empty());
    t.requests++;
    t.inputTokens += u.input;
    t.outputTokens += u.output;
    if (c) {
      t.cost += c.cost;
      if (c.estimated) t.estimated++;
    } else t.unpriced++;
    scheduleSave();
  } catch (e) {
    log("recording usage failed", e);
  }
}

// --- summary ----------------------------------------------------------------

export interface ModelRow extends Totals {
  service: Service;
  host: string;
  model: string;
}

export interface Summary {
  today: Totals;
  month: Totals;
  all: Totals;
  /** This month, by service/host/model, most expensive first */
  byModel: ModelRow[];
  since?: string;
}

function add(a: Totals, b: Totals) {
  a.requests += b.requests;
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cost += b.cost;
  a.unpriced += b.unpriced;
  a.estimated += b.estimated;
}

export async function summary(now = Date.now()): Promise<Summary> {
  const d = await load();
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const out: Summary = {
    today: empty(),
    month: empty(),
    all: empty(),
    byModel: [],
  };
  const rows = new Map<string, ModelRow>();
  const days = Object.keys(d.days).sort();
  out.since = days[0];
  for (const day of days)
    for (const [key, t] of Object.entries(d.days[day])) {
      add(out.all, t);
      if (day === today) add(out.today, t);
      if (!day.startsWith(month)) continue;
      add(out.month, t);
      let row = rows.get(key);
      if (!row) {
        const [service, host, ...rest] = key.split("|");
        row = {
          ...empty(),
          service: service as Service,
          host,
          model: rest.join("|"),
        };
        rows.set(key, row);
      }
      add(row, t);
    }
  out.byModel = [...rows.values()].sort(
    (a, b) => b.cost - a.cost || b.requests - a.requests,
  );
  return out;
}

export async function reset() {
  data = { version: 1, days: {} };
  loading = Promise.resolve(data);
  clearTimeout(saveTimer);
  saveTimer = undefined;
  await writeJSON(data, FILE);
}
