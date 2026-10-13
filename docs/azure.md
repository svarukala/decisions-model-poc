# Repeatable Azure deployment

This pilot hosts **both public browser demos** and the **Entra-protected MCP**
service on separate Azure Container Apps. Public visitors can spend your model
credits; `-AllowPublicWeb` explicitly acknowledges this on each deployment.
No browser sign-in is enabled. Host/origin checks are not user authentication.

The deployment reuses your existing Jev and Decision-1 endpoint/deployment/keys.
It does **not** create, change, or delete a Foundry model deployment.

## Resources and cost

The Bicep templates create, in an **existing** resource group:

- One Consumption Container Apps environment, without a Log Analytics workspace.
- Two HTTPS apps, each 0.5 vCPU / 1 GiB, minimum zero and maximum two replicas.
- One Basic Azure Container Registry (a standing charge even with zero replicas).
- One Standard LRS Storage account and `AdvisorUsage` table, with shared keys
  disabled and no anonymous blob access.
- One user-assigned runtime identity with table-scoped **Storage Table Data
  Contributor** and registry-scoped **AcrPull**.

The script also creates a single-tenant Entra API application and its service
principal. These are tenant-level objects, **not** resources inside the resource
group. Runtime model keys live in Container Apps secrets supplied using secure
ARM parameters; scripts do not write them to state, generated templates, or
command-line arguments. The deployment caller must still protect their process,
`.env`, terminal history and Azure access. Do not enable PowerShell transcription
or verbose HTTP body logging while supplying secrets.

Scale-to-zero reduces idle compute cost but introduces cold starts. Storage,
registry, traffic and model calls still incur charges. Limits are shared:
30 web submissions/minute and 60 MCP comparisons/minute. These are **not daily
spending caps** or abuse prevention; add an appropriate gateway/budget policy
before broad publicity. Table's one-entity-per-channel design is for a pilot.

## Prerequisites

PowerShell 7+, Node 24+, Docker running, Azure CLI signed in, and the Bicep CLI
(`az bicep install`). Restore Node dependencies using `npm ci`.
The account needs:

- Resource creation rights in the target resource group and RBAC role-assignment
  rights (for example Owner, or Contributor plus appropriate RBAC administration).
- Permission to create/update its Entra application and service principal.
- Permission to push images to the new registry.
- Providers `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.Storage`
  and `Microsoft.ManagedIdentity` registered in the subscription.

Set `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `FOUNDRY_ENDPOINT`,
`DECISION_DEPLOYMENT` and `FOUNDRY_API_KEY` in the ignored `.env` or process
environment. Both providers must be configured. Secrets are read directly
into the deployment process; do not put them in script arguments.

## Deploy or update

From the repository root:

```powershell
.\scripts\deploy-azure.ps1 `
  -SubscriptionId YOUR-SUBSCRIPTION-GUID `
  -ResourceGroup rg-arch-advisor-decision `
  -Location eastus `
  -AllowPublicWeb
```

Use `-WhatIf` first to check the target without creating resources. This is a
target preview, not a full ARM what-if or permission validation.
The script never changes your active Azure subscription globally.

If a region is capacity-constrained, `-ComputeLocation eastus2` can place only
the Container Apps environment/apps in another approved region while storage,
registry and identity remain in `-Location`. This choice is saved and reused.
It is not an in-place region migration for an existing environment; do not
change the region of a running deployment. Cross-region traffic can add latency
and bandwidth charges.

The default `-NamePrefix archadvisor` is stable. Rerun with the same target and
prefix to update or recreate. The script creates the API registration, deploys
the foundation, builds/pushes uniquely tagged web/MCP images, then deploys the
apps with exact generated HTTPS origins. An unsuccessful deployment stops with
an error; fix it and rerun. It does not automatically roll back or delete
partially created resources.

The script prints browser, `/advisor`, and `/mcp` URLs plus the API client ID and
scope. The public demo paths preserve the local UI. Local `npm start` still
uses loopback and SQLite. Cloud `npm run start:web:cloud` binds all interfaces,
requires an HTTPS origin and Table access, and never uses ephemeral SQLite.
Cloud configuration changes take effect on a new revision.

### State and reproducibility

An ignored `.azure/<target-hash>.json` stores resource IDs, registration IDs,
permission IDs and non-secret deployment outputs. **Keep this file** for
subsequent deployment/teardown and copy it securely when changing machines.
Do not run simultaneous deployment/teardown commands for the same target.
Losing the file can orphan the Entra registration; recover it before rerunning
rather than creating duplicate registrations.

Tagged resources are owned by the tuple subscription/resource-group/prefix.
The script rejects prefix collisions with resources not tagged for this
deployment. It uses incremental ARM deployments, not complete-mode deletion.
Container image tags are unique per deployment; old images remain in the
registry until teardown or an operator's retention policy removes them.

Web and MCP totals are separate Table entities (`web/usage` and `mcp/usage`).
Only aggregate counts and rate-window metadata are stored. Prompts, responses
and user identities are not persisted. Local SQLite counts and previous Redis
counts are not automatically imported.

## Connect MCP clients

The browser demos are public; **MCP still requires an Entra access token**.
The generated registration exposes delegated permission
`api://<API-CLIENT-ID>/Advisor.Invoke` (administrator consent) and optional
application role `Advisor.Invoke.All`.

Configure a separate approved calling application, exact redirect URI and
delegated permission for an interactive MCP client, or grant the application
role with admin consent to an unattended client. The API registration includes
the `idtyp` optional access-token claim and requests v2 tokens. The server needs
no Entra client secret. It does not register clients or grant consent
automatically. See [the MCP guide](mcp.md) for client compatibility and token
requirements.

The public OAuth metadata is available at
`https://<mcp-host>/.well-known/oauth-protected-resource/mcp`.
Missing/invalid authentication is rejected before any model request.

## Checks after deployment

Before provisioning, run `npm test`, `.\scripts\test-azure-scripts.ps1`, and compile
the Bicep templates. Script tests replace Azure calls with mocks and verify
public-access acknowledgment, target confirmation, dry-run behavior and
preservation of data/unrelated resources during teardown.

Open `/` and `/advisor`, and read `/api/advisor/status`. Status reports
configuration presence and persisted usage, not a provider connectivity test.
Submit only synthetic, non-sensitive prompts to verify both real models; this
consumes credits. `/healthz` is public liveness. MCP `/readyz` requires a valid
token and verifies storage.

Azure probes are TCP startup/liveness/readiness probes; the process binds only
after storage initialization. A running process does not establish ongoing
provider health. Configure protected readiness monitoring for production.
The pilot does not provision centralized application log storage. Avoid adding
prompt/body/token logging to a gateway or diagnostic sink.

## Tear down, preserving counts and client setup

Preview the exact target:

```powershell
.\scripts\remove-azure.ps1 `
  -SubscriptionId YOUR-SUBSCRIPTION-GUID `
  -ResourceGroup rg-arch-advisor-decision `
  -ConfirmResourceGroup rg-arch-advisor-decision `
  -WhatIf
```

Remove `-WhatIf` to delete the tagged apps, environment, registry, runtime
identity and its in-group role assignments. The script preserves:

- The **resource group**, unrelated resources and existing model deployments.
- Usage storage/counters (small storage charges can continue).
- The Entra API registration, keeping client IDs and consent configuration stable.

Rerun the deployment command to recreate the runtime and reuse retained counts.
No destroy/recreate cycle is required to update application code.

### Remove data and registration too

Add `-DeleteData` to permanently delete the deployment's storage account and
aggregate counts. Add `-DeleteEntraRegistration` to remove the API registration
and its service principal. These are explicit opt-ins, not the default.
Recreating a deleted registration yields a **new client ID**, and calling
clients must be reconfigured/reconsented. Do not use these switches as a routine
upgrade. The resource group is never deleted by either script.

The scripts require the existing resource group; if you manually delete it,
recreate it before running deployment. Manually deleting the resource group
does not delete the tenant-level Entra registration.
