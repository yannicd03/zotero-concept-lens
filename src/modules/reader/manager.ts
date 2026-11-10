/**
 * Attaches a ViewDecorator (concept marking) and a CitationHook (citation
 * hover) to every open PDF reader (existing tabs at startup,
 * new/loaded/selected tabs via the Notifier) and detaches them on close,
 * shutdown, or when the feature is switched off in the settings.
 */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { analyzeAttachment } from "../concepts/analyze";
import { CitationHook } from "../citations/hook";
import { startLibraryIndex, stopLibraryIndex } from "../citations/library";
import { ViewDecorator } from "./decorator";
import { log } from "../../utils/log";

type Reader = _ZoteroTypes.ReaderInstance;

const decorators = new Map<Reader, ViewDecorator | "pending">();
const citationHooks = new Map<Reader, CitationHook | "pending">();
let notifierID: string | undefined;
let prefObserver: symbol | undefined;
let citationPrefObserver: symbol | undefined;

const readers = (): Reader[] => (Zotero.Reader as any)._readers ?? [];

export function startReaderIntegration() {
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: async (event: string, type: string, ids: any[], extra: any) => {
        if (type !== "tab") return;
        prune();
        if (!["add", "select", "load"].includes(event)) return;
        for (const id of ids.flat()) {
          if (extra?.[id]?.type !== "reader") continue;
          // On "add" the reader may not be registered yet.
          for (let i = 0; i < 20; i++) {
            const r = Zotero.Reader.getByTabID(id);
            if (r) {
              attach(r);
              break;
            }
            await Zotero.Promise.delay(250);
          }
        }
      },
    },
    ["tab"],
    config.addonRef,
  );
  prefObserver = Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.highlight.enabled`,
    () => (getPref("highlight.enabled") ? attachAll() : detachDecorators()),
    true,
  );
  citationPrefObserver = Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.citation.enabled`,
    () => (getPref("citation.enabled") ? attachAll() : detachCitations()),
    true,
  );
  startLibraryIndex();
  attachAll();
}

export function stopReaderIntegration() {
  if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  if (prefObserver) Zotero.Prefs.unregisterObserver(prefObserver);
  if (citationPrefObserver)
    Zotero.Prefs.unregisterObserver(citationPrefObserver);
  notifierID = undefined;
  prefObserver = undefined;
  citationPrefObserver = undefined;
  detachAll();
  stopLibraryIndex();
}

export function attachAll() {
  for (const r of readers()) attach(r);
}

export function detachAll() {
  detachDecorators();
  detachCitations();
}

function detachDecorators() {
  for (const [r, d] of decorators) {
    if (d !== "pending") d.stop();
    decorators.delete(r);
  }
}

function detachCitations() {
  for (const [r, h] of citationHooks) {
    if (h !== "pending") h.stop();
    citationHooks.delete(r);
  }
}

/** Re-analyse and re-attach (e.g. after the decision model was configured). */
export async function refreshAll() {
  detachAll();
  attachAll();
}

function prune() {
  const open = new Set(readers());
  for (const [r, d] of decorators)
    if (!open.has(r)) {
      if (d !== "pending") d.stop();
      decorators.delete(r);
    }
  for (const [r, h] of citationHooks)
    if (!open.has(r)) {
      if (h !== "pending") h.stop();
      citationHooks.delete(r);
    }
}

function attach(reader: Reader) {
  attachDecorator(reader);
  attachCitations(reader);
}

async function attachCitations(reader: Reader) {
  if (!getPref("citation.enabled") || citationHooks.has(reader)) return;
  citationHooks.set(reader, "pending");
  try {
    await reader._initPromise;
    if (reader.type !== "pdf") {
      citationHooks.delete(reader);
      return;
    }
    const att = Zotero.Items.get(reader.itemID!);
    if (!att) throw new Error(`No item ${reader.itemID}`);
    const ir = (Components.utils as any).waiveXrays(reader._internalReader);
    const view = ir._primaryView;
    await view.initializedPromise;
    if (citationHooks.get(reader) !== "pending") return; // detached meanwhile
    const hook = new CitationHook(reader, view, att);
    citationHooks.set(reader, hook);
    hook.start();
  } catch (e) {
    log("citation hook failed", e);
    citationHooks.delete(reader);
  }
}

async function attachDecorator(reader: Reader) {
  if (!getPref("highlight.enabled") || decorators.has(reader)) return;
  decorators.set(reader, "pending");
  try {
    await reader._initPromise;
    if (reader.type !== "pdf") {
      decorators.delete(reader);
      return;
    }
    const att = Zotero.Items.get(reader.itemID!);
    if (!att) throw new Error(`No item ${reader.itemID}`);
    const set = await analyzeAttachment(att);
    const ir = (Components.utils as any).waiveXrays(reader._internalReader);
    const view = ir._primaryView;
    await view.initializedPromise;
    if (decorators.get(reader) !== "pending") return; // detached meanwhile
    const dec = new ViewDecorator(reader, view, att, set);
    decorators.set(reader, dec);
    log(
      `attached to ${att.key}: ${set.concepts.length} concepts (${set.filteredBy})`,
    );
    await dec.start();
  } catch (e) {
    log("attach failed", e);
    decorators.delete(reader);
  }
}

/** For tests and debugging. */
export function attachedCount() {
  return [...decorators.values()].filter((d) => d !== "pending").length;
}

/** For tests and debugging. */
export function citationHookCount() {
  return [...citationHooks.values()].filter((h) => h !== "pending").length;
}
