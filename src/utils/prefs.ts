/**
 * Typed access to the plugin's prefs (defaults in addon/prefs.js, keys
 * without the extensions.zotero.conceptlens prefix).
 */
import { config } from "../../package.json";

type Prefs = _ZoteroTypes.Prefs["PluginPrefsMap"];

const fullKey = (key: string) => `${config.prefsPrefix}.${key}`;

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return Zotero.Prefs.get(fullKey(key), true) as Prefs[K];
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  return Zotero.Prefs.set(fullKey(key), value, true);
}

export function clearPref(key: keyof Prefs) {
  return Zotero.Prefs.clear(fullKey(key), true);
}
