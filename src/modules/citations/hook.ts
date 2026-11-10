/**
 * Citation hover for one PDF view: wraps the view's `_onSetOverlayPopup`
 * (pdf-view.js calls it with the citation / internal-link popup params, or
 * null to close). Every call is passed through, so the reader's own popup
 * state (open/close delays, scroll, clicks) keeps working; when the cited
 * paper is in the library, the native popup is hidden with CSS and our card
 * is shown in its place.
 *
 * Citations come in two forms: "citation" overlays (the reader parsed the
 * bibliography; params.references carry the entry text), and "internal-link"
 * overlays (hyperref links into the bibliography; the native popup is a page
 * preview). For the latter the entry is cut out of the destination page.
 */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { openItem } from "../reader/decorator";
import type { PdfChar } from "../reader/pagetext";
import { CitationCard, CitationEntry } from "./card";
import { citedItem, resolveReference } from "./library";
import { charsText, entryAtPoint, extractYears } from "./match";
import { log } from "../../utils/log";

const Cu = Components.utils as any;
const ORIGINAL = `__${config.addonRef}OverlayPopup`;
/** How long the native popup waits for the library lookup. */
const RESOLVE_WAIT = 400;
/** Grace period after the pointer leaves the page, as for concept cards. */
const CLOSE_DELAY = 200;

export class CitationHook {
  private card: CitationCard;
  private pdfWin: any;
  private token = 0;
  private pageChars = new Map<number, Promise<PdfChar[]>>();
  private entryCache = new Map<string, string | null>();
  private stopped = false;
  private closeTimer?: number;
  private listeners: [EventTarget, string, EventListener][] = [];

  constructor(
    private reader: _ZoteroTypes.ReaderInstance,
    private view: any,
    private att: Zotero.Item,
    containerSelector = "#reader-ui .split-view > .primary-view",
  ) {
    this.pdfWin = view._iframeWindow;
    this.card = new CitationCard(
      reader._iframeWindow!.document,
      containerSelector,
      { openItem: (id) => this.open(id) },
    );
  }

  start() {
    const view = this.view;
    // Idempotent: a previous wrapper (e.g. from before a hot reload) is
    // removed first, so wrappers never stack.
    if (view[ORIGINAL]) view._onSetOverlayPopup = view[ORIGINAL];
    const original = view._onSetOverlayPopup;
    view[ORIGINAL] = original;
    view._onSetOverlayPopup = Cu.exportFunction(
      (params: any) => this.onSetOverlayPopup(params),
      this.reader._iframeWindow,
    );

    // The reader closes its popup only on pointer moves over the page. When
    // the pointer leaves the page sideways (toolbar, sidebar, out of the
    // reader), close the card ourselves; moving onto the card keeps it.
    const uiDoc = this.reader._iframeWindow!.document;
    this.listen(uiDoc, "pointermove", (e) => {
      if (!this.card.contains(e.target as Node)) this.scheduleClose();
    });
    this.listen(uiDoc, "pointerout", (e) => {
      if (!(e as PointerEvent).relatedTarget) this.scheduleClose();
    });
    this.card.onPointerEnter(() => this.cancelClose());
  }

  private listen(t: EventTarget, type: string, fn: EventListener) {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  /** Not restarted by further moves, so moving around can't keep it open. */
  private scheduleClose() {
    if (!this.card.visible || this.closeTimer !== undefined) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      if (!this.card.visible) return;
      this.token++;
      this.card.hide();
      this.closeReaderPopup();
    }, CLOSE_DELAY) as any;
  }

  private cancelClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  stop() {
    this.stopped = true;
    this.token++;
    this.cancelClose();
    for (const [t, type, fn] of this.listeners)
      try {
        t.removeEventListener(type, fn);
      } catch {
        /* document already gone */
      }
    this.listeners = [];
    try {
      const view = this.view;
      if (view[ORIGINAL]) {
        view._onSetOverlayPopup = view[ORIGINAL];
        delete view[ORIGINAL];
      }
    } catch {
      /* view already gone */
    }
    try {
      this.card.destroy();
    } catch {
      /* reader already gone */
    }
  }

  private callOriginal(params: any) {
    this.view[ORIGINAL]?.(params);
  }

  /**
   * Close the reader's (hidden) popup as the reader itself would: it also
   * forgets the hovered link (pdf-view.js `_selectedOverlay`), else hovering
   * the same citation again would never reopen it.
   */
  private closeReaderPopup() {
    try {
      this.view._selectedOverlay = null;
    } catch {
      /* view gone */
    }
    this.callOriginal(null);
  }

  private onSetOverlayPopup(rawParams: any) {
    const params = rawParams ? Cu.waiveXrays(rawParams) : null;
    const token = ++this.token;
    this.cancelClose();
    const relevant =
      params &&
      !this.stopped &&
      getPref("citation.enabled") &&
      (params.type === "citation" || params.type === "internal-link");
    if (!relevant) {
      this.card.hide();
      this.callOriginal(rawParams);
      return;
    }
    let passed = false;
    const pass = () => {
      if (passed) return;
      passed = true;
      this.callOriginal(rawParams);
    };
    const timer = setTimeout(() => {
      if (token === this.token) pass();
    }, RESOLVE_WAIT);
    this.entries(params)
      .then((entries) => {
        if (token !== this.token) return;
        clearTimeout(timer);
        if (entries) this.card.show(Array.from(params.rect), entries);
        else this.card.hide();
        pass();
      })
      .catch((e) => {
        log("citation lookup failed", e);
        clearTimeout(timer);
        if (token !== this.token) return;
        this.card.hide();
        pass();
      });
  }

  /** Card entries, or null when no cited paper is in the library. */
  private async entries(params: any): Promise<CitationEntry[] | null> {
    const refs: string[] = [];
    if (params.type === "citation") {
      for (const r of params.references ?? []) {
        const text = r.text || charsText(Cu.waiveXrays(r.chars) ?? []);
        if (text) refs.push(text);
      }
    } else {
      const text = await this.linkedEntry(params.destinationPosition);
      if (text) refs.push(text);
    }
    if (!refs.length) return null;
    const parent = this.att.parentItem ?? null;
    let found = false;
    const out: CitationEntry[] = [];
    for (const text of refs) {
      const item = await resolveReference(text, this.att.libraryID, parent);
      if (item) {
        found = true;
        out.push({ kind: "item", item: await citedItem(item) });
      } else out.push({ kind: "text", text });
    }
    return found ? out : null;
  }

  /** Bibliography entry text at an internal link's destination. */
  private async linkedEntry(dest: any): Promise<string | null> {
    if (!dest || typeof dest.pageIndex !== "number" || !dest.rects?.[0])
      return null;
    const [x, y] = dest.rects[0];
    const key = `${dest.pageIndex}:${x}:${y}`;
    if (this.entryCache.has(key)) return this.entryCache.get(key)!;
    const chars = await this.chars(dest.pageIndex);
    let text = entryAtPoint(chars, Number.isFinite(x) ? x : null, y) ?? null;
    // Links to sections, figures and equations land on text without a year;
    // anything else still has to pass the matcher's title/author guards.
    if (text && !extractYears(text).length) text = null;
    this.entryCache.set(key, text);
    return text;
  }

  private chars(pageIndex: number): Promise<PdfChar[]> {
    let p = this.pageChars.get(pageIndex);
    if (!p) {
      const app = this.pdfWin.PDFViewerApplication;
      p = app.pdfDocument
        .getPageData(Cu.cloneInto({ pageIndex }, this.pdfWin))
        .then((d: any) => Cu.waiveXrays(d).chars as PdfChar[]);
      this.pageChars.set(pageIndex, p!);
    }
    return p!;
  }

  private open(itemID: number) {
    this.token++;
    this.card.hide();
    this.closeReaderPopup();
    openItem(itemID);
  }
}
