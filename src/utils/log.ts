/**
 * Logging to Zotero's debug output (Help → Debug Output Logging), and in
 * development builds also to the browser console.
 */
import { config } from "../../package.json";

const PREFIX = `[${config.addonName}]`;

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(...args: unknown[]) {
  Zotero.debug(`${PREFIX} ${args.map(format).join(" ")}`);
  if (__env__ === "development")
    Zotero.getMainWindow()?.console.log(PREFIX, ...args);
}
