/**
 * Library side of the citation hover: an in-memory index of the library's
 * regular items (rebuilt after item changes), reference -> item resolution
 * with a per-reference cache, and the fields the citation card shows.
 */
import { config } from "../../../package.json";
import {
  arxivIdFromFields,
  compact,
  formatAuthors,
  LibraryEntry,
  matchReference,
  truncate,
} from "./match";

const indexes = new Map<number, Promise<LibraryEntry[]>>();
/** `${libraryID}:${reference}` -> itemID | null */
const resolved = new Map<string, number | null>();
let notifierID: string | undefined;

export function startLibraryIndex() {
  if (notifierID) return;
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: async (_event: string, type: string) => {
        if (type === "item") invalidate();
      },
    },
    ["item"],
    `${config.addonRef}-citations`,
  );
}

export function stopLibraryIndex() {
  if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  notifierID = undefined;
  invalidate();
}

export function invalidate() {
  indexes.clear();
  resolved.clear();
}

function yearOf(item: Zotero.Item): number | undefined {
  const y = Number(Zotero.Date.strToDate(item.getField("date") || "").year);
  return Number.isFinite(y) && y > 0 ? y : undefined;
}

const field = (item: Zotero.Item, name: string): string => {
  try {
    return String(item.getField(name as any) ?? "");
  } catch {
    return "";
  }
};

async function buildIndex(libraryID: number): Promise<LibraryEntry[]> {
  const items = (await Zotero.Items.getAll(libraryID, true)).filter(
    (i) => i.isRegularItem() && !i.deleted,
  );
  await Zotero.Items.loadDataTypes(items, ["itemData", "creators"]);
  return items.map((item) => {
    const doi =
      field(item, "DOI") ||
      (field(item, "extra").match(/^DOI:\s*(\S+)/im)?.[1] ?? "");
    return {
      id: item.id,
      title: field(item, "title"),
      year: yearOf(item),
      doi: doi
        ? Zotero.Utilities.cleanDOI(doi)?.toLowerCase() || undefined
        : undefined,
      arxiv: arxivIdFromFields(
        doi,
        field(item, "url"),
        field(item, "extra"),
        field(item, "archiveID"),
      ),
      creators: item.getCreators().map((c) => c.lastName || ""),
    };
  });
}

function index(libraryID: number) {
  let p = indexes.get(libraryID);
  if (!p) {
    p = buildIndex(libraryID);
    indexes.set(libraryID, p);
    p.catch(() => indexes.delete(libraryID));
  }
  return p;
}

/**
 * The library item a bibliography entry refers to. Searches the library of
 * the open paper, then the user library. `exclude` (the open paper) and its
 * duplicates (same title) never match.
 */
export async function resolveReference(
  reference: string,
  libraryID: number,
  exclude: Zotero.Item | null,
): Promise<Zotero.Item | null> {
  const libs = [libraryID];
  if (libraryID !== Zotero.Libraries.userLibraryID)
    libs.push(Zotero.Libraries.userLibraryID);
  const excludedTitle = exclude ? compact(field(exclude, "title")) : "";
  for (const lib of libs) {
    const key = `${lib}:${reference}`;
    let id = resolved.get(key);
    if (id === undefined) {
      const entries = (await index(lib)).filter(
        (e) =>
          e.id !== exclude?.id &&
          !(excludedTitle && compact(e.title) === excludedTitle),
      );
      id = matchReference(reference, entries)?.id ?? null;
      resolved.set(key, id);
    }
    if (id !== null) {
      const item = Zotero.Items.get(id);
      if (item && !item.deleted) return item;
    }
  }
  return null;
}

/** What the citation card shows for a library item. */
export interface CitedItem {
  itemID: number;
  title: string;
  authors: string;
  /** "Chua et al." */
  firstAuthor: string;
  year?: number;
  venue: string;
  abstract: string;
  /** What a click does: open the PDF, open another file, or select the item */
  opens: "pdf" | "file" | "library";
}

const VENUE_FIELDS = [
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "bookTitle",
  "websiteTitle",
  "university",
  "institution",
  "repository",
  "publisher",
];

export async function citedItem(item: Zotero.Item): Promise<CitedItem> {
  // Authors; editors etc. only when the item has no authors.
  const creators = item.getCreatorsJSON();
  const authors = creators.filter((c) => c.creatorType === "author");
  const names = (authors.length ? authors : creators).map(
    (c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
  );
  const best = await item.getBestAttachment();
  const att = best && best.isFileAttachment() ? best : null;
  return {
    itemID: item.id,
    title: field(item, "title"),
    authors: formatAuthors(names),
    firstAuthor: item.firstCreator || "",
    year: yearOf(item),
    venue: VENUE_FIELDS.map((f) => field(item, f)).find(Boolean) ?? "",
    // The abstract is the card's content; long ones scroll.
    abstract: truncate(field(item, "abstractNote"), 1500),
    opens: !att ? "library" : att.isPDFAttachment() ? "pdf" : "file",
  };
}
