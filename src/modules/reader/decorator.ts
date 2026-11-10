/**
 * Marks concepts in one PDF view of a reader: dotted underlines on rendered
 * pages, geometric hover detection, and the hover card.
 *
 * Underlines live in their own layer per page (pointer-events: none), so the
 * reader's selection and highlighting (which hit-test geometrically) are not
 * affected. pdf.js clears foreign page children on re-render (zoom, page
 * buffer trimming), so the layer is re-attached on every "pagerendered".
 */
import { config } from "../../../package.json";
import type { Concept, ConceptSet } from "../concepts/analyze";
import { llmConfigured, resolveDefinition } from "../concepts/definitions";
import { searchRelated } from "../concepts/related";
import { llmPause } from "../clients";
import { getPref } from "../../utils/prefs";
import { CardContent, ConceptCard, Excerpt } from "./card";
import {
  appendixHeadingIndex,
  buildPageText,
  findMatches,
  PageText,
  PdfChar,
  Rect,
  rectsForRange,
  referencesHeadingIndex,
  sentenceAround,
} from "./pagetext";
import { log } from "../../utils/log";

const ref = config.addonRef;
const Cu = Components.utils as any;

const PDF_STYLE = `
.${ref}-terms { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.${ref}-term {
  position: absolute; box-sizing: border-box;
  border-bottom: max(1px, calc(0.55px * var(--scale-factor, 1))) dotted rgba(46, 125, 215, 0.85);
}
`;

interface PageMatch {
  conceptId: string;
  rects: Rect[];
  start: number;
  end: number;
}

interface PageInfo {
  page: PageText;
  chars: PdfChar[];
  matches: PageMatch[];
}

const OPEN_DELAY = 150;
/** Grace period to move the pointer from the term into the card. */
const CLOSE_DELAY = 200;

export class ViewDecorator {
  private pdfWin: any;
  private app: any;
  private pages = new Map<number, PageInfo>();
  private byId: Map<string, Concept>;
  private firstSeen = new Map<
    string,
    { pageIndex: number; match: PageMatch }[]
  >();
  private card: ConceptCard;
  private onRendered: any;
  private listeners: [EventTarget, string, EventListener][] = [];
  private openTimer?: number;
  private closeTimer?: number;
  private closePending = false;
  private hovered: string | null = null;
  private stopped = false;

  constructor(
    private reader: _ZoteroTypes.ReaderInstance,
    private view: any,
    private att: Zotero.Item,
    private set: ConceptSet,
  ) {
    this.pdfWin = view._iframeWindow;
    this.app = this.pdfWin.PDFViewerApplication;
    this.byId = new Map(set.concepts.map((c) => [c.id, c]));
    this.card = new ConceptCard(reader._iframeWindow!.document, {
      navigate: (position) => this.navigate(position),
      openItem: (id) => openItem(id),
      onEnter: () => this.cancelClose(),
      onLeave: () => this.leaveTerm(),
    });
  }

  async start() {
    const doc: Document = this.pdfWin.document;
    if (!doc.getElementById(`${ref}-pdf-style`)) {
      const style = doc.createElement("style");
      style.id = `${ref}-pdf-style`;
      style.textContent = PDF_STYLE;
      (doc.head ?? doc.documentElement)!.append(style);
    }
    this.onRendered = Cu.exportFunction((e: any) => {
      const pv = Cu.waiveXrays(e).source;
      if (pv) this.decorate(pv);
    }, this.pdfWin);
    this.app.eventBus.on("pagerendered", this.onRendered);

    this.listen(this.pdfWin, "pointermove", (e) =>
      this.onPointerMove(e as PointerEvent),
    );
    // Leaving the page: `pointerleave` doesn't fire on a window, so watch
    // for the pointer going out of the PDF document...
    this.listen(doc, "pointerout", (e) => {
      if (!(e as PointerEvent).relatedTarget) this.leaveTerm();
    });
    // ...and moving over the reader UI around it (toolbar, sidebar), or out
    // of the reader entirely. Events inside the PDF iframe don't reach this
    // document, so any move here is outside the page; the card is the only
    // place the pointer may go without closing it.
    const uiDoc = this.reader._iframeWindow!.document;
    this.listen(uiDoc, "pointermove", (e) => {
      if (!this.card.contains(e.target as Node)) this.leaveTerm();
    });
    this.listen(uiDoc, "pointerout", (e) => {
      if (!(e as PointerEvent).relatedTarget) this.leaveTerm();
    });
    const container = doc.getElementById("viewerContainer");
    if (container) this.listen(container, "scroll", () => this.hideNow());

    await this.scanPages();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    try {
      this.app.eventBus.off("pagerendered", this.onRendered);
    } catch {
      /* view already gone */
    }
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners = [];
    try {
      const doc: Document = this.pdfWin.document;
      doc
        .querySelectorAll(`.${ref}-terms`)
        .forEach((el: Element) => el.remove());
      doc.getElementById(`${ref}-pdf-style`)?.remove();
    } catch {
      /* view already gone */
    }
    this.card.destroy();
  }

  private listen(t: EventTarget, type: string, fn: EventListener) {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  // --- page scan ----------------------------------------------------------------

  /**
   * Builds the text of every page (in order, so the bibliography can be
   * skipped), finds concept matches, and decorates pages already rendered.
   */
  private async scanPages() {
    const n: number = this.app.pdfViewer.pagesCount;
    const targets = this.set.concepts.map((c) => ({
      id: c.id,
      forms: [c.term, ...c.aliases],
    }));
    let inRefs = false;
    for (let pageIndex = 0; pageIndex < n && !this.stopped; pageIndex++) {
      const data = Cu.waiveXrays(
        await this.app.pdfDocument.getPageData(
          Cu.cloneInto({ pageIndex }, this.pdfWin),
        ),
      );
      const chars: PdfChar[] = data.chars;
      const page = buildPageText(chars);
      const { text } = page;

      // Allowed ranges: everything except the bibliography.
      const ranges: [number, number][] = [];
      if (inRefs) {
        const app = appendixHeadingIndex(text);
        if (app >= 0) {
          inRefs = false;
          ranges.push([app, text.length]);
        }
      } else {
        const refIdx = pageIndex >= n * 0.3 ? referencesHeadingIndex(text) : -1;
        if (refIdx >= 0) {
          ranges.push([0, refIdx]);
          const app = appendixHeadingIndex(text.slice(refIdx));
          if (app >= 0) ranges.push([refIdx + app, text.length]);
          else inRefs = true;
        } else {
          ranges.push([0, text.length]);
        }
      }

      const matches: PageMatch[] = [];
      for (const r of ranges)
        for (const m of findMatches(text, targets, r))
          matches.push({
            conceptId: m.id,
            start: m.start,
            end: m.end,
            rects: rectsForRange(chars, page, m.start, m.end),
          });
      this.pages.set(pageIndex, { page, chars, matches });
      for (const m of matches) {
        const seen = this.firstSeen.get(m.conceptId) ?? [];
        if (seen.length < 5) seen.push({ pageIndex, match: m });
        this.firstSeen.set(m.conceptId, seen);
      }
      const pv = this.app.pdfViewer._pages?.[pageIndex];
      if (pv?.div?.querySelector(".canvasWrapper")) this.decorate(pv);
    }
  }

  // --- underlines ------------------------------------------------------------------

  private decorate(pv: any) {
    if (this.stopped || !getPref("highlight.enabled")) return;
    const pageIndex = pv.id - 1;
    const info = this.pages.get(pageIndex);
    if (!info) return; // decorated when the scan reaches it
    const div: HTMLElement = pv.div;
    const doc = div.ownerDocument!;
    let layer = div.querySelector(`:scope > .${ref}-terms`);
    if (!layer) {
      layer = doc.createElement("div");
      layer.className = `${ref}-terms`;
      div.append(layer);
    }
    const vp = pv.viewport;
    const s = vp.scale;
    const kids: HTMLElement[] = [];
    for (const m of info.matches) {
      for (const r of m.rects) {
        const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]);
        const [bx, by] = vp.convertToViewportPoint(r[2], r[3]);
        const el = doc.createElement("div");
        el.className = `${ref}-term`;
        const px = (v: number) => `calc(${v / s}px * var(--scale-factor))`;
        el.style.left = px(Math.min(ax, bx));
        el.style.top = px(Math.min(ay, by));
        el.style.width = px(Math.abs(bx - ax));
        el.style.height = px(Math.abs(by - ay));
        kids.push(el);
      }
    }
    layer.replaceChildren(...kids);
  }

  // --- hover -------------------------------------------------------------------------

  private hitTest(e: PointerEvent) {
    const target = e.target as Element | null;
    const pageEl = target?.closest?.(".page") as HTMLElement | null;
    if (!pageEl) return null;
    const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
    const info = this.pages.get(pageIndex);
    const pv = this.app.pdfViewer._pages?.[pageIndex];
    if (!info || !pv) return null;
    const br = pv.div.getBoundingClientRect();
    const x = e.clientX - br.left - pv.div.clientLeft;
    const y = e.clientY - br.top - pv.div.clientTop;
    const [px, py] = pv.viewport.convertToPdfPoint(x, y);
    for (const m of info.matches)
      for (const r of m.rects)
        if (
          px >= r[0] - 0.5 &&
          px <= r[2] + 0.5 &&
          py >= r[1] - 0.5 &&
          py <= r[3] + 0.5
        )
          return { pageIndex, pv, match: m, rect: r };
    return null;
  }

  private onPointerMove(e: PointerEvent) {
    if (!getPref("highlight.enabled")) return;
    // Ignore moves while a button is pressed (selecting, highlighting).
    if (e.buttons) return;
    const hit = this.hitTest(e);
    if (!hit) {
      this.leaveTerm();
      return;
    }
    const key = `${hit.pageIndex}:${hit.match.start}`;
    this.cancelClose();
    if (this.hovered === key) return;
    this.hovered = key;
    // Back on the term whose card is still showing (e.g. from the card).
    if (this.card.visible && this.card.current === key) return;
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => this.open(hit, key), OPEN_DELAY) as any;
  }

  /**
   * Called on every move outside a term, so a pending close is left running
   * rather than restarted (moving around would otherwise keep the card).
   */
  private leaveTerm() {
    clearTimeout(this.openTimer);
    this.hovered = null;
    if (this.card.visible && !this.closePending) this.scheduleClose();
  }

  private scheduleClose() {
    clearTimeout(this.closeTimer);
    this.closePending = true;
    this.closeTimer = setTimeout(() => {
      this.closePending = false;
      if (this.hovered === null) this.card.hide();
    }, CLOSE_DELAY) as any;
  }

  private cancelClose() {
    clearTimeout(this.closeTimer);
    this.closePending = false;
  }

  private hideNow() {
    this.hovered = null;
    clearTimeout(this.openTimer);
    this.cancelClose();
    this.card.hide();
  }

  private open(
    hit: { pageIndex: number; pv: any; match: PageMatch; rect: Rect },
    key: string,
  ) {
    if (this.stopped || this.hovered !== key) return;
    const concept = this.byId.get(hit.match.conceptId);
    if (!concept) return;
    // Anchor: the hovered line box, in reader UI client coordinates.
    const vp = hit.pv.viewport;
    const [ax, ay] = vp.convertToViewportPoint(hit.rect[0], hit.rect[1]);
    const [bx, by] = vp.convertToViewportPoint(hit.rect[2], hit.rect[3]);
    const br = hit.pv.div.getBoundingClientRect();
    const fr = this.pdfWin.frameElement.getBoundingClientRect();
    const ox = fr.left + br.left + hit.pv.div.clientLeft;
    const oy = fr.top + br.top + hit.pv.div.clientTop;
    const anchor: Rect = [
      ox + Math.min(ax, bx),
      oy + Math.min(ay, by),
      ox + Math.max(ax, bx),
      oy + Math.max(ay, by),
    ];
    this.card.show(
      key,
      anchor,
      this.content(concept, hit.pageIndex, hit.match),
    );
  }

  private content(
    concept: Concept,
    pageIndex: number,
    hovered: PageMatch,
  ): CardContent {
    const parent = this.att.parentItem ?? null;
    const excerpt = this.excerptFor(concept, pageIndex, hovered);
    const limit = getPref("card.relatedLimit") ?? 5;
    return {
      concept,
      excerpt,
      llmConfigured: llmConfigured(),
      llmNote,
      definition: resolveDefinition(
        concept,
        parent,
        this.att.libraryID,
        this.llmContext(concept, excerpt),
      ).catch((e) => {
        log("definition failed", e);
        return undefined;
      }),
      related: searchRelated(
        this.att.libraryID,
        concept.term,
        parent,
        limit,
      ).catch((e) => {
        log("related search failed", e);
        return { papers: [], total: 0 };
      }),
    };
  }

  /** Context for the LLM fallback: which paper, which field, which sense. */
  private llmContext(concept: Concept, excerpt?: Excerpt): string {
    const item = this.att.parentItem ?? this.att;
    const abstract = (item.getField("abstractNote") || "").slice(0, 1500);
    const forms = [concept.term, ...concept.aliases].join(", ");
    return [
      `Paper: ${item.getField("title")}`,
      abstract && `Abstract: ${abstract}`,
      `Written in this paper as: ${forms}`,
      concept.introduced && `Introduced as: ${concept.introduced}`,
      concept.definition && `Defined as: ${concept.definition}`,
      excerpt && `Passage: ${excerpt.text}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * The excerpt: the first occurrence in this paper, unless that is the
   * sentence the definition section shows (defining or introducing sentence)
   * or the very passage being hovered, in which case the next one.
   */
  private excerptFor(
    concept: Concept,
    pageIndex: number,
    hovered: PageMatch,
  ): Excerpt | undefined {
    const seen = this.firstSeen.get(concept.id) ?? [];
    const norm = (s: string) =>
      s.replace(/\W+/g, "").toLowerCase().slice(0, 60);
    let fallback: Excerpt | undefined;
    for (const { pageIndex: pi, match } of seen) {
      const info = this.pages.get(pi)!;
      const text = sentenceAround(info.page.text, match.start, match.end);
      const ex: Excerpt = {
        text,
        pageLabel: this.app.pdfViewer._pages?.[pi]?.pageLabel ?? String(pi + 1),
        position: { pageIndex: pi, rects: match.rects },
      };
      fallback ??= ex;
      // Don't repeat the sentence the definition section may show.
      const shown = concept.definition ?? concept.introduced;
      const isDefinition = !!shown && norm(shown) === norm(text);
      const isHovered = pi === pageIndex && match.start === hovered.start;
      // All-caps occurrences of a spelled-out term sit in titles/headings.
      const surface = info.page.text.slice(match.start, match.end);
      const inHeading =
        !/\p{Ll}/u.test(surface) && !concept.aliases.includes(surface);
      if (inHeading) continue;
      if (!isDefinition && !isHovered) return ex;
    }
    return fallback;
  }

  private navigate(position: Excerpt["position"]) {
    this.hideNow();
    this.reader.navigate({ position } as any);
  }
}

/** Why the LLM fallback is not producing definitions right now, if it isn't. */
function llmNote(): string | undefined {
  if (!llmConfigured()) return undefined;
  const p = llmPause();
  if (!p) return undefined;
  const until = new Date(p.until).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `LLM fallback paused until ${until} (request quota reached).`;
}

export async function openItem(itemID: number) {
  const item = Zotero.Items.get(itemID);
  if (!item) return;
  const att = item.isRegularItem() ? await item.getBestAttachment() : item;
  if (att && att.isFileAttachment()) {
    await Zotero.Reader.open(att.id, undefined, { openInBackground: false });
    return;
  }
  const win = Zotero.getMainWindow() as any;
  win.Zotero_Tabs.select("zotero-pane");
  win.ZoteroPane.selectItem(item.id);
}
