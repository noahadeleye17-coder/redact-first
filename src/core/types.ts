export type EntityType =
  | "NAME"
  | "EMAIL"
  | "PHONE"
  | "BVN"
  | "NIN"
  | "ID_NUMBER"
  | "ACCOUNT"
  | "CARD"
  | "ADDRESS"
  | "DOB";

const LABELS: Record<EntityType, [string, string]> = {
  NAME: ["name", "names"],
  EMAIL: ["email", "emails"],
  PHONE: ["phone number", "phone numbers"],
  BVN: ["BVN", "BVNs"],
  NIN: ["NIN", "NINs"],
  ID_NUMBER: ["ID number", "ID numbers"],
  ACCOUNT: ["bank account number", "bank account numbers"],
  CARD: ["card number", "card numbers"],
  ADDRESS: ["address", "addresses"],
  DOB: ["date of birth", "dates of birth"],
};

export function labelFor(type: EntityType, n: number): string {
  return `${n} ${LABELS[type][n === 1 ? 0 : 1]}`;
}

/** Where a finding came from: fixed pattern rules, or the on-device model. */
export type Finder = "rules" | "on_device";

export interface Entity {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  finder: Finder;
}

/** token -> original value, e.g. "[PHONE_1]" -> "08031234567" */
export type Vault = Record<string, string>;

export interface CleanResult {
  original: string;
  cleaned: string;
  entities: Entity[];
  vault: Vault;
  /** true when the on-device model also scanned the text (names, addresses). */
  deepScanned: boolean;
}
