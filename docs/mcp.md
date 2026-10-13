# Architecture Advisor MCP: Entra ID + Azure Table Storage

The MCP service is a separate, stateless **Streamable HTTP** endpoint at `/mcp`.
It uses the same Jev / Microsoft-Decision-1 architecture rubric as the web demo.
It now requires **single-tenant Microsoft Entra v2 access tokens** and uses
**Azure Storage Tables** for atomic shared admission and aggregate usage.
There is no shared-client-key, Redis, anonymous-inference or in-memory fallback.
The public web demo and its SQLite counter are unchanged.
The optional [Azure deployment](azure.md) instead runs the public web demos
with a separate Table counter; local `npm start` retains SQLite.

This repository implements the server, not Azure provisioning. Live tenant
sign-in, client consent, managed identity, RBAC, networking, and model access
must be configured and verified in your environment.

## Tools

| Tool / resource | Purpose | Model usage |
|---|---|---|
| `get_architecture_catalog` | Options, prerequisites, sources and rubric | None |
| `get_advisor_status` | Provider configuration presence and aggregate MCP count | None |
| `advise_agent_architecture` | Compare both providers using `scenario` and optional `requirements` | Both configured providers |
| `architecture-advisor://catalog` | Read-only resource for the catalog | None |

The advice tool accepts a nonblank scenario up to 8,000 characters and optional
requirements up to 3,000. It returns JSON as text and `structuredContent`, with
an advertised output schema. It does not build, deploy, or execute an agent.
Calls incur model charges and increment usage, so they are not idempotent.
Never automatically retry billed requests.

Inspect `comparison` and each provider's `status`. Partial failures return
`isError: true` together with the structured partial result, including any valid
result from the other provider. Configuration presence is not proof of working
credentials, quota or model access.

## 1. Create the Entra API registration

In Microsoft Entra admin center, open **App registrations > New registration**.

1. Register an API such as `Architecture Advisor MCP`, with accounts in your
   organizational directory only. The server supports the Azure public cloud.
2. Record the **Directory (tenant) ID** and this API's **Application (client) ID**.
   Neither is a secret. Do not confuse the API ID with a calling client's ID.
3. In the manifest, set `api.requestedAccessTokenVersion` to `2`.
4. Under **Expose an API**, set the Application ID URI to `api://<API-CLIENT-ID>`.
5. Add delegated scope `Advisor.Invoke`. For controlled internal access, select
   **Admins only** for consent and grant it only to approved client applications.
6. Register or configure each calling application's redirect URI and delegated
   permission `api://<API-CLIENT-ID>/Advisor.Invoke`. Grant administrator consent
   according to your organization's policy. Use authorization code + PKCE for
   interactive public clients; do not embed a client secret in a desktop app.

No client secret is needed by the MCP API to validate incoming access tokens.
It validates signature (RS256), tenant-specific issuer, tenant ID, exact API
audience, v2 token version, expiry/not-before, and the required permission.
Signing keys come only from the configured tenant's Microsoft endpoint and
are cached. Microsoft Graph tokens, legacy API keys, unsigned tokens and ID
tokens without the required access-token permissions are rejected.

The server authorizes permission-bearing tokens from the configured tenant;
it does not maintain a user/group/client allowlist. Manage client consent,
enterprise-app assignments and guest access in Entra. Single-tenant does not
by itself exclude invited guests. Existing tokens remain usable until expiry;
this server does not implement continuous access evaluation or instant revocation.

### Optional unattended application callers

Leave `MCP_ENTRA_APP_ROLE` empty to disable app-only access (the default).
To enable approved unattended callers:

1. Add an app role such as `Advisor.Invoke.All` with allowed member type
   **Applications** on the API registration.
2. Grant that application permission to the approved client service principal
   and obtain administrator consent.
3. Add the optional **access-token** claim `idtyp` to the API registration so
   app-only tokens carry `idtyp: "app"`.
4. Set `MCP_ENTRA_APP_ROLE=Advisor.Invoke.All` on the MCP server.
5. Have the client request `api://<API-CLIENT-ID>/.default` using its supported
   application credential (prefer managed identity or federation where possible).

Both the assigned role and `idtyp=app` are required, with no delegated `scp`
claim. A user or ID token carrying a role is not accepted as app-only access.

## 2. Configure Azure Table Storage

Use an Azure Storage account with the **Table service**, not Cosmos DB. Create a
table named `AdvisorUsage` (or your configured name) before starting the server.

Enable managed identity on the Container App and grant **Storage Table Data
Contributor**, preferably scoped to this table. For local development, grant
your signed-in developer identity equivalent table data access and use
`DefaultAzureCredential`, for example through your existing Azure CLI sign-in.
Management-plane Contributor alone does not grant table data access.

The server uses no storage key or SAS token. Use the standard account URL:
`https://<account>.table.core.windows.net`. Private endpoints use the same
hostname with appropriate private DNS and network connectivity.
The process must be able to read, insert and conditionally replace the usage
entity. It does not create the table or configure RBAC.

At startup, a missing **entity** is initialized to zero; an absent **table** or
authorization failure stops startup. During operation, a deleted/malformed
entity causes failure, never an automatic reset. A restart after deliberate
entity deletion can initialize a new zero counter; restrict data-plane deletion.

## 3. Server settings

Keep the existing TypeSafe and Foundry settings in `.env`. Add:

```dotenv
MCP_ENTRA_TENANT_ID=YOUR-TENANT-GUID
MCP_ENTRA_CLIENT_ID=YOUR-MCP-API-APP-GUID
MCP_ENTRA_SCOPE=Advisor.Invoke
MCP_ENTRA_APP_ROLE=
MCP_HOST=127.0.0.1
MCP_PORT=3002
MCP_PUBLIC_ORIGIN=
MCP_TABLE_ENDPOINT=https://YOURACCOUNT.table.core.windows.net
MCP_TABLE_NAME=AdvisorUsage
MCP_TABLE_NAMESPACE=architecture-advisor
MCP_TABLE_CREDENTIAL=default
MCP_TABLE_MANAGED_IDENTITY_CLIENT_ID=
MCP_RATE_LIMIT=60
MCP_MAX_CONCURRENT=8
```

Use real GUIDs/account name in place of the placeholders.
For Azure, set `MCP_TABLE_CREDENTIAL=managed-identity`; leave the client-ID field
empty for system-assigned identity, or set the **managed identity's client ID**
for user-assigned identity. This is distinct from the MCP API app registration.
Locally, `default` selects `DefaultAzureCredential`; it may use standard Azure
environment credentials or a supported developer login.

```powershell
npm ci
npm run start:mcp
```

The local endpoint is `http://127.0.0.1:3002/mcp`. The web demo remains on port
3000. MCP configuration is read at startup; restart after changing these settings.
Provider configuration is read per advice call. **Only inbound MCP authentication
and storage authentication changed**: Jev and Decision-1 still use their existing
server-side provider keys. No user access token is forwarded to either model.

## 4. Connect MCP clients

The server publishes unauthenticated RFC 9728 protected-resource metadata at:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
```

It advertises the canonical `/mcp` resource, the tenant's Entra authorization
server, and the full delegated scope. A 401 includes a `WWW-Authenticate`
challenge with `resource_metadata` and `scope`; a missing permission returns
403 with `insufficient_scope`. Authentication does not use browser redirects
or cookies on the MCP endpoint.

Use a client that supports Entra OAuth with a **pre-registered client ID**, the
correct redirect URI, and the exposed scope. Discovery is not automatic client
registration: the server does not implement an OAuth proxy, dynamic client
registration, a login UI, or token issuance/refresh. Do not assume every MCP
client's generic "sign in" flow can register itself with Entra.

Where a client's built-in OAuth flow cannot use your registered client, a
short-lived **access token** can be supplied as a custom header for a smoke test:

```text
Authorization: Bearer <ENTRA-ACCESS-TOKEN-FOR-THIS-API>
```

For example, VS Code can prompt for a temporary token in `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "id": "architecture-access-token",
      "type": "promptString",
      "description": "Short-lived Entra access token for the Architecture Advisor API",
      "password": true
    }
  ],
  "servers": {
    "architecture-advisor": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer ${input:architecture-access-token}"
      }
    }
  }
}
```

This manual-token example **does not refresh tokens** and is not the recommended
ongoing organization-wide connection. Validate each target client's OAuth and
consent flow before rollout. Do not paste tokens into chat, source control, or URLs.

## Hosting and limits

Build with `docker build -f Dockerfile.mcp -t architecture-advisor-mcp:latest .`.
The non-root image excludes `.env`, SQLite, tests and prompt history.
In Azure Container Apps (or your approved host), configure:

| Setting | Requirement |
|---|---|
| Ingress | HTTPS, target port 3002, no publicly reachable plaintext backend |
| `MCP_HOST` | `0.0.0.0` |
| `MCP_PUBLIC_ORIGIN` | Exact canonical HTTPS origin; discovery uses this value |
| Storage identity | Managed identity with table data permissions |
| Replica consistency | Same table, namespace, rate limit, Entra settings and rubric |
| Model secrets | Secure secret references; no tokens/body logging |
| Shutdown/request time | At least 30 seconds; no automatic POST retries |

Preserve Host and Authorization headers. Forwarded headers do not override
host checks. Only exact approved browser origins are accepted; permissive CORS
is not enabled. This remains stateless POST-only MCP: GET/DELETE `/mcp` return
405, and no sticky sessions or persistent SSE connections are needed.
OAuth metadata and liveness must remain reachable without an authentication
gateway redirect. Put connection/WAF controls in front of the service.

`MCP_RATE_LIMIT` limits admitted comparisons across replicas in a fixed
60-second window. `MCP_MAX_CONCURRENT` limits in-flight advice **per replica**.
There is no queue, per-user rate tracking, token billing cap, or unlimited-scale
guarantee. A shared Table entity is appropriate for this low-volume pilot;
contention and storage latency make it a bottleneck at higher traffic.
Measure before increasing limits.

The one entity uses `PartitionKey=<namespace>`, `RowKey=usage` and contains:
`schemaVersion`, a decimal-string `submissions` total, `windowCount`, and
`windowStartedAt`. Azure also adds its entity timestamp and ETag. No prompts,
requirements, responses, identities, IPs, tokens, or request IDs are stored.
Unlike the old Redis implementation, window timing metadata is persisted.

Every admission uses the Table service's response clock and an ETag-conditional
replacement updating count and window together. Only definite 412 conflicts
are retried (at most eight attempts within a five-second operation deadline);
generic SDK retries are disabled. An outage, ambiguous write failure, invalid
state or exhausted conflict budget rejects inference. A lost acknowledgement
can count an attempt without starting inference; this is operational usage,
not exactly-once processing or billing-grade accounting.

Calls count once even if either provider fails or is unconfigured. Invalid,
unauthorized, locally busy and shared-rate-rejected calls do not count.
Catalog/status reads do not count. The MCP total remains separate from the web
demo's SQLite counter. Disconnecting a caller does not guarantee cancellation
of already-started model work.

`GET /healthz` is minimal unauthenticated liveness; authenticated `/readyz`
reads and validates the Table entity. Neither checks model credentials/quota.
Docker's built-in health check is liveness only. Alert on readiness, 429s,
auth failures, provider errors and latency without logging tokens or body text.

## Migration from Redis and API keys

This is a breaking MCP deployment change; the web demo is unaffected.

1. Provision the table and Entra permissions, then configure/test new clients.
2. Drain old MCP replicas before switching. Old and new storage backends do not
   coordinate admission. Do not load-balance them together.
3. If an existing Redis total must be preserved, export **only the aggregate
   count** and initialize the new entity under an operator-controlled migration
   before accepting traffic. This version does not automatically read Redis or
   transfer its count. A fresh namespace starts at zero.
4. Remove obsolete `MCP_API_KEYS` and `MCP_REDIS_*` settings. Legacy client keys
   no longer authorize calls. Remove Redis only after cutover is verified.

## Verification

`npm test` covers signed JWT validation, permissions, discovery, MCP calls,
ETag conflict retries, ambiguous failures, clock handling, and web regressions.
The Table integration test uses the real Azure SDK with a loopback Azurite
instance, a unique table, and synthetic credentials; it deletes only that table.

```powershell
docker run --detach --rm --name advisor-table-test -p 127.0.0.1:11002:10002 -e AZURITE_ACCOUNTS=mcpdev:c3ludGhldGljLXRhYmxlLXRlc3Qta2V5LTAxMjM0NTY3ODk= mcr.microsoft.com/azure-storage/azurite:3.35.0 azurite-table --tableHost 0.0.0.0 --tablePort 10002 --silent
$env:MCP_TEST_TABLE_CONNECTION_STRING = 'DefaultEndpointsProtocol=http;AccountName=mcpdev;AccountKey=c3ludGhldGljLXRhYmxlLXRlc3Qta2V5LTAxMjM0NTY3ODk=;TableEndpoint=http://127.0.0.1:11002/mcpdev;'
npm run test:mcp:table
docker stop advisor-table-test
```

Only tests accept emulator connection strings; the application requires an Azure
HTTPS endpoint and identity. The integration test is skipped if its environment
variable is absent. CI should run it explicitly. Locally signed JWTs verify
validation behavior, not live Entra consent or managed-identity access.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[Entra access-token claims](https://learn.microsoft.com/entra/identity-platform/access-token-claims-reference),
[Table conditional updates](https://learn.microsoft.com/rest/api/storageservices/update-entity2).
