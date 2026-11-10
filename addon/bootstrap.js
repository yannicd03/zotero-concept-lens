/**
 * Zotero bootstrap entry point of Concept Lens.
 *
 * Zotero calls these functions by name. startup() registers the add-on's
 * content/ folder as a chrome:// package, runs the bundled plugin script
 * (which creates the plugin object on Zotero) and starts it. The build
 * fills in the names from package.json "config".
 */

let chromeRegistration = null;

async function startup({ rootURI }) {
  const addonManager = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeRegistration = addonManager.registerChrome(
    Services.io.newURI(`${rootURI}manifest.json`),
    [["content", "__addonRef__", `${rootURI}content/`]],
  );

  // The plugin script sees the properties of this object as globals.
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    { rootURI },
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function shutdown(_data, reason) {
  // Zotero is quitting: nothing to clean up.
  if (reason === APP_SHUTDOWN) return;
  await Zotero.__addonInstance__?.hooks.onShutdown();
  chromeRegistration?.destruct();
  chromeRegistration = null;
}

function install() {}

function uninstall() {}
