import { deviceModelStatus, findWithDeviceModel } from "../core/ai";
import { isConfigured } from "../core/firebase";
import { mountApp } from "../ui/app";
import type { DeepScanRequest, DeepScanResponse, InsertRequest, InsertResponse } from "./messages";

async function insertIntoPage(text: string): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, { type: "rf:insert", text } satisfies InsertRequest)) as InsertResponse;
    return !!res?.ok;
  } catch {
    return false; // no content script on this page
  }
}

/**
 * While the panel is open it is the extension's on-device brain: the paste
 * guard sends pasted text here, Gemini Nano finds names and addresses, and
 * only the findings go back. The text never leaves the machine.
 */
chrome.runtime.onMessage.addListener((msg: DeepScanRequest, _sender, reply: (r: DeepScanResponse) => void) => {
  if (msg?.type !== "rf:deep-scan") return false;
  (async () => {
    try {
      if (!isConfigured) return reply({ ok: false, reason: "Firebase is not configured in this build" });
      const status = await deviceModelStatus();
      if (status !== "available") return reply({ ok: false, reason: `Gemini Nano status is "${status}"` });
      reply({ ok: true, findings: await findWithDeviceModel(msg.text) });
    } catch (err) {
      console.error("Deep scan failed:", err);
      reply({ ok: false, reason: (err as Error)?.message || String(err) });
    }
  })();
  return true; // keep the channel open for the async reply
});

mountApp(document.getElementById("app")!, { kind: "extension", insertIntoPage });
