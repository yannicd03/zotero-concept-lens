import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api;

const STORAGE_PREFS = ["protocol", "scheme", "url", "username"];
const SHARE_PREF = `${config.prefsPrefix}.share.enabled`;
const ROOT = "https://me:p%40ss@dav.example.invalid/files/zotero/";

const http = () => Zotero.HTTP as any;
const webdav = () => (Zotero as any).Sync.Storage.Mode.WebDAV.prototype;

describe("shared", function () {
  let saved: Record<string, unknown>;
  let originalRequest: any;
  let originalPassword: any;
  /** The fake WebDAV server: file name in zotero/ -> content */
  let server: Map<string, string>;
  let urls: string[];
  const localFiles: string[] = [];
  const created: Zotero.Item[] = [];

  function fakeDav(method: string, url: string, opts: any) {
    // Anything else (e.g. the test runner reporting results) goes out.
    if (!url.startsWith(ROOT))
      return originalRequest.call(Zotero.HTTP, method, url, opts);
    urls.push(url);
    const path = url.slice(ROOT.length);
    const reply = (status: number, response = "") => ({ status, response });
    switch (method) {
      case "MKCOL":
        throw new Error("the plugin must not create folders on the server");
      case "PUT":
        server.set(path, opts.body);
        return reply(201);
      case "GET":
        return server.has(path) ? reply(200, server.get(path)) : reply(404);
      case "PROPFIND": {
        assert.equal(opts.headers.Depth, "1");
        const files = [...server.keys()].filter((p) => p.startsWith(path));
        // Mixed namespace prefixes and URL-encoding, as real servers send
        const hrefs = [
          `<d:href>/files/zotero/${path}</d:href>`,
          ...files.map((f) => `<D:href>/files/zotero/${f}</D:href>`),
        ];
        return reply(207, `<d:multistatus>${hrefs.join("")}</d:multistatus>`);
      }
    }
    return reply(405);
  }

  function localPath(name: string) {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      config.addonRef,
      "papers",
      name,
    );
  }

  function analysis(term: string, version = api().analyze.ANALYSIS_VERSION) {
    return {
      version,
      settingsKey: api().analyze.settingsKey(),
      filteredBy: "rules",
      concepts: [{ id: "k0", term, aliases: [], kinds: ["phrase"], count: 2 }],
    };
  }

  beforeEach(function () {
    saved = {};
    for (const k of STORAGE_PREFS)
      saved[k] = Zotero.Prefs.get(`sync.storage.${k}`);
    Zotero.Prefs.set("sync.storage.protocol", "webdav");
    Zotero.Prefs.set("sync.storage.scheme", "https");
    Zotero.Prefs.set("sync.storage.url", "dav.example.invalid/files/");
    Zotero.Prefs.set("sync.storage.username", "me");
    Zotero.Prefs.set(SHARE_PREF, true, true);
    originalPassword = webdav().getPassword;
    webdav().getPassword = async () => "p@ss";
    originalRequest = http().request;
    http().request = async (m: string, u: string, o: any) => fakeDav(m, u, o);
    server = new Map();
    urls = [];
    api().shared.resetCredentials();
  });

  afterEach(async function () {
    http().request = originalRequest;
    webdav().getPassword = originalPassword;
    for (const k of STORAGE_PREFS)
      Zotero.Prefs.set(`sync.storage.${k}`, saved[k]);
    Zotero.Prefs.clear(SHARE_PREF, true);
    api().shared.resetCredentials();
    for (const name of localFiles.splice(0))
      await IOUtils.remove(localPath(name), { ignoreAbsent: true });
    for (const item of created.splice(0)) await item.eraseTx();
  });

  it("reads file names from PROPFIND replies", function () {
    const { hrefNames } = api().shared;
    assert.deepEqual(
      hrefNames(
        '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/conceptlens/papers/</D:href></D:response>' +
          "<D:response><D:href>/dav/conceptlens/papers/u-ABCD2345.json</D:href></D:response>" +
          '<response xmlns="DAV:"><href>https://x.invalid/c/papers/g12-KEY%20X.json</href></response></D:multistatus>',
      ),
      ["u-ABCD2345.json", "g12-KEY X.json"],
    );
  });

  it("names shared papers by portable library and item key", function () {
    const { sharedPaperName, localPaperName, portableLibrary } = api().shared;
    const user = Zotero.Libraries.userLibraryID;
    assert.equal(portableLibrary(user), "u");
    assert.equal(
      sharedPaperName(user, "ABCD2345"),
      "conceptlens-u-ABCD2345.json",
    );
    assert.equal(
      localPaperName("conceptlens-u-ABCD2345.json"),
      `${user}-ABCD2345.json`,
    );
    // A group this computer doesn't have, and names that aren't ours
    assert.isUndefined(localPaperName("conceptlens-g987654321-ABCD2345.json"));
    assert.isUndefined(localPaperName("conceptlens-glossary.json"));
    assert.isUndefined(localPaperName("ABCD2345.zip"));
  });

  it("is off unless Zotero's file sync uses WebDAV", function () {
    const { sharingEnabled, webdavProblem, sharedFolderLabel } = api().shared;
    assert.isTrue(sharingEnabled());
    assert.equal(
      sharedFolderLabel(),
      "https://dav.example.invalid/files/zotero/conceptlens-*",
    );
    Zotero.Prefs.set("sync.storage.protocol", "zotero");
    assert.match(webdavProblem(), /not set to WebDAV/);
    assert.isFalse(sharingEnabled());
  });

  it("downloads papers only the server has and uploads local-only ones", async function () {
    const { syncPapers } = api().shared;
    const user = Zotero.Libraries.userLibraryID;
    const version = api().analyze.ANALYSIS_VERSION;
    localFiles.push(`${user}-SHRLOCAL.json`, `${user}-SHRREMOT.json`);
    await IOUtils.makeDirectory(PathUtils.parent(localPath("x"))!, {
      ignoreExisting: true,
      createAncestors: true,
    });
    await IOUtils.writeJSON(
      localPath(`${user}-SHRLOCAL.json`),
      analysis("local concept"),
    );
    // Zotero's own attachment files sit next to ours
    server.set("SHRREMOT.zip", "zip");
    server.set("SHRREMOT.prop", "<properties/>");
    server.set(
      "conceptlens-u-SHRREMOT.json",
      JSON.stringify(analysis("remote")),
    );
    server.set(
      "conceptlens-u-SHROLDVR.json",
      JSON.stringify(analysis("old", version - 1)),
    );

    const r = await syncPapers(version);

    assert.deepEqual(
      r.downloaded.map((d: any) => d.localName),
      [`${user}-SHRREMOT.json`],
    );
    const local = await IOUtils.readJSON(localPath(`${user}-SHRREMOT.json`));
    assert.equal(local.concepts[0].term, "remote");
    assert.isFalse(await IOUtils.exists(localPath(`${user}-SHROLDVR.json`)));
    assert.isAtLeast(r.uploaded, 1);
    assert.equal(
      JSON.parse(server.get("conceptlens-u-SHRLOCAL.json")!).concepts[0].term,
      "local concept",
    );
  });

  it("reuses another computer's analysis instead of analysing again", async function () {
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Shared paper");
    await parent.saveTx();
    created.push(parent);
    localFiles.push(`${parent.libraryID}-${parent.key}.json`);
    server.set(
      `conceptlens-u-${parent.key}.json`,
      JSON.stringify(analysis("borrowed concept")),
    );

    // The item has no PDF text: only the shared analysis can supply concepts.
    const set = await api().analyze.analyzeAttachment(parent);

    assert.equal(set.concepts[0]?.term, "borrowed concept");
    assert.isTrue(
      await IOUtils.exists(localPath(`${parent.libraryID}-${parent.key}.json`)),
    );
  });

  it("merges glossaries per term, newest entry first", function () {
    const { mergeGlossaries } = api().definitions;
    const def = (text: string, at: string) => ({
      text,
      source: { kind: "llm", model: "m" },
      at,
    });
    const merged = mergeGlossaries(
      {
        a: def("old a", "2026-01-01T00:00:00Z"),
        b: def("b here", "2026-03-01T00:00:00Z"),
        c: def("c", "2026-01-01T00:00:00Z"),
      },
      {
        a: def("new a", "2026-02-01T00:00:00Z"),
        b: def("older b", "2026-02-01T00:00:00Z"),
        c: { deleted: true, at: "2026-02-01T00:00:00Z" },
        d: def("only remote", "2026-02-01T00:00:00Z"),
        junk: { text: "no timestamp" },
      },
    );
    assert.equal(merged.a.text, "new a");
    assert.equal(merged.b.text, "b here");
    assert.isTrue(merged.c.deleted);
    assert.equal(merged.d.text, "only remote");
    assert.notProperty(merged, "junk");
  });

  it("exchanges glossary entries with the server", async function () {
    const {
      syncGlossary,
      forgetDefinition,
      resolveDefinition,
      forgetGlossary,
    } = api().definitions;
    server.set(
      "conceptlens-glossary.json",
      JSON.stringify({
        "zeta function": {
          text: "A function defined by a Dirichlet series.",
          source: { kind: "llm", model: "claude-sonnet-5-5" },
          at: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
    await forgetDefinition("only here");

    assert.isAtLeast(await syncGlossary(), 1);

    const def = await resolveDefinition(
      { id: "k0", term: "Zeta function", aliases: [], kinds: [], count: 1 },
      null,
      Zotero.Libraries.userLibraryID,
      "",
    );
    assert.equal(def?.text, "A function defined by a Dirichlet series.");
    const remote = JSON.parse(server.get("conceptlens-glossary.json")!);
    assert.isTrue(remote["only here"].deleted);
    await forgetGlossary();
  });

  it("stops looking up papers for a while after the server fails", async function () {
    const { fetchSharedAnalysis } = api().shared;
    const version = api().analyze.ANALYSIS_VERSION;
    const att = { libraryID: Zotero.Libraries.userLibraryID, key: "SHRDOWN1" };
    const working = http().request;
    http().request = async (m: string, u: string, o: any) =>
      u.startsWith(ROOT)
        ? { status: 503, response: "" }
        : originalRequest.call(Zotero.HTTP, m, u, o);
    assert.isUndefined(await fetchSharedAnalysis(att, version));
    http().request = working;
    server.set("conceptlens-u-SHRDOWN1.json", JSON.stringify(analysis("late")));
    urls = [];
    assert.isUndefined(await fetchSharedAnalysis(att, version));
    assert.lengthOf(urls, 0, "no request while backing off");
    // An explicit sync tries again.
    await api().shared.syncPapers(version);
    assert.isAbove(urls.length, 0);
    localFiles.push(`${att.libraryID}-SHRDOWN1.json`);
  });

  it("sends Zotero's WebDAV login in the request URL", async function () {
    await api().shared.listShared();
    assert.isTrue(urls[0].startsWith(ROOT));
  });
});
