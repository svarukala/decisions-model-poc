import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TableClient } from "@azure/data-tables";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer, readMcpConfig } from "../mcp-server.mjs";
import { createEntraAuthenticator } from "../mcp-auth.mjs";
import { createMcpUsage, TABLE_CLIENT_OPTIONS } from "../mcp-usage.mjs";
import { environment, jwks, token } from "./fixtures/entra.mjs";

test("real Table: ETag contention, startup races, persistent counts and rate-window rollover", {
  skip: !process.env.MCP_TEST_TABLE_CONNECTION_STRING && "Set MCP_TEST_TABLE_CONNECTION_STRING to an isolated Azurite instance.",
}, async (t) => {
  const tableName = `AdvisorTest${randomUUID().replaceAll("-", "")}`;
  const options = { ...TABLE_CLIENT_OPTIONS, allowInsecureConnection: true };
  assert.match(process.env.MCP_TEST_TABLE_CONNECTION_STRING, /TableEndpoint=http:\/\/127\.0\.0\.1:\d+\/[^;]+;/);
  const client = TableClient.fromConnectionString(process.env.MCP_TEST_TABLE_CONNECTION_STRING, tableName, options);
  await client.createTable();
  const config = { namespace: "integration", rateLimit: 4 };
  const first = createMcpUsage(config, client);
  const other = TableClient.fromConnectionString(process.env.MCP_TEST_TABLE_CONNECTION_STRING, tableName, options);
  const second = createMcpUsage(config, other);
  t.after(async () => { first.close(); second.close(); await client.deleteTable(); });
  await Promise.all([first.connect(), second.connect()]);
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).admit()));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.status === 429));
  assert.equal(await first.total(), 4);
  assert.equal(await second.total(), 4);
  const before = await client.getEntity(config.namespace, "usage");
  await client.updateEntity({ partitionKey: config.namespace, rowKey: "usage", windowStartedAt: new Date(0).toISOString() }, "Merge", { etag: before.etag });
  await assert.rejects(client.updateEntity({ partitionKey: config.namespace, rowKey: "usage", submissions: "999" }, "Merge", { etag: before.etag }), (error) => error.statusCode === 412);
  await second.admit();
  const replacement = createMcpUsage(config, other);
  t.after(() => replacement.close());
  await replacement.connect();
  assert.equal(await replacement.total(), 5);
  const serverConfig = await readMcpConfig(environment, new URL("nonexistent.env", import.meta.url));
  const server = createMcpHttpServer({
    config: serverConfig, usage: replacement,
    authenticate: createEntraAuthenticator(serverConfig.entra, jwks),
    getConfig: async () => ({}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/readyz`)).status, 401);
  assert.equal(await first.total(), 5);
  const mcp = new Client({ name: "table-integration", version: "1.0.0" });
  t.after(() => mcp.close());
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${await token()}` } },
  }));
  const status = await mcp.callTool({ name: "get_advisor_status", arguments: {} });
  assert.equal(status.structuredContent.totalSubmissions, 5);
  const result = await mcp.callTool({ name: "advise_agent_architecture", arguments: { scenario: "Synthetic table integration scenario" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.comparison, "incomplete");
  assert.equal(await first.total(), 6);
  const entities = [];
  for await (const entity of client.listEntities()) entities.push(entity);
  assert.equal(entities.length, 1);
  assert.deepEqual(Object.keys(entities[0]).filter((key) => !key.startsWith("odata.")).sort(), ["etag", "partitionKey", "rowKey", "schemaVersion", "submissions", "timestamp", "windowCount", "windowStartedAt"]);
  await client.deleteEntity(config.namespace, "usage", { etag: entities[0].etag });
  await assert.rejects(second.admit(), (error) => error.status === 503);
});
