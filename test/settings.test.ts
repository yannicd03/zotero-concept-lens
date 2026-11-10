import { assert } from "chai";
import { config } from "../package.json";

const plugin = () => (Zotero as any)[config.addonInstance];
const pref = (key: string) => `${config.prefsPrefix}.${key}`;

describe("settings", function () {
  afterEach(function () {
    Zotero.Prefs.clear(pref("card.sectionOrder"), true);
    Zotero.Prefs.clear(pref("card.hiddenSections"), true);
  });

  it("registers the preference pane", function () {
    const panes = (Zotero.PreferencePanes as any).pluginPanes as any[];
    assert.isTrue(panes.some((p) => p.pluginID === config.addonID));
  });

  it("has the default section order", function () {
    assert.deepEqual(plugin().api.sections.visibleSections(), [
      "definition",
      "excerpt",
      "related",
    ]);
  });

  it("applies a saved order and hides sections", function () {
    const { saveSectionOrder, visibleSections } = plugin().api.sections;
    saveSectionOrder(
      ["related", "excerpt", "definition"],
      new Set(["excerpt"]),
    );
    // the definition stays first; the others keep their saved order
    assert.deepEqual(visibleSections(), ["definition", "related"]);
    saveSectionOrder(["related", "excerpt"], new Set(["definition"]));
    assert.deepEqual(visibleSections(), ["related", "excerpt"]);
  });

  it("ignores unknown sections and appends missing ones", function () {
    Zotero.Prefs.set(pref("card.sectionOrder"), "excerpt,bogus", true);
    assert.deepEqual(plugin().api.sections.sectionOrder(), [
      "definition",
      "excerpt",
      "related",
    ]);
  });

  it("stores API keys in the login manager, not in prefs", async function () {
    const { getSecret, setSecret } = plugin().api.secrets;
    const before = getSecret("llm");
    try {
      await setSecret("llm", "sk-test-123");
      assert.equal(getSecret("llm"), "sk-test-123");
      const allPrefs = Services.prefs.getChildList(config.prefsPrefix);
      for (const name of allPrefs) {
        if (Services.prefs.getPrefType(name) !== Services.prefs.PREF_STRING)
          continue;
        assert.notInclude(Services.prefs.getStringPref(name), "sk-test-123");
      }
      await setSecret("llm", "");
      assert.equal(getSecret("llm"), "");
    } finally {
      await setSecret("llm", before);
    }
  });

  it("lets OpenRouter use the decision key unless it has its own", async function () {
    const { getSecret, setSecret } = plugin().api.secrets;
    const { keyFor, inheritedKey } = plugin().api.llmProviders;
    const { llmSettings } = plugin().api.clients;
    const endpoint = pref("decision.endpoint");
    const savedEndpoint = Zotero.Prefs.get(endpoint, true);
    const savedDecision = getSecret("decision");
    const savedOwn = getSecret("llm-openrouter");
    try {
      Zotero.Prefs.set(
        endpoint,
        "https://openrouter.ai/api/v1/systemone",
        true,
      );
      await setSecret("decision", "sk-or-decision");
      await setSecret("llm-openrouter", "");
      assert.equal(keyFor("openrouter"), "sk-or-decision");
      assert.equal(llmSettings("openrouter").key, "sk-or-decision");
      // other presets never borrow it
      assert.equal(inheritedKey("deepseek"), "");
      // an own key overrides the decision key
      await setSecret("llm-openrouter", "sk-or-own");
      assert.equal(keyFor("openrouter"), "sk-or-own");
      // a decision model elsewhere has a key OpenRouter can't use
      await setSecret("llm-openrouter", "");
      Zotero.Prefs.set(endpoint, "https://api.example.com/systemone", true);
      assert.equal(keyFor("openrouter"), "");
    } finally {
      Zotero.Prefs.set(endpoint, savedEndpoint, true);
      await setSecret("decision", savedDecision);
      await setSecret("llm-openrouter", savedOwn);
    }
  });
});
