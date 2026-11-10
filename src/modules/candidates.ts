/**
 * Stage 1: rules propose concept candidates from a paper's text.
 * The decision model filters them afterwards (stage 2), so this stage
 * favours recall; noise like "accurate" is expected and filtered later.
 */

export type CandidateKind = "acronym" | "definition" | "recurring";

export interface Candidate {
  /** Canonical surface form, e.g. "model-based reinforcement learning" */
  term: string;
  /** Other surface forms found in the text, e.g. ["MBRL"] */
  aliases: string[];
  kinds: CandidateKind[];
  /** Occurrences of term + aliases in the text */
  count: number;
  /** Char offset of the first occurrence */
  first: number;
  /** Sentence that defines the term, if a definition pattern matched */
  definition?: string;
  /** Sentence that introduces the acronym (weak definition, context only) */
  introduced?: string;
}

const STOP = new Set(
  (
    "a an the and or but nor of in on at to for from by with without into onto " +
    "over under than then that this these those which who whom whose what when " +
    "where why how is are was were be been being has have had do does did can " +
    "could may might must shall should will would not no as if so such also " +
    "very more most less least many much each every all any some other both " +
    "either neither our we us you your they their them it its he she his her " +
    "i me my one two three first second third et al fig figure table section " +
    "eq equation appendix e.g i.e via using used use based results result show " +
    "shows shown paper work approach method methods propose proposed new well"
  ).split(" "),
);

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z(])/g;

export function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index!;
    out.push({ text: text.slice(start, end).trim(), start });
    start = end + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start).trim(), start });
  return out.filter((s) => s.text.length > 0);
}

/**
 * A line without lowercase letters but with an all-caps word: titles and
 * headings ("ON ROLLOUTS IN ...", "ABSTRACT", "2 BACKGROUND").
 */
export const HEADING_LINE = /^(?=[^\n]*\p{Lu}{3})[^\n\p{Ll}]+$/gmu;

/**
 * Collapse PDF extraction artefacts (hyphenated line breaks, whitespace);
 * headings get a full stop so sentences don't run through them.
 */
export function normalizeText(text: string): string {
  return text
    .replace(HEADING_LINE, (l) => (/[.!?:]\s*$/.test(l) ? l : l + "."))
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTerm(t: string): string {
  return t
    .replace(/^[\s"'“‘(]+|[\s"'”’),.;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlausibleTerm(t: string): boolean {
  if (t.length < 3 || t.length > 80) return false;
  const words = t.toLowerCase().split(/\s+/);
  if (words.length > 6) return false;
  if (STOP.has(words[0]) || STOP.has(words[words.length - 1])) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/\d{3,}/.test(t)) return false;
  return true;
}

// --- acronyms: "model-based reinforcement learning (MBRL)" -----------------

const ACRONYM = /\(([A-Z][A-Za-z0-9-]{1,9}s?)\)/g;

/** Does `long` (its last words) expand `short`? Returns the matched words. */
export function expandAcronym(
  precedingWords: string[],
  short: string,
): string | undefined {
  const letters = short
    .replace(/s$/, "")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase();
  if (letters.length < 2) return undefined;
  // Try spans of the preceding words ending right before "(".
  for (let n = 1; n <= Math.min(8, precedingWords.length); n++) {
    const span = precedingWords.slice(-n);
    // Initials, treating hyphenated parts as separate words.
    const parts = span.flatMap((w) => w.split("-")).filter(Boolean);
    const initials = parts.map((w) => w[0].toLowerCase()).join("");
    // Allow small function words to be skipped ("of", "and").
    const contentInitials = parts
      .filter((w) => !STOP.has(w.toLowerCase()))
      .map((w) => w[0].toLowerCase())
      .join("");
    if (initials === letters || contentInitials === letters) {
      const term = cleanTerm(span.join(" "));
      return isPlausibleTerm(term) ? term : undefined;
    }
  }
  return undefined;
}

function findAcronyms(text: string): Map<string, string> {
  const found = new Map<string, string>(); // short -> long
  for (const m of text.matchAll(ACRONYM)) {
    const short = m[1];
    if (found.has(short)) continue;
    const before = text.slice(Math.max(0, m.index! - 120), m.index!);
    const words = before.split(/\s+/).filter(Boolean);
    const long = expandAcronym(words, short);
    if (long) found.set(short, long);
  }
  return found;
}

// --- definition patterns ---------------------------------------------------

const TERM = String.raw`([A-Za-z][\w-]*(?:\s+[\w-]+){0,5})`;
const DEFINITION_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`\bwe (?:define|call|refer to|term|denote)\s+${TERM}\s+as\b`,
    "gi",
  ),
  new RegExp(String.raw`\b${TERM},?\s+(?:is|are)\s+defined\s+as\b`, "gi"),
  new RegExp(String.raw`\b${TERM}\s+refers?\s+to\b`, "gi"),
  new RegExp(
    String.raw`\b(?:known|referred to)\s+as\s+(?:an?\s+|the\s+)?${TERM}`,
    "gi",
  ),
  new RegExp(
    String.raw`\b(?:called|termed|dubbed)\s+(?:an?\s+|the\s+)?${TERM}`,
    "gi",
  ),
];

function findDefinitions(
  text: string,
  sents: { text: string; start: number }[],
): Map<string, string> {
  const found = new Map<string, string>(); // term -> defining sentence
  for (const s of sents) {
    for (const re of DEFINITION_PATTERNS) {
      re.lastIndex = 0;
      for (const m of s.text.matchAll(re)) {
        const term = trimStops(cleanTerm(m[1]));
        if (!isPlausibleTerm(term)) continue;
        const key = term.toLowerCase();
        if (!found.has(key)) found.set(key, s.text);
      }
    }
  }
  return found;
}

const FILLER = new Set(["term", "terms", "notion", "concept", "so-called"]);

/** "the term replay ratio of" -> "replay ratio" */
function trimStops(term: string): string {
  const words = term.split(" ");
  const drop = (w: string) =>
    STOP.has(w.toLowerCase()) || FILLER.has(w.toLowerCase());
  while (words.length > 1 && drop(words[0])) words.shift();
  while (words.length > 1 && drop(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// --- recurring multi-word terms --------------------------------------------

const WORD = /[A-Za-z][A-Za-z-]*[A-Za-z]|[A-Za-z]/g;

function findRecurring(text: string, minCount: number): Map<string, number> {
  const counts = new Map<string, number>();
  // Count n-grams within sentence-ish chunks so terms don't span punctuation.
  for (const chunk of text.split(/[.,;:!?()[\]{}"“”]/)) {
    const words = chunk.match(WORD) ?? [];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        const lower = gram.map((w) => w.toLowerCase());
        if (STOP.has(lower[0]) || STOP.has(lower[n - 1])) continue;
        if (lower.some((w) => w.length < 2)) continue;
        // Singular and plural forms count together ("rollout(s)").
        const key = singularKey(lower.join(" "));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  // Keep frequent grams; drop sub-grams that only occur inside a longer one.
  const frequent = [...counts].filter(([, c]) => c >= minCount);
  const result = new Map<string, number>();
  for (const [gram, c] of frequent) {
    const subsumed = frequent.some(
      ([other, oc]) => other !== gram && other.includes(gram) && oc >= c * 0.8,
    );
    if (!subsumed) result.set(gram, c);
  }
  return result;
}

// --- combine -----------------------------------------------------------------

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countOccurrences(text: string, forms: string[]) {
  let count = 0;
  let first = -1;
  for (const f of forms) {
    const caseSensitive = /^[A-Z0-9-]+s?$/.test(f); // acronyms
    const re = new RegExp(
      `(?<![\\w-])${escapeRe(f)}${caseSensitive ? "" : "(?:s|es)?"}(?![\\w-])`,
      caseSensitive ? "g" : "gi",
    );
    for (const m of text.matchAll(re)) {
      count++;
      if (first < 0 || m.index! < first) first = m.index!;
    }
  }
  return { count, first };
}

/** "Infoprop Rollouts" -> "infoprop rollout"; leaves "process", "analysis". */
export function singularKey(term: string): string {
  const t = term.toLowerCase();
  if (/(ss|us|is|ics)$/.test(t) || t.length < 5) return t;
  if (/[^aeiou]ies$/.test(t)) return t.slice(0, -3) + "y";
  if (/(ches|shes|xes|sses)$/.test(t)) return t.slice(0, -2);
  return t.endsWith("s") ? t.slice(0, -1) : t;
}

export interface CandidateOptions {
  /** Minimum occurrences for a phrase found only by frequency */
  minRecurring?: number;
  /** Maximum candidates returned (most frequent first) */
  limit?: number;
}

export function proposeCandidates(
  rawText: string,
  { minRecurring = 3, limit = 60 }: CandidateOptions = {},
): Candidate[] {
  const text = normalizeText(rawText);
  const sents = sentences(text);
  const byKey = new Map<string, Candidate>();

  const add = (
    term: string,
    kind: CandidateKind,
    extra?: Partial<Candidate>,
  ) => {
    const key = singularKey(term);
    const c = byKey.get(key) ?? {
      term,
      aliases: [],
      kinds: [],
      count: 0,
      first: -1,
    };
    // Prefer the singular surface form ("infoprop rollout", not "...s").
    if (term.length < c.term.length) c.term = term;
    if (!c.kinds.includes(kind)) c.kinds.push(kind);
    if (extra?.aliases)
      for (const a of extra.aliases)
        if (!c.aliases.includes(a)) c.aliases.push(a);
    if (extra?.definition && !c.definition) c.definition = extra.definition;
    if (extra?.introduced && !c.introduced) c.introduced = extra.introduced;
    byKey.set(key, c);
  };

  for (const [short, long] of findAcronyms(text)) {
    const introduced = sents.find((s) => s.text.includes(`(${short})`))?.text;
    add(long, "acronym", { aliases: [short], introduced });
  }
  for (const [term, sentence] of findDefinitions(text, sents))
    add(term, "definition", { definition: sentence });
  for (const [gram] of findRecurring(text, minRecurring))
    add(gram, "recurring");

  const out: Candidate[] = [];
  for (const c of byKey.values()) {
    const { count, first } = countOccurrences(text, [c.term, ...c.aliases]);
    if (count === 0) continue;
    c.count = count;
    c.first = first;
    out.push(c);
  }
  // Definitions and acronyms first, then by frequency.
  const rank = (c: Candidate) =>
    (c.kinds.includes("definition") ? 2 : 0) +
    (c.kinds.includes("acronym") ? 1 : 0);
  out.sort((a, b) => rank(b) - rank(a) || b.count - a.count);
  return out.slice(0, limit);
}
