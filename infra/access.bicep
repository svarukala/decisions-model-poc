param storageName string
param registryName string
param principalId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource tables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource usage 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = {
  parent: tables
  name: 'AdvisorUsage'
}
resource tableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(usage.id, principalId, 'table-contributor')
  scope: usage
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  }
}
resource registryAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, 'acr-pull')
  scope: registry
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
output roleAssignmentIds array = [tableAccess.id, registryAccess.id]
