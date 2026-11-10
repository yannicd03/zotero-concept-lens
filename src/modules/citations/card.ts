/**
 * The citation card: replaces the reader's citation popup when the cited
 * paper is in the library. Reuses the native popup's classes (view-popup
 * citation-popup page-popup-*-center) like the concept card does.
 */
import { config } from "../../../package.json";
import type { CitedItem } from "./library";

const ref = config.addonRef;

/** One reference of the hovered citation: a library item or the raw text. */
export type CitationEntry =
  { kind: "item"; item: CitedItem } | { kind: "text"; text: string };

export interface CitationCardActions {
  openItem(itemID: number): void;
}

const STYLE = `
.view-popup.${ref}-cite-card { z-index: 2; }
/* the reader's .view-popup sets display, which would override [hidden] */
.view-popup.${ref}-cite-card[hidden] { display: none; }
.view-popup.${ref}-cite-card .inner {
  width: 400px; max-height: 360px; overflow-y: auto; padding: 0;
  display: flex; flex-direction: column; gap: 2px;
}
/* A cited paper that is in the library: marked as such, then its abstract. */
.${ref}-cite-item {
  padding: 6px 8px 7px; margin: 2px; border-radius: 6px; cursor: pointer;
  overflow-wrap: break-word;
  border-inline-start: 3px solid var(--accent-green, #39a845);
}
.${ref}-cite-item:hover { background: var(--fill-quinary); }
.${ref}-cite-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; }
.${ref}-cite-badge {
  padding: 1px 7px; border-radius: 4px; font-size: 0.82em; font-weight: 600;
  color: #fff; background: var(--accent-green, #39a845); white-space: nowrap;
}
.${ref}-cite-who { flex: 1; font-size: 0.85em; color: var(--fill-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${ref}-cite-open { font-size: 0.85em; color: var(--accent-blue); white-space: nowrap; }
.${ref}-cite-item:hover .${ref}-cite-open { text-decoration: underline; }
.${ref}-cite-abstract { line-height: 1.4; }
.${ref}-cite-noabstract { color: var(--fill-secondary); }
.${ref}-cite-text { padding: 5px; overflow-wrap: break-word; color: var(--fill-secondary); }
.${ref}-cite-replace > .view-popup.citation-popup:not(.${ref}-card),
.${ref}-cite-replace > .view-popup.preview-popup { display: none !important; }
`;

export class CitationCard {
  private el: HTMLDivElement;
  private inner: HTMLDivElement;
  private anchor: number[] | null = null;

  constructor(
    private doc: Document,
    /** e.g. "#reader-ui .split-view > .primary-view" */
    private containerSelector: string,
    private actions: CitationCardActions,
  ) {
    if (!doc.getElementById(`${ref}-cite-style`)) {
      const style = doc.createElement("style");
      style.id = `${ref}-cite-style`;
      style.textContent = STYLE;
      (doc.head ?? doc.documentElement)!.append(style);
    }
    this.el = doc.createElement("div");
    this.el.className = `view-popup citation-popup ${ref}-card ${ref}-cite-card`;
    this.el.hidden = true;
    this.inner = doc.createElement("div");
    this.inner.className = "inner";
    this.el.append(this.inner);
  }

  private container(): HTMLElement | null {
    return this.doc.querySelector(this.containerSelector);
  }

  get visible() {
    return !this.el.hidden;
  }

  contains(node: Node | null) {
    return !!node && this.el.contains(node);
  }

  onPointerEnter(fn: () => void) {
    this.el.addEventListener("pointerenter", fn);
  }

  /**
   * `anchor`: the citation's box relative to the view container (the
   * reader's own popup rect).
   */
  show(anchor: number[], entries: CitationEntry[]) {
    const container = this.container();
    if (!container) return;
    if (this.el.parentNode !== container) container.append(this.el);
    container.classList.add(`${ref}-cite-replace`);
    this.anchor = anchor;
    this.render(entries);
    this.el.hidden = false;
    this.place();
  }

  hide() {
    this.el.hidden = true;
    this.container()?.classList.remove(`${ref}-cite-replace`);
  }

  destroy() {
    this.hide();
    this.el.remove();
    this.doc.getElementById(`${ref}-cite-style`)?.remove();
  }

  // Same rules as the reader's ViewPopup: below if it fits, else above.
  private place() {
    const container = this.container();
    if (!container || !this.anchor || this.el.hidden) return;
    const vr = container.getBoundingClientRect();
    const [x1, y1, x2, y2] = this.anchor;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const pad = 10;
    let side: "bottom" | "top";
    let top: number;
    if (y2 + pad + h < vr.height) {
      side = "bottom";
      top = y2 + pad;
    } else if (y1 - pad - h > 0) {
      side = "top";
      top = y1 - pad - h;
    } else {
      side = "bottom";
      top = Math.max(pad, vr.height - h - pad);
    }
    let left = (x1 + x2) / 2 - w / 2;
    left = Math.min(Math.max(left, pad), vr.width - w - pad);
    this.el.classList.toggle("page-popup-bottom-center", side === "bottom");
    this.el.classList.toggle("page-popup-top-center", side === "top");
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private div(cls: string, text?: string) {
    const d = this.doc.createElement("div");
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  private render(entries: CitationEntry[]) {
    this.inner.replaceChildren();
    for (const e of entries)
      this.inner.append(
        e.kind === "item"
          ? this.itemBlock(e.item)
          : this.div(`${ref}-cite-text`, e.text),
      );
  }

  private itemBlock(it: CitedItem) {
    const label =
      it.opens === "pdf"
        ? "Open PDF"
        : it.opens === "file"
          ? "Open"
          : "Show in library";
    const block = this.div(`${ref}-cite-item`);
    // Title, authors and venue only as tooltip; the card shows the abstract.
    block.title = [
      it.title,
      [it.authors, it.year, it.venue].filter(Boolean).join(" · "),
      `Click: ${label}`,
    ]
      .filter(Boolean)
      .join("\n");
    const head = this.div(`${ref}-cite-head`);
    head.append(
      this.div(`${ref}-cite-badge`, "✓ In your library"),
      this.div(
        `${ref}-cite-who`,
        it.year ? `${it.firstAuthor} ${it.year}` : it.firstAuthor,
      ),
      this.div(`${ref}-cite-open`, label),
    );
    block.append(
      head,
      it.abstract
        ? this.div(`${ref}-cite-abstract`, it.abstract)
        : this.div(`${ref}-cite-noabstract`, `No abstract. ${it.title}`),
    );
    block.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.actions.openItem(it.itemID);
    });
    return block;
  }
}
