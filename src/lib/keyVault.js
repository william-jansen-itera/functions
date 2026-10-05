const { randomUUID } = require('crypto');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

const keyVaultUrl = String(process.env.AZURE_KEY_VAULT_URL ?? '').trim();
const managedIdentityClientId = String(process.env.AZURE_KEY_VAULT_MANAGED_IDENTITY_CLIENT_ID ?? '').trim() || undefined;

let secretClient;

function getRequiredKeyVaultUrl() {
  if (!keyVaultUrl) {
    throw new Error('Azure Key Vault URL env var is not configured');
  }

  return keyVaultUrl;
}

function getCredential() {
  return managedIdentityClientId
    ? new DefaultAzureCredential({ managedIdentityClientId })
    : new DefaultAzureCredential();
}

function getSecretClient() {
  if (!secretClient) {
    secretClient = new SecretClient(getRequiredKeyVaultUrl(), getCredential());
  }

  return secretClient;
}

function sanitizeSecretSegment(value, fallbackValue = 'secret') {
  const normalizedValue = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalizedValue || fallbackValue;
}

function buildTreeNodeSecretNamePrefix({ applicationIdentifier, treeId, nodeId }) {
  const applicationSegment = sanitizeSecretSegment(applicationIdentifier, 'app');
  const treeSegment = sanitizeSecretSegment(treeId, 'tree');
  const nodeSegment = sanitizeSecretSegment(nodeId, 'node');

  return `tree-${applicationSegment}-${treeSegment}-${nodeSegment}`;
}

function buildTreeNodeSecretName({ applicationIdentifier, treeId, nodeId, secretSuffix = null }) {
  const suffix = sanitizeSecretSegment(secretSuffix ?? randomUUID().slice(0, 12), 'secret');

  return `${buildTreeNodeSecretNamePrefix({ applicationIdentifier, treeId, nodeId })}-${suffix}`;
}

async function setSecretValue({ secretName, secretValue }) {
  if (!String(secretName ?? '').trim()) {
    throw new Error('A secret name is required');
  }

  if (!String(secretValue ?? '').trim()) {
    throw new Error('A secret value is required');
  }

  const result = await getSecretClient().setSecret(String(secretName).trim(), String(secretValue));

  return {
    provider: 'azure_key_vault',
    secretName: result.name,
    version: result.properties?.version ?? null,
    vaultUrl: getRequiredKeyVaultUrl(),
  };
}

async function getSecretValue(secretName, version = undefined) {
  if (!String(secretName ?? '').trim()) {
    throw new Error('A secret name is required');
  }

  const result = await getSecretClient().getSecret(String(secretName).trim(), {
    version: String(version ?? '').trim() || undefined,
  });

  return {
    value: result.value ?? '',
    provider: 'azure_key_vault',
    secretName: result.name,
    version: result.properties?.version ?? null,
    vaultUrl: getRequiredKeyVaultUrl(),
  };
}

async function deleteSecretValue(secretName) {
  if (!String(secretName ?? '').trim()) {
    throw new Error('A secret name is required');
  }

  try {
    const poller = await getSecretClient().beginDeleteSecret(String(secretName).trim());
    const result = await poller.pollUntilDone();

    return {
      deleted: true,
      provider: 'azure_key_vault',
      secretName: result.name,
      version: result.properties?.version ?? null,
      vaultUrl: getRequiredKeyVaultUrl(),
    };
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === 'SecretNotFound') {
      return {
        deleted: false,
        provider: 'azure_key_vault',
        secretName: String(secretName).trim(),
        version: null,
        vaultUrl: getRequiredKeyVaultUrl(),
      };
    }

    throw error;
  }
}

module.exports = {
  buildTreeNodeSecretName,
  buildTreeNodeSecretNamePrefix,
  deleteSecretValue,
  getRequiredKeyVaultUrl,
  getSecretClient,
  getSecretValue,
  setSecretValue,
};