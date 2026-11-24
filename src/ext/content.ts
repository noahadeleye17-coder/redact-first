import { clean, countByType } from "../core/pipeline";
import { REMOTE_DEFAULTS, type RemoteSettings } from "../core/remoteConfig.defaults";
import { addReceipt, getSettings, getVault, setVault, type Settings } from "../core/storage";
import { labelFor, type EntityType, type Vault } from "../core/types";
import type { DeepScanRequest, DeepScanResponse, InsertRequest, InsertResponse } from "./messages";

/**
 * Runs on AI chat sites. Two jobs:
 *  1. Paste guard: catch a paste, clean it on this device, then insert the clean version.
 *  2. Put-back: swap placeholders in the AI's reply back to real values, on screen only.
 * No Firebase here. Fixed-pattern rules run inline; names come from the side
 * panel's Gemini Nano when the panel is open.
 */

const DEEP_SCAN_TIMEOUT_MS = 90_000; // CPU-only machines can take ~20s per scan
let pendingScans = 0;
let settings: Settings;
let vault: Vault = {};
let remote: RemoteSettings = REMOTE_DEFAULTS;
let lastEditable: HTMLElement | null = null;

async function load() {
  settings = await getSettings();
  vault = await getVault();
  remote = ((await chrome.storage.local.get("remote")).remote as RemoteSettings) ?? REMOTE_DEFAULTS;
}

function siteGuarded(): boolean {
  const host = location.hostname;
  return settings.guardEnabled && remote.guardSites.some((s) => host === s || host.endsWith("." + s));
}

function editableTarget(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|)$/.test(el.type))) return el;
  const ce = el.closest<HTMLElement>("[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']");
  return ce;
}

function insertText(target: HTMLElement, text: string, range?: Range | null): boolean {
  target.focus();
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, "end");
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
    return true;
  }
  if (range) {
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  // execCommand is old, but it is still the one way to insert into rich editors
  // (ProseMirror, Lexical) so that their own state updates correctly.
  return document.execCommand("insertText", false, text);
}

async function askPanel(text: string): Promise<DeepScanResponse> {
  const timeout = new Promise<DeepScanResponse>((r) => setTimeout(() => r({ ok: false }), DEEP_SCAN_TIMEOUT_MS));
  const ask = chrome.runtime
    .sendMessage({ type: "rf:deep-scan", text } satisfies DeepScanRequest)
    .then((r: DeepScanResponse | undefined) => r ?? { ok: false as const, reason: "No reply from the side panel" })
    .catch(() => ({ ok: false as const, reason: "Side panel is closed" }));
  return Promise.race([ask, timeout]);
}

/** Names already found this session, so they are hidden instantly next time. */
function knownNames(): { type: EntityType; text: string }[] {
  return Object.entries(vault)
    .filter(([tok]) => tok.startsWith("[NAME_"))
    .map(([, value]) => ({ type: "NAME" as EntityType, text: value }));
}

async function onPaste(e: ClipboardEvent) {
  if (!siteGuarded()) return;
  const target = editableTarget(e.target);
  const text = e.clipboardData?.getData("text/plain");
  if (!target || !text || !text.trim()) return;

  // Take over the paste. From here the raw text only lives in this function.
  e.preventDefault();
  e.stopImmediatePropagation();
  const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).cloneRange() : null;

  // Step 1, instant: fixed patterns plus names we already know.
  vault = await getVault();
  const known = knownNames();
  const first = clean(text, { vault, deviceFindings: known.length ? known : undefined });
  vault = first.vault;
  await setVault(vault);
  insertText(target, first.cleaned, range);

  // Step 2, background: ask Gemini Nano (in the open side panel) for names.
  pendingScans++;
  toast(countByType(first), "checking");
  try {
    const panel = await askPanel(text);
    if (panel.ok) {
      vault = await getVault();
      const full = clean(text, { vault, deviceFindings: [...known, ...panel.findings] });
      const added = Object.entries(full.vault).filter(([tok]) => !(tok in vault));
      vault = full.vault;
      await setVault(vault);
      for (const [token, value] of added) replaceInEditor(target, value, token);
      await addReceipt({ at: Date.now(), where: location.hostname, counts: countByType(full), deepScanned: true });
      toast(countByType(full), "done");
    } else {
      await addReceipt({ at: Date.now(), where: location.hostname, counts: countByType(first), deepScanned: false });
      toast(countByType(first), "rules-only", panel.reason);
    }
  } finally {
    pendingScans--;
  }
}

/** Swap a value that is already in the message box for its placeholder. */
function replaceInEditor(target: HTMLElement, value: string, token: string) {
  const wordRe = new RegExp(`(?<![\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const next = target.value.replace(wordRe, token);
    if (next === target.value) return;
    // Use the native setter so React-style apps notice the change.
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, next);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
    return;
  }
  // Rich editors: select each match and type over it, so the editor's own state stays right.
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const hits: Range[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec((n as Text).data)) !== null) {
      const r = new Range();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      hits.push(r);
    }
  }
  // Replace from the end so earlier ranges stay valid.
  target.focus();
  for (const r of hits.reverse()) {
    let ok = false;
    // execCommand keeps rich editors' own state right, but only works while
    // this page has focus. When the user is in the side panel it fails, so
    // fall back to editing the text directly; editors like ProseMirror read
    // DOM changes back into their state.
    if (document.hasFocus()) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      ok = document.execCommand("insertText", false, token);
    }
    if (!ok && r.startContainer.isConnected) {
      const node = r.startContainer as Text;
      node.data = node.data.slice(0, r.startOffset) + token + node.data.slice(r.endOffset);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: token }));
    }
  }
  const sel = getSelection();
  if (document.hasFocus() && sel && target.lastChild) {
    sel.selectAllChildren(target);
    sel.collapseToEnd();
  }
}

/** While names are being checked, hold back Enter and Send so nothing leaks early. */
function holdSend(e: Event) {
  if (!pendingScans) return;
  if (e instanceof KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey || !editableTarget(e.target)) return;
  } else {
    const btn = (e.target as HTMLElement | null)?.closest?.(
      'button[type="submit"], [data-testid*="send" i], button[aria-label*="send" i]',
    );
    if (!btn) return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  toastText("Still checking for names on your device. Send again in a moment.");
}

// ---------- Put-back ----------

const TOKEN = /\[([A-Z_]+)_(\d+)\]/g;
const restoredRanges: Range[] = [];

function inEditor(node: Node): boolean {
  const el = node.parentElement;
  return !!el && (!!el.closest("textarea, input, [contenteditable], script, style, #rf-toast") || el.isContentEditable);
}

/** Edit text nodes in place so the page's own framework keeps working. */
function putBack(root: Node) {
  if (!settings?.putBackEnabled || !Object.keys(vault).length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    TOKEN.lastIndex = 0;
    if (TOKEN.test(t.data) && !inEditor(t)) nodes.push(t);
  }
  for (const node of nodes) {
    let out = "";
    let last = 0;
    const spans: [number, number][] = [];
    node.data.replace(TOKEN, (tok, _t, _n, offset: number) => {
      const real = vault[tok];
      out += node.data.slice(last, offset);
      if (real) {
        spans.push([out.length, out.length + real.length]);
        out += real;
      } else out += tok;
      last = offset + tok.length;
      return tok;
    });
    out += node.data.slice(last);
    if (out === node.data) continue;
    node.data = out;
    for (const [s, e] of spans) {
      const r = new Range();
      r.setStart(node, s);
      r.setEnd(node, e);
      restoredRanges.push(r);
    }
  }
  paintHighlights();
}

/** Underline restored values with the CSS Highlight API (no DOM changes needed). */
function paintHighlights() {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !HighlightCtor) return;
  const live = restoredRanges.filter((r) => r.startContainer.isConnected);
  restoredRanges.length = 0;
  restoredRanges.push(...live);
  css.highlights.set("rf-restored", new HighlightCtor(...live));
}

let pending = new Set<Node>();
let scheduled = false;
const observer = new MutationObserver((records) => {
  for (const r of records) pending.add(r.type === "characterData" ? r.target : r.target);
  if (scheduled) return;
  scheduled = true;
  // Wait for streaming replies to settle a little before touching them.
  setTimeout(() => {
    scheduled = false;
    const batch = pending;
    pending = new Set();
    for (const n of batch) if (n.isConnected) putBack(n);
  }, 400);
});

// ---------- UI ----------

type ToastState = "checking" | "done" | "rules-only";

function toast(counts: Partial<Record<EntityType, number>>, state: ToastState, reason?: string) {
  const items = Object.entries(counts)
    .map(([t, n]) => labelFor(t as EntityType, n as number))
    .join(", ");
  const msg = items ? `Hid ${items}.` : "Nothing personal found yet.";
  const sub =
    state === "checking"
      ? "Now checking for names with Gemini Nano on this device…"
      : state === "done"
        ? "Names checked on this device with Gemini Nano."
        : `Pattern check only, names not checked${reason ? ` (${reason})` : ""}.`;
  showToast(msg, sub, state === "checking" ? 0 : 8000);
}

function toastText(text: string) {
  showToast(text, "", 3000);
}

function showToast(msg: string, sub: string, ms: number) {
  document.getElementById("rf-toast")?.remove();
  const host = document.createElement("div");
  host.id = "rf-toast";
  host.dataset.msg = `${msg} ${sub}`.trim();
  const shadow = host.attachShadow({ mode: "closed" });
  const esc = (x: string) => x.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  shadow.innerHTML = `<style>
    .t{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;background:#14201b;color:#e7eee9;
       font:13px/1.45 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
    b{color:#3ec48d} small{display:block;opacity:.75;margin-top:2px}</style>
    <div class="t" role="status"><b>◐ Redact-first</b> ${esc(msg)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  document.documentElement.appendChild(host);
  if (ms) setTimeout(() => host.remove(), ms);
}

function injectHighlightStyle() {
  const style = document.createElement("style");
  style.textContent = `::highlight(rf-restored){background-color:rgba(62,196,141,.22);text-decoration:underline dotted #0f6b4c}`;
  document.documentElement.appendChild(style);
}

// ---------- Wiring ----------

chrome.runtime.onMessage.addListener((msg: InsertRequest, _s, reply: (r: InsertResponse) => void) => {
  if (msg?.type !== "rf:insert") return false;
  const target = lastEditable && lastEditable.isConnected ? lastEditable : editableTarget(document.activeElement);
  reply({ ok: !!target && insertText(target, msg.text) });
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.vault) {
    vault = (changes.vault.newValue as Vault) ?? {};
    putBack(document.body);
  }
  if (area === "local" && changes.settings) settings = { ...settings, ...(changes.settings.newValue as Settings) };
  if (area === "local" && changes.remote) remote = (changes.remote.newValue as RemoteSettings) ?? REMOTE_DEFAULTS;
});

document.addEventListener("focusin", (e) => {
  const t = editableTarget(e.target);
  if (t) lastEditable = t;
});

load().then(() => {
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("keydown", holdSend, true);
  document.addEventListener("click", holdSend, true);
  injectHighlightStyle();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  putBack(document.body);
});
