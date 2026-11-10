import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api;

/** Minimal stand-in for an attachment of a regular item. */
function fakeAttachment(id: number, parentID: number, libraryID = 1) {
  return {
    id,
    key: `TEST${id}`,
    libraryID,
    parentItem: { id: parentID, isRegularItem: () => true },
    isAttachment: () => true,
  };
}

const concept = (term: string, count: number, definition?: string) => ({
  id: term,
  term,
  aliases: [] as string[],
  kinds: [],
  count,
  definition,
});

const set = (...concepts: any[]) => ({
  version: 0,
  settingsKey: "test",
  filteredBy: "rules",
  concepts,
});

describe("concept index", function () {
  const created: Zotero.Item[] = [];

  afterEach(async function () {
    api().conceptIndex.clearIndex();
    for (const item of created.splice(0)) await item.eraseTx();
  });

  async function paper(title: string) {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", title);
    await item.saveTx();
    created.push(item);
    return item;
  }

  it("normalises case, hyphens and spaces", function () {
    const { normTerm } = api().conceptIndex;
    assert.equal(normTerm("Model-Based  RL"), "model based rl");
    assert.equal(normTerm("model‐based rl"), "model based rl");
  });

  it("ranks papers that define a concept above those that use it", async function () {
    const { updateIndex, papersWith } = api().conceptIndex;
    updateIndex(fakeAttachment(901, 1), set(concept("world model", 3)));
    updateIndex(
      fakeAttachment(902, 2),
      set(concept("World-Model", 1, "A world model predicts the next state.")),
    );
    updateIndex(fakeAttachment(903, 3), set(concept("world model", 9)));
    const found = await papersWith(1, ["world model"], 3);
    assert.deepEqual(
      found.map((e: any) => e.itemID),
      [2, 1],
    );
    assert.equal(found[0].definition, "A world model predicts the next state.");
    // re-analysing a paper replaces its entries
    updateIndex(fakeAttachment(902, 2), set(concept("planning", 2)));
    assert.deepEqual(
      (await papersWith(1, ["world model"])).map((e: any) => e.itemID),
      [3, 1],
    );
    // other libraries are separate
    assert.isEmpty(await papersWith(2, ["world model"]));
  });

  it("lists defining papers first on the hover card", async function () {
    const { updateIndex } = api().conceptIndex;
    const a = await paper("Paper that uses it");
    const b = await paper("Paper that defines it");
    const current = await paper("The open paper");
    updateIndex(
      fakeAttachment(911, a.id, a.libraryID),
      set(concept("dyna", 5)),
    );
    updateIndex(
      fakeAttachment(912, b.id, b.libraryID),
      set(concept("Dyna", 1, "Dyna interleaves learning and planning.")),
    );
    updateIndex(
      fakeAttachment(913, current.id, current.libraryID),
      set(concept("dyna", 2)),
    );
    const { papers, total } = await api().reader.relatedPapersFor(
      current.libraryID,
      ["Dyna"],
      current,
      5,
    );
    assert.equal(total, 2);
    assert.deepEqual(
      papers.map((p: any) => [p.title, p.defines, p.mentions]),
      [
        ["Paper that defines it", true, 1],
        ["Paper that uses it", false, 5],
      ],
    );
  });

  it("does not cache PDFs Zotero has no text for yet", async function () {
    const { analyzeAttachment } = api().analyze;
    const att = {
      ...fakeAttachment(921, 1),
      attachmentText: Promise.resolve(""),
      parentItem: null,
      getField: () => "",
    };
    const result = await analyzeAttachment(att);
    assert.isTrue(result.noText);
    assert.isEmpty(result.concepts);
    assert.isUndefined(await api().analyze.cachedAnalysis(att));
  });

  it("describes background progress", function () {
    const { indexStatusText } = api().prefs;
    const base = { total: 450, analysed: 120, noText: 3, newlyAnalysed: 5 };
    assert.equal(indexStatusText({ ...base, state: "off" }), "");
    assert.equal(
      indexStatusText({ ...base, state: "running" }),
      "Analysing: 120 of 450 papers analysed, 3 without text yet…",
    );
    assert.match(
      indexStatusText({
        ...base,
        state: "paused",
        error: "Out of credits (HTTP 402)",
      }),
      /^Paused \(Out of credits \(HTTP 402\)\)\. 120 of 450/,
    );
  });
});
