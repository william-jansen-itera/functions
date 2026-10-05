const { app } = require('@azure/functions');
const { getRequiredApplicationIdentifier } = require('../lib/sql');
const {
  buildTreeNodeSecretName,
  buildTreeNodeSecretNamePrefix,
  getSecretValue,
  setSecretValue,
} = require('../lib/keyVault');

function buildJsonResponse(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

function toTrimmedString(value) {
  const normalizedValue = String(value ?? '').trim();
  return normalizedValue || null;
}

function buildSecretMetadata({ treeId, nodeId, secretMetadata = null, applicationIdentifier }) {
  const normalizedTreeId = toTrimmedString(treeId);
  const normalizedNodeId = toTrimmedString(nodeId);
  const providedSecretName = toTrimmedString(secretMetadata?.secretName);
  const secretName = providedSecretName || buildTreeNodeSecretName({
    applicationIdentifier,
    treeId: normalizedTreeId,
    nodeId: normalizedNodeId,
  });

  return {
    provider: 'azure_key_vault',
    secretName,
    version: toTrimmedString(secretMetadata?.version),
    vaultUrl: toTrimmedString(secretMetadata?.vaultUrl),
    displayLabel: toTrimmedString(secretMetadata?.displayLabel) || secretName,
  };
}

function assertSecretNameMatchesLeaf(secretName, { treeId, nodeId, applicationIdentifier }) {
  const expectedPrefix = `${buildTreeNodeSecretNamePrefix({
    applicationIdentifier,
    treeId,
    nodeId,
  })}-`;

  if (!String(secretName ?? '').startsWith(expectedPrefix)) {
    throw new Error('Invalid request, secret metadata does not match the target leaf node');
  }
}

function validateSetSecretPayload(payload) {
  if (!toTrimmedString(payload?.treeId) || !toTrimmedString(payload?.nodeId)) {
    throw new Error('Invalid request, treeId and nodeId are required for set-secret');
  }

  if (!toTrimmedString(payload?.secretValue)) {
    throw new Error('Invalid request, secretValue is required for set-secret');
  }
}

function validateGetSecretPayload(payload) {
  const secretName = toTrimmedString(payload?.secretMetadata?.secretName);
  const hasTreeNodeCoordinates = toTrimmedString(payload?.treeId) && toTrimmedString(payload?.nodeId);

  if (!secretName || !hasTreeNodeCoordinates) {
    throw new Error('Invalid request, treeId, nodeId, and secretMetadata.secretName are required for get-secret');
  }
}

app.http('secretBroker', {
  route: 'tree-secrets',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let payload;

    try {
      payload = await request.json();
    } catch {
      context.log.warn('secretBroker rejected request with invalid JSON body.');
      return buildJsonResponse(400, { error: 'Request body must be valid JSON.' });
    }

    const action = String(payload?.action ?? '').trim().toLowerCase();

    if (action !== 'set-secret' && action !== 'get-secret') {
      context.log.warn('secretBroker rejected request with unsupported action.', { action });
      return buildJsonResponse(400, { error: 'Invalid request, a supported action is required' });
    }

    try {
      const applicationIdentifier = getRequiredApplicationIdentifier();

      if (action === 'set-secret') {
        validateSetSecretPayload(payload);

        const secretMetadata = buildSecretMetadata({
          treeId: payload.treeId,
          nodeId: payload.nodeId,
          secretMetadata: payload.secretMetadata,
          applicationIdentifier,
        });
        assertSecretNameMatchesLeaf(secretMetadata.secretName, {
          treeId: payload.treeId,
          nodeId: payload.nodeId,
          applicationIdentifier,
        });
        const storedSecret = await setSecretValue({
          secretName: secretMetadata.secretName,
          secretValue: payload.secretValue,
        });

        return buildJsonResponse(200, {
          success: true,
          action,
          secretMetadata: {
            ...secretMetadata,
            version: storedSecret.version,
            vaultUrl: storedSecret.vaultUrl,
          },
        });
      }

      validateGetSecretPayload(payload);

      const secretMetadata = buildSecretMetadata({
        treeId: payload.treeId,
        nodeId: payload.nodeId,
        secretMetadata: payload.secretMetadata,
        applicationIdentifier,
      });
      assertSecretNameMatchesLeaf(secretMetadata.secretName, {
        treeId: payload.treeId,
        nodeId: payload.nodeId,
        applicationIdentifier,
      });
      const secret = await getSecretValue(secretMetadata.secretName, secretMetadata.version);

      return buildJsonResponse(200, {
        success: true,
        action,
        secretMetadata: {
          ...secretMetadata,
          version: secret.version,
          vaultUrl: secret.vaultUrl,
        },
        secretValue: secret.value,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed';
      const status = message.startsWith('Invalid request') ? 400 : 500;

      context.log.error('secretBroker request failed.', {
        action,
        status,
        message,
      });

      return buildJsonResponse(status, { error: message });
    }
  },
});