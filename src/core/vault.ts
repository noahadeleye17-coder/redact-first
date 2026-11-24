import type { Entity, Vault } from "./types";

const TOKEN_RE = /\[([A-Z_]+)_(\d+)\]/g;

/**
 * Replace each entity with a placeholder. The same value always gets the same
 * placeholder, so "[NAME_1]" still means one person across a whole chat.
 * Pass the existing vault to keep numbering consistent across pastes.
 */
export function redact(text: string, entities: Entity[], vault: Vault = {}): { text: string; vault: Vault } {
  const next: Vault = { ...vault };
  const byValue = new Map<string, string>();
  const counters: Record<string, number> = {};

  for (const [token, value] of Object.entries(next)) {
    byValue.set(norm(value), token);
    const m = /\[([A-Z_]+)_(\d+)\]/.exec(token);
    if (m) counters[m[1]] = Math.max(counters[m[1]] ?? 0, Number(m[2]));
  }

  let out = "";
  let cursor = 0;
  for (const e of [...entities].sort((a, b) => a.start - b.start)) {
    if (e.start < cursor) continue;
    let token = byValue.get(norm(e.value));
    if (!token) {
      counters[e.type] = (counters[e.type] ?? 0) + 1;
      token = `[${e.type}_${counters[e.type]}]`;
      byValue.set(norm(e.value), token);
      next[token] = e.value;
    }
    out += text.slice(cursor, e.start) + token;
    cursor = e.end;
  }
  out += text.slice(cursor);
  return { text: out, vault: next };
}

/** Put real values back. Runs only on the user's device. */
export function restore(text: string, vault: Vault): string {
  return text.replace(TOKEN_RE, (tok) => vault[tok] ?? tok);
}

export function hasTokens(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(text);
}

/** Phone numbers and IDs often differ only by spacing; treat them as the same value. */
function norm(v: string): string {
  let digits = v.replace(/\D/g, "");
  // +234 803 123 4567 and 0803 123 4567 are the same Nigerian number.
  if (digits.length === 13 && digits.startsWith("234")) digits = "0" + digits.slice(3);
  return digits.length >= 7 && digits.length / v.replace(/\s/g, "").length > 0.7 ? digits : v.trim().toLowerCase();
}
