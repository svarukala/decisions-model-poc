targetScope = 'resourceGroup'

param location string
param computeLocation string = location
@minLength(3)
@maxLength(11)
param namePrefix string = 'archadvisor'
param deploymentKey string

var suffix = uniqueString(resourceGroup().id, namePrefix)
var tags = { advisorDeployment: deploymentKey }

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${namePrefix}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${namePrefix}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
  }
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource usage 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tables
  name: 'AdvisorUsage'
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-runtime'
  location: location
  tags: tags
}
module access 'access.bicep' = {
  name: '${namePrefix}-access'
  params: {
    storageName: storage.name
    registryName: registry.name
    principalId: identity.properties.principalId
  }
  dependsOn: [usage]
}
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-environment-${computeLocation}'
  location: computeLocation
  tags: tags
  properties: {
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output storageEndpoint string = storage.properties.primaryEndpoints.table
output identityId string = identity.id
output identityClientId string = identity.properties.clientId
output environmentId string = environment.id
output environmentDomain string = environment.properties.defaultDomain
output roleAssignmentIds array = access.outputs.roleAssignmentIds
output resourceIds array = [registry.id, storage.id, identity.id, environment.id]
