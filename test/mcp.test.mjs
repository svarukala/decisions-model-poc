import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readMcpConfig, createMcpHttpServer } from "../mcp-server.mjs";
import { CATALOG, SIGNALS, compareArchitectures } from "../advisor.mjs";
import { AppError } from "../router.mjs";

const KEY = "synthetic_client_key_0123456789_abcdef";
const NEXT_KEY = "synthetic_rotation_key_0123456789_abcdef";
const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
const defaults = { MCP_API_KEYS: KEY, MCP_REDIS_URL: "redis://127.0.0.1:6379" };
const missingEnv = new URL("nonexistent.env", import.meta.url);
function fixture() {
  return {
    model: "synthetic-model",
    answers: {
      architecture: { type: "choice", choice: "cowork_plugin", probabilities: Object.fromEntries(Object.keys(CATALOG).map((key) => [key, key === "cowork_plugin" ? 0.92 : 0.01])) },
      ...Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, { type: "noul", noul: 0.1 }])),
    },
  };
}
function memoryUsage() {
  let count = 0;
  return {
    async ready() {},
    async admit(...args) { assert.equal(args.length, 0); count++; },
    async total() { return count; }, close() {},
  };
}
async function withServer(t, overrides = {}, environment = {}) {
  const usage = overrides.usage || memoryUsage();
  const server = createMcpHttpServer({
    config: await readMcpConfig({ ...defaults, ...environment }, missingEnv),
    usage, getConfig: async () => ({}),
    advise: (input, config) => compareArchitectures(input, config, { jev: async () => fixture(), decision: async () => fixture() }),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, usage, url: `http://127.0.0.1:${server.address().port}` };
}
async function connect(t, url, key = KEY) {
  const client = new Client({ name: "architecture-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}
function post(url, body, overrides = {}) {
  return fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
}

test("MCP config fails closed for weak keys, bad Redis/origin and unsafe limits", async () => {
  for (const override of [
    { MCP_API_KEYS: "" }, { MCP_API_KEYS: "short" }, { MCP_API_KEYS: `${KEY},` },
    { MCP_REDIS_URL: "" }, { MCP_REDIS_URL: "https://redis.example" },
    { MCP_HOST: "0.0.0.0" }, { MCP_PUBLIC_ORIGIN: "http://example.org" },
    { MCP_REDIS_NAMESPACE: "bad{namespace}" }, { MCP_MAX_CONCURRENT: "0" },
    { MCP_RATE_LIMIT: "NaN" }, { MCP_PORT: "70000" },
  ]) await assert.rejects(readMcpConfig({ ...defaults, ...override }, missingEnv));
  const config = await readMcpConfig({ ...defaults, MCP_API_KEYS: `${KEY},${NEXT_KEY}` }, missingEnv);
  assert.equal(config.apiKeyHashes.length, 2);
  assert.equal(config.maxConcurrent, 8);
});

test("official MCP client initializes statelessly, discovers tools/resources and receives structured recommendations", async (t) => {
  const { url, usage } = await withServer(t);
  const { client, transport } = await connect(t, url);
  assert.equal(transport.sessionId, undefined);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["get_architecture_catalog", "get_advisor_status", "advise_agent_architecture"]);
  assert.equal(tools.tools[2].annotations.idempotentHint, false);
  assert.ok(tools.tools[2].outputSchema);
  assert.equal((await client.listResources()).resources[0].uri, "architecture-advisor://catalog");
  assert.match((await client.readResource({ uri: "architecture-advisor://catalog" })).contents[0].text, /cowork_plugin/);
  const catalog = await client.callTool({ name: "get_architecture_catalog", arguments: {} });
  assert.ok(catalog.structuredContent.catalog.cowork_plugin);
  assert.equal(await usage.total(), 0);
  const result = await client.callTool({ name: "advise_agent_architecture", arguments: { scenario: "Create reusable Cowork skills with MCP." } });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.providers.jev.recommendation, "cowork_plugin");
  assert.equal(result.structuredContent.comparison, "agree");
  const status = await client.callTool({ name: "get_advisor_status", arguments: {} });
  assert.equal(status.structuredContent.totalSubmissions, 1);
  assert.equal(status.structuredContent.scope, "mcp");
});

test("MCP auth covers initialization, tools, readiness, and GET/DELETE with overlapping rotation keys", async (t) => {
  const { url, usage } = await withServer(t, {}, { MCP_API_KEYS: `${KEY},${NEXT_KEY}` });
  for (const authorization of ["", "Basic abc", "Bearer short", `Bearer ${"x".repeat(40)}`]) {
    const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: authorization });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /Bearer/);
    assert.doesNotMatch(await response.text(), new RegExp(KEY));
  }
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/readyz`)).status, 401);
  assert.equal((await fetch(`${url}/readyz`, { headers })).status, 200);
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    assert.equal((await fetch(`${url}/mcp`, { method, headers })).status, 405);
  }
  await connect(t, url, NEXT_KEY);
  assert.equal(await usage.total(), 0);
});

test("MCP rejects cross-site, bad host, query credentials, malformed JSON and batches without counting", async (t) => {
  const { url, usage } = await withServer(t);
  assert.equal((await post(url, {}, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await post(url, {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post(url, [], {})).status, 400);
  assert.equal((await fetch(`${url}/mcp?key=${KEY}`, { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await post(url, { padding: "x".repeat(65537) })).status, 413);
  assert.equal((await post(url, {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(url, {}, { "Content-Encoding": "gzip" })).status, 415);
  const status = await new Promise((resolve, reject) => {
    const req = request(url + "/mcp", { method: "POST", headers: { ...headers, Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403);
  for (const path of ["/.env", "/usage.sqlite", "/mcp-server.mjs"]) assert.equal((await fetch(url + path)).status, 404);
  assert.equal(await usage.total(), 0);
});

test("MCP schema validation precedes admission and provider calls", async (t) => {
  const { url, usage } = await withServer(t, { advise: () => assert.fail("Must not call providers") });
  const { client } = await connect(t, url);
  for (const args of [{}, { scenario: " " }, { scenario: "x".repeat(8001) }, { scenario: "x", requirements: 5 }, { scenario: "x", requirements: "x".repeat(3001) }]) {
    const result = await client.callTool({ name: "advise_agent_architecture", arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(await usage.total(), 0);
});

test("MCP bounds concurrent billed calls before Redis admission", async (t) => {
  let begin;
  let finish;
  const started = new Promise((resolve) => { begin = resolve; });
  const { url, usage } = await withServer(t, {
    advise: async (input, config) => {
      begin();
      await new Promise((resolve) => { finish = resolve; });
      return compareArchitectures(input, config, { jev: async () => fixture(), decision: async () => fixture() });
    },
  }, { MCP_MAX_CONCURRENT: "1" });
  const { client } = await connect(t, url);
  const pending = client.callTool({ name: "advise_agent_architecture", arguments: { scenario: "First" } });
  await started;
  try {
    const rejected = await client.callTool({ name: "advise_agent_architecture", arguments: { scenario: "Second" } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /busy/);
    assert.equal(await usage.total(), 1);
  } finally { finish(); }
  assert.notEqual((await pending).isError, true);
});

test("MCP shared-limit/storage failures prevent inference; partial provider results remain explicit", async (t) => {
  for (const code of [429, 503]) {
    const { url } = await withServer(t, {
      usage: { ...memoryUsage(), async admit() { throw new AppError(code, "Shared admission failed."); } },
      advise: () => assert.fail("Must not call provider after failed admission"),
    });
    const { client } = await connect(t, url);
    assert.equal((await client.callTool({ name: "advise_agent_architecture", arguments: { scenario: "Hello" } })).isError, true);
  }
  const { url, usage } = await withServer(t, {
    advise: (input, config) => compareArchitectures(input, config, { jev: async () => fixture(), decision: async () => { throw new AppError(503, "Decision-1 unavailable."); } }),
  });
  const { client } = await connect(t, url);
  const result = await client.callTool({ name: "advise_agent_architecture", arguments: { scenario: "Hello" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.comparison, "incomplete");
  assert.equal(result.structuredContent.providers.jev.status, "success");
  assert.equal(await usage.total(), 1);
});

test("draining replicas fail health/readiness and stop new work", async (t) => {
  const { url, server } = await withServer(t);
  server.drain();
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
  assert.equal((await fetch(`${url}/readyz`, { headers })).status, 503);
  assert.equal((await post(url, {})).status, 503);
});
