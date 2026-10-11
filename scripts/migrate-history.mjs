import { readFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createUsageStore } from "../usage.mjs";

export async function migrateHistory(store, file = new URL("../prompt-history.jsonl", import.meta.url), removeFile = unlink) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { imported: 0, total: store.total(), deleted: false };
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("History contains an invalid JSON entry. No count was imported and no file was deleted.");
    }
    if (!entry || typeof entry.prompt !== "string") {
      throw new Error("History contains an invalid prompt entry. No count was imported and no file was deleted.");
    }
    count++;
  }
  // Commit the count and migration marker before deleting text. Retrying after a
  // deletion failure cannot add the same historical submissions a second time.
  const result = store.importHistory(count);
  await removeFile(file);
  return { ...result, deleted: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = createUsageStore();
  try {
    const result = await migrateHistory(store);
    console.log(JSON.stringify(result));
  } finally {
    store.close();
  }
}
