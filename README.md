# Jev Copilot Router

A small local web app that recommends Microsoft 365 Copilot Chat or Cowork using
the **real Jev endpoint**, `https://api.typesafe.ai/v1/systemone`.
No mock mode, alternate model, or keyword-only fallback is used by the app.

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

## Saved prompts

Each valid submission through **Ask Jev** is appended to
`C:\D\Jev\prompt-history.jsonl` before calling Jev, including submissions for
which the API call fails or the API key is missing. The file is created on the
first submission and preserved across server restarts. Earlier submissions
made before this feature was enabled cannot be recovered.

Each line is a JSON object with a UTC `timestamp`, `prompt`, and optional
conversation `context` (an empty string when omitted). Multiline prompts are
escaped within one JSON line. Empty/invalid, cross-site, and rate-limited
requests are not saved. API keys and classification results are not recorded.
If saving fails, the app displays an error and does not call Jev.

The file is local plaintext, excluded by `.gitignore`, and not served through
the web app. It has no automatic retention limit. Delete this specific file to
clear history; the next valid submission recreates it. Protect it using your
local filesystem permissions.

## Privacy and scope

- Clicking **Ask Jev** sends the prompt and context to TypeSafe AI, outside
  Microsoft 365. Use synthetic/non-sensitive data until organizational approval.
- The app persists submitted prompts and context locally as described above.
  Responses are not persisted, and SDK body logging is disabled. TypeSafe's
  own retention terms still apply.
- This is a **local, single-user demo** bound to loopback, not an authenticated
  multi-user service. Do not expose it publicly or through a tunnel as-is.
- Same-origin checks, a 64 KiB body limit, input limits, one in-flight request,
  and a 30-per-minute cap limit accidental or cross-site consumption.
- Requests time out after 20 seconds. There are no automatic retries, simulated
  successes, task execution, native Cowork interception, or session transfer.
- This is a task-fit recommendation, not a capability/permissions or billing check.
  Some Chat agents are metered; no exact savings are promised.

## Development

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
