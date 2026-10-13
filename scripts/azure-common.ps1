Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzJson {
    param([string[]]$Arguments)
    $text = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0..([Math]::Min(1, $Arguments.Length - 1))] -join ' ')" }
    if ($text) { return ($text -join "`n" | ConvertFrom-Json -AsHashtable) }
}

function Get-CloudToken {
    param([string]$Resource, [string]$TenantId)
    return (Invoke-AzJson -Arguments @('account', 'get-access-token', '--resource', $Resource, '--tenant', $TenantId)).accessToken
}

function Invoke-CloudApi {
    param([string]$Uri, [string]$Token, [string]$Method = 'GET', $Body, [switch]$AllowNotFound)
    $params = @{ Uri = $Uri; Method = $Method; Headers = @{ Authorization = "Bearer $Token" }; TimeoutSec = 120 }
    if ($null -ne $Body) {
        $params.ContentType = 'application/json'
        $params.Body = ConvertTo-Json -InputObject $Body -Depth 100 -Compress
    }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try { return Invoke-RestMethod @params }
        catch {
            $response = $_.Exception.PSObject.Properties['Response']
            $status = if ($response -and $response.Value) { [int]$response.Value.StatusCode } else { 0 }
            if ($AllowNotFound -and $status -eq 404) { return $null }
            if ($Method -eq 'GET' -and $status -in @(0, 408, 429, 500, 502, 503, 504) -and $attempt -lt 2) {
                Start-Sleep -Seconds (5 * ($attempt + 1))
                continue
            }
            throw "Cloud API $Method failed (HTTP $status, $($_.Exception.GetType().Name)). Check Azure/Entra permissions and deployment operations. Request bodies and tokens are intentionally not logged."
        }
    }
}

function Get-DeploymentContext {
    param([string]$SubscriptionId, [string]$ResourceGroup, [string]$NamePrefix)
    if ($ResourceGroup -notmatch '^[A-Za-z0-9_-]{1,90}$') { throw 'Use a resource-group name containing letters, numbers, underscores or hyphens.' }
    if ($NamePrefix -notmatch '^[a-z][a-z0-9]{2,10}$') { throw 'NamePrefix must be 3-11 lowercase alphanumeric characters, starting with a letter.' }
    $account = Invoke-AzJson -Arguments @('account', 'show', '--subscription', $SubscriptionId)
    if ($account.environmentName -ne 'AzureCloud') { throw 'Only the Azure public cloud is supported.' }
    $rg = Invoke-AzJson -Arguments @('group', 'show', '--name', $ResourceGroup, '--subscription', $SubscriptionId)
    $key = "$SubscriptionId/$ResourceGroup/$NamePrefix".ToLowerInvariant()
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($key))).Substring(0, 16).ToLowerInvariant()
    $root = Split-Path $PSScriptRoot -Parent
    $stateDirectory = Join-Path $root '.azure'
    return @{
        Root = $root; GroupId = $rg.id; TenantId = $account.tenantId; Key = $key
        StateDirectory = $stateDirectory; StatePath = Join-Path $stateDirectory "$hash.json"
        Arm = 'https://management.azure.com'; Graph = 'https://graph.microsoft.com'
    }
}

function Save-DeploymentState {
    param($State, [string]$Path)
    $temporary = "$Path.tmp"
    $State | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Wait-AdvisorEndpoints {
    param([string]$WebUrl, [string]$McpUrl)
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    Write-Host 'Waiting for public web routes, Table-backed status and protected MCP ingress...'
    do {
        try {
            foreach ($path in @('/', '/advisor')) {
                $page = Invoke-WebRequest "$WebUrl$path" -TimeoutSec 20
                if ($page.StatusCode -ne 200) { throw 'Web page is not ready.' }
            }
            $status = Invoke-RestMethod "$WebUrl/api/advisor/status" -TimeoutSec 20
            if ($null -eq $status.totalSubmissions) { throw 'Table-backed status is not ready.' }
            $mcpOrigin = ([uri]$McpUrl).GetLeftPart([UriPartial]::Authority)
            $metadata = Invoke-RestMethod "$mcpOrigin/.well-known/oauth-protected-resource/mcp" -TimeoutSec 20
            if ($metadata.resource -ne $McpUrl) { throw 'MCP discovery has an unexpected resource URL.' }
            $protected = Invoke-WebRequest $McpUrl -SkipHttpErrorCheck -TimeoutSec 20
            if ($protected.StatusCode -ne 401 -or -not $protected.Headers['WWW-Authenticate']) { throw 'MCP must reject unauthenticated requests.' }
            return
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Azure resources were deployed, but endpoint checks did not pass within five minutes. Inspect Container Apps console/system logs; no model smoke requests were sent.' }
            Write-Warning 'Endpoints are not ready yet; retrying read-only checks in 15 seconds.'
            Start-Sleep -Seconds 15
        }
    } while ($true)
}

function Invoke-AdvisorDeployment {
    param($Context, [string]$Name, [string]$TemplatePath, [hashtable]$Parameters)
    $templateText = & az bicep build --file $TemplatePath --stdout --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Bicep compilation failed: $TemplatePath" }
    $values = @{}
    foreach ($key in $Parameters.Keys) { $values[$key] = @{ value = $Parameters[$key] } }
    $body = @{ properties = @{
        mode = 'Incremental'
        template = ($templateText -join "`n" | ConvertFrom-Json -AsHashtable)
        parameters = $values
    } }
    $uri = "$($Context.Arm)$($Context.GroupId)/providers/Microsoft.Resources/deployments/${Name}?api-version=2022-09-01"
    $token = Get-CloudToken $Context.Arm $Context.TenantId
    $null = Invoke-CloudApi $uri $token 'PUT' $body
    $deadline = [DateTime]::UtcNow.AddMinutes(25)
    do {
        Start-Sleep -Seconds 10
        $deployment = Invoke-CloudApi $uri $token
        $status = $deployment.properties.provisioningState
        if ($status -eq 'Succeeded') { return $deployment.properties.outputs }
        if ($status -in @('Failed', 'Canceled')) { throw "Deployment $Name $status. Inspect its operations in the Azure portal; rerun after correcting the reported cause." }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Deployment $Name is still in progress after 25 minutes. Inspect it before rerunning; do not start a competing deployment."
}
