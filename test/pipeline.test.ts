import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api;

describe("pipeline", function () {
  describe("doctext", function () {
    it("drops running headers and the bibliography but keeps the appendix", function () {
      const header = "Published as a conference paper at ICLR 2025";
      const raw = [
        header,
        "Intro text about MBRL.",
        "1",
        header,
        "More text.",
        "2",
        header,
        "References",
        "Chua et al. Deep RL in a handful of trials. 2018.",
        "A Appendix details",
        "Appendix text.",
        "3",
      ].join("\n");
      const out = api().doctext.cleanDocumentText(raw);
      assert.notInclude(out, header);
      assert.notInclude(out, "Chua et al.");
      assert.include(out, "Appendix text.");
      assert.include(out, "Intro text about MBRL.");
    });
  });

  describe("definitions", function () {
    it("ranks explicit definitions above 'X is a' sentences", function () {
      const { definingSentences } = api().definitions;
      const text =
        "Trajectory sampling is a common scheme in many recent papers on model-based control. " +
        "We define trajectory sampling as propagating particles through a learned dynamics model. " +
        "Trajectory sampling works well.";
      const found = definingSentences(text, ["trajectory sampling"]);
      assert.match(found[0].sentence, /^We define trajectory sampling as/);
      assert.equal(found.length, 2);
    });
  });

  describe("candidates: plurals", function () {
    it("merges singular and plural forms into one concept", function () {
      const { proposeCandidates, singularKey } = api().candidates;
      assert.equal(singularKey("Infoprop Rollouts"), "infoprop rollout");
      assert.equal(singularKey("process"), "process");
      assert.equal(singularKey("dynamics"), "dynamics");
      const text =
        "Infoprop rollouts are long. An infoprop rollout is short. Infoprop rollouts again. The infoprop rollout ends.";
      const c = proposeCandidates(text).filter((x: any) =>
        /infoprop rollout/i.test(x.term),
      );
      assert.equal(c.length, 1);
      assert.equal(c[0].term.toLowerCase(), "infoprop rollout");
      assert.equal(c[0].count, 4);
    });
  });
});
