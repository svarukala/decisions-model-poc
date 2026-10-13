#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$ResourceGroup = 'rg-arch-advisor-decision',
    [string]$Location = 'eastus',
    [string]$ComputeLocation = '',
    [string]$NamePrefix = 'archadvisor',
    [switch]$AllowPublicWeb
)
. "$PSScriptRoot\azure-common.ps1"

if (-not $AllowPublicWeb) { throw 'The browser demos are public and can consume model credits. Pass -AllowPublicWeb to acknowledge this.' }
$context = Get-DeploymentContext $SubscriptionId $ResourceGroup $NamePrefix
if (-not $PSCmdlet.ShouldProcess("$SubscriptionId/$ResourceGroup ($Location)", 'Deploy public web demos, Entra-protected MCP, Table Storage and Container Apps')) { return }
New-Item -ItemType Directory -Path $context.StateDirectory -Force | Out-Null
$state = if (Test-Path $context.StatePath) { Get-Content -LiteralPath $context.StatePath -Raw | ConvertFrom-Json -AsHashtable } else {
    @{ deploymentKey = $context.Key; subscriptionId = $SubscriptionId; resourceGroup = $ResourceGroup; namePrefix = $NamePrefix; location = $Location; tenantId = $context.TenantId }
}
if ($state.deploymentKey -ne $context.Key -or $state.location -ne $Location -or $state.tenantId -ne $context.TenantId) { throw 'Saved deployment target differs. Use another prefix or restore the original target.' }
if (-not $ComputeLocation) { $ComputeLocation = if ($state.ContainsKey('computeLocation')) { $state.computeLocation } else { $Location } }
if ($state.ContainsKey('computeLocation') -and $state.computeLocation -ne $ComputeLocation) { throw 'Saved compute region differs. Existing environments cannot be moved in place.' }
$state.computeLocation = $ComputeLocation
Save-DeploymentState $state $context.StatePath
$resources = @(Invoke-AzJson -Arguments @('resource', 'list', '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId))
foreach ($resource in $resources) {
    if ($resource.name.StartsWith($NamePrefix) -and (-not $resource['tags'] -or $resource.tags['advisorDeployment'] -ne $context.Key)) {
        throw "An existing resource with this prefix is not owned by this deployment: $($resource.name). Choose another prefix."
    }
}

# Read secrets directly into process memory; no secret parameter files or CLI arguments.
Push-Location $context.Root
try {
    $configuration = & node --input-type=module -e "import {readConfig} from './router.mjs'; console.log(JSON.stringify(await readConfig()));"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read provider configuration.' }
    $provider = $configuration | ConvertFrom-Json -AsHashtable
    if (-not $provider.apiKey -or -not $provider.foundryApiKey -or -not $provider.foundryEndpoint -or -not $provider.decisionDeployment) { throw 'Configure Jev and Decision-1 in .env or environment variables first.' }
    $null = & docker info --format '{{.ServerVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker must be running before deployment.' }
    $null = & az bicep version --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Install Bicep with az bicep install, then rerun.' }

    $graphToken = Get-CloudToken $context.Graph $context.TenantId
    $graphRoot = "$($context.Graph)/v1.0"
    $tag = "advisorDeployment:$($context.Key)"
    if (-not $state.ContainsKey('apiObjectId')) {
        $scopeId = [guid]::NewGuid().ToString()
        $roleId = [guid]::NewGuid().ToString()
        $api = Invoke-CloudApi "$graphRoot/applications" $graphToken 'POST' @{
            displayName = "$NamePrefix MCP API ($ResourceGroup)"
            signInAudience = 'AzureADMyOrg'
            tags = @($tag)
            api = @{
                requestedAccessTokenVersion = 2
                oauth2PermissionScopes = @(@{
                    id = $scopeId; value = 'Advisor.Invoke'; type = 'Admin'; isEnabled = $true
                    adminConsentDisplayName = 'Invoke the architecture advisor'
                    adminConsentDescription = 'Call the architecture advisor MCP service and consume configured model credits.'
                })
            }
            appRoles = @(@{
                id = $roleId; value = 'Advisor.Invoke.All'; allowedMemberTypes = @('Application'); isEnabled = $true
                displayName = 'Invoke architecture advisor'; description = 'Invoke the MCP service without a signed-in user.'
            })
            optionalClaims = @{ accessToken = @(@{ name = 'idtyp'; essential = $false }) }
        }
        $state.apiObjectId = $api.id
        $state.apiClientId = $api.appId
        $state.scopeId = $scopeId
        $state.appRoleId = $roleId
        Save-DeploymentState $state $context.StatePath
    }
    $api = Invoke-CloudApi "$graphRoot/applications/$($state.apiObjectId)" $graphToken
    if ($tag -notin $api.tags -or $api.appId -ne $state.apiClientId) { throw 'Refusing to modify an Entra app not owned by this deployment.' }
    $null = Invoke-CloudApi "$graphRoot/applications/$($state.apiObjectId)" $graphToken 'PATCH' @{ identifierUris = @("api://$($state.apiClientId)") }
    if (-not $state.ContainsKey('apiServicePrincipalId')) {
        $filter = [uri]::EscapeDataString("appId eq '$($state.apiClientId)'")
        $existing = Invoke-CloudApi "$graphRoot/servicePrincipals?`$filter=$filter" $graphToken
        $principal = if ($existing.value.Count) { $existing.value[0] } else {
            Invoke-CloudApi "$graphRoot/servicePrincipals" $graphToken 'POST' @{ appId = $state.apiClientId; tags = @($tag) }
        }
        $state.apiServicePrincipalId = $principal.id
        Save-DeploymentState $state $context.StatePath
    }

    Write-Host 'Deploying registry, identity, table and Consumption environment...'
    $infra = Invoke-AdvisorDeployment $context "$NamePrefix-infra" (Join-Path $context.Root 'infra\main.bicep') @{
        location = $Location; computeLocation = $ComputeLocation; namePrefix = $NamePrefix; deploymentKey = $context.Key
    }
    $state.infrastructure = $infra | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    Save-DeploymentState $state $context.StatePath
    & az acr login --name $infra.registryName.value --subscription $SubscriptionId --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Container registry sign-in failed.' }
    $imageTag = "r$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    foreach ($kind in @('web', 'mcp')) {
        $image = "$($infra.registryServer.value)/advisor-${kind}:$imageTag"
        & docker build --quiet --platform linux/amd64 --file "Dockerfile.$kind" --tag $image .
        if ($LASTEXITCODE -ne 0) { throw "Building $kind failed." }
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            & docker push --quiet $image
            if ($LASTEXITCODE -eq 0) { break }
            if ($attempt -eq 3) { throw "Pushing $kind failed after three attempts." }
            Write-Warning "Registry push failed; retrying the same immutable image ($attempt/3)."
            Start-Sleep -Seconds (10 * $attempt)
        }
    }
    Write-Host 'Deploying web and MCP applications...'
    $apps = Invoke-AdvisorDeployment $context "$NamePrefix-apps" (Join-Path $context.Root 'infra\apps.bicep') @{
        location = $ComputeLocation; namePrefix = $NamePrefix; deploymentKey = $context.Key
        registryServer = $infra.registryServer.value; imageTag = $imageTag
        identityId = $infra.identityId.value; identityClientId = $infra.identityClientId.value
        environmentId = $infra.environmentId.value; environmentDomain = $infra.environmentDomain.value
        storageEndpoint = $infra.storageEndpoint.value; tenantId = $context.TenantId; apiClientId = $state.apiClientId
        typesafeApiKey = $provider.apiKey; typesafeModel = $provider.model
        foundryApiKey = $provider.foundryApiKey; foundryEndpoint = $provider.foundryEndpoint; decisionDeployment = $provider.decisionDeployment
    }
    $state.applications = $apps | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
    $state.imageTag = $imageTag
    Save-DeploymentState $state $context.StatePath
    Wait-AdvisorEndpoints $apps.webUrl.value $apps.mcpUrl.value
    Write-Host "Public browser demos: $($apps.webUrl.value)"
    Write-Host "Architecture advisor: $($apps.webUrl.value)/advisor"
    Write-Host "Entra-protected MCP: $($apps.mcpUrl.value)"
    Write-Host "API client ID: $($state.apiClientId)"
    Write-Host "Delegated scope: api://$($state.apiClientId)/Advisor.Invoke"
    Write-Host "Deployment state (no secrets): $($context.StatePath)"
    Write-Host 'Configure/consent a calling Entra client before using MCP. See docs/azure.md.'
} finally {
    $provider = $null
    $configuration = $null
    $graphToken = $null
    Pop-Location
}
