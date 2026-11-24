import { detectWithRules, expandNameParts, locate, resolveOverlaps } from "./detectors";
import { redact } from "./vault";
import type { CleanResult, EntityType, Vault } from "./types";

export interface CleanOptions {
  vault?: Vault;
  /** Extra findings from the on-device model (names, addresses). */
  deviceFindings?: { type: EntityType; text: string }[];
}

/**
 * The one place text gets cleaned. Rules always run; on-device findings are
 * merged in when available. Pure and synchronous, so the content script can
 * use it on paste without loading Firebase.
 */
export function clean(text: string, opts: CleanOptions = {}): CleanResult {
  const ruleHits = detectWithRules(text);
  // Names found by rules (after a title) also count for name-part matching.
  const ruleNames = ruleHits.filter((e) => e.type === "NAME").map((e) => ({ type: e.type, text: e.value }));
  const named = expandNameParts([...(opts.deviceFindings ?? []), ...ruleNames]);
  const deviceHits = named.length ? locate(text, named) : [];
  const entities = resolveOverlaps([...ruleHits, ...deviceHits]);
  const { text: cleaned, vault } = redact(text, entities, opts.vault);
  return { original: text, cleaned, entities, vault, deepScanned: !!opts.deviceFindings };
}

export function countByType(result: Pick<CleanResult, "entities">): Partial<Record<EntityType, number>> {
  const counts: Partial<Record<EntityType, number>> = {};
  for (const e of result.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
