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
});
