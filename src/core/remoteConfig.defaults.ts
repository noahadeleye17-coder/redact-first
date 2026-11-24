// Kept apart from remoteConfig.ts so the content script can use the defaults
// without bundling Firebase.
export interface RemoteSettings {
  /** Sites where the paste guard is on. Pushed to the extension without a new release. */
  guardSites: string[];
  /** Turn strict mode on by default for everyone (e.g. during an incident). */
  strictByDefault: boolean;
  /** Short note shown in the panel, e.g. "New: Kuda account numbers detected". */
  notice: string;
}

export const REMOTE_DEFAULTS: RemoteSettings = {
  guardSites: ["chatgpt.com", "claude.ai", "gemini.google.com", "chat.deepseek.com", "copilot.microsoft.com", "perplexity.ai"],
  strictByDefault: false,
  notice: "",
};
