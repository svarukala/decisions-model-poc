import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteJWKSet, customFetch, exportJWK, generateKeyPair } from "jose";
import { createEntraAuthenticator } from "../mcp-auth.mjs";
import { entra, jwk, jwks, token } from "./fixtures/entra.mjs";

test("Entra accepts valid signed delegated tokens and explicitly enabled app-only roles", async () => {
  const auth = createEntraAuthenticator(entra, jwks);
  await auth(`Bearer ${await token()}`);
  const app = await token({ scp: undefined, roles: ["Advisor.Invoke.All"], idtyp: "app" });
  await assert.rejects(auth(`Bearer ${app}`), (error) => error.status === 403);
  const appAuth = createEntraAuthenticator({ ...entra, appRole: "Advisor.Invoke.All" }, jwks);
  await appAuth(`Bearer ${app}`);
  for (const claims of [
    { scp: undefined, roles: ["Advisor.Invoke.All"] },
    { scp: undefined, roles: ["Other"], idtyp: "app" },
    { idtyp: "app" }, { scp: "Other" }, { scp: ["Advisor.Invoke"] },
  ]) await assert.rejects(appAuth(`Bearer ${await token(claims)}`), (error) => error.status === 403);
});

test("Entra rejects expired, premature, wrong tenant/issuer/audience, ID and invalidly signed tokens", async () => {
  const auth = createEntraAuthenticator(entra, jwks);
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { exp: now - 60 }, { nbf: now + 120 }, { exp: undefined }, { nbf: undefined },
    { tid: "44444444-4444-4444-8444-444444444444" },
    { iss: "https://untrusted.example/v2.0" }, { aud: "00000003-0000-0000-c000-000000000000" },
    { aud: [entra.clientId, "other"] }, { ver: "1.0" }, { azp: undefined },
  ]) await assert.rejects(auth(`Bearer ${await token(claims)}`), (error) => error.status === 401);
  await assert.rejects(auth(`Bearer ${await token({ scp: undefined, nonce: "id-token" })}`), (error) => error.status === 403);
  const wrongKeys = await generateKeyPair("RS256");
  await assert.rejects(auth(`Bearer ${await token({}, wrongKeys.privateKey)}`), (error) => error.status === 401);
  const symmetric = new Uint8Array(32).fill(1);
  await assert.rejects(auth(`Bearer ${await token({}, symmetric, { alg: "HS256" })}`), (error) => error.status === 401);
  for (const value of ["", "Basic abc", "Bearer legacy_api_key_0123456789abcdef", "Bearer a.b.c", `Bearer ${"a".repeat(12001)}.b.c`]) {
    await assert.rejects(auth(value), (error) => error.status === 401);
  }
});

test("Entra uses the configured signing-key endpoint, caches keys, and fails closed on key-service failure", async () => {
  let calls = 0;
  let publishedKeys = [jwk];
  const remote = createRemoteJWKSet(new URL(entra.jwksUri), {
    cooldownDuration: 0,
    [customFetch]: async (url) => {
      calls++;
      assert.equal(String(url), entra.jwksUri);
      return Response.json({ keys: publishedKeys });
    },
  });
  const auth = createEntraAuthenticator(entra, remote);
  const value = await token();
  await auth(`Bearer ${value}`);
  await auth(`Bearer ${value}`);
  assert.equal(calls, 1);
  const rotated = await generateKeyPair("RS256");
  publishedKeys = [jwk, { ...await exportJWK(rotated.publicKey), kid: "rotated-key", alg: "RS256", use: "sig" }];
  await auth(`Bearer ${await token({}, rotated.privateKey, { kid: "rotated-key" })}`);
  assert.equal(calls, 2);
  const down = createRemoteJWKSet(new URL(entra.jwksUri), {
    [customFetch]: async () => { throw new TypeError("Private network details"); },
  });
  await assert.rejects(createEntraAuthenticator(entra, down)(`Bearer ${value}`), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /Private network|eyJ/);
    return true;
  });
});
