import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getSecret, setSecret, SecretName } from "../utils/secrets";
import {
  PINNED,
  SECTIONS,
  SectionId,
  hiddenSections,
  saveSectionOrder,
  sectionOrder,
} from "./sections";
import { log } from "../utils/log";
import {
  accountInfo,
  chatComplete,
  decide,
  decisionSettings,
  llmSettings,
} from "./clients";
import { ModelRow, Totals, reset as resetUsage, summary } from "./usage";
import { backgroundStatus } from "./concepts/background";
import {
  LlmProvider,
  PRESETS,
  PROVIDERS,
  currentProvider,
  inheritedKey,
  modelFor,
  secretFor,
} from "./llmProviders";

const ref = config.addonRef;

export async function registerPrefsScripts(win: Window) {
  const doc = win.document;
  renderSectionOrder(doc);
  bindNumber(doc, `${ref}-related-limit`, "card.relatedLimit", 0, 20);
  bindNumber(doc, `${ref}-decision-threshold`, "decision.threshold", 0, 100);
  const refreshLlm = bindLlmProvider(doc);
  // OpenRouter may use the decision key, so its key field follows it.
  bindSecret(doc, `${ref}-decision-key`, "decision", refreshLlm);
  bindUsage(win);
  bindIndexStatus(win);
  doc
    .getElementById(`${ref}-decision-test`)
    ?.addEventListener("command", () => testDecision(doc));
  doc
    .getElementById(`${ref}-llm-test`)
    ?.addEventListener("command", () => testLlm(doc));
}

// --- section order ---------------------------------------------------------

function renderSectionOrder(doc: Document) {
  const box = doc.getElementById(`${ref}-section-order`);
  if (!box) return;
  const order = sectionOrder();
  const hidden = hiddenSections();
  box.replaceChildren();

  const commit = () => {
    saveSectionOrder(order, hidden);
    renderSectionOrder(doc);
  };
  const movable = (i: number) =>
    i >= 0 && i < order.length && !PINNED.has(order[i]);
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (!movable(i) || !movable(j)) return;
    [order[i], order[j]] = [order[j], order[i]];
    commit();
  };

  order.forEach((id: SectionId, i) => {
    const row = doc.createElement("div");
    row.className = `${ref}-order-row`;
    if (hidden.has(id)) row.classList.add("hidden-section");

    const index = doc.createElement("span");
    index.className = `${ref}-order-index`;
    index.textContent = `${i + 1}.`;

    const check = doc.createElement("input");
    check.type = "checkbox";
    check.checked = !hidden.has(id);
    check.title = "Show this section";
    check.addEventListener("change", () => {
      if (check.checked) hidden.delete(id);
      else hidden.add(id);
      commit();
    });

    const label = doc.createElement("span");
    label.className = `${ref}-order-label`;
    label.textContent = SECTIONS[id];

    const up = doc.createElement("button");
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = !movable(i) || !movable(i - 1);
    up.addEventListener("click", () => move(i, -1));

    const down = doc.createElement("button");
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = !movable(i) || !movable(i + 1);
    down.addEventListener("click", () => move(i, 1));

    row.append(index, check, label, up, down);
    box.append(row);
  });
}

// --- inputs not bound via `preference=` ------------------------------------

function bindNumber(
  doc: Document,
  id: string,
  pref: "card.relatedLimit" | "decision.threshold",
  min: number,
  max: number,
) {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.value = String(getPref(pref));
  input.addEventListener("change", () => {
    const n = Math.round(Number(input.value));
    if (Number.isFinite(n)) setPref(pref, Math.min(max, Math.max(min, n)));
    input.value = String(getPref(pref));
  });
}

function bindSecret(
  doc: Document,
  id: string,
  name: SecretName,
  onSaved?: () => void,
) {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.value = getSecret(name);
  input.addEventListener("change", () =>
    setSecret(name, input.value.trim())
      .then(() => onSaved?.())
      .catch((e) => log("setSecret failed", e)),
  );
}

// --- LLM provider ------------------------------------------------------------

/**
 * Provider dropdown: presets show a model list, "custom" shows the
 * free-form format/endpoint/model fields. The key field holds the selected
 * provider's own key; when it is empty and the provider inherits the
 * decision key (OpenRouter), the placeholder says so. Returns a function
 * that redraws the section.
 */
function bindLlmProvider(doc: Document): () => void {
  const providerList = doc.getElementById(`${ref}-llm-provider`) as any;
  const modelList = doc.getElementById(`${ref}-llm-preset-model`) as any;
  const keyInput = doc.getElementById(`${ref}-llm-key`) as
    HTMLInputElement | undefined;
  if (!providerList || !modelList || !keyInput) return () => {};

  const render = () => {
    const provider = currentProvider();
    providerList.value = provider;
    const custom = provider === "custom";
    for (const el of doc.querySelectorAll("[data-llm]"))
      (el as HTMLElement).hidden =
        el.getAttribute("data-llm") !== (custom ? "custom" : "preset");
    if (!custom) {
      const popup = modelList.menupopup ?? modelList.querySelector("menupopup");
      popup.replaceChildren(
        ...PRESETS[provider].models.map((m) => {
          const item = (doc as any).createXULElement("menuitem");
          item.setAttribute("value", m.id);
          item.setAttribute("label", `${m.label} (${m.id})`);
          return item;
        }),
      );
      modelList.value = modelFor(provider);
    }
    keyInput.value = getSecret(secretFor(provider));
    keyInput.placeholder = inheritedKey(provider)
      ? "Using the decision model's key (enter one to override)"
      : "";
    status(doc, "llm", true, "");
  };

  providerList.addEventListener("command", () => {
    const p = providerList.value as LlmProvider;
    if (PROVIDERS.includes(p)) setPref("llm.provider", p);
    render();
  });
  modelList.addEventListener("command", () => {
    const p = currentProvider();
    if (p !== "custom") setPref(PRESETS[p].modelPref, modelList.value);
  });
  keyInput.addEventListener("change", () =>
    setSecret(secretFor(currentProvider()), keyInput.value.trim())
      .then(render)
      .catch((e) => log("setSecret failed", e)),
  );
  render();
  return render;
}

// --- background analysis -------------------------------------------------------

export function indexStatusText(
  s: ReturnType<typeof backgroundStatus>,
): string {
  const progress = s.total ? `${s.analysed} of ${s.total} papers analysed` : "";
  const noText = s.noText ? `, ${s.noText} without text yet` : "";
  switch (s.state) {
    case "off":
      return "";
    case "waiting":
      return s.total
        ? `${progress}${noText}. Next pass soon.`
        : "Starts shortly after Zotero has started.";
    case "running":
      return `Analysing: ${progress}${noText}…`;
    case "paused":
      return `Paused (${s.error}). ${progress}. Retries in 30 minutes.`;
    case "done":
      return `${progress}${noText}.`;
  }
}

function bindIndexStatus(win: Window) {
  const el = win.document.getElementById(`${ref}-index-status`);
  if (!el) return;
  const update = () => (el.textContent = indexStatusText(backgroundStatus()));
  update();
  const t = win.setInterval(update, 2000);
  win.addEventListener("unload", () => win.clearInterval(t));
}

// --- spending ----------------------------------------------------------------

const HTML = "http://www.w3.org/1999/xhtml";

function el(doc: Document, tag: string, text?: string, cls?: string) {
  const e = doc.createElementNS(HTML, tag) as HTMLElement;
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function formatCost(
  t: Pick<Totals, "cost" | "estimated" | "unpriced" | "requests">,
) {
  if (!t.requests) return "–";
  if (t.unpriced === t.requests) return "unknown";
  const n = t.cost;
  // Two significant digits below a cent: $0.000012, $0.0042
  const digits = n >= 0.01 ? 2 : Math.min(8, Math.ceil(-Math.log10(n)) + 1);
  const money = n === 0 ? "$0" : `$${n.toFixed(digits)}`;
  const approx = t.estimated ? "≈ " : "";
  const unknown = t.unpriced ? ` + ${t.unpriced} unpriced` : "";
  return approx + money + unknown;
}

const tokens = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : String(n);

function table(doc: Document, head: string[], rows: string[][]) {
  const t = el(doc, "table", undefined, `${ref}-usage-table`);
  const tr = el(doc, "tr");
  for (const h of head) tr.append(el(doc, "th", h));
  t.append(tr);
  for (const r of rows) {
    const row = el(doc, "tr");
    r.forEach((c, i) =>
      row.append(
        el(doc, "td", c, i === r.length - 1 ? `${ref}-usage-cost` : undefined),
      ),
    );
    t.append(row);
  }
  return t;
}

function modelLabel(r: ModelRow) {
  const what = r.service === "decision" ? "decision" : "LLM";
  return `${r.model || "(no model)"} · ${what}, ${r.host || "?"}`;
}

async function renderUsage(doc: Document) {
  const box = doc.getElementById(`${ref}-usage`);
  if (!box) return;
  const s = await summary();
  const row = (label: string, t: Totals) => [
    label,
    String(t.requests),
    tokens(t.inputTokens),
    tokens(t.outputTokens),
    formatCost(t),
  ];
  const parts: HTMLElement[] = [
    table(
      doc,
      ["", "Requests", "Tokens in", "Tokens out", "Cost"],
      [
        row("Today", s.today),
        row("This month", s.month),
        row(s.since ? `Since ${s.since}` : "All time", s.all),
      ],
    ),
  ];
  if (s.byModel.length) {
    parts.push(el(doc, "div", "This month by model", `${ref}-usage-sub`));
    parts.push(
      table(
        doc,
        ["Model", "Requests", "Cost"],
        s.byModel.map((r) => [
          modelLabel(r),
          String(r.requests),
          formatCost(r),
        ]),
      ),
    );
  }
  box.replaceChildren(...parts);
}

function bindUsage(win: Window) {
  const doc = win.document;
  renderUsage(doc).catch((e) => log("usage view failed", e));
  doc
    .getElementById(`${ref}-usage-refresh`)
    ?.addEventListener("command", () => renderUsage(doc));
  doc
    .getElementById(`${ref}-usage-reset`)
    ?.addEventListener("command", async () => {
      const ok = Services.prompt.confirm(
        win as any,
        "Reset spending",
        "Clear all recorded requests and costs? Your provider accounts are not affected.",
      );
      if (!ok) return;
      await resetUsage();
      await renderUsage(doc);
    });
  doc
    .getElementById(`${ref}-usage-accounts`)
    ?.addEventListener("command", async () => {
      const list = doc.getElementById(`${ref}-usage-account-list`);
      if (!list) return;
      list.replaceChildren(el(doc, "div", "Asking the providers…"));
      const infos = await accountInfo().catch((e) => [
        { name: "Error", ok: false, text: String(e?.message ?? e) },
      ]);
      list.replaceChildren(
        ...(infos.length
          ? infos.map((i) =>
              el(
                doc,
                "div",
                `${i.name}: ${i.text}`,
                i.ok ? `${ref}-ok` : `${ref}-err`,
              ),
            )
          : [el(doc, "div", "No OpenRouter or DeepSeek key configured.")]),
      );
    });
}

// --- connection tests ------------------------------------------------------

function status(doc: Document, which: string, ok: boolean, text: string) {
  const el = doc.getElementById(`${ref}-${which}-status`);
  if (!el) return;
  el.textContent = text;
  el.className = ok ? `${ref}-ok` : `${ref}-err`;
}

async function testDecision(doc: Document) {
  status(doc, "decision", true, "Testing…");
  try {
    const a = await decide(
      "Model-based reinforcement learning (MBRL) learns a dynamics model of the environment and uses it for planning.",
      {
        link: {
          type: "noul",
          instructions:
            "Is 'model-based reinforcement learning' a technical concept defined or used in the text?",
        },
      },
      decisionSettings(),
    );
    const ans = a.link;
    const p = ans.type === "noul" ? ans.noul : NaN;
    status(doc, "decision", true, `OK, answered yes with p=${p.toFixed(2)}`);
  } catch (e: any) {
    status(doc, "decision", false, String(e?.message ?? e));
  }
}

async function testLlm(doc: Document) {
  status(doc, "llm", true, "Testing…");
  try {
    const text = await chatComplete(
      llmSettings(),
      "Reply with exactly: ok",
      "ping",
      10,
    );
    status(doc, "llm", true, `OK, model replied "${text.slice(0, 40)}"`);
  } catch (e: any) {
    status(doc, "llm", false, String(e?.message ?? e));
  }
}
