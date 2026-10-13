import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { createMcpUsage } from "../mcp-usage.mjs";

test("real Redis: two replicas share atomic admission, persistent count and fixed-window expiry", {
  skip: !process.env.MCP_TEST_REDIS_URL && "Set MCP_TEST_REDIS_URL to run real Redis integration.",
}, async (t) => {
  const namespace = `advisor-test-${randomUUID()}`;
  const config = { redisUrl: process.env.MCP_TEST_REDIS_URL, namespace, rateLimit: 10 };
  const first = createMcpUsage(config);
  const second = createMcpUsage(config);
  const admin = createClient({ url: config.redisUrl, socket: { reconnectStrategy: false } });
  admin.on("error", () => {});
  const rateKey = `{${namespace}}:rate`;
  const totalKey = `{${namespace}}:submissions`;
  t.after(async () => {
    first.close(); second.close();
    if (admin.isReady) await admin.del([rateKey, totalKey]);
    if (admin.isOpen) admin.destroy();
  });
  await admin.connect();
  await Promise.all([first.connect(), second.connect()]);
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).admit()));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 10);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 429));
  assert.equal(await first.total(), 10);
  assert.equal(await second.total(), 10);
  assert.ok(await admin.pTTL(rateKey) > 0);
  assert.equal(await admin.pTTL(totalKey), -1);
  first.close();
  const replacement = createMcpUsage(config);
  t.after(() => replacement.close());
  await replacement.connect();
  assert.equal(await replacement.total(), 10);
  await assert.rejects(replacement.admit(), (error) => error.status === 429);
  await admin.pExpire(rateKey, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await replacement.admit();
  assert.equal(await second.total(), 11);
  // No prompt text, per-user keys, IDs or response records exist in this namespace.
  assert.deepEqual((await admin.keys(`{${namespace}}:*`)).sort(), [rateKey, totalKey].sort());
  await admin.set(totalKey, "invalid");
  await assert.rejects(second.admit(), (error) => error.status === 503);
  await assert.rejects(second.total(), (error) => error.status === 503);
  await admin.set(totalKey, "9007199254740991");
  await assert.rejects(second.admit(), (error) => error.status === 503);
  second.close();
  await assert.rejects(second.admit(), (error) => error.status === 503);
});
