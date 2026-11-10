/** Hover-card sections and their user-configurable order/visibility. */
import { getPref, setPref } from "../utils/prefs";

export const SECTIONS = {
  definition: "Definition",
  excerpt: "In this paper",
  related: "Other papers",
} as const;

export type SectionId = keyof typeof SECTIONS;

const ALL = Object.keys(SECTIONS) as SectionId[];

function parse(value: string | undefined): SectionId[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SectionId => (ALL as string[]).includes(s));
}

/**
 * Full order; sections missing from the pref are appended. The definition
 * is the card's main item and always comes first (it can still be hidden).
 */
export function sectionOrder(): SectionId[] {
  const order = [...new Set(parse(getPref("card.sectionOrder")))];
  const all = [...order, ...ALL.filter((s) => !order.includes(s))];
  return ["definition", ...all.filter((s) => s !== "definition")];
}

/** Sections whose position is fixed in the settings list. */
export const PINNED: ReadonlySet<SectionId> = new Set(["definition"]);

export function hiddenSections(): Set<SectionId> {
  return new Set(parse(getPref("card.hiddenSections")));
}

/** Sections to render, in order. */
export function visibleSections(): SectionId[] {
  const hidden = hiddenSections();
  return sectionOrder().filter((s) => !hidden.has(s));
}

export function saveSectionOrder(order: SectionId[], hidden: Set<SectionId>) {
  setPref("card.sectionOrder", order.join(","));
  setPref("card.hiddenSections", [...hidden].join(","));
}
