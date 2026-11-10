#!/usr/bin/env node
/* global process, Buffer, console, setTimeout */
/**
 * Evaluate JavaScript in the running *dev* Zotero (the instance `npm start`
 * launches) over the Firefox Remote Debugging Protocol.
 *
 *   node scripts/zotero-eval.mjs script.js        # or: echo 'code' | node ... -
 *
 * The script runs in Zotero's main chrome window as the body of an async
 * function; `return` a JSON-serialisable value to print it. The debugger port
 * is read from the dev instance's -start-debugger-server argument (only
 * processes whose profile lives under this repo are considered), or from
 * ZOTERO_RDP_PORT.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findPort() {
  if (process.env.ZOTERO_RDP_PORT) return Number(process.env.ZOTERO_RDP_PORT);
  const ps = execSync("ps -eo args", { encoding: "utf8" });
  for (const line of ps.split("\n")) {
    if (!line.includes("zotero-bin") || !line.includes(`-profile ${repo}/`))
      continue;
    const m = line.match(/-start-debugger-server (\d+)/);
    if (m) return Number(m[1]);
  }
  throw new Error("No dev Zotero found (run `npm start` first)");
}

class Rdp {
  constructor(port) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.listeners = [];
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.onData(d));
    this.ready = this.next(() => true);
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(
        this.buf.subarray(colon + 1, colon + 1 + len).toString(),
      );
      this.buf = this.buf.subarray(colon + 1 + len);
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
    }
  }
  next(match) {
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }
  async request(to, type, extra = {}) {
    const reply = this.next(
      (m) => m.from === to && m.type !== "evaluationResult",
    );
    const body = JSON.stringify({ to, type, ...extra });
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    const msg = await reply;
    if (msg.error) throw new Error(`${msg.error}: ${msg.message}`);
    return msg;
  }
  async evaluate(consoleActor, text) {
    const result = this.next(
      (m) => m.from === consoleActor && m.type === "evaluationResult",
    );
    await this.request(consoleActor, "evaluateJSAsync", { text });
    return result;
  }
  async gripToString(grip) {
    if (grip && typeof grip === "object" && grip.type === "longString") {
      const r = await this.request(grip.actor, "substring", {
        start: 0,
        end: grip.length,
      });
      return r.substring;
    }
    if (grip && typeof grip === "object" && grip.type === "undefined")
      return undefined;
    return grip;
  }
}

const arg = process.argv[2];
const code =
  !arg || arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");

const rdp = new Rdp(findPort());
await rdp.ready;
const { processDescriptor } = await rdp.request("root", "getProcess", {
  id: 0,
});
const target = await rdp.request(processDescriptor.actor, "getTarget");
const consoleActor = (target.process ?? target.frame ?? target).consoleActor;

// Run as an async function in the main window and stash the outcome, then
// poll for it: evaluateJSAsync does not await promises.
const key = `__zoteroEval${Date.now()}`;
const wrapped = `(() => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const run = new win.Function("return (async () => {" + ${JSON.stringify(code)} + "\\n})()");
  globalThis[${JSON.stringify(key)}] = { done: false };
  run.call(win).then(
    (v) => globalThis[${JSON.stringify(key)}] = { done: true, value: JSON.stringify(v, null, 2) },
    (e) => globalThis[${JSON.stringify(key)}] = { done: true, error: String(e) + "\\n" + (e && e.stack || "") },
  );
})()`;
const first = await rdp.evaluate(consoleActor, wrapped);
if (first.exceptionMessage) {
  console.error(first.exceptionMessage);
  process.exit(1);
}

for (;;) {
  const r = await rdp.evaluate(
    consoleActor,
    `JSON.stringify(globalThis[${JSON.stringify(key)}])`,
  );
  const state = JSON.parse((await rdp.gripToString(r.result)) ?? "{}");
  if (state.done) {
    await rdp.evaluate(
      consoleActor,
      `delete globalThis[${JSON.stringify(key)}]`,
    );
    rdp.sock.end();
    if (state.error) {
      console.error(state.error);
      process.exit(1);
    }
    if (state.value !== undefined) console.log(state.value);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 200));
}
