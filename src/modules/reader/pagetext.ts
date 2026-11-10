/**
 * Page text from Zotero's structured chars (pdfDocument.getPageData), concept
 * matching on it, and conversion of matches into underline boxes.
 * Pure functions: no Zotero or DOM access.
 */

/** The subset of a structured char this module uses (PDF user space). */
export interface PdfChar {
  c: string;
  rect: [number, number, number, number];
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  /** Line-end hyphenation hyphen */
  ignorable?: boolean;
}

export interface PageText {
  text: string;
  /** text index -> char index (-1 for inserted spaces) */
  map: number[];
}

export function buildPageText(chars: PdfChar[]): PageText {
  let text = "";
  const map: number[] = [];
  chars.forEach((ch, i) => {
    if (!ch.ignorable) {
      text += ch.c;
      for (let k = 0; k < ch.c.length; k++) map.push(i);
    }
    // Line breaks stay "\n" so headings can be recognised as whole lines;
    // a hyphenation hyphen (ignorable) joins the word across the break.
    const sep =
      ch.paragraphBreakAfter || (ch.lineBreakAfter && !ch.ignorable)
        ? "\n"
        : ch.spaceAfter
          ? " "
          : "";
    if (sep && !/[ \n]$/.test(text)) {
      text += sep;
      map.push(-1);
    }
  });
  return { text, map };
}

export interface MatchTarget {
  id: string;
  forms: string[];
}

export interface Match {
  id: string;
  start: number;
  end: number;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const isAcronym = (f: string) => /^[A-Z][A-Z0-9-]*s?$/.test(f);

/** Regex for a surface form; tolerant to hyphen/space variation and plurals. */
export function formRegex(form: string): RegExp {
  const words = form
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(escapeRe);
  const body = words.join("[\\s-]*");
  const plural = isAcronym(form) ? "s?" : "(?:s|es)?";
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${body}${plural}(?![\\p{L}\\p{N}])`,
    isAcronym(form) ? "gu" : "giu",
  );
}

/**
 * All non-overlapping matches; longer forms win over shorter ones
 * ("model-based reinforcement learning" over "reinforcement learning").
 */
export function findMatches(
  text: string,
  targets: MatchTarget[],
  range: [number, number] = [0, text.length],
): Match[] {
  const forms = targets
    .flatMap((t) => t.forms.map((f) => ({ id: t.id, f })))
    .sort((a, b) => b.f.length - a.f.length);
  const taken = new Uint8Array(text.length);
  const out: Match[] = [];
  for (const { id, f } of forms) {
    for (const m of text.matchAll(formRegex(f))) {
      const start = m.index!;
      const end = start + m[0].length;
      if (start < range[0] || end > range[1]) continue;
      let free = true;
      for (let i = start; i < end; i++) if (taken[i]) free = false;
      if (!free) continue;
      taken.fill(1, start, end);
      out.push({ id, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export type Rect = [number, number, number, number];

/** One box per line covered by text[start, end) (PDF user space). */
export function rectsForRange(
  chars: PdfChar[],
  page: PageText,
  start: number,
  end: number,
): Rect[] {
  const rects: Rect[] = [];
  let cur: Rect | null = null;
  let lastChar = -1;
  for (let i = start; i < end; i++) {
    const ci = page.map[i];
    if (ci < 0 || ci === lastChar) continue;
    lastChar = ci;
    const [x1, y1, x2, y2] = chars[ci].rect;
    const sameLine =
      cur && Math.min(cur[3], y2) - Math.max(cur[1], y1) > 0.5 * (y2 - y1);
    if (cur && sameLine) {
      cur = [
        Math.min(cur[0], x1),
        Math.min(cur[1], y1),
        Math.max(cur[2], x2),
        Math.max(cur[3], y2),
      ];
      rects[rects.length - 1] = cur;
    } else {
      cur = [x1, y1, x2, y2];
      rects.push(cur);
    }
  }
  return rects;
}

/** A whole line without lowercase letters, with an all-caps word. */
const HEADING = /(?<=^|\n)(?=[^\n]*\p{Lu}{3})[^\n\p{Ll}]+(?=\n|$)/gu;

/** The sentence around text[start, end), trimmed to at most `max` chars. */
export function sentenceAround(
  text: string,
  start: number,
  end: number,
  max = 320,
): string {
  const before = text.slice(0, start);
  // Sentence start: after ". " / "? " / "! " followed by an uppercase
  // letter, or after a heading line (no lowercase letters, e.g. a title).
  const re = /[.!?]\s+(?=[\p{Lu}(])/gu;
  let s = 0;
  for (const m of before.matchAll(re)) s = m.index! + m[0].length;
  for (const m of before.matchAll(HEADING))
    s = Math.max(s, m.index! + m[0].length);
  const rest = text.slice(end);
  const after = /[.!?](?=\s+[\p{Lu}(]|\s*$)/u.exec(rest);
  let e = after ? end + after.index + 1 : text.length;
  for (const m of rest.matchAll(HEADING)) {
    e = Math.min(e, end + m.index!);
    break;
  }
  let sentence = flatten(text.slice(s, e));
  if (sentence.length > max) {
    // Keep a window centred on the match.
    const mid = start - s + (end - start) / 2;
    const from = Math.max(0, Math.round(mid - max / 2));
    sentence =
      (from > 0 ? "…" : "") +
      sentence.slice(from, from + max).trim() +
      (from + max < sentence.length ? "…" : "");
  }
  return sentence;
}

/** Start of a "References"/"Bibliography" heading line, or -1. */
export function referencesHeadingIndex(text: string): number {
  const m =
    /(?:^|\n)(?:\d+\.?\s+)?(REFERENCES|References|Bibliography|BIBLIOGRAPHY)[ \t]*\n/.exec(
      text,
    );
  return m ? m.index + m[0].indexOf(m[1]) : -1;
}

/** Start of an appendix heading line ("Appendix", "A Proofs", "A  EXPERIMENTS"), or -1. */
export function appendixHeadingIndex(text: string): number {
  const m =
    /(?:^|\n)((?:APPENDIX|Appendix|APPENDICES|Supplementary Material)\b[^\n]*|A\.?\s+[A-Z][A-Za-z-]*(?: [A-Za-z-]+){0,6})[ \t]*\n/.exec(
      text,
    );
  return m ? m.index + m[0].indexOf(m[1]) : -1;
}

/** Display form of a page-text snippet. */
export function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
