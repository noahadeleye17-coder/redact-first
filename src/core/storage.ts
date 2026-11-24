import type { EntityType, Vault } from "./types";

/**
 * Small storage layer. In the extension the vault lives in
 * chrome.storage.session (memory only, cleared when Chrome closes) so the
 * content script and side panel share it. Receipts and settings go in
 * chrome.storage.local. In the web playground everything stays in memory
 * or localStorage on this device.
 */

export interface Receipt {
  at: number;
  where: string;
  counts: Partial<Record<EntityType, number>>;
  deepScanned: boolean;
  aiSource?: "on_device" | "in_cloud";
}

export interface Settings {
  guardEnabled: boolean;
  putBackEnabled: boolean;
  strictMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = { guardEnabled: true, putBackEnabled: true, strictMode: false };

const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;
let memoryVault: Vault = {};

export async function getVault(): Promise<Vault> {
  if (hasChrome) return ((await chrome.storage.session.get("vault")).vault as Vault) ?? {};
  return memoryVault;
}

export async function setVault(vault: Vault): Promise<void> {
  if (hasChrome) await chrome.storage.session.set({ vault });
  else memoryVault = vault;
}

export async function getSettings(): Promise<Settings> {
  if (hasChrome) return { ...DEFAULT_SETTINGS, ...((await chrome.storage.local.get("settings")).settings ?? {}) };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rf-settings") ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  if (hasChrome) await chrome.storage.local.set({ settings: next });
  else
    try {
      localStorage.setItem("rf-settings", JSON.stringify(next));
    } catch {
      /* storage blocked; keep in memory for this visit */
    }
  return next;
}

const MAX_RECEIPTS = 50;

/** Receipts hold counts only. The masked values themselves are never written here. */
export async function addReceipt(r: Receipt): Promise<void> {
  const list = [r, ...(await getReceipts())].slice(0, MAX_RECEIPTS);
  if (hasChrome) await chrome.storage.local.set({ receipts: list });
  else
    try {
      localStorage.setItem("rf-receipts", JSON.stringify(list));
    } catch {
      /* ignore */
    }
}

export async function getReceipts(): Promise<Receipt[]> {
  if (hasChrome) return ((await chrome.storage.local.get("receipts")).receipts as Receipt[]) ?? [];
  try {
    return JSON.parse(localStorage.getItem("rf-receipts") ?? "[]");
  } catch {
    return [];
  }
}

export async function clearReceipts(): Promise<void> {
  if (hasChrome) await chrome.storage.local.remove("receipts");
  else
    try {
      localStorage.removeItem("rf-receipts");
    } catch {
      /* ignore */
    }
}
