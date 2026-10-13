import { pathToFileURL } from "node:url";
import { createApp } from "./server.mjs";
import { AppError, readConfig, readLocalEnv } from "./router.mjs";
import { createMcpUsage, readTableConfig } from "./mcp-usage.mjs";

export async function readCloudWebConfig(env = process.env, file) {
  const settings = { ...await readLocalEnv(file), ...env };
  const web = await readConfig(settings, file);
  if (!web.publicOrigin) throw new AppError(503, "PUBLIC_ORIGIN is required for the public cloud web host.");
  if (!Number.isInteger(web.port) || web.port < 1 || web.port > 65535) throw new AppError(503, "PORT must be between 1 and 65535.");
  const rateLimit = Number(settings.WEB_RATE_LIMIT || 30);
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) throw new AppError(503, "WEB_RATE_LIMIT must be between 1 and 100000.");
  return { web, table: { ...readTableConfig(settings, "WEB"), rateLimit } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let store;
  try {
    const { web, table } = await readCloudWebConfig();
    store = createMcpUsage(table);
    await store.connect();
    const server = createApp({
      getConfig: async () => web,
      usage: { total: () => store.total(), increment: () => store.admit(), close: () => store.close() },
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.on("error", () => { console.error("Cloud web listener failed."); store.close(); process.exitCode = 1; });
    server.listen(web.port, "0.0.0.0", () => {
      console.log(`Public web demos listening on port ${web.port}; aggregate usage persists in Table Storage.`);
      console.warn("Public visitors can consume provider credits. No sign-in is required.");
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => { server.closeAllConnections(); store.close(); }, 25000);
      deadline.unref();
      server.close(() => clearTimeout(deadline));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof AppError ? error.message : "Cloud web startup failed. Check storage, origin and provider configuration.");
    store?.close();
    process.exitCode = 1;
  }
}
