# Redact-first

People paste CVs, bank statements, screenshots of chats and ID details into AI chatbots every day. Once it's sent, it's gone.

Redact-first is a Chrome extension that cleans your text **on your own device** before any AI sees it. It swaps names, phone numbers, BVNs, NINs, bank account numbers, card numbers, emails and addresses for placeholders like `[PHONE_1]`. When the AI replies using those placeholders, the extension puts your real details back, on your screen only. The chatbot never sees them.

Built for the Firebase #BuildHybridAI hackathon with Firebase AI Logic hybrid inference.

## How the hybrid part works

Most hybrid apps use the cloud as a fallback for the same job. Redact-first splits the work by what the data is:

| Job | Where it runs | Why |
| --- | --- | --- |
| Finding names and addresses in your raw text | Gemini Nano, `ONLY_ON_DEVICE` | This is the sensitive text. It must never leave the machine, so there is no cloud fallback. If Nano isn't available, we fall back to rules, not to the cloud. |
| Phone numbers, BVN, NIN, NUBAN, cards, emails | Fixed-pattern rules, in the page | Instant, offline, and works even with no model. Card numbers are Luhn-checked; 10- and 11-digit numbers are only masked when banking or ID words are nearby. |
| Summarize, rewrite, draft a reply, explain | Firebase AI Logic, `PREFER_ON_DEVICE` | Uses Nano when it can, the cloud when it can't. It only ever receives the cleaned text. |
| Strict mode | `ONLY_ON_DEVICE` for everything | For people who don't want the cloud involved at all. |

Every cloud-capable call goes through a **privacy gate** (`src/core/gate.ts`) that re-runs the rules on the outgoing text and refuses to send anything that still looks like a phone number, ID or account number. Each response's `inferenceSource` is shown to the user, so they always know where their request ran.

## Features

- **Paste guard** on ChatGPT, Claude, Gemini, DeepSeek, Copilot and Perplexity. Paste as normal; the clean version is what lands in the box. With the side panel open, Gemini Nano also checks for names.
- **Put-back**: placeholders in AI replies are swapped back to your real details on screen and lightly highlighted. The page's own code is left alone.
- **Side panel**: clean any text, drop in a PDF or text file and download a redacted copy, add anything it missed, and get AI help on the cleaned version.
- **Nigeria-aware detection**: BVN, NIN, NUBAN with 30+ bank names, +234 / 080x numbers, Lagos-style street addresses.
- **Privacy receipts**: a log of what was hidden, as counts only. Values are never stored.
- **Session vault**: the token-to-value map lives in `chrome.storage.session`, which is memory-only and clears when Chrome closes. "Forget all" clears it at any time.
- **Remote Config**: the list of guarded sites, a strict-by-default switch and an in-app notice can be changed from the Firebase console without shipping a new version.
- **Web playground** on Firebase Hosting, so judges can try it without installing anything.

## Run it

Needs Node 20+ and Chrome 139+ on desktop.

```bash
npm install
cp .env.example .env.local   # fill in your Firebase web config
npm test                     # detector and vault tests
npm run dev                  # web playground at http://localhost:5173
npm run build                # builds dist/web and dist/extension
```

**Load the extension:** open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/extension`. Click the toolbar icon to open the side panel.

**Turn on Gemini Nano:** in `chrome://flags` enable `prompt-api-for-gemini-nano-multimodal-input`, restart Chrome, then click "Clean on this device" once. The first run downloads the model, which takes a few minutes. `chrome://on-device-internals` shows its status. Your machine needs either a GPU with more than 4 GB VRAM, or 16 GB RAM and 4+ CPU cores, plus about 22 GB free disk space.

## Firebase setup

1. Create a Firebase project and register a Web app. Copy its config into `.env.local`.
2. In the console go to **AI Services > AI Logic**, click Get started, and choose the **Gemini Developer API**.
3. **App Check**: register the web app with reCAPTCHA Enterprise and put the site key in `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`. Then enforce App Check for Firebase AI Logic.
   The extension can't load reCAPTCHA (extension pages block remote scripts), so it uses an App Check **debug token**: add one under App Check > Apps > Manage debug tokens and put it in `VITE_APPCHECK_DEBUG_TOKEN`. Never commit it.
4. **Remote Config** (optional): add `guard_sites` (JSON array of hostnames), `strict_by_default` (boolean) and `notice` (string).
5. Deploy the playground: `npm run build:web && npx firebase deploy --only hosting`.

## Project layout

```
src/core/      detection rules, vault, privacy gate, Firebase AI Logic calls, Remote Config, file reading
src/ui/        the shared interface used by the side panel and the web playground
src/ext/       service worker, side panel entry, and the content script (paste guard + put-back)
src/web/       web playground entry
ext-static/    manifest and icons
```

The content script has no Firebase code in it. It runs the rules inline and asks the open side panel for Gemini Nano results, so raw text never goes through the network to get scanned.

## Limits

- Name detection needs Gemini Nano. Without it you still get every fixed-pattern check, and the app says clearly that names weren't checked.
- Text inside images isn't read yet.
- Put-back edits text in place. If a site re-renders a reply, it is restored again on the next pass.

## License

MIT
