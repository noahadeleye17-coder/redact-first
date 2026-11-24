import type { Entity, EntityType } from "./types";

/**
 * Fixed-pattern detectors. These run everywhere (content script, side panel,
 * web playground), need no model and no network, and are the floor of
 * protection: if Gemini Nano is missing, these still run.
 */

const NIGERIAN_BANKS =
  "access|gtb|gtbank|guaranty|zenith|uba|first ?bank|fidelity|union|sterling|wema|alat|stanbic|fcmb|ecobank|polaris|keystone|unity|providus|jaiz|kuda|opay|palmpay|moniepoint|carbon|vfd|globus|titan|taj|lotus|premium ?trust|parallex|suntrust";

const ACCOUNT_CONTEXT = new RegExp(`\\b(acc(oun)?t|acct|a\\/c|nuban|bank|${NIGERIAN_BANKS})\\b`, "i");
const BVN_CONTEXT = /\bbvn\b|bank verification/i;
const NIN_CONTEXT = /\bnin\b|national identi(ty|fication)|nimc/i;
const DOB_CONTEXT = /\b(dob|d\.o\.b|date of birth|born( on)?|birthday)\b/i;

interface Rule {
  type: EntityType;
  pattern: RegExp;
  /** Optional check on the match and the text around it. */
  accept?: (match: string, before: string, after: string) => EntityType | null;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Luhn check, so random long numbers are not called card numbers. */
export function luhnValid(num: string): boolean {
  const d = digitsOnly(num);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  {
    type: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // 13-19 digit card numbers, optionally grouped with spaces or dashes.
    type: "CARD",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => (luhnValid(m) ? "CARD" : null),
  },
  {
    // Nigerian mobile numbers: 080..., 070..., 090..., 081..., 091..., +234 / 234 forms.
    type: "PHONE",
    pattern: /(?<![\d+])(?:\+?234[ -]?|0)[789][01]\d[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
  },
  {
    // International numbers written with a leading +, e.g. +44 20 7946 0958.
    type: "PHONE",
    pattern: /(?<![\w+])\+(?!234)\d{1,3}(?:[ -]?\d{2,4}){2,4}(?!\d)/g,
  },
  {
    // 11 digits: BVN or NIN. We only label them when the text around says which.
    type: "ID_NUMBER",
    pattern: /(?<!\d)\d{11}(?!\d)/g,
    accept: (m, before, after) => {
      // Prefer the label on the same line ("NIN: ..."), so a "BVN" on the line
      // above doesn't relabel this one.
      const sameLine = before.split("\n").pop() ?? "";
      if (NIN_CONTEXT.test(sameLine)) return "NIN";
      if (BVN_CONTEXT.test(sameLine)) return "BVN";
      const ctx = before + " " + after;
      if (BVN_CONTEXT.test(ctx)) return "BVN";
      if (NIN_CONTEXT.test(ctx)) return "NIN";
      // 080..., 070..., 091... with no ID words around it is a phone number.
      if (/^0[789][01]/.test(m)) return null;
      return "ID_NUMBER";
    },
  },
  {
    // 10-digit NUBAN account numbers, only when banking words are nearby,
    // so we do not mask every 10-digit number in a document.
    type: "ACCOUNT",
    pattern: /(?<!\d)\d{10}(?!\d)/g,
    accept: (_m, before, after) => (ACCOUNT_CONTEXT.test(before + " " + after) ? "ACCOUNT" : null),
  },
  {
    // Street addresses: "No. 12 Adebayo Street", "15B Allen Avenue", "Plot 4, Unity Close".
    type: "ADDRESS",
    pattern:
      /\b(?:(?:no\.?|plot|block|flat|house)\s*)?\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][a-zA-Z'-]+\s+){1,4}(?:street|st\.?|road|rd\.?|avenue|ave\.?|close|crescent|cres\.?|way|lane|ln\.?|drive|dr\.?|estate|layout|boulevard)\b/gi,
  },
  {
    // Names after a title: "Mr. Chinedu Eze", "Alhaji Musa", "Dr Funke Akindele".
    // Works without the on-device model. The title itself is kept.
    type: "NAME",
    pattern:
      /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Chief|Alhaji|Alhaja|Engr|Pastor|Rev|Barr|Hon|Mallam|Madam|Aunty|Uncle)\.?\s+((?:[A-Z][a-zA-Z'-]+)(?:\s+[A-Z][a-zA-Z'-]+){0,2})/g,
  },
  {
    // Dates, only when they read as a birth date.
    type: "DOB",
    pattern:
      /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+\d{4})\b/gi,
    accept: (_m, before) => (DOB_CONTEXT.test(before) ? "DOB" : null),
  },
];

/** Case-insensitive cue word, but the name after it must be capitalised. */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const RELATIONS =
  "friend|brother|sister|mum|mom|mother|dad|father|wife|husband|guardian|boss|landlord|landlady|colleague|cousin|uncle|aunt|aunty|neighbou?r|roommate|flatmate|son|daughter|manager|lecturer|agent|caretaker";
const NAME_CUES = [
  "my name is", "i am", "i'm", "this is", "dear", "hi", "hello", "hey",
  ...RELATIONS.split("|").map((r) => `my ${r}`),
].map(ci);
const SIGN_OFFS = ["thanks", "thank you", "regards", "best regards", "kind regards", "sincerely", "cheers", "yours faithfully"].map(ci);
const NAME_WORD = "[A-Z][a-z'-]+";
const NOT_NAMES = new Set(
  "I I'm Im The There Team Sir Madam Ma Everyone All Guys Folks Friends Again Here Good Doing Fine Happy Sorry Writing Interested Available Looking Nigerian Ok Okay Please Thanks".split(" "),
);
const CUE_NAME_RE = new RegExp(`(?:^|[^\\p{L}])(?:${NAME_CUES.join("|")}),?\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, "gu");
const SIGNOFF_NAME_RE = new RegExp(`(?:${SIGN_OFFS.join("|")}),?[ \\t]*\\n+[ \\t]*(${NAME_WORD}(?:[ \\t]+${NAME_WORD}){0,2})[ \\t]*$`, "gmu");

/**
 * Names introduced by a cue ("my friend Adaeze Okonkwo", "I'm Tunde") or in a
 * sign-off. Instant and works without the on-device model.
 */
export function detectCuedNames(text: string): Entity[] {
  const out: Entity[] = [];
  for (const re of [CUE_NAME_RE, SIGNOFF_NAME_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Drop trailing words that are clearly not part of a name ("Tunde Here").
      const words = m[1].split(/\s+/);
      while (words.length && NOT_NAMES.has(words[words.length - 1])) words.pop();
      if (!words.length || NOT_NAMES.has(words[0])) {
        // e.g. "Hi, I'm Tunde": skip "I'm" and look again from there.
        re.lastIndex = m.index + m[0].lastIndexOf(m[1]) - 1;
        continue;
      }
      const value = words.join(" ");
      const start = m.index + m[0].lastIndexOf(m[1]);
      out.push({ type: "NAME", value, start, end: start + value.length, finder: "rules" });
    }
  }
  return out;
}

const CONTEXT_WINDOW = 40;

export function detectWithRules(text: string): Entity[] {
  const found: Entity[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      // A rule may capture just the sensitive part (e.g. the name after "Mr.").
      const value = (m[1] ?? m[0]).trim();
      const start = m.index + m[0].indexOf(value, m[1] ? m[0].length - m[1].length - 1 : 0);
      const end = start + value.length;
      const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
      const after = text.slice(end, end + CONTEXT_WINDOW);
      const type = rule.accept ? rule.accept(value, before, after) : rule.type;
      if (type) found.push({ type, value, start, end, finder: "rules" });
    }
  }
  return resolveOverlaps([...found, ...detectCuedNames(text)]);
}

/**
 * When two findings overlap (a card number that also looks like a phone),
 * keep the longer one; on a tie keep the rules finding, which is exact.
 */
export function resolveOverlaps(entities: Entity[]): Entity[] {
  const sorted = [...entities].sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      (a.finder === b.finder ? 0 : a.finder === "rules" ? -1 : 1),
  );
  const kept: Entity[] = [];
  for (const e of sorted) {
    if (!kept.some((k) => e.start < k.end && k.start < e.end)) kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * If "Tunde Bakare" is a name, "Tunde" or "Bakare" on its own elsewhere is the
 * same person. Adds those parts as extra name findings.
 */
export function expandNameParts(items: { type: EntityType; text: string }[]): { type: EntityType; text: string }[] {
  const out = [...items];
  const seen = new Set(items.map((i) => i.text));
  for (const item of items) {
    if (item.type !== "NAME") continue;
    for (const part of item.text.split(/\s+/)) {
      if (part.length >= 3 && /^[A-Z][a-zA-Z'-]+$/.test(part) && !seen.has(part)) {
        seen.add(part);
        out.push({ type: "NAME", text: part });
      }
    }
  }
  return out;
}

/**
 * Turn model findings (just strings) into positioned entities by finding every
 * place each string occurs in the text. The model never gives us offsets we
 * have to trust.
 */
export function locate(text: string, items: { type: EntityType; text: string }[]): Entity[] {
  const out: Entity[] = [];
  for (const item of items) {
    const needle = item.text.trim();
    if (needle.length < 2) continue;
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      const before = text[idx - 1] ?? " ";
      const after = text[idx + needle.length] ?? " ";
      if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) {
        from = idx + 1; // part of a longer word, e.g. "Ada" inside "Adaeze"
        continue;
      }
      out.push({ type: item.type, value: needle, start: idx, end: idx + needle.length, finder: "on_device" });
      from = idx + needle.length;
    }
  }
  return out;
}
