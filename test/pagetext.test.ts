import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api;

/** Fake structured chars for one line of text at baseline y. */
function line(text: string, y: number, x0 = 0, flags: any = {}) {
  return [...text].map((c, i) => ({
    c,
    rect: [x0 + i * 5, y, x0 + i * 5 + 5, y + 10],
    ...(i === text.length - 1 ? flags : {}),
  }));
}

function chars(...lines: any[][]) {
  return lines
    .flat()
    .map((ch, i, all) => {
      // spaces in the fake text become spaceAfter on the previous char
      if (ch.c === " ") return null;
      if (all[i + 1]?.c === " ") ch.spaceAfter = true;
      return ch;
    })
    .filter(Boolean);
}

describe("pagetext", function () {
  it("builds page text with spaces, line breaks and joined hyphenation", function () {
    const cs = chars(
      line("model-based rein-", 100, 0, { lineBreakAfter: true }),
      line("forcement works", 80, 0, { lineBreakAfter: true }),
    );
    // the line-end hyphen is a hyphenation hyphen
    const hyphen = cs.find((c: any) => c.lineBreakAfter && c.c === "-");
    hyphen.ignorable = true;
    const page = api().pagetext.buildPageText(cs);
    assert.equal(page.text, "model-based reinforcement works\n");
    assert.equal(page.map.length, page.text.length);
  });

  it("matches across hyphen/space variants and plurals, longest form first", function () {
    const { findMatches } = api().pagetext;
    const text =
      "Model based reinforcement learning uses model-based rollouts.";
    const m = findMatches(text, [
      { id: "a", forms: ["model-based reinforcement learning", "MBRL"] },
      { id: "b", forms: ["reinforcement learning"] },
      { id: "c", forms: ["model-based rollout"] },
    ]);
    assert.deepEqual(
      m.map((x: any) => [x.id, text.slice(x.start, x.end)]),
      [
        ["a", "Model based reinforcement learning"],
        ["c", "model-based rollouts"],
      ],
    );
  });

  it("matches acronyms case-sensitively", function () {
    const { findMatches } = api().pagetext;
    const m = findMatches("TS and ts and TSs", [{ id: "t", forms: ["TS"] }]);
    assert.equal(m.length, 2);
  });

  it("returns one box per line for a match spanning two lines", function () {
    const { buildPageText, findMatches, rectsForRange } = api().pagetext;
    const cs = chars(
      line("the trajectory", 100, 0, { lineBreakAfter: true }),
      line("sampling scheme", 80, 0),
    );
    const page = buildPageText(cs);
    const [m] = findMatches(page.text, [
      { id: "x", forms: ["trajectory sampling"] },
    ]);
    const rects = rectsForRange(cs, page, m.start, m.end);
    assert.equal(rects.length, 2);
    assert.isAbove(rects[0][1], rects[1][1]); // first line is higher on the page
  });

  it("cuts excerpts at sentence ends and heading lines", function () {
    const { sentenceAround } = api().pagetext;
    const text =
      "ON ROLLOUTS IN MODEL-BASED\nREINFORCEMENT LEARNING\nAuthors, Some University\nABSTRACT\nModel-based reinforcement learning (MBRL) seeks to enhance data efficiency. It works.";
    const i = text.indexOf("(MBRL)") + 1;
    assert.equal(
      sentenceAround(text, i, i + 4),
      "Model-based reinforcement learning (MBRL) seeks to enhance data efficiency.",
    );
  });

  it("finds the references heading and the appendix after it", function () {
    const { referencesHeadingIndex, appendixHeadingIndex } = api().pagetext;
    const text =
      "end of conclusion.\nREFERENCES\nA. Author. A Bayesian approach. 2020.\nA PROOFS\nProof of theorem.";
    const r = referencesHeadingIndex(text);
    assert.equal(text.slice(r, r + 10), "REFERENCES");
    const a = appendixHeadingIndex(text.slice(r));
    assert.equal(text.slice(r + a, r + a + 8), "A PROOFS");
  });
});
