/**
 * Library-wide concept index: which papers have which concepts, built from
 * the per-paper analyses in <data dir>/conceptlens/papers/. Papers opened
 * in the reader and papers analysed in the background (background.ts) both
 * land here, so hover cards can list the other papers that define or use a
 * concept without searching the library.
 */
import { listFiles, readJSON } from "../../utils/store";
import { log } from "../../utils/log";
import type { ConceptSet } from "./analyze";

export interface IndexEntry {
  /** The paper (regular item) */
  itemID: number;
  /** Its analysed attachment */
  attachmentID: number;
  /** How often the paper uses the concept */
  count: number;
  /** The paper's defining sentence for it, if it has one */
  definition?: string;
  /** The sentence that introduces the acronym, if any */
  introduced?: string;
}

/** Forms of a term that should meet in the index: case, hyphens, spaces. */
export function normTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[\s‐-―-]+/g, " ")
    .trim();
}

/** libraryID → normalised term → entries (one per paper) */
const index = new Map<number, Map<string, IndexEntry[]>>();
/** attachmentID → the terms it was indexed under (for replacing) */
const termsOf = new Map<number, { libraryID: number; terms: string[] }>();
let loading: Promise<void> | undefined;

function remove(attachmentID: number) {
  const prev = termsOf.get(attachmentID);
  if (!prev) return;
  const lib = index.get(prev.libraryID);
  for (const t of prev.terms) {
    const list = lib?.get(t)?.filter((e) => e.attachmentID !== attachmentID);
    if (!lib || !list) continue;
    if (list.length) lib.set(t, list);
    else lib.delete(t);
  }
  termsOf.delete(attachmentID);
}

function add(att: Zotero.Item, set: ConceptSet) {
  const item = att.parentItem ?? att;
  remove(att.id);
  if (!item.isRegularItem() && !att.isAttachment()) return;
  let lib = index.get(att.libraryID);
  if (!lib) index.set(att.libraryID, (lib = new Map()));
  const terms = new Set<string>();
  for (const c of set.concepts) {
    const entry: IndexEntry = {
      itemID: item.id,
      attachmentID: att.id,
      count: c.count,
      definition: c.definition,
      introduced: c.introduced,
    };
    for (const form of [c.term, ...c.aliases]) {
      const t = normTerm(form);
      if (!t || terms.has(t)) continue;
      terms.add(t);
      const list = lib.get(t) ?? [];
      list.push(entry);
      lib.set(t, list);
    }
  }
  termsOf.set(att.id, { libraryID: att.libraryID, terms: [...terms] });
}

/** Adds or replaces one paper's concepts. */
export function updateIndex(att: Zotero.Item, set: ConceptSet) {
  try {
    add(att, set);
  } catch (e) {
    log("concept index update failed", e);
  }
}

/** Reads every cached analysis once (the index lives in memory). */
export function loadIndex(): Promise<void> {
  loading ??= (async () => {
    const files = await listFiles("papers");
    for (const name of files) {
      const m = /^(\d+)-([A-Z0-9]+)\.json$/.exec(name);
      if (!m) continue;
      const att = Zotero.Items.getByLibraryAndKey(Number(m[1]), m[2]);
      if (!att || att.deleted) continue;
      const set = await readJSON<ConceptSet>("papers", name);
      if (set?.concepts) add(att as Zotero.Item, set);
    }
    log(`concept index: ${termsOf.size} papers`);
  })();
  return loading;
}

/** Number of papers in the index. */
export function indexedPapers(): number {
  return termsOf.size;
}

/**
 * Papers in the library with this concept (any of `forms`), excluding
 * `excludeItemID`: those that define it first, then by how often they use
 * it.
 */
export async function papersWith(
  libraryID: number,
  forms: string[],
  excludeItemID?: number,
): Promise<IndexEntry[]> {
  await loadIndex();
  const lib = index.get(libraryID);
  if (!lib) return [];
  const byItem = new Map<number, IndexEntry>();
  for (const f of forms)
    for (const e of lib.get(normTerm(f)) ?? []) {
      if (e.itemID === excludeItemID) continue;
      const prev = byItem.get(e.itemID);
      if (!prev || rank(e) > rank(prev)) byItem.set(e.itemID, e);
    }
  return [...byItem.values()].sort((a, b) => rank(b) - rank(a));
}

const rank = (e: IndexEntry) => (e.definition ? 1e6 : 0) + e.count;

/** Forget everything (tests, cache reset). */
export function clearIndex() {
  index.clear();
  termsOf.clear();
  loading = undefined;
}
