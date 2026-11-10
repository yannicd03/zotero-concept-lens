/** Small JSON files under <Zotero data dir>/conceptlens/. */
import { config } from "../../package.json";
import { log } from "./log";

function baseDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
}

export async function readJSON<T>(...parts: string[]): Promise<T | undefined> {
  const path = PathUtils.join(baseDir(), ...parts);
  try {
    if (!(await IOUtils.exists(path))) return undefined;
    return JSON.parse(await IOUtils.readUTF8(path)) as T;
  } catch (e) {
    log("readJSON failed", path, e);
    return undefined;
  }
}

export async function writeJSON(value: unknown, ...parts: string[]) {
  const path = PathUtils.join(baseDir(), ...parts);
  await IOUtils.makeDirectory(PathUtils.parent(path)!, {
    ignoreExisting: true,
    createAncestors: true,
  });
  await IOUtils.writeUTF8(path, JSON.stringify(value), {
    tmpPath: path + ".tmp",
  });
}

export async function removeAll(...parts: string[]) {
  const path = PathUtils.join(baseDir(), ...parts);
  await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
}
