/**
 * Other library papers with a concept: from the library concept index
 * (papers whose analysis has the concept) and from Zotero's full-text index
 * (papers that mention the words, including ones not analysed yet).
 */
import { papersWith } from "./conceptIndex";

export interface RelatedPaper {
  itemID: number;
  title: string;
  /** "Chua et al. 2018" */
  label: string;
  hasPDF: boolean;
  /** The paper defines the concept */
  defines?: boolean;
  /** How often the paper uses it (analysed papers only) */
  mentions?: number;
}

export const normTitle = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function shortLabel(item: Zotero.Item): string {
  const year = Zotero.Date.strToDate(item.getField("date") || "").year;
  const who = item.firstCreator || "";
  return [who, year].filter(Boolean).join(" ");
}

/**
 * Regular items whose attachments contain the phrase, excluding `exclude`
 * and anything with the same title (duplicates of the current paper).
 * Duplicate entries collapse to one.
 */
export async function searchRelated(
  libraryID: number,
  phrase: string,
  exclude: Zotero.Item | null,
  limit: number,
): Promise<{ papers: RelatedPaper[]; total: number; itemIDs: number[] }> {
  const s = new Zotero.Search({ libraryID });
  s.addCondition("fulltextContent", "contains", phrase);
  const attIDs: number[] = await s.search();
  const seen = new Set<string>(
    exclude ? [normTitle(exclude.getField("title"))] : [],
  );
  const papers: RelatedPaper[] = [];
  const itemIDs: number[] = [];
  let total = 0;
  for (const id of attIDs) {
    const att = Zotero.Items.get(id);
    if (!att) continue;
    const item = att.parentItem ?? (att.isRegularItem() ? att : null);
    if (!item || !item.isRegularItem() || item.deleted) continue;
    if (exclude && item.id === exclude.id) continue;
    const key = normTitle(item.getField("title"));
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    itemIDs.push(item.id);
    if (papers.length < limit)
      papers.push({
        itemID: item.id,
        title: item.getField("title"),
        label: shortLabel(item),
        hasPDF: !!(await item.getBestAttachment()),
      });
  }
  return { papers, total, itemIDs };
}

/**
 * Papers for the hover card: analysed papers that define the concept, then
 * those that use it most, then full-text matches not covered by the index.
 */
export async function relatedPapers(
  libraryID: number,
  forms: string[],
  exclude: Zotero.Item | null,
  limit: number,
): Promise<{ papers: RelatedPaper[]; total: number }> {
  const [indexed, text] = await Promise.all([
    papersWith(libraryID, forms, exclude?.id),
    searchRelated(libraryID, forms[0], exclude, limit),
  ]);
  const seen = new Set<string>(
    exclude ? [normTitle(exclude.getField("title"))] : [],
  );
  const ids = new Set<number>();
  const papers: RelatedPaper[] = [];
  for (const e of indexed) {
    const item = Zotero.Items.get(e.itemID);
    if (!item || item.deleted) continue;
    const key = normTitle(item.getField("title"));
    if (seen.has(key)) continue;
    seen.add(key);
    ids.add(item.id);
    if (papers.length < limit)
      papers.push({
        itemID: item.id,
        title: item.getField("title"),
        label: shortLabel(item),
        hasPDF: !!(await item.getBestAttachment()),
        defines: !!e.definition,
        mentions: e.count,
      });
  }
  for (const p of text.papers) {
    if (papers.length >= limit) break;
    if (ids.has(p.itemID)) continue;
    const key = normTitle(p.title);
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push(p);
  }
  const total = ids.size + text.itemIDs.filter((id) => !ids.has(id)).length;
  return { papers, total };
}
