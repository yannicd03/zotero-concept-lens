/**
 * Definition for the hover card. Order:
 *  1. a defining sentence in this paper
 *  2. the library-wide glossary (cached results of 3 and 4)
 *  3. the best defining sentence in another paper of the library
 *     (picked by the decision model if configured)
 *  4. the LLM fallback (if enabled and configured)
 *  5. the sentence introducing the acronym in this paper
 *
 * The glossary can be shared between computers (shared.ts): entries are
 * merged per term, newest first, and deletions are kept as markers so a
 * merge doesn't bring them back.
 */
import { getPref } from "../../utils/prefs";
import { readJSON, writeJSON } from "../../utils/store";
import { sentences } from "../candidates";
import { decide, llmDefinition, llmSettings } from "../clients";
import { Concept, decisionConfigured } from "./analyze";
import { cleanDocumentText } from "./doctext";
import { papersWith } from "./conceptIndex";
import { searchRelated, shortLabel } from "./related";
import { log } from "../../utils/log";
import {
  getShared,
  localLibrary,
  portableLibrary,
  putShared,
  sharingEnabled,
} from "../shared";

export interface Definition {
  text: string;
  source:
    | { kind: "paper" }
    | {
        kind: "library";
        /** Local item number (resolved from itemKey when read back) */
        itemID: number;
        label: string;
        /** Item key and portable library id ("u", "g<id>"), stored */
        itemKey?: string;
        library?: string;
      }
    | { kind: "llm"; model: string }
    | { kind: "intro" };
}

type Entry = Definition & { at: string; deleted?: undefined };
type Deleted = { deleted: true; at: string };
export type Glossary = Record<string, Entry | Deleted>;
let glossary: Glossary | undefined;

async function loadGlossary(): Promise<Glossary> {
  glossary ??= withItemKeys((await readJSON<Glossary>("glossary.json")) ?? {});
  return glossary;
}

/** Entries from before sharing know their source paper only by its local
 * item number; add the key while this computer can still resolve it. */
function withItemKeys(g: Glossary): Glossary {
  for (const e of Object.values(g)) {
    if (e.deleted || e.source?.kind !== "library" || e.source.itemKey) continue;
    const item = Zotero.Items.get(e.source.itemID);
    const library = item && portableLibrary(item.libraryID);
    if (item && library)
      Object.assign(e.source, { itemKey: item.key, library });
  }
  return g;
}

async function saveGlossary(g: Glossary) {
  glossary = g;
  await writeJSON(g, "glossary.json");
  scheduleGlossarySync();
}

const now = () => new Date().toISOString();

async function remember(term: string, def: Definition) {
  const g = await loadGlossary();
  let stored = def;
  if (def.source.kind === "library") {
    const item = Zotero.Items.get(def.source.itemID);
    const library = item && portableLibrary(item.libraryID);
    if (item && library)
      stored = {
        ...def,
        source: { ...def.source, itemKey: item.key, library },
      };
  }
  g[term.toLowerCase()] = { ...stored, at: now() };
  await saveGlossary(g);
}

/** A stored entry as a usable definition, or undefined (deleted, or its
 * source paper is not in this library). */
function fromGlossary(e: Entry | Deleted | undefined): Definition | undefined {
  if (!e || e.deleted) return undefined;
  const { at: _at, ...def } = e;
  if (def.source.kind !== "library") return def;
  // No key: its paper was already gone here, or the entry came from a
  // computer that couldn't resolve it. Look the definition up again.
  if (!def.source.itemKey) return undefined;
  const lib = localLibrary(def.source.library ?? "u");
  const item = lib && Zotero.Items.getByLibraryAndKey(lib, def.source.itemKey);
  if (!item || item.deleted) return undefined;
  return { ...def, source: { ...def.source, itemID: item.id } };
}

/** Drop one cached definition (e.g. a wrong LLM answer). */
export async function forgetDefinition(term: string) {
  const g = await loadGlossary();
  g[term.toLowerCase()] = { deleted: true, at: now() };
  await saveGlossary(g);
}

export async function forgetGlossary() {
  const g = await loadGlossary();
  const at = now();
  for (const k of Object.keys(g)) g[k] = { deleted: true, at };
  await saveGlossary(g);
}

/** Per term, the entry written last wins (deletions included). */
export function mergeGlossaries(a: Glossary, b: Glossary): Glossary {
  const out: Glossary = { ...a };
  for (const [k, e] of Object.entries(b)) {
    if (!validEntry(e)) continue;
    if (!out[k] || e.at > out[k].at) out[k] = e;
  }
  return out;
}

/** A deletion marker, or a definition with text and a source. */
function validEntry(e: any): e is Entry | Deleted {
  if (typeof e?.at !== "string") return false;
  if (e.deleted === true) return true;
  return typeof e.text === "string" && typeof e.source?.kind === "string";
}

function sameGlossary(a: Glossary, b: Glossary) {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => b[k]?.at === a[k].at && !!b[k].deleted === !!a[k].deleted)
  );
}

/**
 * Merges this computer's glossary with the shared one and writes the
 * result to whichever side lacked something. Returns how many entries came
 * from the server.
 */
export async function syncGlossary(): Promise<number> {
  const remote = (await getShared<Glossary>("glossary.json")) ?? {};
  // Read after the network wait, so entries remembered meanwhile are kept.
  const local = await loadGlossary();
  const merged = mergeGlossaries(local, remote);
  const fromServer = Object.keys(merged).filter(
    (k) => merged[k] !== local[k],
  ).length;
  if (!sameGlossary(merged, local)) {
    glossary = merged;
    await writeJSON(merged, "glossary.json");
  }
  if (!sameGlossary(merged, remote)) await putShared("glossary.json", merged);
  return fromServer;
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;

/** Share glossary changes a little later, batching several of them. */
function scheduleGlossarySync() {
  if (!sharingEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(
    () => syncGlossary().catch((e) => log("glossary sync failed", e)),
    10_000,
  );
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
  const options: {
    sentence: string;
    score: number;
    itemID: number;
    label: string;
  }[] = [];
  // Analysed papers that define the concept (library concept index)
  for (const e of await papersWith(
    libraryID,
    [concept.term, ...concept.aliases],
    current?.id,
  )) {
    if (!e.definition || options.length >= 8) continue;
    const item = Zotero.Items.get(e.itemID);
    if (item && !item.deleted)
      options.push({
        sentence: e.definition,
        score: 3,
        itemID: item.id,
        label: shortLabel(item),
      });
  }
  // Else scan the full text of papers that mention it
  const { papers } = options.length
    ? { papers: [] }
    : await searchRelated(libraryID, concept.term, current, 6);
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
    const known = fromGlossary(g[key]);
    if (known) return known;
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
