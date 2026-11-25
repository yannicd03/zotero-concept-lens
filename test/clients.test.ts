import { assert } from "chai";
import { config } from "../package.json";

const clients = () => (Zotero as any)[config.addonInstance].api.clients;
const providers = () => (Zotero as any)[config.addonInstance].api.llmProviders;

describe("clients", function () {
  it("leaves room for reasoning on models that think by default", function () {
    const { tokenLimit } = clients();
    const ds = "https://api.deepseek.com/chat/completions";
    assert.equal(tokenLimit({ model: "deepseek-flash" }, ds, 10), 8192);
    assert.equal(
      tokenLimit(
        { model: "deepseek-flash" },
        "https://api.deepseek.com/anthropic/v1/messages",
        300,
      ),
      8192,
    );
    const anthropic = "https://api.anthropic.com/v1/messages";
    assert.equal(
      tokenLimit({ model: "claude-haiku-5-5" }, anthropic, 300),
      8192,
    );
    // OpenRouter counts reasoning tokens against max_tokens
    assert.equal(
      tokenLimit(
        { model: "deepseek/deepseek-v4.1-flash" },
        "https://openrouter.ai/api/v1/chat/completions",
        300,
      ),
      8192,
    );
    // Older Claude models only think when asked to
    assert.equal(
      tokenLimit({ model: "claude-haiku-4-5" }, anthropic, 300),
      300,
    );
    assert.equal(
      tokenLimit(
        { model: "m" },
        "https://example.invalid/v1/chat/completions",
        300,
      ),
      300,
    );
  });

  it("detects the provider of free-form LLM settings", function () {
    const { detectProvider } = providers();
    assert.equal(
      detectProvider("openai", "https://api.deepseek.com", "deepseek-flash"),
      "deepseek",
    );
    // retired name of the same model
    assert.equal(
      detectProvider(
        "openai",
        "https://api.deepseek.com/",
        "deepseek-v4-flash",
      ),
      "deepseek",
    );
    assert.equal(
      detectProvider(
        "anthropic",
        "https://api.anthropic.com",
        "claude-opus-5-5",
      ),
      "anthropic",
    );
    assert.equal(
      detectProvider(
        "openai",
        "https://openrouter.ai/api/v1",
        "anthropic/claude-haiku-5.5",
      ),
      "openrouter",
    );
    // a model outside the preset list, or a different format, stays custom
    assert.equal(
      detectProvider("openai", "https://openrouter.ai/api/v1", "some/model"),
      "custom",
    );
    assert.equal(
      detectProvider("openai", "https://api.deepseek.com", "deepseek-chat"),
      "custom",
    );
    assert.equal(
      detectProvider("anthropic", "https://api.deepseek.com/anthropic", ""),
      "custom",
    );
    assert.equal(
      detectProvider("openai", "https://llm.example.org/api/v1", "x"),
      "custom",
    );
    assert.isUndefined(detectProvider("openai", "", ""));
  });

  it("maps preset model names and retired aliases", function () {
    const { presetModel } = providers();
    assert.equal(presetModel("deepseek", "deepseek-v4-pro"), "deepseek-v4-pro");
    assert.equal(
      presetModel("deepseek", "deepseek-v4-flash"),
      "deepseek-flash",
    );
    assert.isUndefined(presetModel("anthropic", "deepseek-flash"));
    assert.equal(
      presetModel("openrouter", "google/gemini-3.8-flash"),
      "google/gemini-3.8-flash",
    );
    assert.isUndefined(presetModel("openrouter", "claude-haiku-5-5"));
  });

  it("strips leaked reasoning and safety tags from completions", function () {
    const { cleanCompletion } = clients();
    assert.equal(
      cleanCompletion("<think>hmm</think> A definition."),
      "A definition.",
    );
    assert.equal(
      cleanCompletion("<ds_safety>check</ds_safety>Safe A definition."),
      "A definition.",
    );
    assert.equal(cleanCompletion("  plain  "), "plain");
  });

  it("asks the decision model over the Anthropic Messages API", async function () {
    const { decide } = clients();
    const http = Zotero.HTTP as any;
    const original = http.request;
    let sent: any;
    http.request = async (method: string, url: string, opts: any) => {
      sent = {
        method,
        url,
        headers: opts.headers,
        body: JSON.parse(opts.body),
      };
      return {
        status: 200,
        response: {
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "…" },
            { type: "text", text: '{"keep": 0.9, "kind": "method"}' },
          ],
        },
      };
    };
    try {
      const answers = await decide(
        "Gradient descent minimises a loss.",
        {
          keep: { type: "noul", instructions: "Is this a concept?" },
          kind: {
            type: "choice",
            instructions: "What kind?",
            criteria: { method: "a method", other: "anything else" },
          },
        },
        {
          format: "anthropic",
          endpoint: "https://anthropic.example.invalid",
          model: "claude-haiku-5-5",
          key: "sk-test",
        },
      );
      assert.equal(sent.url, "https://anthropic.example.invalid/v1/messages");
      assert.equal(sent.headers["x-api-key"], "sk-test");
      assert.notProperty(sent.headers, "Authorization");
      assert.equal(sent.body.model, "claude-haiku-5-5");
      assert.isString(sent.body.system);
      assert.deepEqual(answers.keep, { type: "noul", noul: 0.9 });
      assert.equal(answers.kind.choice, "method");
    } finally {
      http.request = original;
    }
  });

  it("sends the chosen effort to Claude on api.anthropic.com", async function () {
    const { chatComplete } = clients();
    const effortPref = `${config.prefsPrefix}.llm.anthropicEffort`;
    const saved = Zotero.Prefs.get(effortPref, true);
    const http = Zotero.HTTP as any;
    const original = http.request;
    const bodies: any[] = [];
    http.request = async (_m: string, _u: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return {
        status: 200,
        response: { content: [{ type: "text", text: "A definition." }] },
      };
    };
    const s = {
      format: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-5-5",
      key: "sk-test",
    };
    try {
      Zotero.Prefs.set(effortPref, "medium", true);
      await chatComplete(s, "sys", "user");
      Zotero.Prefs.set(effortPref, "bogus", true);
      await chatComplete(s, "sys", "user");
      assert.deepEqual(bodies[0].output_config, { effort: "medium" });
      assert.deepEqual(bodies[1].output_config, { effort: "low" });
    } finally {
      http.request = original;
      if (saved === undefined) Zotero.Prefs.clear(effortPref, true);
      else Zotero.Prefs.set(effortPref, saved, true);
    }
  });

  it("does not pause the LLM for endpoints that never hit a quota", function () {
    const { llmPause } = clients();
    assert.isUndefined(
      llmPause({
        format: "openai",
        endpoint: "https://example.invalid",
        model: "m",
        key: "",
      }),
    );
  });
});
