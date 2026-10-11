import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createUsageStore } from "../usage.mjs";
import { migrateHistory } from "../scripts/migrate-history.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "jev-usage-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("only an aggregate count and migration marker are persisted across restarts", async (t) => {
  const file = join(await directory(t), "usage.sqlite");
  const store = createUsageStore(file);
  assert.equal(store.total(), 0);
  assert.equal(store.increment(), 1);
  assert.equal(store.increment(), 2);
  store.close();
  const reopened = createUsageStore(file);
  assert.equal(reopened.total(), 2);
  reopened.close();
  const database = new DatabaseSync(file);
  assert.deepEqual(database.prepare("PRAGMA table_info(usage)").all().map((column) => column.name),
    ["id", "submissions", "history_imported"]);
  assert.deepEqual({ ...database.prepare("SELECT * FROM usage").get() },
    { id: 1, submissions: 2, history_imported: 0 });
  database.close();
});

test("separate processes increment the shared counter without losing submissions", async (t) => {
  const file = join(await directory(t), "usage.sqlite");
  createUsageStore(file).close();
  const moduleUrl = new URL("../usage.mjs", import.meta.url).href;
  const script = `import {createUsageStore} from ${JSON.stringify(moduleUrl)};
    const store = createUsageStore(process.argv[1]);
    for(let i=0;i<30;i++) store.increment();
    store.close();`;
  const run = promisify(execFile);
  await Promise.all([1, 2].map(() => run(process.execPath, ["--input-type=module", "-e", script, file])));
  const store = createUsageStore(file);
  assert.equal(store.total(), 60);
  store.close();
});

test("migration preserves the existing total, deletes text, and is repeatable", async (t) => {
  const path = await directory(t);
  const history = join(path, "prompt-history.jsonl");
  const store = createUsageStore(join(path, "usage.sqlite"));
  const marker = "Synthetic private prompt\nsecond line";
  await writeFile(history, [
    JSON.stringify({ prompt: marker, context: "Synthetic private context" }),
    JSON.stringify({ prompt: "Another example", context: "" }),
  ].join("\n") + "\n");
  store.increment();
  assert.deepEqual(await migrateHistory(store, history), { imported: 2, total: 3, deleted: true });
  assert.deepEqual(await migrateHistory(store, history), { imported: 0, total: 3, deleted: false });
  store.close();
  assert.deepEqual(await readdir(path), ["usage.sqlite"]);
  assert.equal((await readFile(join(path, "usage.sqlite"))).includes(Buffer.from("Synthetic private")), false);
});

test("a deletion failure can be retried without double-counting old history", async (t) => {
  const path = await directory(t);
  const history = join(path, "prompt-history.jsonl");
  const store = createUsageStore(join(path, "usage.sqlite"));
  await writeFile(history, '{"prompt":"Synthetic example","context":""}\n');
  await assert.rejects(migrateHistory(store, history, async () => {
    throw new Error("Synthetic deletion failure");
  }), /Synthetic deletion failure/);
  assert.equal(store.total(), 1);
  assert.deepEqual(await migrateHistory(store, history), { imported: 0, total: 1, deleted: true });
  store.close();
});

test("invalid history is not deleted or silently counted", async (t) => {
  const path = await directory(t);
  const history = join(path, "prompt-history.jsonl");
  const store = createUsageStore(join(path, "usage.sqlite"));
  for (const text of ['{"prompt":"Valid"}\ninvalid json\n', '{"unexpected":"field"}\n']) {
    await writeFile(history, text);
    await assert.rejects(migrateHistory(store, history), /History contains an invalid/);
    assert.equal(store.total(), 0);
    assert.equal(await readFile(history, "utf8"), text);
  }
  store.close();
});
