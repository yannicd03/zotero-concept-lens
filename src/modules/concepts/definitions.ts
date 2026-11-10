/**
 * Definition for the hover card. Order:
 *  1. a defining sentence in this paper
 *  2. the library-wide glossary (cached results of 3 and 4)
 *  3. the best defining sentence in another paper of the library
 *     (picked by the decision model if configured)
 *  4. the LLM fallback (if enabled and configured)
 *  5. the sentence introducing the acronym in this paper
 */
import { getPref } from "../../utils/prefs";
import { readJSON, writeJSON } from "../../utils/store";
import { sentences } from "../candidates";
import { decide, llmDefinition, llmSettings } from "../clients";
import { Concept, decisionConfigured } from "./analyze";
import { cleanDocumentText } from "./doctext";
import { searchRelated, shortLabel } from "./related";
import { log } from "../../utils/log";

export interface Definition {
  text: string;
  source:
    | { kind: "paper" }
    | { kind: "library"; itemID: number; label: string }
    | { kind: "llm"; model: string }
    | { kind: "intro" };
}

type Glossary = Record<string, Definition & { at: string }>;
let glossary: Glossary | undefined;

async function loadGlossary(): Promise<Glossary> {
  glossary ??= (await readJSON<Glossary>("glossary.json")) ?? {};
  return glossary;
}

async function remember(term: string, def: Definition) {
  const g = await loadGlossary();
  g[term.toLowerCase()] = { ...def, at: new Date().toISOString() };
  await writeJSON(g, "glossary.json");
}

/** Drop one cached definition (e.g. a wrong LLM answer). */
export async function forgetDefinition(term: string) {
  const g = await loadGlossary();
  delete g[term.toLowerCase()];
  await writeJSON(g, "glossary.json");
}

export async function forgetGlossary() {
  glossary = {};
  await writeJSON(glossary, "glossary.json");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sentences in `text` that define one of `forms`, best first. */
export function definingSentences(
  text: string,
  forms: string[],
): { sentence: string; score: number }[] {
  const alts = forms
    .map((f) =>
      f
        .split(/[\s-]+/)
        .map(escapeRe)
        .join("[\\s-]*"),
    )
    .join("|");
  const T = `(?:${alts})s?`;
  const art = "(?:the |a |an )?";
  const patterns: [RegExp, number][] = [
    [
      new RegExp(
        `\\bwe (?:define|call|refer to|term|denote) ${art}${T}\\b`,
        "i",
      ),
      3,
    ],
    [new RegExp(`\\b${T}\\b[^.]{0,40}?\\b(?:is|are) defined as\\b`, "i"), 3],
    [
      new RegExp(`\\b${T}\\b\\s*(?:\\([^)]{1,30}\\))?,?\\s+refers? to\\b`, "i"),
      3,
    ],
    [
      new RegExp(
        `\\b(?:known|referred to|called|termed) as ${art}${T}\\b`,
        "i",
      ),
      2,
    ],
    [
      new RegExp(
        `\\b${T}\\b\\s*(?:\\([^)]{1,30}\\))?,?\\s+(?:is|are) (?:a|an|the)\\b`,
        "i",
      ),
      1.5,
    ],
  ];
  const out: { sentence: string; score: number }[] = [];
  for (const s of sentences(text.replace(/\s+/g, " "))) {
    if (s.text.length < 30 || s.text.length > 400) continue;
    let best = 0;
    for (const [re, score] of patterns)
      if (re.test(s.text)) best = Math.max(best, score);
    if (best) out.push({ sentence: s.text, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function fromLibrary(
  concept: Concept,
  current: Zotero.Item | null,
  libraryID: number,
): Promise<Definition | undefined> {
  const { papers } = await searchRelated(libraryID, concept.term, current, 6);
  const options: {
    sentence: string;
    score: number;
    itemID: number;
    label: string;
  }[] = [];
  for (const p of papers) {
    const item = Zotero.Items.get(p.itemID);
    if (!item) continue;
    const att = await item.getBestAttachment();
    if (!att) continue;
    const text = cleanDocumentText(await att.attachmentText);
    const found = definingSentences(text, [concept.term]).filter(
      (d) => d.score >= 1.5,
    );
    if (found[0])
      options.push({ ...found[0], itemID: item.id, label: shortLabel(item) });
  }
  if (!options.length) return undefined;
  options.sort((a, b) => b.score - a.score);
  let pick = options[0];
  if (options.length > 1 && decisionConfigured()) {
    try {
      const criteria: Record<string, string> = {};
      options.slice(0, 8).forEach((o, i) => (criteria[`s${i}`] = o.sentence));
      const a = await decide(`Concept: ${concept.term}`, {
        best: {
          type: "choice",
          instructions: `Which sentence gives the clearest, most general definition of "${concept.term}"?`,
          criteria,
        },
      });
      const choice = a.best?.type === "choice" ? a.best.choice : "";
      const i = Number(choice.replace(/^s/, ""));
      if (Number.isInteger(i) && options[i]) pick = options[i];
    } catch (e) {
      log("decision model choice failed, using rule ranking", e);
    }
  }
  return {
    text: pick.sentence,
    source: { kind: "library", itemID: pick.itemID, label: pick.label },
  };
}

export function llmConfigured(): boolean {
  const s = llmSettings();
  return !!(getPref("llm.enabled") && s.endpoint && s.model);
}

const pending = new Map<string, Promise<Definition | undefined>>();

export function resolveDefinition(
  concept: Concept,
  current: Zotero.Item | null,
  libraryID: number,
  context: string,
): Promise<Definition | undefined> {
  if (concept.definition)
    return Promise.resolve({
      text: concept.definition,
      source: { kind: "paper" },
    });
  const key = concept.term.toLowerCase();
  if (pending.has(key)) return pending.get(key)!;
  const p = (async (): Promise<Definition | undefined> => {
    const g = await loadGlossary();
    if (g[key]) return g[key];
    const lib = await fromLibrary(concept, current, libraryID);
    if (lib) {
      await remember(concept.term, lib);
      return lib;
    }
    if (llmConfigured()) {
      try {
        const s = llmSettings();
        const text = await llmDefinition(concept.term, context, s);
        const def: Definition = {
          text,
          source: { kind: "llm", model: s.model },
        };
        await remember(concept.term, def);
        return def;
      } catch (e) {
        log("LLM fallback failed", e);
      }
    }
    if (concept.introduced)
      return { text: concept.introduced, source: { kind: "intro" } };
    return undefined;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
