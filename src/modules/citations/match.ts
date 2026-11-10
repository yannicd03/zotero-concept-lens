/**
 * Matching a bibliography entry (as text) to a library item: DOI and arXiv
 * ID first, then a fuzzy title match guarded by author and year. Also cuts
 * the entry a link points at out of a page's structured chars.
 * Pure functions: no Zotero or DOM access.
 */
import type { PdfChar } from "../reader/pagetext";

/** What the matcher needs to know about a library item. */
export interface LibraryEntry {
  id: number;
  title: string;
  year?: number;
  /** Lower-case, no "https://doi.org/" prefix */
  doi?: string;
  /** Without version, e.g. "1805.12114" or "cs/0101001" */
  arxiv?: string;
  /** Creator last names */
  creators: string[];
}

export interface ReferenceMatch {
  id: number;
  by: "doi" | "arxiv" | "title";
  score: number;
}

/** Minimum Dice similarity for a fuzzy title match. */
export const MIN_TITLE_SIMILARITY = 0.85;

/** Lower-case letters and digits only (PDF text loses and invents spaces). */
export function compact(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Dice coefficient over character bigrams of the compacted strings. */
export function dice(a: string, b: string): number {
  const x = compact(a);
  const y = compact(b);
  if (x === y) return x ? 1 : 0;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = bigrams.get(g) ?? 0;
    if (n > 0) {
      shared++;
      bigrams.set(g, n - 1);
    }
  }
  return (2 * shared) / (x.length + y.length - 2);
}

// --- identifiers ----------------------------------------------------------------

export function extractDOI(text: string): string | undefined {
  const m = text.match(/\b10\.\d{4,9}\/[^\s"<>]+/i);
  if (!m) return undefined;
  return m[0].replace(/[.,;:)\]]+$/, "").toLowerCase();
}

const ARXIV_NEW = String.raw`(\d{4}\.\d{4,5})(?:v\d+)?`;
const ARXIV_OLD = String.raw`([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?`;

/**
 * arXiv ID from "arXiv:1805.12114", "arXiv preprint arXiv:1805.12114v2",
 * "arxiv.org/abs/1805.12114", "10.48550/arXiv.1805.12114", or old-style
 * "arXiv:cs/0101001".
 */
export function extractArxivId(text: string): string | undefined {
  const res = [
    new RegExp(
      String.raw`arxiv(?:\.org\/(?:abs|pdf)\/|[:.]\s?)` + ARXIV_NEW,
      "i",
    ),
    new RegExp(String.raw`arxiv(?:\.org\/(?:abs|pdf)\/|:\s?)` + ARXIV_OLD, "i"),
  ];
  for (const re of res) {
    const m = text.match(re);
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

/** Plausible publication years mentioned in the text. */
export function extractYears(text: string): number[] {
  const now = new Date().getFullYear();
  return [...text.matchAll(/(?<![\d.-])(1[89]\d\d|20\d\d)(?![\d-])/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y <= now + 1);
}

// --- title candidates -----------------------------------------------------------

// Abbreviations that end with "." inside a reference without ending a segment.
const ABBREV =
  /(?:^|\s)(?:al|et|vol|no|pp|eds?|proc|int|conf|adv|inf|process|syst|trans|j|jr|dr|st|vs|e\.g|i\.e|cf|univ|dept|assoc|comput|mach|learn|neural|res|rev|sci|bull|lett|phys|stat|math|appl|intell|artif|rob|autom|soc|annu|symp|inc|ltd|co)\.$/i;

/**
 * Text segments that could be the title: quoted parts (IEEE style) and the
 * ". "-separated segments of the entry (plus pairs of neighbours, for titles
 * containing "? " or ". "). Author initials ("K. Chua") do not split.
 */
export function titleCandidates(reference: string): string[] {
  const text = reference
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:\[\d+\]|\d{1,3}\.)\s*/, "")
    .trim();
  const out: string[] = [];
  for (const m of text.matchAll(/["“„]([^"“”]{10,})["”]/g))
    out.push(m[1].replace(/[\s,.]+$/, ""));

  const raw = text.split(/(?<=[.?!])\s+/);
  const segs: string[] = [];
  for (const piece of raw) {
    const prev = segs[segs.length - 1];
    // Don't split after an initial ("K.") or an abbreviation ("et al.").
    if (prev && (/(?:^|[\s.-])\p{Lu}\.$/u.test(prev) || ABBREV.test(prev)))
      segs[segs.length - 1] = `${prev} ${piece}`;
    else segs.push(piece);
  }
  const clean = (s: string) =>
    s
      .replace(/^\(?(?:19|20)\d\d[a-z]?\)?[.,:]?\s*/, "")
      .replace(/[\s,.]+$/, "")
      .replace(/^(?:In:?\s+)/, "")
      .trim();
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  for (let i = 0; i < segs.length; i++) {
    const s = clean(segs[i]);
    if (words(s) >= 2) out.push(s);
    if (i + 1 < segs.length) {
      const pair = clean(`${segs[i]} ${segs[i + 1]}`);
      if (words(pair) >= 3) out.push(pair);
    }
  }
  return [...new Set(out)];
}

// --- matching -------------------------------------------------------------------

/** Some creator's last name appears in the reference text. */
function authorAgrees(entry: LibraryEntry, refCompact: string): boolean {
  const names = entry.creators.map(compact).filter((n) => n.length >= 2);
  if (!names.length) return true;
  return names.some((n) => refCompact.includes(n));
}

function yearAgrees(entry: LibraryEntry, years: number[]): boolean {
  if (!entry.year || !years.length) return true;
  return years.some((y) => Math.abs(y - entry.year!) <= 1);
}

/**
 * Title score: 1 when the whole library title occurs in the reference
 * (compacted), else the best Dice similarity against a title candidate.
 */
export function titleScore(
  title: string,
  refCompact: string,
  candidates: string[],
): number {
  const t = compact(title);
  if (t.length < 8) return 0;
  if (refCompact.includes(t)) return 1;
  let best = 0;
  for (const c of candidates) best = Math.max(best, dice(title, c));
  return best;
}

/**
 * The library item a bibliography entry refers to, if any. DOI and arXiv
 * ID are exact. A title match needs similarity >= MIN_TITLE_SIMILARITY, one
 * of the item's creators named in the entry, and the year to agree (within
 * one year, for preprint vs. published) - unless the title is long and an
 * almost exact match.
 */
export function matchReference(
  reference: string,
  entries: LibraryEntry[],
): ReferenceMatch | null {
  const doi = extractDOI(reference);
  if (doi) {
    const e = entries.find((x) => x.doi === doi);
    if (e) return { id: e.id, by: "doi", score: 1 };
  }
  const arxiv = extractArxivId(reference);
  if (arxiv) {
    const e = entries.find((x) => x.arxiv === arxiv);
    if (e) return { id: e.id, by: "arxiv", score: 1 };
  }

  const refCompact = compact(reference);
  const candidates = titleCandidates(reference);
  const years = extractYears(reference);
  let best: ReferenceMatch | null = null;
  for (const e of entries) {
    const score = titleScore(e.title, refCompact, candidates);
    if (score < MIN_TITLE_SIMILARITY) continue;
    if (!authorAgrees(e, refCompact)) continue;
    const longExact = score >= 0.95 && compact(e.title).length >= 30;
    if (!yearAgrees(e, years) && !longExact) continue;
    if (!best || score > best.score) best = { id: e.id, by: "title", score };
  }
  return best;
}

/** arXiv ID of a library item, from its DOI, URL, Extra or archive ID. */
export function arxivIdFromFields(...fields: (string | undefined)[]) {
  for (const f of fields) {
    const id = f && extractArxivId(f);
    if (id) return id;
  }
  return undefined;
}

// --- bibliography entry at a link destination -----------------------------------

interface Line {
  x0: number;
  y0: number;
  y1: number;
  text: string;
  /** Ends with a paragraph break */
  pb: boolean;
  /** Ends with a hyphenation hyphen: the word continues on the next line */
  join: boolean;
}

/** Text lines of a page (PDF user space, y grows upwards). */
export function pageLines(chars: PdfChar[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const ch of chars) {
    if (!cur)
      cur = {
        x0: ch.rect[0],
        y0: ch.rect[1],
        y1: ch.rect[3],
        text: "",
        pb: false,
        join: false,
      };
    cur.x0 = Math.min(cur.x0, ch.rect[0]);
    cur.y0 = Math.min(cur.y0, ch.rect[1]);
    cur.y1 = Math.max(cur.y1, ch.rect[3]);
    if (!ch.ignorable) cur.text += ch.c;
    if (ch.spaceAfter && !ch.lineBreakAfter) cur.text += " ";
    if (ch.lineBreakAfter || ch.paragraphBreakAfter) {
      cur.pb = !!ch.paragraphBreakAfter;
      cur.join = !!ch.ignorable;
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const ENTRY_MARKER = /^\s*(?:\[\d+\]|\d{1,3}\.\s)/;

/**
 * The bibliography entry starting at a link destination point (x may be
 * null for "fit horizontally" destinations): the line just below the point,
 * plus continuation lines until the next entry starts (hanging indent ends,
 * a "[n]" marker, a paragraph break, a column change or a large gap).
 */
export function entryAtPoint(
  chars: PdfChar[],
  x: number | null,
  y: number,
  maxLines = 10,
): string | undefined {
  const lines = pageLines(chars);
  let start = -1;
  let bestCost = Infinity;
  lines.forEach((l, i) => {
    if (l.y1 > y + 3 || l.y1 < y - 30) return;
    if (x !== null && (l.x0 < x - 12 || l.x0 > x + 150)) return;
    const cost = Math.abs(y - l.y1) + (x === null ? 0 : (l.x0 - x) * 0.2);
    if (cost < bestCost) {
      bestCost = cost;
      start = i;
    }
  });
  if (start < 0) return undefined;
  const first = lines[start];
  const height = first.y1 - first.y0;
  const parts = [first];
  // Hanging-indent bibliography: continuation lines sit a little right of
  // the margin, so any line back at the margin starts the next entry.
  const hanging = lines.some(
    (l) => l.x0 > first.x0 + 2 && l.x0 < first.x0 + 30,
  );
  for (let i = start + 1; i < lines.length && parts.length < maxLines; i++) {
    const prev = lines[i - 1];
    const l = lines[i];
    if (prev.pb) break;
    if (ENTRY_MARKER.test(l.text)) break;
    if (l.y1 > prev.y0 + 2) break; // moved up: next column or page part
    if (prev.y0 - l.y1 > height * 1.5) break; // gap between entries
    if (Math.abs(l.x0 - first.x0) > 60) break; // other column
    if (hanging && l.x0 <= first.x0 + 2) break;
    parts.push(l);
  }
  let text = "";
  for (const p of parts) {
    text += p.text;
    if (!p.join) text += " ";
  }
  return text.replace(/\s+/g, " ").trim() || undefined;
}

/** Plain text of a reference from the reader's structured chars. */
export function charsText(chars: PdfChar[]): string {
  let text = "";
  for (const ch of chars) {
    if (!ch.ignorable) text += ch.c;
    if (ch.spaceAfter || (ch.lineBreakAfter && !ch.ignorable)) text += " ";
  }
  return text.replace(/\s+/g, " ").trim();
}

// --- card text ------------------------------------------------------------------

/** "A, B and C" / "A, B, C et al." */
export function formatAuthors(names: string[], max = 4): string {
  if (!names.length) return "";
  if (names.length > max) return `${names.slice(0, 3).join(", ")} et al.`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Cut at a word boundary, with an ellipsis. */
export function truncate(text: string, max = 600): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.7 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
