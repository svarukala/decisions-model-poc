import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AppError, classify, readConfig, validateInput, ENDPOINT } from "./router.mjs";
import { createUsageStore } from "./usage.mjs";
import { advisorStatus, compareArchitectures } from "./advisor.mjs";

function send(res, status, payload, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(type === "application/json" ? JSON.stringify(payload) : payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new AppError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new AppError(400, "Request must contain valid JSON.");
    throw error;
  }
}

export function createApp({ getConfig = readConfig, classifyPrompt = classify, compareScenario = compareArchitectures, usage = createUsageStore() } = {}) {
  let inFlight = false;
  let requests = [];
  const server = createServer(async (req, res) => {
    try {
      const config = await getConfig();
      const port = req.socket.localPort;
      const allowedOrigins = new Map([
        [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
        [`localhost:${port}`, `http://localhost:${port}`],
      ]);
      if (config.publicOrigin) {
        allowedOrigins.set(new URL(config.publicOrigin).host, config.publicOrigin);
      }
      // Match the configured external origin, not untrusted forwarded headers.
      const requestOrigin = allowedOrigins.get(req.headers.host);
      if (!requestOrigin) throw new AppError(403, "Host is not allowed. Configure PUBLIC_ORIGIN for your exact HTTPS tunnel URL.");
      const pathname = new URL(req.url, requestOrigin).pathname;
      if (req.method === "GET" && pathname === "/") {
        return send(res, 200, await readFile(new URL("index.html", import.meta.url), "utf8"), "text/html");
      }
      if (req.method === "GET" && (pathname === "/advisor" || pathname === "/advisor/")) {
        return send(res, 200, await readFile(new URL("advisor.html", import.meta.url), "utf8"), "text/html");
      }
      if (req.method === "GET" && pathname === "/api/advisor/status") {
        return send(res, 200, { ...advisorStatus(config), totalSubmissions: usage.total() });
      }
      if (req.method === "GET" && pathname === "/api/status") {
        return send(res, 200, {
          configured: Boolean(config.apiKey), model: config.model,
          endpoint: ENDPOINT, totalSubmissions: usage.total(),
        });
      }
      if (req.method !== "POST" || !["/api/classify", "/api/advisor"].includes(pathname)) throw new AppError(404, "Not found.");
      if (
        (req.headers.origin && req.headers.origin !== requestOrigin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        throw new AppError(403, "Cross-site requests are not allowed.");
      }
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new AppError(415, "Use application/json.");
      }
      const now = Date.now();
      requests = requests.filter((time) => now - time < 60000);
      if (inFlight || requests.length >= 30) {
        throw new AppError(429, "Please wait. One request at a time and at most 30 requests per minute are allowed.");
      }
      // Reserve the slot before reading the body, so concurrent submissions cannot race.
      inFlight = true;
      requests.push(now);
      try {
        const input = validateInput(await readJson(req));
        usage.increment();
        const result = await (pathname === "/api/advisor" ? compareScenario : classifyPrompt)(input, config);
        send(res, 200, result);
      } finally {
        inFlight = false;
      }
    } catch (error) {
      if (!(error instanceof AppError)) console.error("Unexpected request failure:", error.name);
      if (!res.headersSent && !res.destroyed) {
        send(res, error instanceof AppError ? error.status : 500, {
          error: error instanceof AppError ? error.message : "Unexpected server error. See the server console.",
        });
      }
    }
  });
  server.on("close", () => usage.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await readConfig();
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const server = createApp();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Jev router: http://127.0.0.1:${config.port}`);
    console.log(config.apiKey ? "TypeSafe API key configured." : "Setup needed: copy .env.example to .env and add TYPESAFE_API_KEY.");
    if (config.publicOrigin) {
      console.warn(`Public access enabled without authentication: ${config.publicOrigin}. Visitors can consume Jev and Azure credits. Only an aggregate submission count is stored locally.`);
    }
  });
}
