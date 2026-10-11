import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { AppError } from "./router.mjs";

export function createUsageStore(file = fileURLToPath(new URL("usage.sqlite", import.meta.url))) {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        submissions INTEGER NOT NULL CHECK (submissions BETWEEN 0 AND 9007199254740991),
        history_imported INTEGER NOT NULL CHECK (history_imported IN (0, 1))
      );
      INSERT OR IGNORE INTO usage VALUES (1, 0, 0);
    `);
  } catch (error) {
    database.close();
    throw error;
  }
  const read = database.prepare("SELECT submissions FROM usage WHERE id = 1");
  const increment = database.prepare("UPDATE usage SET submissions = submissions + 1 WHERE id = 1 RETURNING submissions");
  const importHistory = database.prepare(`
    UPDATE usage SET submissions = submissions + ?, history_imported = 1
    WHERE id = 1 AND history_imported = 0 RETURNING submissions
  `);

  function execute(statement, ...parameters) {
    try {
      return statement.get(...parameters);
    } catch (error) {
      if (!error.code?.startsWith("ERR_SQLITE")) throw error;
      console.error("Usage counter unavailable:", error.code);
      throw new AppError(503, "The submission counter is unavailable. Please ask the app owner to check the local usage database.");
    }
  }

  return {
    total() {
      return execute(read).submissions;
    },
    increment() {
      // A single SQLite update prevents lost increments across server processes.
      return execute(increment).submissions;
    },
    importHistory(count) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("History count must be a non-negative safe integer.");
      const result = execute(importHistory, count);
      return { imported: result ? count : 0, total: result ? result.submissions : this.total() };
    },
    close() {
      database.close();
    },
  };
}
