// Build, dev server and test runner settings for zotero-plugin-scaffold.
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const { addonName, addonID, addonRef, addonInstance, prefsPrefix } = pkg.config;

export default defineConfig({
  name: addonName,
  id: addonID,
  namespace: addonRef,
  source: ["src", "addon"],
  dist: ".scaffold/build",
  // Release assets of the GitHub repository in package.json.
  updateURL: `${pkg.homepage}/releases/latest/download/update.json`,
  xpiDownloadLink: `${pkg.homepage}/releases/download/v{{version}}/{{xpiName}}.xpi`,

  build: {
    assets: ["addon/**/*.*"],
    // Replaces __key__ placeholders in addon/ (manifest, bootstrap, xhtml).
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      // Shown in the settings footer; filled in by the scaffold.
      buildTime: "{{buildTime}}",
    },
    prefs: { prefix: prefsPrefix },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        outfile: `.scaffold/build/addon/content/scripts/${addonRef}.js`,
        bundle: true,
        target: "firefox115",
        define: { __env__: JSON.stringify(process.env.NODE_ENV) },
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${addonInstance}?.data.initialized`,
  },
});
