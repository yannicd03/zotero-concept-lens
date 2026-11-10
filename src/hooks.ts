/** Lifecycle hooks, called by bootstrap.js and the preferences pane. */
import { config } from "../package.json";
import { migrateLlmProvider } from "./modules/llmProviders";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  startReaderIntegration,
  stopReaderIntegration,
} from "./modules/reader/manager";
import { state } from "./state";
import { log } from "./utils/log";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/icon-96.png`,
  });

  await migrateLlmProvider().catch((e) =>
    log("LLM provider migration failed", e),
  );
  startReaderIntegration();
  state.initialized = true;
}

function onShutdown() {
  stopReaderIntegration();
  state.alive = false;
  delete (Zotero as unknown as Record<string, unknown>)[config.addonInstance];
}

/** Called from preferences.xhtml once the pane has loaded. */
function onPrefsEvent(type: string, data: { window: Window }) {
  if (type === "load") registerPrefsScripts(data.window);
}

export default { onStartup, onShutdown, onPrefsEvent };
