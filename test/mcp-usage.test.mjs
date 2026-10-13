import test from "node:test";
import assert from "node:assert/strict";
import { createMcpUsage } from "../mcp-usage.mjs";

const config = { namespace: "test-advisor", rateLimit: 4 };
const statusError = (statusCode, errorCode) => Object.assign(new Error("Private storage details"), { statusCode, details: { errorCode } });
function fakeTable() {
  let entity;
  let version = 0;
  const table = {
    now: 1760000000000, updates: 0, creates: 0,
    async getEntity(partitionKey, rowKey, options) {
      options.abortSignal.throwIfAborted();
      if (!entity) throw statusError(404, "ResourceNotFound");
      options.onResponse({ headers: new Headers({ Date: new Date(table.now).toUTCString() }) });
      return { ...entity, etag: `W/"${version}"` };
    },
    async createEntity(value) {
      table.creates++;
      if (entity) throw statusError(409, "EntityAlreadyExists");
      entity = structuredClone(value);
      version++;
    },
    async updateEntity(value, mode, options) {
      table.updates++;
      options.abortSignal.throwIfAborted();
      assert.equal(mode, "Replace");
      assert.notEqual(options.etag, "*");
      if (options.etag !== `W/"${version}"`) throw statusError(412, "UpdateConditionNotSatisfied");
      entity = structuredClone(value);
      version++;
    },
    state: () => structuredClone(entity),
    corrupt: (values) => { entity = { ...entity, ...values }; version++; },
    remove: () => { entity = undefined; },
  };
  return table;
}
const store = (client) => createMcpUsage(config, client, { backoff: async () => {} });

test("Table admission shares one atomic entity across replicas and expires using the service clock", async () => {
  const table = fakeTable();
  const first = store(table), second = store(table);
  await Promise.all([first.connect(), second.connect()]);
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).admit()));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 429));
  assert.equal(await first.total(), 4);
  assert.equal(await second.total(), 4);
  table.now += 59000;
  await assert.rejects(first.admit(), (error) => error.status === 429);
  table.now += 1000;
  await first.admit();
  assert.equal(await second.total(), 5);
  assert.equal(table.state().windowCount, 1);
  assert.deepEqual(Object.keys(table.state()).sort(), ["partitionKey", "rowKey", "schemaVersion", "submissions", "windowCount", "windowStartedAt"]);
  const replacement = store(table);
  await replacement.connect();
  assert.equal(await replacement.total(), 5);
});

test("Table retries only definite ETag conflicts, never ambiguous writes, and bounds contention", async () => {
  const table = fakeTable();
  const usage = store(table);
  await usage.connect();
  const update = table.updateEntity;
  let conflicts = 0;
  table.updateEntity = (...args) => {
    if (conflicts++ < 2) throw statusError(412, "UpdateConditionNotSatisfied");
    return update(...args);
  };
  await usage.admit();
  assert.equal(conflicts, 3);
  assert.equal(await usage.total(), 1);
  let calls = 0;
  table.updateEntity = async (...args) => { calls++; await update(...args); throw statusError(500, "ServerError"); };
  await assert.rejects(usage.admit(), (error) => error.status === 503 && !error.message.includes("Private"));
  assert.equal(calls, 1);
  assert.equal(await usage.total(), 2);
  calls = 0;
  table.updateEntity = () => { calls++; throw statusError(412, "UpdateConditionNotSatisfied"); };
  await assert.rejects(usage.admit(), (error) => error.status === 503 && /busy/.test(error.message));
  assert.equal(calls, 8);
  assert.equal(await usage.total(), 2);
});

test("Table rejects corruption, exhausted counts, missing time and a deleted counter without resetting", async () => {
  for (const bad of [
    { submissions: "-1" }, { submissions: 1 }, { submissions: "9007199254740992" },
    { windowCount: -1 }, { schemaVersion: 2 }, { windowStartedAt: "invalid" },
    { windowStartedAt: 1 }, { windowStartedAt: "2026-01-01" },
    { windowStartedAt: new Date(1760000001000).toISOString() },
  ]) {
    const table = fakeTable(); const usage = store(table); await usage.connect();
    table.corrupt(bad);
    await assert.rejects(usage.admit(), (error) => error.status === 503);
    assert.equal(table.updates, 0);
  }
  const table = fakeTable(); const usage = store(table); await usage.connect();
  table.corrupt({ submissions: String(Number.MAX_SAFE_INTEGER) });
  await assert.rejects(usage.admit(), (error) => error.status === 503);
  table.remove();
  await assert.rejects(usage.admit(), (error) => error.status === 503);
  assert.equal(table.creates, 1);
  const get = table.getEntity;
  await table.createEntity({ partitionKey: config.namespace, rowKey: "usage", schemaVersion: 1, submissions: "0", windowCount: 0, windowStartedAt: new Date(0).toISOString() });
  table.getEntity = (p, r, options) => get(p, r, { ...options, onResponse() {} });
  await assert.rejects(usage.admit(), (error) => error.status === 503);
  table.getEntity = get;
  for (const etag of [undefined, "", "*"]) {
    table.getEntity = async (...args) => ({ ...await get(...args), etag });
    await assert.rejects(usage.admit(), (error) => error.status === 503);
  }
  table.getEntity = get;
  usage.close();
  await assert.rejects(usage.admit(), (error) => error.status === 503);
});

test("Table startup does not create a table or swallow permissions/missing-table errors", async () => {
  for (const [status, code] of [[403, "AuthorizationPermissionMismatch"], [404, "TableNotFound"], [500, "ServerError"]]) {
    const usage = store({
      async getEntity() { throw statusError(status, code); },
      createEntity() { assert.fail("Do not initialize on a missing table or failed read."); },
    });
    await assert.rejects(usage.connect(), (error) => error.status === 503);
  }
});
