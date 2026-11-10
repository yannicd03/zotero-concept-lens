<img src="addon/content/icons/icon-96.png" alt="" width="64" align="right">

# Concept Lens

A Zotero plugin that helps you read papers inside your own library.

- **Concepts:** it marks the technical concepts of the open PDF with a
  dotted underline. Hovering one shows a card with its definition, the
  passage in this paper that uses it, and the other papers in your library
  that mention it.
- **Citations:** hovering an in-text citation such as "Chua et al. (2018)"
  shows the cited paper's abstract with an "In your library" badge, when
  that paper is in your library. A click opens its PDF. Citations to papers
  you don't have keep Zotero's normal preview.

Tested with Zotero 10 on Linux. The manifest allows Zotero 8 to 11.

## How it works

### Finding concepts

Two stages: rules propose candidates, a model filters them.

1. **Rules propose candidates** from the paper's text:
   - acronyms with their expansion, e.g. "model-based reinforcement
     learning (MBRL)";
   - definition patterns such as "we define X as", "X refers to",
     "known as X";
   - multi-word terms that recur in the paper.

   Plurals count as the same term. Running headers, page numbers and the
   bibliography are ignored; the appendix is kept.

2. **A decision model filters them.** It answers one yes/no question per
   candidate ("is this a technical concept of the paper?") and keeps those
   above a threshold (80 % by default). Without a decision model, a simple
   rule-based filter is used.

Results are cached per paper, so a paper is only analysed once.

### Definitions

The card takes the first definition it finds, in this order:

1. a definition sentence in the open paper itself;
2. a definition remembered from earlier (a library-wide glossary);
3. the clearest defining sentence from another paper in your library,
   chosen by the decision model;
4. a short definition written by an LLM, given the paper's title, abstract
   and the passage that uses the term, so it picks the right field. These
   are marked with an **AI** badge and remembered in the glossary;
5. the sentence in which the paper introduces the acronym.

The other papers come from Zotero's full-text index, so only papers whose
PDFs Zotero has indexed are found.

### Citations

Most papers link their citations to the bibliography (hyperref links), and
Zotero's own hover shows a picture of that bibliography page. Concept Lens
reads the text at the link's target, cuts out the one entry and matches it
against your library:

- by DOI or arXiv ID first;
- then by title, which must also agree with an author's surname and the
  year.

When in doubt it shows no match rather than the wrong paper. The open paper
itself is never offered.

## Installation

Requirements: Zotero 8 or newer (tested with Zotero 10 on Linux). Building
needs Node.js and npm (tested with Node.js 24).

There is no release yet, so build the plugin file yourself:

```sh
git clone https://github.com/yannicd03/zotero-concept-lens.git
cd zotero-concept-lens
npm install
npm run build
```

This creates `.scaffold/build/concept-lens.xpi`. To install it:

1. In Zotero, open **Tools → Plugins**.
2. Click the gear icon and choose **Install Plugin From File…**.
3. Pick `concept-lens.xpi`.

To update, build again and install the new file the same way. To remove
the plugin, use **Remove** in **Tools → Plugins**; its caches stay in
`<Zotero data directory>/conceptlens/` until you delete that folder.

## Setup

The plugin works without any setup: concepts are then filtered by rules
only, and cards show only definitions found in your papers. Two optional
models make it better. Both are set in **Zotero Settings → Concept Lens**,
and both have a **Test connection** button.

1. **Decision model** (recommended). It decides which candidates are real
   concepts and picks the best defining sentence. The default is Jev via
   OpenRouter: create an API key at [openrouter.ai](https://openrouter.ai),
   paste it under **Decision model → API key**, and click **Test
   connection**. Endpoint and model are pre-filled.
2. **LLM fallback** (optional). It writes a short definition when no paper
   in your library defines the concept. Choose a provider (DeepSeek,
   Anthropic, OpenRouter or a custom endpoint), paste that provider's API
   key, pick a model, and click **Test connection**. **OpenRouter** needs no
   extra key: it uses the decision model's OpenRouter key unless you enter
   a different one.
3. **Full-text index.** "Other papers in your library" comes from Zotero's
   full-text index. Zotero indexes new PDFs by itself. If older papers are
   missing, rebuild the index under **Zotero Settings → Search**.

Then open a PDF. The first time a paper is opened it is analysed, which
can take a moment; the underlines appear when the analysis is done. The
result is cached, so later visits are instant.

## Settings

**Zotero Settings → Concept Lens:**

| Setting        | What it does                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marking        | Switch the concept underlines and the citation hover on or off.                                                                                                                                                                                                                                                                           |
| Hover card     | Show or hide the card's sections and order those below the definition. Number of other papers shown (default 5).                                                                                                                                                                                                                          |
| Decision model | Format (`systemone` or an OpenAI-compatible chat model), endpoint, model, API key, link threshold. Default: Jev (`typesafe/jev-1.14`) via OpenRouter's `/systemone` route.                                                                                                                                                                |
| LLM fallback   | Provider: **DeepSeek** (Flash or Pro), **Anthropic** (Claude Haiku, Sonnet or Opus), **OpenRouter** (DeepSeek Flash, Claude Haiku or Sonnet, Gemini Flash, GPT-6 Luna) or a **custom** endpoint (OpenAI-compatible or Anthropic Messages format). Each provider keeps its own API key; OpenRouter falls back to the decision model's key. |
| Spending       | Requests, tokens and cost of this plugin's API calls: today, this month, all time, and this month by model. OpenRouter costs are exact; DeepSeek and Anthropic costs are price-list estimates. **Check provider accounts** shows the OpenRouter key's spend and limit and the DeepSeek balance.                                           |

## Privacy

- **API keys** are stored in Zotero's login manager (like Zotero's own sync
  credentials), not in the preferences file.
- **Without API keys,** nothing leaves your computer.
- **With a decision model configured,** the open paper's title and the
  first 60,000 characters of its text go to that endpoint, once per paper.
  So do candidate defining sentences from your other papers.
- **With an LLM configured,** the concept, the paper's title and abstract,
  and the passage that uses the concept go to that endpoint, once per
  concept.
- **The citation hover** uses only your local library.
- **Caches** and the spending record (`usage.json`) live in
  `<Zotero data directory>/conceptlens/`.

## Development

Built and tested with
[zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold),
with types from [zotero-types](https://github.com/windingwind/zotero-types).

```sh
npm install
cp .env.example .env      # set the Zotero binary, a dev profile and data dir
npm start                 # dev Zotero with hot reload
npm test                  # tests run inside Zotero, in a separate profile
npm run lint:check
```

- `.env.example` documents every variable. The `CONCEPTLENS_*` values are
  optional: `npm run dev:settings` copies them into the running dev Zotero,
  with keys going to the login manager.
- `scripts/zotero-eval.mjs` runs JavaScript inside the running dev Zotero
  over the remote debugging protocol, for example
  `echo 'return Zotero.version' | node scripts/zotero-eval.mjs -`.
- `scripts/zotero-flatpak.sh` starts the Flatpak build of Zotero under X11.
  Under GNOME Wayland a covered window counts as hidden, and pdf.js then
  stops rendering pages.

Code layout:

| Path                                        | Contents                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `src/modules/candidates.ts`                 | Rule-based candidate proposal.                                         |
| `src/modules/concepts/`                     | Per-paper analysis, definitions, related papers.                       |
| `src/modules/reader/`                       | Underlines, hover and concept card in the PDF reader.                  |
| `src/modules/citations/`                    | Citation hover: reader hook, entry extraction, library matching, card. |
| `src/modules/clients.ts`, `llmProviders.ts` | Decision model and LLM clients.                                        |
| `addon/`                                    | Manifest, preferences pane, locale, default prefs.                     |

## License

[MIT](LICENSE). The software is provided "as is", without warranty of any
kind.
