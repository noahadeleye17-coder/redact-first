import type { EntityType } from "../core/types";

/** Content script asks the open side panel to scan pasted text with Gemini Nano. */
export interface DeepScanRequest {
  type: "rf:deep-scan";
  text: string;
}
export type DeepScanResponse =
  | { ok: true; findings: { type: EntityType; text: string }[] }
  | { ok: false; reason?: string };

/** Side panel asks the content script to type cleaned text into the focused box. */
export interface InsertRequest {
  type: "rf:insert";
  text: string;
}
export interface InsertResponse {
  ok: boolean;
}
