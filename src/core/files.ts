import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const TEXT_TYPES = /\.(txt|md|csv|json|log|eml)$/i;
const MAX_BYTES = 15 * 1024 * 1024;

/** Read a file's text on this device. PDFs are parsed locally with pdf.js. */
export async function readFileText(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error("That file is over 15 MB. Try a smaller one.");
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
    }
    await task.destroy();
    return pages.join("\n\n");
  }
  if (file.type.startsWith("text/") || TEXT_TYPES.test(file.name)) return file.text();
  throw new Error("Only PDF and text files are supported for now.");
}

export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function redactedName(original: string): string {
  return original.replace(/\.[^.]+$/, "") + ".redacted.txt";
}
