/** Other library papers that mention a concept (Zotero full-text index). */

export interface RelatedPaper {
  itemID: number;
  title: string;
  /** "Chua et al. 2018" */
  label: string;
  hasPDF: boolean;
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
): Promise<{ papers: RelatedPaper[]; total: number }> {
  const s = new Zotero.Search({ libraryID });
  s.addCondition("fulltextContent", "contains", phrase);
  const attIDs: number[] = await s.search();
  const seen = new Set<string>(
    exclude ? [normTitle(exclude.getField("title"))] : [],
  );
  const papers: RelatedPaper[] = [];
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
    if (papers.length < limit)
      papers.push({
        itemID: item.id,
        title: item.getField("title"),
        label: shortLabel(item),
        hasPDF: !!(await item.getBestAttachment()),
      });
  }
  return { papers, total };
}
