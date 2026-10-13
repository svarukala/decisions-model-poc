# Architecture Advisor MCP server

This is a separate, API-key-authenticated **Streamable HTTP** MCP service at
`/mcp`, not an MCP wrapper around the public web demo. It directly reuses the
same architecture rubric and real Jev / Microsoft-Decision-1 adapters.
It can run behind a load balancer with multiple stateless replicas and no sticky
sessions. Azure resources are not provisioned by this repository.

## Tools and resource

| Name | Purpose | Model usage |
|---|---|---|
| `get_architecture_catalog` | Options, prerequisites, sources, signals and rubric version | None |
| `get_advisor_status` | Provider configuration presence and shared MCP count | None |
| `advise_agent_architecture` | Compare both providers for `scenario` and optional `requirements` | Both configured providers |
| `architecture-advisor://catalog` | Read-only MCP resource for the same catalog | None |

The advice tool accepts a nonblank scenario up to 8,000 characters and optional
requirements up to 3,000. It returns JSON as both `structuredContent` and text
for clients that do not render structured content. Its output schema is
advertised by `tools/list`.

Results preserve `comparison`, per-provider `status`, probabilities, signals,
actual model, measured duration and supplied token usage. The catalog resolves
the recommendation keys to names and prerequisites. Partial failures return
`isError: true` **and** the structured partial result: do not discard a successful
provider's card, and do not treat HTTP 200 as successful inference.

These tools recommend architectures; they do not build or execute agents. Advice
calls consume provider quota and are explicitly marked **not idempotent**.
Agents should not automatically retry them.

## Local setup

Requires Node 24+, the npm dependencies, and Redis 7+ with `EVAL` permitted.
Use a standalone Redis endpoint or a compatible proxy endpoint; this client
does not discover nodes in a directly exposed Redis Cluster.
Keep existing provider credentials in the root `.env` as documented in the
main README. A missing Decision-1 configuration produces a partial result;
there is no fake result or provider substitution.

Start a local Redis instance, for example with Docker Desktop running:

```powershell
docker run --detach --name advisor-redis -p 127.0.0.1:6379:6379 -v advisor-redis-data:/data redis:7.4-alpine redis-server --appendonly yes
```

This example is loopback-only and has no Redis password. Production Redis must
be private, access-controlled, and use TLS.

Generate a new client API key locally (keep its output private):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Add these settings to `.env` without overwriting the existing provider settings:

```dotenv
MCP_API_KEYS=PASTE_YOUR_GENERATED_KEY_HERE
MCP_HOST=127.0.0.1
MCP_PORT=3002
MCP_PUBLIC_ORIGIN=
MCP_REDIS_URL=redis://127.0.0.1:6379
MCP_REDIS_NAMESPACE=architecture-advisor
MCP_RATE_LIMIT=60
MCP_MAX_CONCURRENT=8
```

The placeholder key is not valid: replace it with the generated random key.
Never reuse a TypeSafe or Foundry credential as a client API key.
Run:

```powershell
npm ci
npm run start:mcp
```

The endpoint is `http://127.0.0.1:3002/mcp`. Redis must be reachable before
startup succeeds. The existing web demo still uses `npm start` and port 3000.

## Connect a client

Use an MCP client that supports **Streamable HTTP and custom request headers**:

| Field | Value |
|---|---|
| Transport | HTTP / Streamable HTTP |
| Local URL | `http://127.0.0.1:3002/mcp` |
| Production URL | `https://YOUR-MCP-HOST/mcp` |
| Header | `Authorization: Bearer YOUR_MCP_CLIENT_KEY` |

For example, VS Code's `.vscode/mcp.json` supports a prompted secret:

```json
{
  "inputs": [
    {
      "id": "architecture-api-key",
      "type": "promptString",
      "description": "Architecture Advisor MCP client API key",
      "password": true
    }
  ],
  "servers": {
    "architecture-advisor": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer ${input:architecture-api-key}"
      }
    }
  }
}
```

Replace the URL with your HTTPS endpoint for shared use. Other clients have
different configuration formats. This server does **not** implement OAuth
discovery, sign-in, or Microsoft Entra ID: clients that require OAuth without
support for manually configured API-key headers need an authenticating gateway
or a future OAuth adapter. Do not put a shared key into a browser application
or a URL.

Suggested prompt after connecting:

> Use the architecture advisor to compare development options for an internal
> Cowork extension that packages account-review skills and connects to our CRM
> through MCP. Show the recommendation, alternatives and any provider errors.

## Host at scale

Build the supplied non-root image:

```powershell
docker build -f Dockerfile.mcp -t architecture-advisor-mcp:latest .
```

The image contains only the required server files and dependencies, not `.env`,
SQLite, history, tests, or the web UI. Pin a reviewed base-image digest and scan
the image in your production release pipeline.

Deploy the image to your approved container host, for example Azure Container
Apps or Kubernetes, with the following configuration:

| Setting | Production requirement |
|---|---|
| Ingress | HTTPS only; target port 3002; block direct access to the backend |
| `MCP_HOST` | `0.0.0.0` |
| `MCP_PUBLIC_ORIGIN` | Exact HTTPS gateway origin, e.g. `https://advisor.example.com` |
| `MCP_API_KEYS` | Secret reference, not plaintext in manifests/source |
| Provider configuration | Secret references for keys; resource endpoint and deployment name as settings |
| `MCP_REDIS_URL` | Private Redis, preferably `rediss://...`, with a dedicated credential |
| Namespace/rate | Identical `MCP_REDIS_NAMESPACE` and `MCP_RATE_LIMIT` on every replica of this service |
| Version | Run a consistent rubric version across replicas |
| Shutdown | Allow at least 30 seconds for graceful termination |

Preserve the incoming `Host` and `Authorization` headers. Arbitrary forwarded
headers do not bypass host checks. Disable gateway caching, automatic POST
retries, and request/response-body logging. Allow at least 30 seconds upstream
request time. No persistent GET SSE connection, session affinity or session
database is required. GET and DELETE on `/mcp` deliberately return 405.
Browser Origins must exactly match the requested approved origin; no permissive
CORS policy is provided.

Put WAF/request-rate controls in front of the service to protect authentication,
catalog/status endpoints and connection limits. API keys are checked on **every**
MCP request using hashed constant-time comparisons. Each key grants the same
advisor access; there are no per-user roles or identities.

### Limits, counting and durability

- `MCP_RATE_LIMIT` is the shared number of admitted comparisons per **fixed
  60-second window**, enforced atomically in Redis. It is global across all keys
  and replicas, not per caller, and is not a token-based billing cap. Bursts can
  occur around window boundaries.
- `MCP_MAX_CONCURRENT` bounds active advice calls **per replica**. With N replicas,
  the aggregate concurrency can reach N times this limit. Size both settings
  against Jev and Foundry quotas; increase capacity only after load testing.
- There is no in-memory work queue. Busy replicas or failed shared admission
  reject work before model calls. Redis outages fail closed; no local fallback
  counters or unlimited inference are enabled. Connections reconnect, but
  commands and provider calls are not automatically replayed.
- Admitted advice calls increment one Redis total, even when either provider
  fails or both are unconfigured. Schema-invalid, unauthorized, local-busy and
  shared-rate-rejected calls do not count. Catalog/status reads do not count.
- The MCP count is **separate from the web demo's SQLite count**. Read it with
  `get_advisor_status`; the website's footer does not include MCP calls.
- Redis stores only `{namespace}:submissions` and an expiring `{namespace}:rate`
  integer. It stores no scenario, requirements, response, API key, user ID, IP
  address, or request log. The total has no TTL.
- Configure Redis persistence, backups, HA and **no-eviction**. A Redis restart
  without persistence, eviction, restore or flush can lose counts/rate state.
  Redis acknowledgement loss can count an admission whose model call never
  started. This aggregate is operational usage, **not billing-grade accounting**
  or exactly-once processing.
- Client disconnection does not guarantee cancellation of an in-flight model
  request. Calls have provider timeouts; manual retries can incur charges and
  increment the count again. No scenario-based caching or deduplication is used.

### Operations and key rotation

`GET /healthz` returns minimal unauthenticated liveness. Authenticated
`GET /readyz` also checks Redis. Neither verifies model credentials or quota.
Configure readiness checks with a protected header or a private monitoring
agent. The Docker health check is liveness only. Alert on Redis readiness,
provider failures, 429s and latency without recording submitted text or secrets.

`MCP_API_KEYS` accepts multiple comma-separated random keys. During rotation,
configure old and new keys on all replicas, restart/roll out, update clients,
then remove the old key and roll out again. All MCP settings are startup
configuration. Provider settings are reread per advice call; environment changes
still require container replacement. API keys are not a substitute for
organization-level authorization or a security review.

The default limits are conservative demo settings, **not a measured throughput
or availability guarantee**. Cloud deployment, secret provisioning, autoscaling,
provider quota allocation and production monitoring remain operator tasks.

## Verification

```powershell
npm test
$env:MCP_TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm run test:mcp:redis
```

The normal suite covers the official MCP client handshake, discovery,
structured tool results, validation, authentication/rotation, origin/host checks,
concurrency, partial provider failures and shutdown. The Redis integration test
uses a unique namespace, cleans up only its own keys, and verifies shared atomic
admission, reconnecting clients, expiration, count preservation and failures.
It is skipped when `MCP_TEST_REDIS_URL` is absent; CI should set that variable.
These tests use synthetic provider responses and do not spend model credits.
