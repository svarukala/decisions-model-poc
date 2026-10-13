#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($name in @('azure-common.ps1', 'deploy-azure.ps1', 'remove-azure.ps1')) {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "$name contains parser errors: $errors" }
}
. "$PSScriptRoot\azure-common.ps1"

$global:AdvisorScriptTestAzCalls = @()
function az {
    $global:AdvisorScriptTestAzCalls += ,@($args)
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'account') {
        return '{"environmentName":"AzureCloud","tenantId":"synthetic-tenant","accessToken":"synthetic-token"}'
    }
    if ($args[0] -eq 'group') {
        return '{"id":"/subscriptions/synthetic/resourceGroups/synthetic-rg"}'
    }
    if ($args[0] -eq 'resource' -and $args[1] -eq 'list') {
        return ($global:AdvisorScriptTestResources | ConvertTo-Json -Depth 10 -AsArray)
    }
    if ($args[0] -eq 'resource' -and $args[1] -eq 'delete') { return }
    throw 'Unexpected CLI command in a read-only script test.'
}
$context = Get-DeploymentContext 'synthetic' 'synthetic-rg' 'advisor'
if ($context.Key -ne 'synthetic/synthetic-rg/advisor') { throw 'Wrong deployment ownership key.' }
if ((Get-CloudToken 'https://management.azure.com' 'synthetic-tenant') -ne 'synthetic-token') { throw 'Token retrieval failed.' }
if ($global:AdvisorScriptTestAzCalls[0][1] -ne 'show') { throw 'CLI argument arrays were not forwarded correctly.' }

foreach ($operation in @(
    { & "$PSScriptRoot\deploy-azure.ps1" -SubscriptionId synthetic },
    { & "$PSScriptRoot\remove-azure.ps1" -SubscriptionId synthetic -ConfirmResourceGroup wrong }
)) {
    $before = $global:AdvisorScriptTestAzCalls.Count
    $failed = $false
    try { & $operation } catch { $failed = $true }
    if (-not $failed -or $global:AdvisorScriptTestAzCalls.Count -ne $before) { throw 'A safety guard failed before Azure access.' }
}
& "$PSScriptRoot\deploy-azure.ps1" -SubscriptionId synthetic -ResourceGroup synthetic-rg -NamePrefix advisor -AllowPublicWeb -WhatIf
if (@($global:AdvisorScriptTestAzCalls | Where-Object { $_[0] -notin @('account', 'group') }).Count) { throw 'Dry-run attempted a write.' }

$global:AdvisorScriptTestResources = @(
    @{ id = "$($context.GroupId)/providers/Microsoft.App/containerApps/advisor-web"; name = 'advisor-web'; type = 'Microsoft.App/containerApps'; tags = @{ advisorDeployment = $context.Key } },
    @{ id = "$($context.GroupId)/providers/Microsoft.Storage/storageAccounts/advisorstore"; name = 'advisorstore'; type = 'Microsoft.Storage/storageAccounts'; tags = @{ advisorDeployment = $context.Key } },
    @{ id = "$($context.GroupId)/providers/Microsoft.App/containerApps/unrelated"; name = 'unrelated'; type = 'Microsoft.App/containerApps'; tags = @{ advisorDeployment = 'someone-else' } }
)
if (Test-Path -LiteralPath $context.StatePath) { throw 'Refusing to overwrite existing synthetic test state.' }
New-Item -ItemType Directory -Path $context.StateDirectory -Force | Out-Null
try {
    Save-DeploymentState @{ deploymentKey = $context.Key; tenantId = $context.TenantId } $context.StatePath
    & "$PSScriptRoot\remove-azure.ps1" -SubscriptionId synthetic -ResourceGroup synthetic-rg -NamePrefix advisor -ConfirmResourceGroup synthetic-rg
    $deletes = @($global:AdvisorScriptTestAzCalls | Where-Object { $_[1] -eq 'delete' })
    if ($deletes.Count -ne 1 -or $deletes[0][3] -ne $global:AdvisorScriptTestResources[0].id) {
        throw 'Default teardown did not preserve data and unrelated resources.'
    }
    $global:AdvisorScriptTestAzCalls = @()
    & "$PSScriptRoot\remove-azure.ps1" -SubscriptionId synthetic -ResourceGroup synthetic-rg -NamePrefix advisor -ConfirmResourceGroup synthetic-rg -DeleteData
    $deletes = @($global:AdvisorScriptTestAzCalls | Where-Object { $_[1] -eq 'delete' })
    if ($deletes.Count -ne 2 -or $deletes[1][3] -ne $global:AdvisorScriptTestResources[1].id) {
        throw 'Explicit data deletion selected unexpected resources.'
    }
} finally {
    Remove-Item -LiteralPath $context.StatePath -Force
    Remove-Variable AdvisorScriptTestResources -Scope Global
}

function Invoke-RestMethod { throw [System.InvalidOperationException]::new('Synthetic failure without a Response property') }
$failed = $false
try { Invoke-CloudApi 'https://synthetic.invalid' 'synthetic-token' 'POST' @{ secret = 'never-log-this' } }
catch {
    $failed = $true
    if ($_.Exception.Message -notmatch 'HTTP 0, InvalidOperationException' -or $_.Exception.Message -match 'never-log-this') {
        throw 'Cloud error handling is incorrect or disclosed request data.'
    }
}
if (-not $failed) { throw 'Cloud error was swallowed.' }
Remove-Variable AdvisorScriptTestAzCalls -Scope Global
Write-Host 'Azure script parser, argument forwarding, dry-run, teardown scope and safety-guard checks passed.'
