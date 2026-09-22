import { appendFile } from "node:fs/promises";
import { AppError } from "./router.mjs";

export async function savePrompt({ prompt, context }, file = new URL("prompt-history.jsonl", import.meta.url)) {
  const entry = { timestamp: new Date().toISOString(), prompt, context };
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  } catch (error) {
    if (typeof error.code !== "string") throw error;
    console.error("Prompt history write failed:", error.code);
    throw new AppError(500, "Could not save prompt-history.jsonl. Check disk space and file permissions. No Jev request was sent.");
  }
}
