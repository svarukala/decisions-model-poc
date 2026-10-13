import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AppError, parsePublicOrigin, readConfig, readLocalEnv } from "./router.mjs";
import { ADVISOR_REFERENCE, CATALOG, RUBRIC_VERSION, SIGNALS, advisorStatus, compareArchitectures } from "./advisor.mjs";
import { createMcpUsage } from "./mcp-usage.mjs";
import { authChallenge, createEntraAuthenticator, isGuid, protectedResourceMetadata, readEntraConfig } from "./mcp-auth.mjs";

function integer(value, fallback, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new AppError(503, `${label} must be an integer from 1 to ${maximum}.`);
  return parsed;
}

export async function readMcpConfig(env = process.env, file) {
  const settings = { ...await readLocalEnv(file), ...env };
  const entra = readEntraConfig(settings);
  const publicOrigin = parsePublicOrigin(settings.MCP_PUBLIC_ORIGIN || "");
  const host = settings.MCP_HOST || "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new AppError(503, "MCP_HOST must be 127.0.0.1 or 0.0.0.0.");
  if (host === "0.0.0.0" && !publicOrigin) throw new AppError(503, "Set MCP_PUBLIC_ORIGIN to the HTTPS gateway origin before binding MCP to all interfaces.");
  let table;
  try { table = new URL(settings.MCP_TABLE_ENDPOINT); } catch { throw new AppError(503, "Set MCP_TABLE_ENDPOINT to your Azure Storage Table HTTPS endpoint."); }
  if (table.protocol !== "https:" || !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(table.hostname) ||
    table.port || table.pathname !== "/" || table.username || table.password || table.search || table.hash) {
    throw new AppError(503, "MCP_TABLE_ENDPOINT must be https://ACCOUNT.table.core.windows.net without paths, keys or SAS tokens.");
  }
  const tableName = settings.MCP_TABLE_NAME || "AdvisorUsage";
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tableName)) throw new AppError(503, "MCP_TABLE_NAME must be 3-63 alphanumeric characters starting with a letter.");
  const namespace = settings.MCP_TABLE_NAMESPACE || "architecture-advisor";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new AppError(503, "MCP_TABLE_NAMESPACE must contain 1-64 letters, digits, underscores or hyphens.");
  const tableCredential = settings.MCP_TABLE_CREDENTIAL || "default";
  if (!["default", "managed-identity"].includes(tableCredential)) throw new AppError(503, "MCP_TABLE_CREDENTIAL must be default or managed-identity.");
  const managedIdentityClientId = settings.MCP_TABLE_MANAGED_IDENTITY_CLIENT_ID?.trim() || "";
  if (managedIdentityClientId && !isGuid(managedIdentityClientId)) throw new AppError(503, "MCP_TABLE_MANAGED_IDENTITY_CLIENT_ID must be a GUID.");
  return {
    host, publicOrigin, entra,
    port: integer(settings.MCP_PORT, 3002, 65535, "MCP_PORT"),
    maxConcurrent: integer(settings.MCP_MAX_CONCURRENT, 8, 128, "MCP_MAX_CONCURRENT"),
    rateLimit: integer(settings.MCP_RATE_LIMIT, 60, 100000, "MCP_RATE_LIMIT"),
    tableEndpoint: table.origin, tableName, tableCredential, managedIdentityClientId, namespace,
  };
}

const architecture = z.enum(Object.keys(CATALOG));
const providerResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("error"), error: z.string(), durationMs: z.number() }),
  z.object({
    status: z.literal("success"), recommendation: architecture, modelChoice: architecture,
    ranking: z.array(z.object({ key: architecture, probability: z.number().min(0).max(1) })),
    signals: z.object(Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, z.number().min(0).max(1)]))),
    confidence: z.number().nullable(), explanation: z.string(), policyReasons: z.array(z.string()),
    supportingComponents: z.array(z.string()), model: z.string(), durationMs: z.number(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number().nullable() }).nullable(),
  }),
]);
const comparisonSchema = {
  rubricVersion: z.string(),
  comparison: z.enum(["agree", "disagree", "needs_clarification", "incomplete"]),
  providers: z.object({ jev: providerResult, decision: providerResult }),
};
const catalog = {
  rubricVersion: RUBRIC_VERSION, catalog: CATALOG, signalLabels: SIGNALS, reference: ADVISOR_REFERENCE,
  limitations: "Advisory only. Verify tenant capabilities, costs and permissions. Explanations are templates; probabilities are not measured accuracy. Input goes to both configured providers. No scenario text is persisted by this server.",
};
function toolResult(result, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, ...(isError ? { isError: true } : {}) };
}
function toolError(error) {
  if (!(error instanceof AppError)) console.error("MCP tool failed unexpectedly.");
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof AppError ? error.message : "Advisor execution failed. Ask the operator to check the service." }],
  };
}

export function createAdvisorMcp({ getConfig, usage, advise, runAdvice }) {
  const server = new McpServer({ name: "microsoft-agent-architecture-advisor", version: "2.0.0" });
  server.registerTool("get_architecture_catalog", {
    title: "Get Microsoft agent architecture options",
    description: "Read supported development approaches, prerequisites, source documentation, capability signals and rubric version. No model calls or charges.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(catalog));
  server.registerResource("architecture-catalog", "architecture-advisor://catalog", {
    description: "Versioned architecture rubric and platform documentation.", mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(catalog) }] }));
  server.registerTool("get_advisor_status", {
    title: "Get advisor readiness and aggregate usage",
    description: "Read provider configuration presence and total admitted MCP comparisons across replicas. Configuration presence does not verify provider credentials or quota. No model calls.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return toolResult({ rubricVersion: RUBRIC_VERSION, providers: advisorStatus(await getConfig()).providers, totalSubmissions: await usage.total(), scope: "mcp" });
    } catch (error) { return toolError(error); }
  });
  server.registerTool("advise_agent_architecture", {
    title: "Compare Microsoft agent architectures",
    description: "Recommend a primary development approach for a scenario using real Jev and Microsoft-Decision-1 in parallel. Includes Cowork plugins, declarative agents, Studio harnesses, Foundry agents, workflows and no-build/clarify options. Sends supplied text to both configured providers, incurs usage charges and increments a shared counter once. Does not build, deploy or execute the proposed solution. Use only approved non-sensitive input. Consult get_architecture_catalog for option names and prerequisites. Inspect each provider status: incomplete results have isError=true but may contain a valid result from the other provider. Never treat agreement as an accuracy guarantee or automatically retry billed calls.",
    inputSchema: {
      scenario: z.string().trim().min(1).max(8000).describe("Desired outcome, intended users and user experience."),
      requirements: z.string().max(3000).optional().describe("Channels, data/actions, runtime ownership, model needs, governance and budget. Do not include secrets."),
    },
    outputSchema: comparisonSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ scenario, requirements }, extra) => {
    try {
      return await runAdvice(async () => {
        if (extra.signal.aborted) throw new AppError(499, "The caller cancelled the request before admission.");
        const settings = await getConfig();
        await usage.admit();
        // Admission is counted even when a provider fails. Never replay it automatically.
        const result = await advise({ prompt: scenario, context: requirements || "" }, settings);
        return toolResult(result, result.comparison === "incomplete");
      });
    } catch (error) { return toolError(error); }
  });
  return server;
}

function sendError(res, status, message) {
  if (res.headersSent || res.destroyed) return;
  if (status === 429) res.setHeader("Retry-After", "60");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new AppError(413, "MCP request exceeds 64 KiB.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (Array.isArray(body)) throw new AppError(400, "JSON-RPC batch requests are not supported.");
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AppError(400, "MCP request must contain valid JSON.");
    throw error;
  }
}

export function createMcpHttpServer({ config, usage, getConfig = readConfig, advise = compareArchitectures, authenticate = createEntraAuthenticator(config.entra) }) {
  let activeAdvice = 0;
  let activeHttp = 0;
  let draining = false;
  async function runAdvice(work) {
    if (draining || activeAdvice >= config.maxConcurrent) throw new AppError(429, "This replica is busy. Wait before retrying; no provider request was started.");
    activeAdvice++;
    try { return await work(); } finally { activeAdvice--; }
  }
  const httpServer = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let mcp;
    let reserved = false;
    const canonicalOrigin = config.publicOrigin || `http://127.0.0.1:${req.socket.localPort}`;
    try {
      const localPort = req.socket.localPort;
      const origins = new Map([
        [`127.0.0.1:${localPort}`, `http://127.0.0.1:${localPort}`],
        [`localhost:${localPort}`, `http://localhost:${localPort}`],
      ]);
      if (config.publicOrigin) origins.set(new URL(config.publicOrigin).host, config.publicOrigin);
      const origin = origins.get(req.headers.host);
      if (!origin || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
        throw new AppError(403, "Host or Origin is not allowed.");
      }
      const url = new URL(req.url, origin);
      if (url.search) throw new AppError(400, "Query parameters are not supported. Supply the access token in the Authorization header.");
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(draining ? 503 : 200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: draining ? "draining" : "ok" }));
      }
      if (req.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(protectedResourceMetadata(config.entra, canonicalOrigin)));
      }
      if (!["/mcp", "/readyz"].includes(url.pathname)) throw new AppError(404, "Not found.");
      if (draining) throw new AppError(503, "This replica is shutting down.");
      if (activeHttp >= config.maxConcurrent + 16) throw new AppError(429, "This replica is busy. Wait before retrying.");
      activeHttp++;
      reserved = true;
      await authenticate(req.headers.authorization);
      if (url.pathname === "/readyz" && req.method === "GET") {
        await usage.ready();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ready" }));
      }
      if (url.pathname !== "/mcp") throw new AppError(405, "Method not allowed.");
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        throw new AppError(405, "Stateless MCP supports POST only; there is no persistent SSE session.");
      }
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError(415, "Use application/json.");
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new AppError(415, "Compressed requests are not supported.");
      const body = await readBody(req);
      mcp = createAdvisorMcp({ getConfig, usage, advise, runAdvice });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!(error instanceof AppError)) console.error("MCP HTTP request failed unexpectedly.");
      if ([401, 403].includes(error.status) && !res.headersSent && !res.destroyed) {
        res.setHeader("WWW-Authenticate", authChallenge(config.entra, canonicalOrigin, error.status));
      }
      sendError(res, error instanceof AppError ? error.status : 500, error instanceof AppError ? error.message : "Unexpected MCP server error.");
    } finally {
      if (mcp) {
        try { await mcp.close(); } catch { console.error("MCP transport cleanup failed."); }
      }
      if (reserved) activeHttp--;
    }
  });
  httpServer.requestTimeout = 30000;
  httpServer.headersTimeout = 10000;
  httpServer.keepAliveTimeout = 5000;
  httpServer.on("close", () => usage.close());
  httpServer.drain = () => { draining = true; };
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let usage;
  try {
    const config = await readMcpConfig();
    usage = createMcpUsage(config);
    await usage.connect();
    const server = createMcpHttpServer({ config, usage });
    server.on("error", () => { console.error("MCP listener failed. Check the configured bind address and port."); usage.close(); process.exitCode = 1; });
    server.listen(config.port, config.host, () => {
      console.log(`Architecture MCP listening on port ${config.port}; Entra access tokens required.`);
      console.log(`Shared limit: ${config.rateLimit} comparisons/minute; concurrency per replica: ${config.maxConcurrent}.`);
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.drain();
      server.close(() => { clearTimeout(deadline); });
      const deadline = setTimeout(() => { server.closeAllConnections(); usage.close(); }, 25000);
      deadline.unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    // Configuration errors are authored messages, never external connection details.
    console.error(error instanceof AppError ? error.message : "MCP startup failed. Check Entra, Table Storage, bind/origin and numeric settings.");
    usage?.close();
    process.exitCode = 1;
  }
}
