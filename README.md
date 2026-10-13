# Jev Copilot Router

A small local web app that recommends Microsoft 365 Copilot Chat or Cowork using
the **real Jev endpoint**, `https://api.typesafe.ai/v1/systemone`.
No mock mode, alternate model, or keyword-only fallback is used by the app.

The second demo, **Microsoft Agent Architecture Advisor** at `/advisor`, compares
real Jev and Microsoft-Decision-1 decisions for a development scenario.
The original Chat/Cowork router remains at `/`.

## Shared MCP service

The architecture advisor is also available as an **API-key-authenticated,
stateless Streamable HTTP MCP server**, separate from the web demo. It exposes
the architecture catalog, readiness/aggregate usage, and dual-model advice.
Redis shares the rate limit and MCP submission count across replicas.

See [MCP setup, client configuration and scalable hosting](docs/mcp.md).
Run `npm run start:mcp` after configuring Redis and `MCP_API_KEYS`.
The default MCP endpoint is `http://127.0.0.1:3002/mcp`; shared deployments
require HTTPS ingress. MCP usage is separate from the web demo's SQLite count.

## Run

Requires Node.js 24 or later and a TypeSafe API key with Jev access.

```powershell
cd C:\D\Jev
npm install
Copy-Item .env.example .env
notepad .env
npm start
```

Set `TYPESAFE_API_KEY` in `.env`, then open <http://127.0.0.1:3000>.
Do not paste your API key into chat or commit it. Environment variables take
precedence over `.env`. Key and model changes are read on each request; changing
`PORT` requires restarting the server.

The default model is pinned to `jev-1.13.0`. Change `TYPESAFE_MODEL` if your
account requires a different available Jev version.

## Microsoft Agent Architecture Advisor

Open <http://127.0.0.1:3000/advisor> after starting the same server. Enter a
scenario, optionally select builder experience, audience and runtime ownership,
and add requirements such as channels, data, actions or governance.

The advisor considers declarative agents (including Agent Builder and Agents
Toolkit authoring paths), Copilot Studio Standard and GitHub Copilot harnesses,
Foundry prompt and hosted/custom-code agents, **Cowork plugins (skills + MCP)**,
workflow automation, using an existing tool without building, and clarification.
The Studio GitHub Copilot harness is not the GitHub Copilot coding service.
SharePoint knowledge agents are an adjacent specialized path; this demo does not
attempt to enumerate every authoring surface or hosting option as a separate class.

### Connect Microsoft-Decision-1

Deploy **Microsoft-Decision-1** in a supported Microsoft Foundry resource.
Follow [Microsoft's deployment and API guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision).
Add these entries to your existing `.env` (do not overwrite your Jev key):

```dotenv
FOUNDRY_ENDPOINT=https://YOUR-RESOURCE.services.ai.azure.com
DECISION_DEPLOYMENT=YOUR-DEPLOYMENT-NAME
FOUNDRY_API_KEY=YOUR-RESOURCE-KEY
```

Use the HTTPS **resource origin** from the deployment page, not a project URL,
OpenAI endpoint, or a full inference path. The server appends
`/providers/microsoft/v1/systemone`, sends the deployment name as `model`, and
authenticates using the server-side `api-key` header. Redirects are not followed.
Verify your deployment is actually Microsoft-Decision-1; the UI displays the
returned model identifier. Do not paste credentials into chat or source control.
This demo uses API-key authentication; a production deployment should consider
Microsoft Entra ID and managed identity instead.

Both providers receive the **same scenario, requirements, choices and signal
questions**, concurrently. Neither is a fallback for the other. A missing
configuration, timeout, billing failure or invalid response appears in that
provider's card without discarding the other result. Status indicates only that
settings are present, not that credentials, deployment access or billing work.
Real Decision-1 inference cannot be verified without a configured deployment.

### Interpreting the comparison

Each result includes its primary approach, all option probabilities, capability
signals, template explanation, prerequisites, documentation, actual model,
elapsed request time and token usage when available. The overall result distinguishes
agreement, disagreement, clarification and incomplete comparisons. Latency is
one request's wall-clock duration, not a controlled benchmark.

The shared demo policy abstains when the leading probability is below 0.65,
the gap to the second option is below 0.15, missing-context probability is at
least 0.65, or a strong custom-runtime/Cowork-extension signal (at least 0.8)
conflicts with the primary choice. The model may also choose clarification
directly. A workflow-component probability of at least 0.75 can suggest a
supporting flow. These thresholds are illustrative, not accuracy guarantees.
Provider confidence values are optional and not directly comparable across models.
Neither model produces a written rationale; the descriptions are maintained
templates, not generated reasoning.

The [Microsoft Agent Platform Advisor](https://microsoft.github.io/AgentPlatformAdvisor/)
and its [published decision matrix](https://github.com/microsoft/AgentPlatformAdvisor/blob/main/apa.yaml)
inform the distinction between **using an existing agent** and **building one**,
as well as audience, authoring skills and runtime ownership. This demo does not
copy or run its deterministic scoring engine and does not claim equivalent
recommendations. Agent Builder limitations must not be generalized to every
declarative agent. Product details are maintained in `advisor.mjs` alongside the
rubric version and Microsoft documentation links; they are not refreshed from
the web on each submission. Confirm product availability, licenses and technical
constraints before implementing any recommendation.

`GET /api/advisor/status` exposes the catalog, rubric version, configuration
readiness (never keys), and shared submission count.
`POST /api/advisor` accepts `{ "prompt": "...", "context": "..." }`.
An accepted comparison returns HTTP 200 with per-provider `status` and an
overall `comparison`; **inspect these fields**, because HTTP 200 alone does not
mean either model succeeded. Input/access errors use the existing HTTP error contract.

## Public Cloudflare tunnel (optional)

By default, only local hostnames are allowed. To allow a tunnel, add its exact
HTTPS origin to your local `.env`:

```dotenv
PUBLIC_ORIGIN=https://your-tunnel-name.trycloudflare.com
```

Start the app with `npm start`, then in another terminal:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

Use the actual URL printed by Cloudflare as `PUBLIC_ORIGIN`. If the app runs on
3001, target 3001 instead. Keep Cloudflare's original Host header; do not override
it to localhost. After upgrading the server code, restart `npm start`. Subsequent
`.env` origin changes are read on each request without restarting.

This deliberately enables **public, unauthenticated access**. Anyone reaching
the tunnel can consume your Jev credits, incur Azure model charges through the
advisor, and increase the submission count.
The shared 30-per-minute cap and single in-flight request still apply, but are
not authentication or a spending cap. Do not share sensitive data or use this
as a production service.

Only the configured origin is allowed, not all `trycloudflare.com` domains.
HTTPS browser submissions from that same origin are accepted; cross-origin
requests are still blocked. Secrets and the usage database are never served as files.
Quick-tunnel URLs change on restart, so update `.env` when that happens.
To disable public access, clear `PUBLIC_ORIGIN` and stop the tunnel.
Environment variables override `.env`, including an explicitly empty origin.

## How it works

The single-file browser UI sends the prompt and optional conversation context
to a local Node server. The server uses the official TypeSafe JavaScript SDK
to make one real request containing a route Choice and two Noul questions.
Only the server holds the key. The UI shows probabilities, the actual model
version, latency, input tokens when provided, and template-based explanations.

The rubric assumes paid, work-grounded Microsoft 365 Copilot Chat and enabled
Cowork with suitable connectors. Chat handles answers, reasoning, analysis, and
drafts; Cowork handles delegated execution and coordinated workflows. Prompt
length and reasoning complexity alone do not justify Cowork. Specialized Chat
agents are not assumed available. Adapt the rubric to your tenant before real use.

The app does not force a binary answer. It recommends more context when Jev
chooses `unsure`, its top probability is below 0.70, missing-context probability
is at least 0.60, or Chat is selected despite execution probability at least 0.70.
These are illustrative policy thresholds, not empirically calibrated guarantees.
Provider confidence is a distribution statistic, not measured task accuracy.

## Submission count (no prompt storage)

The app stores only an aggregate submission count in `C:\D\Jev\usage.sqlite`,
using Node's built-in SQLite support (no additional package). It does not save
prompts, context, responses, timestamps, IP addresses, or user identifiers.
The database also contains a boolean marker to prevent double-counting a
one-time migration from old prompt history.

Each valid submission through **Ask Jev** or **Compare both models** counts once
before inference, including submissions whose API calls fail or whose keys are
missing. Comparing two providers increments the shared count once, not twice.
Invalid, cross-site, and rate-limited requests do not count. Retrying manually
counts as a new submission. Direct calls through `smoke:live` do not count.
If the counter cannot be updated, an error is shown and neither provider is called.

The total is visible in the page footer and as `totalSubmissions` in
`GET /api/status`. It refreshes on page load and after your submission, not
continuously while other visitors submit. SQLite's atomic updates preserve
counts across restarts and simultaneous server processes on ports 3000/3001.
The database and its sidecar files are excluded by `.gitignore` and are not
downloadable through the app.

### Migrating old prompt history

Stop **all** old server processes first, then run:

```powershell
npm run migrate:history
```

This counts entries in the existing `prompt-history.jsonl`, commits only their
total, and deletes that specific file without printing or backing up its text.
The migration is idempotent: a deletion failure can be retried without adding
the old count again. A malformed history file produces an error without
changing the count or deleting the file. Start the updated server afterwards.
Deletion is ordinary filesystem deletion, not a secure wipe of external backups.

## Privacy and scope

- Clicking **Ask Jev** sends the prompt and context to TypeSafe AI, outside
  Microsoft 365. Use synthetic/non-sensitive data until organizational approval.
- Clicking **Compare both models** sends the scenario and requirements to both
  configured providers: TypeSafe AI and Microsoft Foundry. Their respective
  data handling and retention terms apply; the app's count-only storage does
  not promise that upstream providers retain nothing.
- The app persists only the aggregate count described above. SDK body logging
  is disabled. Prompts and context are still sent to TypeSafe for inference;
  TypeSafe's own retention terms still apply.
- This is a demo bound to loopback, not an authenticated multi-user service.
  Public tunnel access is opt-in via `PUBLIC_ORIGIN`, with the risks above.
- Same-origin checks, a 64 KiB body limit, input limits, one in-flight request,
  and a 30-per-minute cap limit accidental or cross-site consumption.
- Requests time out after 20 seconds. There are no automatic retries, simulated
  successes, task execution, native Cowork interception, or session transfer.
- This is a task-fit recommendation, not a capability/permissions or billing check.
  Some Chat agents are metered; no exact savings are promised.

## Development

### Credits and billing errors

If Jev returns HTTP `402 Payment Required`, the app explains that the TypeSafe
account has insufficient credits or needs billing attention, and directs the
app owner to <https://console.typesafe.ai>. It does not claim that every billing
failure means a zero balance. No recommendation is shown and no automatic retry
is made. The failed submission counts toward usage, but its text is not stored.

Temporary `429` rate limits retain their separate wait-and-retry message.
Provider account details are not exposed to visitors.

### Commands

```powershell
npm test
npm run smoke:live
```

Tests use synthetic SDK transport fixtures, never live customer prompts.
`smoke:live` requires a configured real key, sends two synthetic prompts to Jev,
incurs API usage, and prints actual recommendations. It fails explicitly if the
key is absent or the service call fails.

Sources: [Jev API](https://docs.typesafe.ai/api),
[models and pricing](https://docs.typesafe.ai/models),
[known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
