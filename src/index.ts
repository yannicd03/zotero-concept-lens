/**
 * Entry of the bundled plugin script. bootstrap.js loads it once per start
 * and then calls Zotero.ConceptLens.hooks.onStartup().
 */
import { config } from "../package.json";
import { plugin } from "./addon";

const zotero = Zotero as unknown as Record<string, unknown>;
zotero[config.addonInstance] ??= plugin;
