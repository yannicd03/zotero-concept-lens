// Concept marking in the PDF reader
pref("highlight.enabled", true);

// Analyse every PDF in the library in the background (rules + one
// decision-model request per paper), so concepts link across papers that
// were never opened. Definitions are still only generated on hover.
pref("index.enabled", true);

// Hover card: comma-separated section order; sections listed in
// card.hiddenSections are not shown. Sections: definition, excerpt, related
pref("card.sectionOrder", "definition,excerpt,related");
pref("card.hiddenSections", "");
// Max. number of related papers shown on the card
pref("card.relatedLimit", 5);

// Decision model: filters rule-proposed candidates (yes/no per candidate)
// and picks the best defining sentence. API keys live in the login manager.
// format: "systemone" (OpenRouter /systemone, e.g. Jev) or "chat"
// (an OpenAI-compatible chat model asked for yes/no probabilities) or
// "anthropic" (the same, over the Anthropic Messages API)
pref("decision.format", "systemone");
pref("decision.endpoint", "https://openrouter.ai/api/v1/systemone");
pref("decision.model", "typesafe/jev-1.14");
// Link threshold in percent (0-100)
pref("decision.threshold", 80);

// LLM fallback: writes a short definition when no paper in the library
// defines the concept. provider: "deepseek", "anthropic" or "openrouter"
// (preset endpoint, model picked from a list; OpenRouter uses the decision
// model's key unless it has its own) or "custom" (the llm.format/endpoint/
// model below; format: "openai" (chat completions) or "anthropic")
pref("llm.enabled", true);
pref("llm.provider", "deepseek");
pref("llm.deepseekModel", "deepseek-flash");
pref("llm.anthropicModel", "claude-haiku-5-5");
// Thinking effort for current Claude models on api.anthropic.com:
// "low", "medium" or "high"
pref("llm.anthropicEffort", "low");
pref("llm.openrouterModel", "deepseek/deepseek-v4.1-flash");
pref("llm.format", "openai");
pref("llm.endpoint", "");
pref("llm.model", "");

// Share paper analyses and the glossary with your other computers through
// the WebDAV server of Zotero's file sync (a "conceptlens" folder next to
// its "zotero" folder). Needs Zotero's file sync set to WebDAV.
pref("share.enabled", false);

// Citation hover: show the library copy instead of the reference list
pref("citation.enabled", true);
