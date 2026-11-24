import { fetchAndActivate, getRemoteConfig, getValue } from "firebase/remote-config";
import { getFirebase } from "./firebase";
import { REMOTE_DEFAULTS, type RemoteSettings } from "./remoteConfig.defaults";

export type { RemoteSettings } from "./remoteConfig.defaults";
export { REMOTE_DEFAULTS } from "./remoteConfig.defaults";

export async function loadRemoteSettings(): Promise<RemoteSettings> {
  try {
    const rc = getRemoteConfig(getFirebase().app);
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.defaultConfig = {
      guard_sites: JSON.stringify(REMOTE_DEFAULTS.guardSites),
      strict_by_default: false,
      notice: "",
    };
    await fetchAndActivate(rc);
    let sites = REMOTE_DEFAULTS.guardSites;
    try {
      const parsed = JSON.parse(getValue(rc, "guard_sites").asString());
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) sites = parsed;
    } catch {
      /* bad value in console; keep defaults */
    }
    return {
      guardSites: sites,
      strictByDefault: getValue(rc, "strict_by_default").asBoolean(),
      notice: getValue(rc, "notice").asString(),
    };
  } catch {
    return REMOTE_DEFAULTS;
  }
}
