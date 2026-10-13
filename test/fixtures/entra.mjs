import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { readEntraConfig } from "../../mcp-auth.mjs";

export const environment = {
  MCP_ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  MCP_ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  MCP_TABLE_ENDPOINT: "https://synthetic.table.core.windows.net",
};
export const entra = readEntraConfig(environment);
export const keys = await generateKeyPair("RS256");
export const jwk = { ...await exportJWK(keys.publicKey), kid: "synthetic-signing-key", alg: "RS256", use: "sig" };
export const jwks = createLocalJWKSet({ keys: [jwk] });
export async function token(claims = {}, key = keys.privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: entra.tenantId, ver: "2.0", iss: entra.issuer, aud: entra.clientId,
    azp: "33333333-3333-4333-8333-333333333333",
    scp: entra.scope, iat: now, nbf: now - 5, exp: now + 300, ...claims,
  }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...header }).sign(key);
}
