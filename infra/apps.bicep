targetScope = 'resourceGroup'

param location string
param namePrefix string
param deploymentKey string
param registryServer string
param imageTag string
param identityId string
param identityClientId string
param environmentId string
param environmentDomain string
param storageEndpoint string
param tenantId string
param apiClientId string
param typesafeModel string
param foundryEndpoint string
param decisionDeployment string
@secure()
param typesafeApiKey string
@secure()
param foundryApiKey string

var kinds = ['web', 'mcp']
resource apps 'Microsoft.App/containerApps@2024-03-01' = [for kind in kinds: {
  name: '${namePrefix}-${kind}'
  location: location
  tags: { advisorDeployment: deploymentKey }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: kind == 'web' ? 3000 : 3002
        transport: 'http'
        allowInsecure: false
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: [
        { name: 'typesafe-key', value: typesafeApiKey }
        { name: 'foundry-key', value: foundryApiKey }
      ]
    }
    template: {
      revisionSuffix: imageTag
      terminationGracePeriodSeconds: 30
      containers: [{
        name: kind
        image: '${registryServer}/advisor-${kind}:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat([
          { name: 'TYPESAFE_API_KEY', secretRef: 'typesafe-key' }
          { name: 'TYPESAFE_MODEL', value: typesafeModel }
          { name: 'FOUNDRY_ENDPOINT', value: foundryEndpoint }
          { name: 'DECISION_DEPLOYMENT', value: decisionDeployment }
          { name: 'FOUNDRY_API_KEY', secretRef: 'foundry-key' }
          { name: '${toUpper(kind)}_TABLE_ENDPOINT', value: storageEndpoint }
          { name: '${toUpper(kind)}_TABLE_NAME', value: 'AdvisorUsage' }
          { name: '${toUpper(kind)}_TABLE_NAMESPACE', value: kind }
          { name: '${toUpper(kind)}_TABLE_CREDENTIAL', value: 'managed-identity' }
          { name: '${toUpper(kind)}_TABLE_MANAGED_IDENTITY_CLIENT_ID', value: identityClientId }
        ], kind == 'web' ? [
          { name: 'PUBLIC_ORIGIN', value: 'https://${namePrefix}-web.${environmentDomain}' }
          { name: 'WEB_RATE_LIMIT', value: '30' }
        ] : [
          { name: 'MCP_PUBLIC_ORIGIN', value: 'https://${namePrefix}-mcp.${environmentDomain}' }
          { name: 'MCP_ENTRA_TENANT_ID', value: tenantId }
          { name: 'MCP_ENTRA_CLIENT_ID', value: apiClientId }
          { name: 'MCP_ENTRA_APP_ROLE', value: 'Advisor.Invoke.All' }
          { name: 'MCP_RATE_LIMIT', value: '60' }
        ])
        probes: [
          {
            type: 'Startup'
            tcpSocket: { port: kind == 'web' ? 3000 : 3002 }
            periodSeconds: 5
            failureThreshold: 60
          }
          {
            type: 'Liveness'
            tcpSocket: { port: kind == 'web' ? 3000 : 3002 }
            periodSeconds: 30
          }
          {
            type: 'Readiness'
            tcpSocket: { port: kind == 'web' ? 3000 : 3002 }
            periodSeconds: 10
          }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [{
          name: 'http'
          http: { metadata: { concurrentRequests: kind == 'web' ? '1' : '8' } }
        }]
      }
    }
  }
}]

output webUrl string = 'https://${apps[0].properties.configuration.ingress.fqdn}'
output mcpUrl string = 'https://${apps[1].properties.configuration.ingress.fqdn}/mcp'
output resourceIds array = [for (kind, index) in kinds: apps[index].id]
