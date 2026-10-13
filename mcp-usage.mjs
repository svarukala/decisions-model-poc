import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "./router.mjs";
import { isGuid } from "./mcp-auth.mjs";

export const TABLE_CLIENT_OPTIONS = { retryOptions: { maxRetries: 0 } };

const storageErrorCode = (error) => error.details?.errorCode ?? error.code;

export function readTableConfig(settings, prefix = "MCP") {
  const value = (name) => settings[`${prefix}_${name}`];
  let table;
  try { table = new URL(value("TABLE_ENDPOINT")); } catch { throw new AppError(503, `Set ${prefix}_TABLE_ENDPOINT to your Azure Storage Table HTTPS endpoint.`); }
  if (table.protocol !== "https:" || !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(table.hostname) ||
    table.port || table.pathname !== "/" || table.username || table.password || table.search || table.hash) {
    throw new AppError(503, `${prefix}_TABLE_ENDPOINT must be https://ACCOUNT.table.core.windows.net without paths, keys or SAS tokens.`);
  }
  const tableName = value("TABLE_NAME") || "AdvisorUsage";
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tableName)) throw new AppError(503, `${prefix}_TABLE_NAME must be 3-63 alphanumeric characters starting with a letter.`);
  const namespace = value("TABLE_NAMESPACE") || (prefix === "WEB" ? "web" : "architecture-advisor");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new AppError(503, `${prefix}_TABLE_NAMESPACE must contain 1-64 letters, digits, underscores or hyphens.`);
  const tableCredential = value("TABLE_CREDENTIAL") || "default";
  if (!["default", "managed-identity"].includes(tableCredential)) throw new AppError(503, `${prefix}_TABLE_CREDENTIAL must be default or managed-identity.`);
  const managedIdentityClientId = value("TABLE_MANAGED_IDENTITY_CLIENT_ID")?.trim() || "";
  if (managedIdentityClientId && !isGuid(managedIdentityClientId)) throw new AppError(503, `${prefix}_TABLE_MANAGED_IDENTITY_CLIENT_ID must be a GUID.`);
  return { tableEndpoint: table.origin, tableName, tableCredential, managedIdentityClientId, namespace };
}

export function createTableClient(config) {
  const credential = config.tableCredential === "managed-identity"
    ? new ManagedIdentityCredential(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {})
    : new DefaultAzureCredential({ managedIdentityClientId: config.managedIdentityClientId || undefined });
  return new TableClient(config.tableEndpoint, config.tableName, credential, TABLE_CLIENT_OPTIONS);
}

function validate(entity) {
  const total = Number(entity.submissions);
  const start = typeof entity.windowStartedAt === "string" ? Date.parse(entity.windowStartedAt) : NaN;
  if (
    entity.schemaVersion !== 1 || typeof entity.submissions !== "string" ||
    !/^(0|[1-9]\d*)$/.test(entity.submissions) || !Number.isSafeInteger(total) || total < 0 ||
    !Number.isSafeInteger(entity.windowCount) || entity.windowCount < 0 ||
    entity.windowCount > total || !Number.isFinite(start) || start < 0 ||
    new Date(start).toISOString() !== entity.windowStartedAt ||
    typeof entity.etag !== "string" || !entity.etag || entity.etag === "*"
  ) throw new AppError(503, "The shared Table usage entity is invalid. Ask the operator to check storage; no inference was started.");
  return { total, start };
}

export function createMcpUsage(config, client = createTableClient(config), {
  backoff = (attempt, signal) => sleep(Math.min(20 * (attempt + 1), 150) + Math.random() * 30, undefined, { signal }),
} = {}) {
  const partitionKey = config.namespace;
  const rowKey = "usage";
  const closed = new AbortController();
  const signal = () => AbortSignal.any([closed.signal, AbortSignal.timeout(5000)]);
  async function guarded(work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error("MCP Table usage storage unavailable.");
      throw new AppError(503, "Shared Table usage storage is unavailable. No provider request was started. Check storage access and configuration.");
    }
  }
  async function read(abortSignal) {
    let serviceTime;
    const entity = await client.getEntity(partitionKey, rowKey, {
      abortSignal,
      onResponse: (response) => { serviceTime = Date.parse(response.headers.get("date")); },
    });
    const state = validate(entity);
    // Storage's clock, not each replica's clock, controls window expiration.
    if (!Number.isFinite(serviceTime) || serviceTime < state.start) {
      throw new AppError(503, "Table service time is missing or inconsistent. No inference was started.");
    }
    return { entity, ...state, serviceTime };
  }
  return {
    async connect() {
      await guarded(async () => {
        const abortSignal = signal();
        try {
          await read(abortSignal);
          return;
        } catch (error) {
          if (error.statusCode !== 404 || storageErrorCode(error) !== "ResourceNotFound") throw error;
        }
        // Bootstrap only at startup, never recreate a missing counter during admission.
        try {
          await client.createEntity({
            partitionKey, rowKey, schemaVersion: 1, submissions: "0",
            windowCount: 0, windowStartedAt: new Date(0).toISOString(),
          }, { abortSignal });
        } catch (error) {
          if (error.statusCode !== 409 || storageErrorCode(error) !== "EntityAlreadyExists") throw error;
        }
        await read(abortSignal);
      });
    },
    async ready() { await guarded(() => read(signal())); },
    async total() { return guarded(async () => (await read(signal())).total); },
    async admit() {
      await guarded(async () => {
        const abortSignal = signal();
        for (let attempt = 0; attempt < 8; attempt++) {
          abortSignal.throwIfAborted();
          const state = await read(abortSignal);
          if (state.total >= Number.MAX_SAFE_INTEGER) throw new AppError(503, "The shared submission counter is exhausted.");
          const expired = state.serviceTime - state.start >= 60000;
          const count = expired ? 0 : state.entity.windowCount;
          if (count >= config.rateLimit) throw new AppError(429, "The shared advisor rate limit was reached. Wait at least 60 seconds before retrying.");
          try {
            await client.updateEntity({
              partitionKey, rowKey, schemaVersion: 1,
              submissions: String(state.total + 1), windowCount: count + 1,
              windowStartedAt: expired ? new Date(state.serviceTime).toISOString() : state.entity.windowStartedAt,
            }, "Replace", { etag: state.entity.etag, abortSignal });
            return;
          } catch (error) {
            // Only a definite ETag rejection is safe to replay. Timeouts/5xx may have committed.
            if (error.statusCode !== 412) throw error;
          }
          if (attempt < 7) await backoff(attempt, abortSignal);
        }
        throw new AppError(503, "Shared admission is busy. No inference was started; try again later.");
      });
    },
    close() { closed.abort(); },
  };
}
