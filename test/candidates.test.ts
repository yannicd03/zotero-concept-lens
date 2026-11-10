import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api.candidates;

const TEXT = `Model-based reinforcement learning (MBRL) learns a dynamics model of the environment and uses it to improve the policy.
We distinguish four main categories of MBRL that all build on model-based rollouts. Dyna-style approaches use model-based rollouts to generate training data for a model-free agent. Model-based planning approaches optimise action sequences with the learned dynamics model.
The compounding error problem refers to the accumulation of prediction errors over long model-based rollouts. We define the replay ratio as the number of gradient updates per environment step.
A probabilistic ensemble (PE) of dynamics models captures epistemic uncertainty. The learned dynamics model is accurate in accurate regions. The dynamics model is trained with maximum likelihood. Epistemic uncertainty is high far from data, so epistemic uncertainty guides exploration.`;

describe("candidates", function () {
  const find = (term: string) =>
    api()
      .proposeCandidates(TEXT)
      .find((c: any) => c.term.toLowerCase() === term);

  it("expands acronyms and keeps the short form as alias", function () {
    const c = find("model-based reinforcement learning");
    assert.exists(c);
    assert.include(c.kinds, "acronym");
    assert.deepEqual(c.aliases, ["MBRL"]);
    assert.equal(c.count, 2 + 1); // long form once, MBRL twice
  });

  it("finds 'X refers to' and 'we define X as' with the defining sentence", function () {
    const a = find("compounding error problem");
    assert.include(a.kinds, "definition");
    assert.match(a.definition, /^The compounding error problem refers to/);
    const b = find("replay ratio");
    assert.match(b.definition, /^We define the replay ratio as/);
  });

  it("proposes recurring multi-word terms", function () {
    assert.exists(find("dynamics model"));
    assert.exists(find("epistemic uncertainty"));
  });

  it("does not propose single generic words", function () {
    assert.notExists(find("accurate"));
  });

  it("joins words hyphenated across line breaks", function () {
    assert.equal(
      api().normalizeText("rein-\nforcement  learning"),
      "reinforcement learning",
    );
  });

  it("ranks definitions before acronyms before plain recurring terms", function () {
    const kinds = api()
      .proposeCandidates(TEXT)
      .map((c: any) => c.kinds[0]);
    assert.equal(kinds[0], "definition");
    assert.isBelow(kinds.indexOf("acronym"), kinds.indexOf("recurring"));
  });
});
