import { assert } from "chai";
import { config } from "../package.json";

const usage = () => (Zotero as any)[config.addonInstance].api.usage;

describe("usage", function () {
  beforeEach(async function () {
    await usage().reset();
  });

  it("reads token counts in both API formats", function () {
    const { readUsage } = usage();
    assert.deepEqual(
      readUsage({
        prompt_tokens: 33,
        completion_tokens: 14,
        prompt_cache_hit_tokens: 10,
      }),
      {
        input: 33,
        cachedInput: 10,
        cacheWrite: 0,
        output: 14,
        reportedCost: undefined,
      },
    );
    // Anthropic's input_tokens excludes cache reads and writes
    assert.deepEqual(
      readUsage({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        output_tokens: 7,
      }),
      {
        input: 170,
        cachedInput: 50,
        cacheWrite: 20,
        output: 7,
        reportedCost: undefined,
      },
    );
    assert.equal(
      readUsage({ input_tokens: 1, cost: 0.002 }).reportedCost,
      0.002,
    );
    assert.equal(readUsage(undefined).input, 0);
  });

  it("prices requests: reported, estimated or unknown", function () {
    const { costOf, readUsage } = usage();
    // Monday 2026-11-09, 07:00 UTC: DeepSeek peak; 12:00 UTC: off-peak
    const peak = Date.UTC(2026, 10, 9, 7);
    const offPeak = Date.UTC(2026, 10, 9, 12);
    const u = readUsage({
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    });
    const ds = (t: number) =>
      costOf("api.deepseek.com", "deepseek-flash", u, t);
    assert.closeTo(ds(peak).cost, 0.3 + 1.2, 1e-9);
    assert.closeTo(ds(offPeak).cost, (0.3 + 1.2) / 2, 1e-9);
    assert.isTrue(ds(peak).estimated);
    const claude = costOf("api.anthropic.com", "claude-sonnet-5-5", u, peak);
    assert.closeTo(claude.cost, 2 + 10, 1e-9);
    // OpenRouter's reported cost wins over any price list
    const or = costOf(
      "openrouter.ai",
      "anthropic/claude-sonnet-5.5",
      readUsage({ prompt_tokens: 5, completion_tokens: 5, cost: 0.0042 }),
      peak,
    );
    assert.deepEqual(or, { cost: 0.0042, estimated: false });
    assert.isUndefined(costOf("llm.example.org", "x", u, peak));
  });

  it("knows DeepSeek's peak hours", function () {
    const { deepseekPeak } = usage();
    assert.isTrue(deepseekPeak(Date.UTC(2026, 10, 10, 2))); // Tue 02:00
    assert.isFalse(deepseekPeak(Date.UTC(2026, 10, 10, 5))); // Tue 05:00
    assert.isTrue(deepseekPeak(Date.UTC(2026, 10, 10, 9, 59)));
    assert.isFalse(deepseekPeak(Date.UTC(2026, 10, 14, 7))); // Saturday
  });

  it("sums requests per day and model", async function () {
    const { record, summary } = usage();
    const now = Date.now();
    await record(
      "decision",
      "https://openrouter.ai/api/v1/systemone",
      "typesafe/jev-1.14",
      { input_tokens: 281, output_tokens: 20, cost: 0.00001 },
      now,
    );
    await record(
      "decision",
      "https://openrouter.ai/api/v1/systemone",
      "typesafe/jev-1.14",
      { input_tokens: 100, output_tokens: 10, cost: 0.00002 },
      now,
    );
    await record(
      "llm",
      "https://llm.example.org/v1/chat/completions",
      "x",
      { prompt_tokens: 40, completion_tokens: 2 },
      now,
    );
    // a day long ago counts for "all time" only
    await record(
      "llm",
      "https://api.deepseek.com/chat/completions",
      "deepseek-flash",
      { prompt_tokens: 1, completion_tokens: 1 },
      Date.UTC(2020, 0, 6, 12),
    );
    const s = await summary(now);
    assert.equal(s.today.requests, 3);
    assert.equal(s.today.inputTokens, 421);
    assert.closeTo(s.today.cost, 0.00003, 1e-12);
    assert.equal(s.today.unpriced, 1);
    assert.equal(s.all.requests, 4);
    assert.equal(s.since, "2020-01-06");
    assert.deepEqual(
      s.byModel.map((r: any) => [r.service, r.host, r.model, r.requests]),
      [
        ["decision", "openrouter.ai", "typesafe/jev-1.14", 2],
        ["llm", "llm.example.org", "x", 1],
      ],
    );
  });

  it("formats costs for the settings view", function () {
    const { formatCost } = (Zotero as any)[config.addonInstance].api.prefs;
    const base = { requests: 2, unpriced: 0, estimated: 0 };
    assert.equal(formatCost({ ...base, cost: 0.0123 }), "$0.01");
    assert.equal(formatCost({ ...base, cost: 0.0042 }), "$0.0042");
    assert.equal(formatCost({ ...base, cost: 0.0000118 }), "$0.000012");
    assert.equal(formatCost({ ...base, cost: 0.5, estimated: 1 }), "≈ $0.50");
    assert.equal(formatCost({ ...base, cost: 0, unpriced: 2 }), "unknown");
    assert.equal(
      formatCost({ ...base, cost: 0.2, unpriced: 1 }),
      "$0.20 + 1 unpriced",
    );
    assert.equal(formatCost({ ...base, requests: 0, cost: 0 }), "–");
  });
});
