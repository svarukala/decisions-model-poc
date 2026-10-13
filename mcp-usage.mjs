import { createClient } from "redis";
import { AppError } from "./router.mjs";

// One atomic admission across replicas. Both keys share a Redis Cluster hash slot.
export const ADMIT_SCRIPT = `
local rate = redis.call('GET', KEYS[1]) or '0'
local total = redis.call('GET', KEYS[2]) or '0'
if not string.match(rate, '^%d+$') or not string.match(total, '^%d+$') then
  return redis.error_reply('Invalid counter state')
end
if tonumber(total) >= 9007199254740991 then
  return redis.error_reply('Submission counter exhausted')
end
if tonumber(rate) >= tonumber(ARGV[1]) then
  return {0, redis.call('PTTL', KEYS[1])}
end
redis.call('INCR', KEYS[1])
if tonumber(rate) == 0 then redis.call('PEXPIRE', KEYS[1], 60000) end
redis.call('INCR', KEYS[2])
return {1, 0}
`;

export function createMcpUsage({ redisUrl, namespace, rateLimit }, client = createClient({
  url: redisUrl,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 256,
  socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 5000) },
})) {
  const prefix = `{${namespace}}`;
  const rateKey = `${prefix}:rate`;
  const totalKey = `${prefix}:submissions`;
  client.on("error", () => console.error("MCP Redis connection error."));
  async function command(run) {
    try {
      return await run(client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }));
    } catch {
      // Never log Redis URLs, credentials, or command arguments.
      console.error("MCP shared usage store unavailable.");
      throw new AppError(503, "Shared usage storage is unavailable. No provider request was started. Ask the operator to check Redis.");
    }
  }
  return {
    async connect() {
      const deadline = setTimeout(() => { if (client.isOpen) client.destroy(); }, 5000);
      try { await command(() => client.connect()); } finally { clearTimeout(deadline); }
    },
    async ready() { await command((connection) => connection.ping()); },
    async admit() {
      const result = await command((connection) => connection.eval(ADMIT_SCRIPT, {
        keys: [rateKey, totalKey], arguments: [String(rateLimit)],
      }));
      if (!Array.isArray(result) || ![0, 1].includes(result[0])) {
        console.error("MCP shared usage store returned an invalid admission.");
        throw new AppError(503, "Shared usage storage returned an invalid admission. No provider request was started.");
      }
      if (result[0] === 0) throw new AppError(429, "The shared advisor rate limit was reached. Wait at least 60 seconds before retrying.");
    },
    async total() {
      const text = await command((connection) => connection.get(totalKey));
      const total = text === null ? 0 : Number(text);
      if ((text !== null && !/^\d+$/.test(text)) || !Number.isSafeInteger(total) || total < 0) {
        console.error("MCP aggregate counter is invalid.");
        throw new AppError(503, "The shared submission counter is invalid. Ask the operator to check Redis.");
      }
      return total;
    },
    close() { if (client.isOpen) client.destroy(); },
  };
}
