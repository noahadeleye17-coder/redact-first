import { initializeApp, type FirebaseApp } from "firebase/app";
import { CustomProvider, ReCaptchaEnterpriseProvider, initializeAppCheck } from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";

declare global {
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.appId);

let app: FirebaseApp | undefined;
let ai: AI | undefined;

/**
 * App Check is required by the hackathon. The web playground uses reCAPTCHA
 * Enterprise when a site key is set. The Chrome extension cannot load
 * reCAPTCHA (extension pages block remote scripts), so it runs with a
 * registered debug token, which the rules accept for submissions.
 */
function setUpAppCheck(firebaseApp: FirebaseApp): void {
  const debugToken = env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined;
  const isExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;

  if (debugToken) self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
  else if (env.DEV) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

  const provider =
    siteKey && !isExtension
      ? new ReCaptchaEnterpriseProvider(siteKey)
      : new CustomProvider({
          getToken: () => Promise.reject(new Error("No attestation provider here; using the App Check debug token.")),
        });

  initializeAppCheck(firebaseApp, { provider, isTokenAutoRefreshEnabled: true });
}

export function getFirebase(): { app: FirebaseApp; ai: AI } {
  if (!isConfigured) throw new Error("Firebase is not configured. Copy .env.example to .env.local and fill it in.");
  if (!app) {
    app = initializeApp(firebaseConfig);
    setUpAppCheck(app);
    ai = getAI(app, { backend: new GoogleAIBackend() });
  }
  return { app, ai: ai! };
}
