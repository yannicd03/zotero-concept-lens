/**
 * Shares paper analyses and the glossary between computers through the
 * WebDAV server Zotero already uses for file sync. Files go to a
 * "conceptlens" folder next to Zotero's own "zotero" folder: Zotero keeps
 * attachments in <url>/zotero/ and its orphan cleanup only deletes .zip
 * and .prop files there (chrome/content/zotero/xpcom/storage/webdav.js).
 *
 * Address, username and password come from Zotero's WebDAV settings.
 * Credentials go into the request URL, like Zotero's own WebDAV requests:
 * Zotero.HTTP moves them into the request and masks them in debug output.
 *
 * Remote file names use a portable library id ("u" for My Library,
 * "g<groupID>" for a group), since local library numbers differ between
 * computers; item keys are the same everywhere.
 */
import { getPref } from "../utils/prefs";
import { listFiles, readJSON, writeJSON } from "../utils/store";
import { log } from "../utils/log";

const FOLDER = "conceptlens";
const TIMEOUT = 30_000;
/** Looking up one paper while it opens: don't keep the reader waiting. */
const LOOKUP_TIMEOUT = 8_000;
/** After a failed lookup, skip per-paper lookups and uploads for a while. */
const BACKOFF = 5 * 60_000;
let unreachableUntil = 0;

function backingOff() {
  return Date.now() < unreachableUntil;
}

function failed(what: string, e: unknown) {
  unreachableUntil = Date.now() + BACKOFF;
  log(`${what} failed; pausing shared lookups for 5 minutes`, e);
}

export class ShareError extends Error {}

// --- configuration -----------------------------------------------------------

/** Zotero's WebDAV address without scheme, e.g. "dav.example.com/files". */
function webdavURL(): string {
  return String(Zotero.Prefs.get("sync.storage.url") ?? "").replace(/\/+$/, "");
}

/** Why sharing can't run, or "" if Zotero's file sync is set to WebDAV. */
export function webdavProblem(): string {
  if (Zotero.Prefs.get("sync.storage.protocol") !== "webdav")
    return "Zotero's file sync is not set to WebDAV";
  if (!webdavURL()) return "Zotero's WebDAV address is empty";
  if (!Zotero.Prefs.get("sync.storage.username"))
    return "Zotero's WebDAV username is empty";
  return "";
}

/** The shared folder as shown to the user (no credentials). */
export function sharedFolderLabel(): string {
  const scheme = Zotero.Prefs.get("sync.storage.scheme") || "https";
  return `${scheme}://${webdavURL()}/${FOLDER}/`;
}

export function sharingEnabled(): boolean {
  return !!getPref("share.enabled") && !webdavProblem();
}

let passwordCache: string | undefined;

async function folderURL(): Promise<string> {
  const problem = webdavProblem();
  if (problem) throw new ShareError(problem);
  // A separate controller instance: Zotero.Sync.Runner caches the one it
  // creates with its own options, so don't create that one here.
  const WebDAV = (Zotero as any).Sync.Storage.Mode.WebDAV;
  passwordCache ||= await new WebDAV({}).getPassword();
  if (!passwordCache) throw new ShareError("Zotero's WebDAV password is empty");
  const scheme = Zotero.Prefs.get("sync.storage.scheme") || "https";
  const user = encodeURIComponent(
    String(Zotero.Prefs.get("sync.storage.username")),
  );
  const pass = encodeURIComponent(passwordCache);
  return `${scheme}://${user}:${pass}@${webdavURL()}/${FOLDER}/`;
}

/** Forget the cached password (after a login failure or in tests). */
export function resetCredentials() {
  passwordCache = undefined;
  foldersReady = false;
  unreachableUntil = 0;
}

// --- requests ------------------------------------------------------------------

async function dav(
  method: string,
  path: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<{ status: number; text: string }> {
  const url = (await folderURL()) + path;
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request(method, url, {
      body: options.body,
      headers: options.headers,
      responseType: "text",
      timeout: options.timeout ?? TIMEOUT,
      successCodes: false,
    });
  } catch (e: any) {
    throw new ShareError(`WebDAV ${method} failed: ${e?.message ?? e}`);
  }
  if (xhr.status === 401 || xhr.status === 403) {
    resetCredentials();
    throw new ShareError(`WebDAV login refused (HTTP ${xhr.status})`);
  }
  return { status: xhr.status, text: String(xhr.response ?? "") };
}

function ok(status: number) {
  return status >= 200 && status < 300;
}

let foldersReady = false;

async function ensureFolders() {
  if (foldersReady) return;
  for (const path of ["", "papers/"]) {
    // 201 created; 405 (or 301) when it already exists
    const r = await dav("MKCOL", path);
    if (!ok(r.status) && r.status !== 405 && r.status !== 301)
      throw new ShareError(`Can't create ${FOLDER}/${path} (HTTP ${r.status})`);
  }
  foldersReady = true;
}

/** GET a JSON file; undefined if it doesn't exist. */
export async function getShared<T>(
  path: string,
  timeout = TIMEOUT,
): Promise<T | undefined> {
  const r = await dav("GET", path, { timeout });
  if (r.status === 404) return undefined;
  if (!ok(r.status))
    throw new ShareError(`Reading ${path} failed (HTTP ${r.status})`);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    log(`shared ${path} is not JSON, ignoring it`);
    return undefined;
  }
}

export async function putShared(path: string, value: unknown) {
  await ensureFolders();
  const r = await dav("PUT", path, {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
  if (!ok(r.status))
    throw new ShareError(`Writing ${path} failed (HTTP ${r.status})`);
}

/** File names in a shared folder ([] if it doesn't exist yet). */
export async function listShared(path: string): Promise<string[]> {
  const r = await dav("PROPFIND", path, {
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>',
    headers: { Depth: "1", "Content-Type": "text/xml; charset=utf-8" },
  });
  if (r.status === 404) return [];
  if (r.status !== 207 && !ok(r.status))
    throw new ShareError(`Listing ${path} failed (HTTP ${r.status})`);
  return hrefNames(r.text);
}

/** File names from the <href> elements of a PROPFIND reply. */
export function hrefNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<(?:[\w-]+:)?href(?:\s[^>]*)?>([^<]*)<\/(?:[\w-]+:)?href>/gi;
  for (const m of xml.matchAll(re)) {
    const href = m[1].trim();
    if (!href || href.endsWith("/")) continue; // the folder itself
    let name = href.slice(href.lastIndexOf("/") + 1);
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep it as is
    }
    names.push(name);
  }
  return names;
}

// --- portable names ------------------------------------------------------------

/** "u" for My Library, "g<groupID>" for a group, undefined for others. */
export function portableLibrary(libraryID: number): string | undefined {
  if (libraryID === Zotero.Libraries.userLibraryID) return "u";
  try {
    const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
    return groupID ? `g${groupID}` : undefined;
  } catch {
    return undefined; // not a group (e.g. a feed)
  }
}

/** The local library number for a portable id, if that library is here. */
export function localLibrary(portable: string): number | undefined {
  if (portable === "u") return Zotero.Libraries.userLibraryID;
  const m = /^g(\d+)$/.exec(portable);
  if (!m) return undefined;
  const id = Zotero.Groups.getLibraryIDFromGroupID(Number(m[1]));
  return id || undefined;
}

/** Shared name of a paper's analysis: "<library>-<attachment key>.json". */
export function sharedPaperName(libraryID: number, key: string) {
  const lib = portableLibrary(libraryID);
  return lib ? `${lib}-${key}.json` : undefined;
}

/** Local cache name (analyze.ts cacheName) for a shared paper name. */
export function localPaperName(shared: string): string | undefined {
  const m = /^(u|g\d+)-([A-Z0-9]+)\.json$/.exec(shared);
  const lib = m && localLibrary(m[1]);
  return lib ? `${lib}-${m[2]}.json` : undefined;
}

// --- paper analyses ------------------------------------------------------------

interface SharedAnalysis {
  version: number;
  concepts: unknown[];
  error?: string;
}

function usable(set: SharedAnalysis | undefined, version: number) {
  return !!set && set.version === version && Array.isArray(set.concepts);
}

/** The shared analysis of one paper, if sharing is on and there is one. */
export async function fetchSharedAnalysis<T extends SharedAnalysis>(
  att: Zotero.Item,
  version: number,
): Promise<T | undefined> {
  if (!sharingEnabled() || backingOff()) return undefined;
  const name = sharedPaperName(att.libraryID, att.key);
  if (!name) return undefined;
  try {
    const set = await getShared<T>(`papers/${name}`, LOOKUP_TIMEOUT);
    return usable(set, version) ? set : undefined;
  } catch (e) {
    failed("fetching shared analysis", e);
    return undefined;
  }
}

/** Upload one paper's analysis in the background, if sharing is on. */
export function shareAnalysis(att: Zotero.Item, set: SharedAnalysis) {
  if (!sharingEnabled() || backingOff() || set.error) return;
  const name = sharedPaperName(att.libraryID, att.key);
  if (!name) return;
  // Missed uploads are caught up by the next syncPapers.
  putShared(`papers/${name}`, set).catch((e) => failed("sharing analysis", e));
}

export interface PaperSyncResult {
  downloaded: { localName: string; set: any }[];
  uploaded: number;
}

/**
 * Downloads analyses that only the server has and uploads those only this
 * computer has. Papers present on both sides are left alone: a paper whose
 * local analysis is out of date fetches the shared one before re-analysing
 * (analyze.ts).
 */
export async function syncPapers(version: number): Promise<PaperSyncResult> {
  unreachableUntil = 0; // an explicit sync always tries
  const remote = new Set(
    (await listShared("papers/")).filter((n) => n.endsWith(".json")),
  );
  const local = new Set(await listFiles("papers"));
  const result: PaperSyncResult = { downloaded: [], uploaded: 0 };

  for (const name of remote) {
    const localName = localPaperName(name);
    if (!localName || local.has(localName)) continue;
    const set = await getShared<SharedAnalysis>(`papers/${name}`);
    if (!usable(set, version)) continue;
    await writeJSON(set, "papers", localName);
    result.downloaded.push({ localName, set });
  }

  for (const localName of local) {
    const m = /^(\d+)-([A-Z0-9]+)\.json$/.exec(localName);
    const name = m && sharedPaperName(Number(m[1]), m[2]);
    if (!name || remote.has(name)) continue;
    const set = await readJSON<SharedAnalysis>("papers", localName);
    if (!usable(set, version) || set!.error) continue;
    await putShared(`papers/${name}`, set);
    result.uploaded++;
  }
  return result;
}
