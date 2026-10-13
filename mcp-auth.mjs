import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError } from "./router.mjs";

export const isGuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function readEntraConfig(settings) {
  const tenantId = settings.MCP_ENTRA_TENANT_ID?.trim().toLowerCase();
  const clientId = settings.MCP_ENTRA_CLIENT_ID?.trim().toLowerCase();
  if (!isGuid(tenantId) || !isGuid(clientId)) throw new AppError(503, "Set MCP_ENTRA_TENANT_ID and MCP_ENTRA_CLIENT_ID to your tenant and API app-registration GUIDs.");
  const scope = settings.MCP_ENTRA_SCOPE || "Advisor.Invoke";
  const appRole = settings.MCP_ENTRA_APP_ROLE || "";
  if (![scope, ...(appRole ? [appRole] : [])].every((value) => /^[A-Za-z0-9._-]{1,100}$/.test(value))) {
    throw new AppError(503, "Entra scope and app-role names must contain only letters, digits, dots, underscores or hyphens.");
  }
  return {
    tenantId, clientId, scope, appRole,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    fullScope: `api://${clientId}/${scope}`,
  };
}

export function protectedResourceMetadata(entra, origin) {
  return {
    resource: `${origin}/mcp`,
    resource_name: "Microsoft Agent Architecture Advisor",
    authorization_servers: [entra.issuer],
    scopes_supported: [entra.fullScope],
    bearer_methods_supported: ["header"],
  };
}

export function authChallenge(entra, origin, status) {
  const error = status === 403 ? "insufficient_scope" : "invalid_token";
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${entra.fullScope}", error="${error}"`;
}

const invalidTokenCodes = new Set([
  "ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID", "ERR_JWT_INVALID", "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_NO_MATCHING_KEY",
]);

export function createEntraAuthenticator(entra, jwks = createRemoteJWKSet(new URL(entra.jwksUri), {
  timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000,
})) {
  return async (authorization) => {
    const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match || match[1].length > 12000) throw new AppError(401, "A valid Entra access token is required.");
    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], jwks, {
        algorithms: ["RS256"], issuer: entra.issuer, audience: entra.clientId,
        requiredClaims: ["exp", "nbf", "iat", "tid", "ver", "azp"],
        clockTolerance: 30,
      }));
    } catch (error) {
      if (invalidTokenCodes.has(error.code)) throw new AppError(401, "The Entra access token is invalid or expired.");
      console.error("MCP Entra signing-key validation unavailable.");
      throw new AppError(503, "Entra token validation is temporarily unavailable. No inference was started.");
    }
    if (payload.tid !== entra.tenantId || payload.ver !== "2.0" || payload.aud !== entra.clientId || !isGuid(payload.azp)) {
      throw new AppError(401, "The access token does not target this tenant and API.");
    }
    if (typeof payload.scp === "string" && payload.idtyp !== "app" && payload.scp.split(" ").includes(entra.scope)) return;
    // idtyp=app prevents a user/ID token carrying a role from authorizing app-only access.
    if (entra.appRole && payload.idtyp === "app" && payload.scp === undefined &&
      Array.isArray(payload.roles) && payload.roles.includes(entra.appRole)) return;
    throw new AppError(403, "The token lacks the required delegated scope or an enabled application permission.");
  };
}
