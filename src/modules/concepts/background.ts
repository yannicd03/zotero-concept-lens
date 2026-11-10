/**
 * Background analysis of the whole library, so concepts link across papers
 * that were never opened. Papers are analysed one at a time, exactly as when
 * opened (rules, then one decision-model request), newest first; papers
 * with a current cached analysis are skipped, and PDFs Zotero has no text
 * for yet are retried on the next pass. A failing decision model (e.g. out
 * of credits) pauses the pass until the next one. Definitions are not
 * generated here; they stay on hover in an open paper.
 */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { log } from "../../utils/log";
import { analyzeAttachment, cachedAnalysis } from "./analyze";
import { loadIndex, updateIndex } from "./conceptIndex";

export interface BackgroundStatus {
  state: "off" | "waiting" | "running" | "paused" | "done";
  /** PDFs in the library */
  total: number;
  /** PDFs with a current analysis */
  analysed: number;
  /** PDFs Zotero has no text for yet */
  noText: number;
  /** Analysed in this session */
  newlyAnalysed: number;
  error?: string;
}

/** Wait after startup before the first pass. */
const START_DELAY = 60_000;
/** Pause between two papers that needed a request. */
const PAUSE = 3_000;
/** A new pass (new papers, newly indexed PDFs) every 30 minutes. */
const PASS_INTERVAL = 30 * 60_000;

const status: BackgroundStatus = {
  state: "off",
  total: 0,
  analysed: 0,
  noText: 0,
  newlyAnalysed: 0,
};
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let prefObserver: symbol | undefined;

export function backgroundStatus(): BackgroundStatus {
  return { ...status };
}

/** PDFs of all regular items, newest first. */
async function libraryPDFs(): Promise<Zotero.Item[]> {
  const out: { att: Zotero.Item; added: string }[] = [];
  for (const lib of Zotero.Libraries.getAll()) {
    const items = (await Zotero.Items.getAll(
      lib.libraryID,
      true,
      false,
    )) as Zotero.Item[];
    for (const item of items) {
      if (!item.isRegularItem() || item.deleted) continue;
      const att = await item.getBestAttachment();
      if (att && att.attachmentContentType === "application/pdf")
        out.push({ att, added: item.dateAdded });
    }
  }
  out.sort((a, b) => (a.added < b.added ? 1 : -1));
  return out.map((o) => o.att);
}

async function pass(gen: number) {
  status.state = "running";
  status.error = undefined;
  await loadIndex();
  const atts = await libraryPDFs();
  status.total = atts.length;
  status.analysed = 0;
  status.noText = 0;
  for (const att of atts) {
    if (gen !== generation) return;
    const cached = await cachedAnalysis(att);
    if (cached) {
      updateIndex(att, cached);
      status.analysed++;
      continue;
    }
    const set = await analyzeAttachment(att);
    if (gen !== generation) return;
    if (set.noText) {
      status.noText++;
      continue;
    }
    if (set.error) {
      status.state = "paused";
      status.error = set.error;
      log("background analysis paused", set.error);
      return;
    }
    status.analysed++;
    status.newlyAnalysed++;
    await Zotero.Promise.delay(PAUSE);
  }
  status.state = "done";
}

function schedule(delay: number) {
  clearTimeout(timer);
  const gen = generation;
  // After a pass, keep showing its result until the next one starts.
  if (status.state === "off") status.state = "waiting";
  timer = setTimeout(async () => {
    try {
      await pass(gen);
    } catch (e: any) {
      status.state = "paused";
      status.error = String(e?.message ?? e);
      log("background analysis failed", e);
    }
    if (gen === generation) schedule(PASS_INTERVAL);
  }, delay);
}

function stop() {
  generation++;
  clearTimeout(timer);
  timer = undefined;
  status.state = "off";
}

/** Starts (or restarts) background analysis if it is switched on. */
export function startBackground(delay = START_DELAY) {
  stop();
  if (getPref("index.enabled")) schedule(delay);
}

export function startBackgroundIntegration() {
  prefObserver = Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.index.enabled`,
    () => startBackground(2_000),
    true,
  );
  startBackground();
}

export function stopBackgroundIntegration() {
  if (prefObserver) Zotero.Prefs.unregisterObserver(prefObserver);
  prefObserver = undefined;
  stop();
}
