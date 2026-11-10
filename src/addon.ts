/**
 * The plugin object, published as Zotero.ConceptLens: lifecycle hooks for
 * bootstrap.js and the preferences pane, run state, and the modules under
 * `api` for tests and the dev scripts (scripts/zotero-eval.mjs).
 */
import hooks from "./hooks";
import { state } from "./state";
import * as sections from "./modules/sections";
import * as secrets from "./utils/secrets";
import * as clients from "./modules/clients";
import * as llmProviders from "./modules/llmProviders";
import * as candidates from "./modules/candidates";
import * as pagetext from "./modules/reader/pagetext";
import * as doctext from "./modules/concepts/doctext";
import * as analyze from "./modules/concepts/analyze";
import * as definitions from "./modules/concepts/definitions";
import * as reader from "./modules/reader/manager";
import * as citations from "./modules/citations/match";
import * as citationLibrary from "./modules/citations/library";
import * as usage from "./modules/usage";
import * as prefs from "./modules/preferenceScript";

export const plugin = {
  hooks,
  /** `data.initialized` tells the test runner that startup has finished. */
  data: state,
  api: {
    sections,
    secrets,
    clients,
    llmProviders,
    candidates,
    pagetext,
    doctext,
    analyze,
    definitions,
    reader,
    citations,
    citationLibrary,
    usage,
    prefs,
  },
};
