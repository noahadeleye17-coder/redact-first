import "./style.css";
import { assist, deviceModelStatus, findWithDeviceModel, prepareDeviceModel, type AssistTask, type ModelStatus, type RunSource } from "../core/ai";
import { isConfigured } from "../core/firebase";
import { PrivacyGateError } from "../core/gate";
import { clean, countByType } from "../core/pipeline";
import { loadRemoteSettings } from "../core/remoteConfig";
import { addReceipt, clearReceipts, getReceipts, getSettings, getVault, setSettings, setVault, type Settings } from "../core/storage";
import { labelFor, type CleanResult, type EntityType } from "../core/types";
import { restore } from "../core/vault";
import { downloadText, readFileText, redactedName } from "../core/files";

export interface AppEnv {
  /** "extension" shows paste-guard settings and the Insert button. */
  kind: "extension" | "web";
  insertIntoPage?: (text: string) => Promise<boolean>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TOKEN_HTML = /\[([A-Z_]+?)_(\d+)\]/g;

function highlight(text: string): string {
  return esc(text).replace(TOKEN_HTML, (tok, type) => `<mark class="tok tok-${type}">${tok}</mark>`);
}

function countsLine(counts: Partial<Record<EntityType, number>>): string {
  const parts = Object.entries(counts).map(([t, n]) => labelFor(t as EntityType, n as number));
  return parts.length ? parts.join(", ") : "nothing personal found";
}

export async function mountApp(root: HTMLElement, env: AppEnv): Promise<void> {
  let settings: Settings = await getSettings();
  let status: ModelStatus = "unsupported";
  let result: CleanResult | undefined;
  let fileName: string | undefined;
  const manual: { type: EntityType; text: string }[] = [];

  root.innerHTML = `
  <header class="top">
    <div class="brand"><span class="logo">◐</span> Redact-first</div>
    <div id="model" class="chip">Checking Gemini Nano…</div>
  </header>
  <p class="lede">Clean personal data out of your text <b>on this device</b> before any AI sees it.</p>
  <p id="notice" class="notice" hidden></p>
  ${isConfigured ? "" : `<p class="warn">Firebase isn't configured yet, so only the fixed-pattern checks will run. See the README.</p>`}

  <section class="card">
    <label class="label" for="input">1. Paste text or drop a file</label>
    <div id="drop" class="drop">
      <textarea id="input" rows="7" placeholder="e.g. Hi, I'm Tunde Bakare. My BVN is 22123456789 and you can reach me on 0803 123 4567…"></textarea>
      <div class="drop-hint">or drop a PDF / .txt here · <label class="link">browse<input id="file" type="file" accept=".pdf,.txt,.md,.csv,.json,.eml" hidden></label></div>
    </div>
    <div class="row">
      <button id="clean" class="primary">Clean on this device</button>
      <span id="cleanNote" class="muted"></span>
    </div>
  </section>

  <section id="out" class="card" hidden>
    <div class="label">2. What leaves your device</div>
    <div id="cleaned" class="output"></div>
    <div id="summary" class="muted small"></div>
    <div class="row wrap">
      <button id="copy">Copy cleaned text</button>
      ${env.kind === "extension" ? `<button id="insert">Insert into page</button>` : ""}
      <button id="download" hidden>Download redacted file</button>
    </div>
    <details class="missed">
      <summary>We missed something?</summary>
      <div class="row"><input id="extra" placeholder="Type the exact text to hide, e.g. Mama Ngozi"><button id="addExtra">Hide it</button></div>
    </details>
  </section>

  <section id="assistCard" class="card" hidden>
    <div class="label">3. Get AI help with the cleaned text</div>
    <div class="row wrap">
      <select id="task">
        <option value="summarize">Summarize</option>
        <option value="rewrite">Rewrite professionally</option>
        <option value="reply">Draft a reply</option>
        <option value="explain">Explain in plain English</option>
        <option value="custom">Something else…</option>
      </select>
      <input id="instruction" placeholder="What should it do?" hidden>
      <button id="run" class="primary">Run</button>
    </div>
    <div id="where" class="where" hidden></div>
    <div id="answer" class="output" hidden></div>
    <label class="toggle small" id="revealWrap" hidden><input id="reveal" type="checkbox"> Show my real details in the answer (only on this screen)</label>
  </section>

  <section class="card">
    <div class="label">Settings</div>
    <label class="toggle"><input id="strict" type="checkbox"> <span><b>Strict mode</b>: never use the cloud, even for cleaned text</span></label>
    ${
      env.kind === "extension"
        ? `<label class="toggle"><input id="guard" type="checkbox"> <span><b>Paste guard</b> on AI chat sites</span></label>
           <label class="toggle"><input id="putback" type="checkbox"> <span><b>Put-back</b>: show real details in AI replies, on your screen only</span></label>`
        : ""
    }
  </section>

  <section class="card">
    <div class="row between"><div class="label">Privacy receipts</div><button id="clearReceipts" class="ghost small">Clear</button></div>
    <p class="muted small">Counts only. The real values are never stored here.</p>
    <ul id="receipts" class="receipts"></ul>
  </section>

  <section class="card">
    <div class="row between"><div class="label">Hidden details (this session)</div><button id="forget" class="ghost small">Forget all</button></div>
    <p class="muted small">Kept in memory on this device so placeholders can be swapped back. Cleared when you close the browser.</p>
    <ul id="vault" class="vault"></ul>
  </section>
  <footer class="muted small">Detection runs on Gemini Nano in Chrome. The cloud model only ever gets cleaned text, and a final check blocks anything that still looks like a phone number, ID or account number.</footer>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  // ---------- Gemini Nano status ----------
  async function refreshStatus(progress?: number) {
    status = await deviceModelStatus();
    const chip = $("model");
    const map: Record<ModelStatus, [string, string]> = {
      available: ["ok", "Gemini Nano ready"],
      downloadable: ["idle", "Gemini Nano: click Clean to download"],
      downloading: ["idle", `Downloading Gemini Nano${progress ? ` ${Math.round(progress * 100)}%` : "…"}`],
      unavailable: ["bad", "Gemini Nano not available here"],
      unsupported: ["bad", "This browser has no on-device model"],
    };
    const [cls, label] = map[status];
    chip.className = `chip ${cls}`;
    chip.textContent = label;
  }
  await refreshStatus();

  // ---------- Settings ----------
  const strict = $<HTMLInputElement>("strict");
  strict.checked = settings.strictMode;
  strict.onchange = async () => (settings = await setSettings({ strictMode: strict.checked }));
  if (env.kind === "extension") {
    const guard = $<HTMLInputElement>("guard");
    const putback = $<HTMLInputElement>("putback");
    guard.checked = settings.guardEnabled;
    putback.checked = settings.putBackEnabled;
    guard.onchange = async () => (settings = await setSettings({ guardEnabled: guard.checked }));
    putback.onchange = async () => (settings = await setSettings({ putBackEnabled: putback.checked }));
  }

  if (isConfigured) {
    loadRemoteSettings().then(async (remote) => {
      if (remote.notice) {
        $("notice").textContent = remote.notice;
        $("notice").hidden = false;
      }
      if (typeof chrome !== "undefined" && chrome.storage) await chrome.storage.local.set({ remote });
      if (remote.strictByDefault && !settings.strictMode) {
        settings = await setSettings({ strictMode: true });
        strict.checked = true;
      }
    });
  }

  // ---------- Clean ----------
  async function runClean(text: string, where: string) {
    const btn = $<HTMLButtonElement>("clean");
    const note = $("cleanNote");
    btn.disabled = true;
    note.textContent = "Checking…";
    let findings: { type: EntityType; text: string }[] | undefined;
    try {
      if (isConfigured && status !== "unsupported" && status !== "unavailable") {
        note.textContent = "Scanning for names and addresses on this device…";
        await prepareDeviceModel((p) => refreshStatus(p));
        findings = await findWithDeviceModel(text);
      }
    } catch (err) {
      console.warn("On-device scan skipped:", err);
      findings = undefined;
    } finally {
      await refreshStatus();
    }
    const deviceFindings = findings ? [...findings, ...manual] : manual.length ? [...manual] : undefined;
    result = clean(text, { vault: await getVault(), deviceFindings });
    if (!findings) result.deepScanned = false;
    await setVault(result.vault);
    await addReceipt({ at: Date.now(), where, counts: countByType(result), deepScanned: result.deepScanned });
    btn.disabled = false;
    note.textContent = "";
    render();
  }

  function render() {
    if (!result) return;
    $("out").hidden = false;
    $("assistCard").hidden = false;
    $("cleaned").innerHTML = highlight(result.cleaned);
    const warn = result.deepScanned
      ? ""
      : ` <span class="warn-inline">Names were not checked by Gemini Nano, only fixed patterns. Read it over before you send.</span>`;
    $("summary").innerHTML = `Hid ${esc(countsLine(countByType(result)))}.${warn}`;
    $("download").hidden = !fileName;
    renderLists();
  }

  $("clean").onclick = () => {
    const text = $<HTMLTextAreaElement>("input").value;
    if (!text.trim()) return;
    fileName = undefined;
    runClean(text, env.kind === "web" ? "Playground" : "Side panel");
  };

  // ---------- Files ----------
  async function handleFile(file: File) {
    const note = $("cleanNote");
    try {
      note.textContent = `Reading ${file.name} on this device…`;
      const text = await readFileText(file);
      $<HTMLTextAreaElement>("input").value = text;
      await runClean(text, `File: ${file.name}`);
      fileName = file.name;
      render();
    } catch (err) {
      note.textContent = (err as Error).message;
    }
  }
  $<HTMLInputElement>("file").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handleFile(f);
  };
  const drop = $("drop");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  };
  $("download").onclick = () => result && fileName && downloadText(redactedName(fileName), result.cleaned);

  // ---------- Output actions ----------
  $("copy").onclick = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.cleaned);
    flash($("copy"), "Copied");
  };
  if (env.kind === "extension") {
    $("insert").onclick = async () => {
      if (!result || !env.insertIntoPage) return;
      const ok = await env.insertIntoPage(result.cleaned);
      flash($("insert"), ok ? "Inserted" : "Click into a chat box first");
    };
  }
  $("addExtra").onclick = () => {
    const v = $<HTMLInputElement>("extra").value.trim();
    if (!v || !result) return;
    manual.push({ type: "NAME", text: v });
    $<HTMLInputElement>("extra").value = "";
    const wasDeepScanned = result.deepScanned;
    result = clean(result.original, {
      vault: result.vault,
      deviceFindings: [...result.entities.filter((e) => e.finder === "on_device").map((e) => ({ type: e.type, text: e.value })), ...manual],
    });
    result.deepScanned = wasDeepScanned; // a manual addition is not a model scan
    setVault(result.vault);
    render();
  };

  // ---------- Assist ----------
  const task = $<HTMLSelectElement>("task");
  task.onchange = () => ($("instruction").hidden = task.value !== "custom");
  let lastAnswer = "";
  const showAnswer = () => {
    if (!result) return;
    const reveal = $<HTMLInputElement>("reveal").checked;
    $("answer").innerHTML = reveal ? esc(restore(lastAnswer, result.vault)) : highlight(lastAnswer);
  };
  $<HTMLInputElement>("reveal").onchange = showAnswer;

  $("run").onclick = async () => {
    if (!result) return;
    if (!isConfigured) return setWhere("bad", "Firebase isn't configured, so AI help is off.");
    const btn = $<HTMLButtonElement>("run");
    btn.disabled = true;
    $("answer").hidden = false;
    $("answer").textContent = "Thinking…";
    setWhere("idle", settings.strictMode ? "Running on your device (strict mode)…" : "Running…");
    try {
      const out = await assist(result.cleaned, task.value as AssistTask, {
        strict: settings.strictMode,
        instruction: $<HTMLInputElement>("instruction").value,
        onChunk: (t) => {
          lastAnswer = t;
          showAnswer();
        },
      });
      lastAnswer = out.text;
      showAnswer();
      $("revealWrap").hidden = false;
      setSource(out.source);
      await addReceipt({ at: Date.now(), where: `AI: ${task.selectedOptions[0].text}`, counts: {}, deepScanned: result.deepScanned, aiSource: out.source });
      renderLists();
    } catch (err) {
      $("answer").textContent = "";
      $("answer").hidden = true;
      if (err instanceof PrivacyGateError) setWhere("bad", err.message);
      else if (settings.strictMode) setWhere("bad", "Strict mode is on and Gemini Nano isn't ready on this device, so nothing was sent.");
      else setWhere("bad", `Couldn't get an answer: ${(err as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  };

  function setSource(src: RunSource) {
    if (src === "on_device") setWhere("ok", "● Ran on your device. Nothing left this computer.");
    else setWhere("cloud", "● Ran in the cloud. It only saw the cleaned text above.");
  }
  function setWhere(cls: string, text: string) {
    const w = $("where");
    w.hidden = false;
    w.className = `where ${cls}`;
    w.textContent = text;
  }

  // ---------- Receipts & vault ----------
  async function renderLists() {
    const receipts = await getReceipts();
    $("receipts").innerHTML =
      receipts
        .slice(0, 12)
        .map((r) => {
          const time = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const what = r.aiSource
            ? r.aiSource === "on_device"
              ? "answered on-device"
              : "answered in cloud (cleaned text only)"
            : `hid ${countsLine(r.counts)}${r.deepScanned ? "" : " · rules only"}`;
          return `<li><span class="muted">${time}</span> ${esc(r.where)}: ${esc(what)}</li>`;
        })
        .join("") || `<li class="muted">Nothing yet.</li>`;

    const vault = await getVault();
    $("vault").innerHTML =
      Object.entries(vault)
        .map(([tok, val]) => `<li><mark class="tok">${esc(tok)}</mark><span class="secret">${esc(val)}</span></li>`)
        .join("") || `<li class="muted">Empty.</li>`;
  }
  $("clearReceipts").onclick = async () => {
    await clearReceipts();
    renderLists();
  };
  $("forget").onclick = async () => {
    await setVault({});
    if (result) result.vault = {};
    $("revealWrap").hidden = true;
    renderLists();
  };

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((_c, area) => (area === "local" || area === "session") && renderLists());
  }
  renderLists();
}

function flash(el: HTMLElement, text: string) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 1500);
}
