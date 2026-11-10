/**
 * Per-paper concept analysis: rules propose candidates, the decision model
 * (if configured) filters them, the result is cached per attachment.
 */
import { getPref } from "../../utils/prefs";
import { readJSON, writeJSON } from "../../utils/store";
import { Candidate, proposeCandidates } from "../candidates";
import { DecisionQuestion, decide, decisionSettings } from "../clients";
import { cleanDocumentText } from "./doctext";
import { log } from "../../utils/log";
import { updateIndex } from "./conceptIndex";

export interface Concept {
  id: string;
  term: string;
  aliases: string[];
  kinds: Candidate["kinds"];
  count: number;
  /** Defining sentence in this paper (definition pattern) */
  definition?: string;
  /** Sentence introducing the acronym in this paper */
  introduced?: string;
  /** Decision-model probability, if it ran */
  score?: number;
}

export interface ConceptSet {
  version: number;
  settingsKey: string;
  filteredBy: "decision" | "rules";
  concepts: Concept[];
  /** Set when the decision model was configured but failed */
  error?: string;
  /** Zotero has no text for the PDF yet (not full-text indexed) */
  noText?: boolean;
}

const VERSION = 4; // bump when candidate generation changes

export function decisionConfigured(): boolean {
  const s = decisionSettings();
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(s.endpoint);
  return !!(s.endpoint && s.model && (s.key || local));
}

function settingsKey(): string {
  if (!decisionConfigured()) return "rules";
  const s = decisionSettings();
  return [s.format, s.endpoint, s.model, getPref("decision.threshold")].join(
    "|",
  );
}

// --- rule-only filter (used until a decision model is configured) ----------

const NOISE =
  /\b(conference|proceedings|workshop|symposium|journal|transactions|university|institute|arxiv|preprint|iclr|neurips|icml|aaai|ijcai|cvpr|iccv|eccv|et al|copyright|licen[cs]e|corresponding author)\b/i;

function ruleFilter(c: Candidate): boolean {
  if (NOISE.test(c.term)) return false;
  if (/\d/.test(c.term)) return false;
  const words = c.term.split(/\s+/).length;
  if (
    c.kinds.includes("definition") &&
    words > 4 &&
    !c.kinds.includes("acronym")
  )
    return false;
  if (c.kinds.length === 1 && c.kinds[0] === "recurring" && c.count < 4)
    return false;
  if (c.kinds.includes("acronym") && c.count < 2) return false;
  return true;
}

// --- decision-model filter ---------------------------------------------------

function question(c: Candidate): DecisionQuestion {
  const alias = c.aliases.length
    ? ` (also written ${c.aliases.join(", ")})`
    : "";
  return {
    type: "noul",
    instructions:
      `Is "${c.term}"${alias} a domain concept or technical term that a reader ` +
      `of this paper may want explained? Answer no for generic phrases, ` +
      `adjectives, venue or institution names, people, and fragments of ` +
      `citations or headers.`,
  };
}

async function decisionFilter(
  title: string,
  text: string,
  cands: Candidate[],
): Promise<{ keep: Candidate[]; scores: Map<Candidate, number> }> {
  const questions: Record<string, DecisionQuestion> = {};
  cands.forEach((c, i) => (questions[`c${i}`] = question(c)));
  const state = `Title: ${title}\n\n${text.slice(0, 60_000)}`;
  const answers = await decide(state, questions);
  const threshold = (getPref("decision.threshold") ?? 80) / 100;
  const scores = new Map<Candidate, number>();
  const keep: Candidate[] = [];
  cands.forEach((c, i) => {
    const a = answers[`c${i}`];
    const p = a?.type === "noul" ? a.noul : 0;
    scores.set(c, p);
    if (p >= threshold) keep.push(c);
  });
  return { keep, scores };
}

// --- entry point ---------------------------------------------------------------

const inflight = new Map<string, Promise<ConceptSet>>();

export function cacheName(att: Zotero.Item) {
  return `${att.libraryID}-${att.key}.json`;
}

/** The cached analysis, if it is current for the present settings. */
export async function cachedAnalysis(
  att: Zotero.Item,
): Promise<ConceptSet | undefined> {
  const cached = await readJSON<ConceptSet>("papers", cacheName(att));
  return cached?.version === VERSION && cached.settingsKey === settingsKey()
    ? cached
    : undefined;
}

export const ANALYSIS_VERSION = VERSION;

export function analyzeAttachment(
  att: Zotero.Item,
  { force = false } = {},
): Promise<ConceptSet> {
  const key = `${att.libraryID}/${att.key}`;
  if (!force && inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    const sk = settingsKey();
    if (!force) {
      const cached = await cachedAnalysis(att);
      if (cached) return cached;
    }
    const raw = await att.attachmentText;
    // Not indexed yet: nothing to analyse, and nothing to cache.
    if (!raw?.trim())
      return {
        version: VERSION,
        settingsKey: sk,
        filteredBy: "rules",
        concepts: [],
        noText: true,
      } satisfies ConceptSet;
    const text = cleanDocumentText(raw);
    const cands = proposeCandidates(text);
    const title = att.parentItem?.getField("title") ?? att.getField("title");

    let kept: Candidate[];
    let scores = new Map<Candidate, number>();
    let filteredBy: ConceptSet["filteredBy"] = "rules";
    let error: string | undefined;
    if (decisionConfigured() && cands.length) {
      try {
        ({ keep: kept, scores } = await decisionFilter(title, text, cands));
        filteredBy = "decision";
      } catch (e: any) {
        error = String(e?.message ?? e);
        log("decision model failed, using rules", e);
        kept = cands.filter(ruleFilter);
      }
    } else {
      kept = cands.filter(ruleFilter);
    }

    const set: ConceptSet = {
      version: VERSION,
      settingsKey: error ? "rules-after-error" : sk,
      filteredBy,
      error,
      concepts: kept.map((c, i) => ({
        id: `k${i}`,
        term: c.term,
        aliases: c.aliases,
        kinds: c.kinds,
        count: c.count,
        definition: c.definition,
        introduced: c.introduced,
        score: scores.get(c),
      })),
    };
    // Don't cache a fallback result: retry the model next time.
    if (!error) {
      await writeJSON(set, "papers", cacheName(att));
      updateIndex(att, set);
    }
    return set;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
