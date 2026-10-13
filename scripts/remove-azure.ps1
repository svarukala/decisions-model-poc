#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$ResourceGroup = 'rg-arch-advisor-decision',
    [string]$NamePrefix = 'archadvisor',
    [Parameter(Mandatory)][string]$ConfirmResourceGroup,
    [switch]$DeleteData,
    [switch]$DeleteEntraRegistration
)
. "$PSScriptRoot\azure-common.ps1"

if ($ConfirmResourceGroup -cne $ResourceGroup) { throw 'ConfirmResourceGroup must exactly match ResourceGroup.' }
$context = Get-DeploymentContext $SubscriptionId $ResourceGroup $NamePrefix
if (-not (Test-Path -LiteralPath $context.StatePath)) { throw 'Deployment state is missing. Restore the .azure state file before teardown.' }
$state = Get-Content -LiteralPath $context.StatePath -Raw | ConvertFrom-Json -AsHashtable
if ($state.deploymentKey -ne $context.Key -or $state.tenantId -ne $context.TenantId) { throw 'Deployment state does not match this target.' }
$all = @(Invoke-AzJson -Arguments @('resource', 'list', '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId))
$owned = @($all | Where-Object { $_['tags'] -and $_.tags['advisorDeployment'] -eq $context.Key })
$order = @('Microsoft.App/containerApps', 'Microsoft.App/managedEnvironments', 'Microsoft.ContainerRegistry/registries',
    'Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft.Storage/storageAccounts')
foreach ($resource in $owned) {
    if ($resource.type -notin $order -or -not $resource.id.StartsWith("$($context.GroupId)/", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected deployment-owned resource; inspect before teardown: $($resource.id)"
    }
}
$graphToken = $null
if ($DeleteEntraRegistration -and $state.ContainsKey('apiObjectId')) {
    $graphToken = Get-CloudToken $context.Graph $context.TenantId
    $api = Invoke-CloudApi "$($context.Graph)/v1.0/applications/$($state.apiObjectId)" $graphToken -AllowNotFound
    if ($api -and ("advisorDeployment:$($context.Key)" -notin $api.tags -or $api.appId -ne $state.apiClientId)) {
        throw 'Entra ownership check failed. Nothing was deleted.'
    }
}
$description = "Remove tagged compute, registry and runtime identity; preserve resource group and existing model"
$description += if ($DeleteData) { '; DELETE usage storage' } else { '; preserve usage storage' }
$description += if ($DeleteEntraRegistration) { '; DELETE MCP Entra registration' } else { '; preserve MCP Entra registration' }
if (-not $PSCmdlet.ShouldProcess("$SubscriptionId/$ResourceGroup/$NamePrefix", $description)) { return }

# Remove only assignments belonging to this runtime identity and this resource group.
foreach ($identity in @($owned | Where-Object type -eq 'Microsoft.ManagedIdentity/userAssignedIdentities')) {
    $details = Invoke-AzJson -Arguments @('identity', 'show', '--ids', $identity.id, '--subscription', $SubscriptionId)
    $roles = @(Invoke-AzJson -Arguments @('role', 'assignment', 'list', '--all',
        '--query', "[?principalId=='$($details.principalId)']", '--subscription', $SubscriptionId))
    foreach ($role in $roles) {
        if (-not $role.id.StartsWith("$($context.GroupId)/", [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to delete an assignment outside the target resource group.' }
        & az role assignment delete --ids $role.id --subscription $SubscriptionId --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove runtime role assignment; teardown stopped.' }
    }
}
foreach ($type in $order) {
    if ($type -eq 'Microsoft.Storage/storageAccounts' -and -not $DeleteData) { continue }
    foreach ($resource in @($owned | Where-Object type -eq $type)) {
        Write-Host "Deleting $($resource.type): $($resource.name)"
        & az resource delete --ids $resource.id --subscription $SubscriptionId --only-show-errors --output none
        if ($LASTEXITCODE -ne 0) { throw "Deletion failed: $($resource.name). Correct the error and rerun." }
    }
}
if ($DeleteEntraRegistration -and $state.ContainsKey('apiObjectId')) {
    if ($state.ContainsKey('apiServicePrincipalId')) {
        $principalUri = "$($context.Graph)/v1.0/servicePrincipals/$($state.apiServicePrincipalId)"
        $principal = Invoke-CloudApi $principalUri $graphToken -AllowNotFound
        if ($principal) {
            if ($principal.appId -ne $state.apiClientId) { throw 'Service principal does not match the recorded API.' }
            $null = Invoke-CloudApi $principalUri $graphToken 'DELETE'
        }
    }
    if ($api) { $null = Invoke-CloudApi "$($context.Graph)/v1.0/applications/$($state.apiObjectId)" $graphToken 'DELETE' }
    foreach ($key in @('apiObjectId', 'apiClientId', 'apiServicePrincipalId', 'scopeId', 'appRoleId')) { $null = $state.Remove($key) }
}
foreach ($key in @('applications', 'infrastructure', 'imageTag')) { $null = $state.Remove($key) }
$state.lastTeardown = [DateTime]::UtcNow.ToString('o')
Save-DeploymentState $state $context.StatePath
Write-Host 'Teardown complete. The resource group and existing model deployments were not deleted.'
if (-not $DeleteData) { Write-Host 'Usage storage was preserved (small ongoing storage charges may apply).' }
if (-not $DeleteEntraRegistration) { Write-Host 'Entra registration was preserved so client configuration can be reused.' }
