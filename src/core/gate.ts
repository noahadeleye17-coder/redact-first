import { detectWithRules } from "./detectors";

export class PrivacyGateError extends Error {
  constructor(public readonly leaks: string[]) {
    super(`Blocked: text still contains ${leaks.join(", ")}. Clean it first.`);
    this.name = "PrivacyGateError";
  }
}

/**
 * Last check before any text may leave the device. Every cloud-capable call
 * goes through this, so a bug elsewhere cannot leak a phone number or BVN.
 */
export function assertNoRulePii(text: string): void {
  const leaks = detectWithRules(text);
  if (leaks.length) throw new PrivacyGateError([...new Set(leaks.map((e) => e.type))]);
}
