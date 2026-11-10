/**
 * The concept hover card. Lives in the reader UI document and reuses the
 * native citation popup's classes (view-popup citation-popup
 * page-popup-*-center), so it gets the same look, arrow and theme.
 */
import { config } from "../../../package.json";
import type { Concept } from "../concepts/analyze";
import type { Definition } from "../concepts/definitions";
import type { RelatedPaper } from "../concepts/related";
import { SectionId, visibleSections } from "../sections";
import { formRegex, Rect } from "./pagetext";

const ref = config.addonRef;

export interface Excerpt {
  text: string;
  pageLabel: string;
  position: { pageIndex: number; rects: Rect[] };
}

export interface CardContent {
  concept: Concept;
  excerpt?: Excerpt;
  definition: Promise<Definition | undefined>;
  related: Promise<{ papers: RelatedPaper[]; total: number }>;
  llmConfigured: boolean;
  /** Shown under the definition when the LLM fallback is unavailable */
  llmNote: () => string | undefined;
}

export interface CardActions {
  navigate(position: Excerpt["position"]): void;
  openItem(itemID: number): void;
  onEnter(): void;
  onLeave(): void;
}

const STYLE = `
.view-popup.${ref}-card { z-index: 2; }
/* The reader's .view-popup rule sets display:flex, which beats [hidden]. */
.view-popup.${ref}-card[hidden] { display: none; }
.view-popup.${ref}-card .inner {
  width: 380px; max-height: 360px; overflow-y: auto; padding: 2px;
  display: flex; flex-direction: column; gap: 2px;
}
.${ref}-head { padding: 5px 5px 1px; font-weight: 600; }
.${ref}-alias { margin-inline-start: 6px; font-weight: normal; color: var(--fill-secondary); }
/* The definition is the card's main item: term + definition, set apart. */
.${ref}-hero {
  padding: 7px 9px 8px; margin: 2px; border-radius: 6px;
  background: var(--fill-quinary);
  border-inline-start: 3px solid var(--accent-blue);
  overflow-wrap: break-word;
}
.${ref}-hero.${ref}-ai { border-inline-start-color: var(--accent-purple, #8f5bd8); }
.${ref}-hero .${ref}-head { padding: 0 0 3px; font-size: 1.05em; }
.${ref}-def { font-size: 1.04em; line-height: 1.4; }
.${ref}-badge {
  display: inline-block; margin-inline-end: 6px; padding: 0 5px;
  border-radius: 4px; font-size: 0.8em; font-weight: 600; line-height: 1.5;
  color: #fff; background: var(--accent-purple, #8f5bd8);
}
.${ref}-hero .${ref}-source { margin-top: 5px; }
/* Occurrences below it: this paper, then other papers. */
.${ref}-more { display: flex; flex-direction: column; gap: 2px; padding-top: 4px; }
.${ref}-section { padding: 5px; border-radius: 5px; overflow-wrap: break-word; }
.${ref}-label {
  font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  color: var(--fill-secondary); margin-bottom: 2px;
  display: flex; justify-content: space-between; gap: 8px;
}
.${ref}-quote { font-style: italic; }
.${ref}-quote strong { font-style: normal; }
.${ref}-source { font-size: 0.85em; color: var(--fill-secondary); margin-top: 3px; }
.${ref}-muted { color: var(--fill-secondary); }
.${ref}-clickable { cursor: pointer; }
.${ref}-clickable:hover { background: var(--fill-quinary); }
.${ref}-link { color: var(--accent-blue); cursor: pointer; }
.${ref}-link:hover { text-decoration: underline; }
.${ref}-paper { padding: 3px 5px; margin-inline: -5px; border-radius: 4px; cursor: pointer; }
.${ref}-paper:hover { background: var(--fill-quinary); }
.${ref}-paper-meta { font-size: 0.85em; color: var(--fill-secondary); }
`;

export class ConceptCard {
  private el: HTMLDivElement;
  private inner: HTMLDivElement;
  private token = 0;
  private anchor: Rect | null = null;
  current: string | null = null;

  constructor(
    private doc: Document,
    private actions: CardActions,
  ) {
    if (!doc.getElementById(`${ref}-card-style`)) {
      const style = doc.createElement("style");
      style.id = `${ref}-card-style`;
      style.textContent = STYLE;
      (doc.head ?? doc.documentElement)!.append(style);
    }
    this.el = doc.createElement("div");
    this.el.className = `view-popup citation-popup ${ref}-card`;
    this.el.hidden = true;
    this.inner = doc.createElement("div");
    this.inner.className = "inner";
    this.el.append(this.inner);
    this.el.addEventListener("pointerenter", () => this.actions.onEnter());
    this.el.addEventListener("pointerleave", () => this.actions.onLeave());
  }

  private container(): HTMLElement | null {
    return this.doc.querySelector("#reader-ui .split-view > .primary-view");
  }

  get visible() {
    return !this.el.hidden;
  }

  contains(node: Node | null) {
    return !!node && this.el.contains(node);
  }

  /** `anchor`: the hovered word box in reader UI client coordinates. */
  show(key: string, anchor: Rect, content: CardContent) {
    const container = this.container();
    if (!container) return;
    if (this.el.parentNode !== container) container.append(this.el);
    const token = ++this.token;
    this.current = key;
    this.anchor = anchor;
    this.render(content, token);
    this.el.hidden = false;
    this.place();
  }

  hide() {
    this.token++;
    this.current = null;
    this.el.hidden = true;
  }

  destroy() {
    this.hide();
    this.el.remove();
    this.doc.getElementById(`${ref}-card-style`)?.remove();
  }

  // --- placement: same rules as the reader's ViewPopup -----------------------

  private place() {
    const container = this.container();
    if (!container || !this.anchor || this.el.hidden) return;
    const vr = container.getBoundingClientRect();
    const [x1, y1, x2, y2] = [
      this.anchor[0] - vr.left,
      this.anchor[1] - vr.top,
      this.anchor[2] - vr.left,
      this.anchor[3] - vr.top,
    ];
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

  // --- content ----------------------------------------------------------------

  private div(cls: string, text?: string) {
    const d = this.doc.createElement("div");
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  private section(label: string, extra?: HTMLElement) {
    const s = this.div(`${ref}-section`);
    const l = this.div(`${ref}-label`);
    const span = this.doc.createElement("span");
    span.textContent = label;
    l.append(span);
    if (extra) l.append(extra);
    s.append(l);
    return s;
  }

  /**
   * Term and definition first, as the main item; the occurrences in this
   * paper and in other papers follow below it.
   */
  private render(c: CardContent, token: number) {
    const { concept } = c;
    this.inner.replaceChildren();

    const head = this.div(`${ref}-head`, concept.term);
    if (concept.aliases.length) {
      const a = this.doc.createElement("span");
      a.className = `${ref}-alias`;
      a.textContent = concept.aliases.join(", ");
      head.append(a);
    }

    const sections = visibleSections();
    if (sections.includes("definition"))
      this.inner.append(this.definitionHero(c, head, token));
    else this.inner.append(head);

    const builders: Record<
      Exclude<SectionId, "definition">,
      () => HTMLElement | null
    > = {
      excerpt: () => this.excerptSection(c),
      related: () => this.relatedSection(c, token),
    };
    const more = this.div(`${ref}-more`);
    for (const id of sections) {
      if (id === "definition") continue;
      const el = builders[id]();
      if (el) more.append(el);
    }
    if (more.childElementCount) this.inner.append(more);
  }

  private definitionHero(c: CardContent, head: HTMLElement, token: number) {
    const s = this.div(`${ref}-hero`);
    const body = this.div(`${ref}-def ${ref}-muted`, "Looking up…");
    s.append(head, body);
    c.definition.then((def) => {
      if (token !== this.token) return;
      const note = c.llmNote();
      body.className = `${ref}-def`;
      if (!def) {
        body.className = `${ref}-def ${ref}-muted`;
        body.textContent = note
          ? `No paper in your library defines this. ${note}`
          : c.llmConfigured
            ? "No definition found."
            : "No paper in your library defines this. Set up the LLM fallback in Settings → Concept Lens to generate one.";
      } else {
        body.textContent = def.text;
        const src = this.div(`${ref}-source`);
        switch (def.source.kind) {
          case "paper":
            src.textContent = "Defined in this paper";
            break;
          case "intro":
            src.textContent = "Introduced in this paper";
            break;
          case "llm": {
            s.classList.add(`${ref}-ai`);
            const badge = this.doc.createElement("span");
            badge.className = `${ref}-badge`;
            badge.textContent = "AI";
            badge.title = "Written by the LLM fallback, not taken from a paper";
            src.append(badge, `Generated by ${def.source.model}`);
            break;
          }
          case "library": {
            const { itemID, label } = def.source;
            src.textContent = "From ";
            const a = this.doc.createElement("span");
            a.className = `${ref}-link`;
            a.textContent = label;
            a.addEventListener("click", () => this.actions.openItem(itemID));
            src.append(a);
            break;
          }
        }
        s.append(src);
        if (note && def.source.kind === "intro")
          s.append(this.div(`${ref}-source`, note));
      }
      this.place();
    });
    return s;
  }

  private excerptSection(c: CardContent) {
    const ex = c.excerpt;
    if (!ex) return null;
    const page = this.doc.createElement("span");
    page.textContent = `p. ${ex.pageLabel}`;
    const s = this.section("In this paper", page);
    s.classList.add(`${ref}-clickable`);
    s.title = "Go to this passage";
    const q = this.div(`${ref}-quote`);
    // Bold the concept inside the quote.
    const forms = [c.concept.term, ...c.concept.aliases];
    const marks: [number, number][] = [];
    for (const f of forms)
      for (const m of ex.text.matchAll(formRegex(f)))
        marks.push([m.index!, m.index! + m[0].length]);
    marks.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [a, b] of marks) {
      if (a < pos) continue;
      q.append(ex.text.slice(pos, a));
      const strong = this.doc.createElement("strong");
      strong.textContent = ex.text.slice(a, b);
      q.append(strong);
      pos = b;
    }
    q.append(ex.text.slice(pos));
    s.append(q);
    s.addEventListener("click", () => this.actions.navigate(ex.position));
    return s;
  }

  private relatedSection(c: CardContent, token: number) {
    const count = this.doc.createElement("span");
    const s = this.section("Other papers in your library", count);
    const list = this.div("", "");
    list.append(this.div(`${ref}-muted`, "Searching…"));
    s.append(list);
    c.related.then(({ papers, total }) => {
      if (token !== this.token) return;
      list.replaceChildren();
      if (!papers.length) {
        list.append(this.div(`${ref}-muted`, "No other paper mentions this."));
      } else {
        count.textContent =
          total > papers.length
            ? `${papers.length} of ${total}`
            : String(total);
        for (const p of papers) {
          const row = this.div(`${ref}-paper`);
          row.title = p.hasPDF ? "Open PDF" : "Show in library";
          const how = p.defines
            ? "defines it"
            : p.mentions
              ? `${p.mentions}× in the paper`
              : "mentions it";
          row.append(
            this.div("", p.title),
            this.div(
              `${ref}-paper-meta`,
              [p.label, how].filter(Boolean).join(" · "),
            ),
          );
          row.addEventListener("click", () => this.actions.openItem(p.itemID));
          list.append(row);
        }
      }
      this.place();
    });
    return s;
  }
}
