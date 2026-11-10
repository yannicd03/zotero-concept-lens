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
