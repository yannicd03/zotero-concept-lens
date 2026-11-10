import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("publishes the plugin object on Zotero once started", function () {
    const plugin = (Zotero as any)[config.addonInstance];
    assert.isObject(plugin);
    assert.isTrue(plugin.data.initialized);
    assert.isFunction(plugin.hooks.onShutdown);
  });
});
