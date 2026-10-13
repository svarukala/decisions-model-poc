import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { readCloudWebConfig } from "../web-server.mjs";
import { AppError } from "../router.mjs";

const missingEnv = new URL("nonexistent.env", import.meta.url);
const settings = { PUBLIC_ORIGIN: "https://advisor.example", WEB_TABLE_ENDPOINT: "https://synthetic.table.core.windows.net" };

test("cloud web requires an exact origin and identity-based Table settings with a separate namespace", async () => {
  const config = await readCloudWebConfig(settings, missingEnv);
  assert.equal(config.table.namespace, "web");
  assert.equal(config.table.rateLimit, 30);
  assert.equal(config.web.port, 3000);
  for (const change of [
    { PUBLIC_ORIGIN: "" }, { PUBLIC_ORIGIN: "http://advisor.example" },
    { WEB_TABLE_ENDPOINT: "" }, { WEB_TABLE_ENDPOINT: "https://untrusted.example" },
    { WEB_TABLE_CREDENTIAL: "key" }, { WEB_RATE_LIMIT: "0" }, { PORT: "0" },
  ]) await assert.rejects(readCloudWebConfig({ ...settings, ...change }, missingEnv));
});

test("web awaits cloud usage writes, exposes numeric totals and fails closed on async storage errors", async (t) => {
  let total = 0, calls = 0, reject = false, closed = false;
  const usage = {
    async total() { return total; },
    async increment() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (reject) throw new AppError(503, "Synthetic storage unavailable.");
      total++;
    },
    close() { closed = true; },
  };
  const server = createApp({
    usage, getConfig: async () => ({ publicOrigin: "", model: "synthetic" }),
    classifyPrompt: async () => { calls++; assert.equal(total, 1); return { route: "chat" }; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${origin}/api/classify`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Synthetic prompt" }),
  });
  assert.equal((await post()).status, 200);
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).totalSubmissions, 1);
  reject = true;
  assert.equal((await post()).status, 503);
  assert.equal(calls, 1);
  assert.equal(total, 1);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal(closed, false);
});
