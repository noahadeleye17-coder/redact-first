import { getGenerativeModel, InferenceMode, InferenceSource, type GenerativeModel } from "firebase/ai";
import { getFirebase } from "./firebase";
import { assertNoRulePii } from "./gate";
import type { EntityType } from "./types";

export type ModelStatus = "unsupported" | "unavailable" | "downloadable" | "downloading" | "available";
export type RunSource = "on_device" | "in_cloud";

interface LanguageModelStatic {
  availability(options?: object): Promise<string>;
}

const LANG = {
  expectedInputs: [{ type: "text" as const, languages: ["en"] }],
  expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

const system = (text: string) => [{ role: "system" as const, content: [{ type: "text" as const, value: text }] }];

/** What Chrome reports about Gemini Nano on this machine. */
export async function deviceModelStatus(): Promise<ModelStatus> {
  const LM = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  if (!LM) return "unsupported";
  try {
    return (await LM.availability(LANG)) as ModelStatus;
  } catch {
    return "unavailable";
  }
}

// ---------- Detection: on-device only, never the cloud ----------

const DETECT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["NAME", "ADDRESS"] },
          text: { type: "string" },
        },
        required: ["type", "text"],
      },
    },
  },
  required: ["items"],
};

const DETECT_SYSTEM = `You find personal data in text so it can be hidden.
Return every person's name (first names, surnames, nicknames used as names) and every street or home address.
Copy each one exactly as it appears in the text. Do not return placeholders like [PHONE_1], company names, place names on their own, or job titles.
If there is nothing, return an empty list.

Example text: "Ngozi said Mr Bello and Chukwuemeka Obi will come to 5 Allen Avenue. Ask Funmi."
Example answer: {"items":[{"type":"NAME","text":"Ngozi"},{"type":"NAME","text":"Bello"},{"type":"NAME","text":"Chukwuemeka Obi"},{"type":"ADDRESS","text":"5 Allen Avenue"},{"type":"NAME","text":"Funmi"}]}`;

let detectModel: GenerativeModel | undefined;
const ready = new WeakMap<GenerativeModel, Promise<void>>();

/** Each model keeps its own on-device session, so each one is initialised once. */
function initModel(model: GenerativeModel, onProgress?: (p: number) => void): Promise<void> {
  let p = ready.get(model);
  if (!p) {
    p = model.initializeDeviceModel(onProgress).catch((err) => {
      ready.delete(model);
      throw err;
    });
    ready.set(model, p);
  }
  return p;
}

function getDetectModel(): GenerativeModel {
  if (!detectModel) {
    detectModel = getGenerativeModel(getFirebase().ai, {
      // Raw text is what we are trying to protect, so this model must never
      // fall back to the cloud. If Nano is missing, this throws and we keep
      // the rules-only result.
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          ...LANG,
          initialPrompts: system(DETECT_SYSTEM),
        },
        promptOptions: { responseConstraint: DETECT_SCHEMA },
      },
    });
  }
  return detectModel;
}

/**
 * Must be called from a click or key press (Chrome needs a user gesture to
 * start the model download). Safe to call many times.
 */
export async function prepareDeviceModel(onProgress?: (p: number) => void): Promise<void> {
  await initModel(getDetectModel(), onProgress);
  await Promise.all([initModel(getAssistModel(false)), initModel(getAssistModel(true))]);
}

const MAX_CHUNK = 3000; // stays well under the 9,216-token on-device limit

function chunk(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let buf = "";
  for (const para of text.split(/(\n+)/)) {
    if (buf.length + para.length > MAX_CHUNK && buf) {
      parts.push(buf);
      buf = "";
    }
    if (para.length > MAX_CHUNK) {
      for (let i = 0; i < para.length; i += MAX_CHUNK) parts.push(para.slice(i, i + MAX_CHUNK));
    } else buf += para;
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Ask Gemini Nano for names and addresses. Returns strings; offsets are found locally. */
export async function findWithDeviceModel(text: string): Promise<{ type: EntityType; text: string }[]> {
  const model = getDetectModel();
  await initModel(model);
  const found: { type: EntityType; text: string }[] = [];
  for (const part of chunk(text)) {
    const result = await model.generateContent(`Text:\n"""\n${part}\n"""`);
    if (result.response.inferenceSource !== InferenceSource.ON_DEVICE) {
      throw new Error("Detection did not run on-device; refusing to continue.");
    }
    let parsed: { items?: { type: string; text: string }[] } = {};
    try {
      parsed = JSON.parse(result.response.text());
    } catch {
      continue;
    }
    for (const item of parsed.items ?? []) {
      const value = (item.text ?? "").trim();
      const ok =
        (item.type === "NAME" || item.type === "ADDRESS") &&
        value.length >= 2 &&
        value.length <= 120 &&
        !/\[[A-Z_]+_\d+\]/.test(value) &&
        part.includes(value); // the model must quote the text, not invent it
      if (ok) found.push({ type: item.type as EntityType, text: value });
    }
  }
  return found;
}

// ---------- Assist: hybrid, but only ever sees cleaned text ----------

export type AssistTask = "summarize" | "rewrite" | "reply" | "explain" | "custom";

const TASKS: Record<Exclude<AssistTask, "custom">, string> = {
  summarize: "Summarize this in 3 to 5 short bullet points.",
  rewrite: "Rewrite this so it is clear, professional and well organised. Keep the meaning.",
  reply: "Draft a short, polite reply to this message.",
  explain: "Explain what this document says in plain, simple English.",
};

const ASSIST_SYSTEM =
  "Some details in the text were replaced with placeholders like [NAME_1] or [PHONE_2] to protect privacy. Keep every placeholder exactly as written, in square brackets, wherever you need that detail. Never guess the real values.";

const assistModels: Partial<Record<"hybrid" | "strict", GenerativeModel>> = {};

function getAssistModel(strict: boolean): GenerativeModel {
  const key = strict ? "strict" : "hybrid";
  if (!assistModels[key]) {
    assistModels[key] = getGenerativeModel(getFirebase().ai, {
      mode: strict ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: { createOptions: { ...LANG, initialPrompts: system(ASSIST_SYSTEM) } },
      inCloudParams: { model: "gemini-3.5-flash-lite", systemInstruction: ASSIST_SYSTEM },
    });
  }
  return assistModels[key]!;
}

export async function assist(
  cleanedText: string,
  task: AssistTask,
  opts: { strict: boolean; instruction?: string; onChunk?: (text: string) => void },
): Promise<{ text: string; source: RunSource }> {
  // The gate: nothing a rule can recognise may leave this function.
  assertNoRulePii(cleanedText);
  if (opts.instruction) assertNoRulePii(opts.instruction);

  const ask = task === "custom" ? (opts.instruction || "Help with this text.") : TASKS[task];
  const model = getAssistModel(opts.strict);
  // In strict mode Nano is required; in hybrid mode a failed init just means cloud.
  if (opts.strict) await initModel(model);
  else await initModel(model).catch(() => undefined);

  const prompt = `${ask}\n\nText:\n"""\n${cleanedText}\n"""`;
  const sourceOf = (r: { inferenceSource?: string }): RunSource =>
    r.inferenceSource === InferenceSource.ON_DEVICE ? "on_device" : "in_cloud";

  try {
    const stream = await model.generateContentStream(prompt);
    let text = "";
    for await (const c of stream.stream) {
      text += c.text();
      opts.onChunk?.(text);
    }
    return { text, source: sourceOf(await stream.response) };
  } catch (err) {
    // Streaming sometimes fails to parse mid-way. Retry once without streaming.
    console.warn("Streaming failed, retrying without it:", err);
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    opts.onChunk?.(text);
    return { text, source: sourceOf(result.response) };
  }
}
