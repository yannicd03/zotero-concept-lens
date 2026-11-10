// Concept marking in the PDF reader
pref("highlight.enabled", true);

// Hover card: comma-separated section order; sections listed in
// card.hiddenSections are not shown. Sections: definition, excerpt, related
pref("card.sectionOrder", "definition,excerpt,related");
pref("card.hiddenSections", "");
// Max. number of related papers shown on the card
pref("card.relatedLimit", 5);

// Decision model: filters rule-proposed candidates (yes/no per candidate)
// and picks the best defining sentence. API keys live in the login manager.
// format: "systemone" (OpenRouter /systemone, e.g. Jev) or "chat"
// (an OpenAI-compatible chat model asked for yes/no probabilities)
pref("decision.format", "systemone");
pref("decision.endpoint", "https://openrouter.ai/api/v1/systemone");
pref("decision.model", "typesafe/jev-1.14");
// Link threshold in percent (0-100)
pref("decision.threshold", 80);

// LLM fallback: writes a short definition when no paper in the library
// defines the concept. provider: "deepseek" or "anthropic" (preset endpoint,
// model picked from a list) or "custom" (the llm.format/endpoint/model below;
// format: "openai" (chat completions) or "anthropic")
pref("llm.enabled", true);
pref("llm.provider", "deepseek");
pref("llm.deepseekModel", "deepseek-flash");
pref("llm.anthropicModel", "claude-haiku-5-5");
pref("llm.format", "openai");
pref("llm.endpoint", "");
pref("llm.model", "");

// Citation hover: show the library copy instead of the reference list
pref("citation.enabled", true);
