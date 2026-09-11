const { app } = require('@azure/functions');
const { getRequiredApplicationIdentifier, withSqlConnection } = require('../lib/sql');
const {
  purgeAttachment,
  purgeDeletedNodes,
  purgeDeletedTrees,
  purgeNode,
  purgeTree,
} = require('../lib/purgeService');

function buildJsonResponse(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

function buildPurgeLogContext(payload) {
  const action = String(payload?.action ?? '').trim().toLowerCase();
  const treeId = Number(payload?.treeId);
  const nodeId = Number(payload?.nodeId);
  const attachmentId = Number(payload?.attachmentId);

  return {
    action,
    treeId: Number.isFinite(treeId) ? treeId : null,
    nodeId: Number.isFinite(nodeId) ? nodeId : null,
    attachmentId: Number.isFinite(attachmentId) ? attachmentId : null,
  };
}

app.http('purgeManager', {
  route: 'purge',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let payload;

    try {
      payload = await request.json();
    } catch {
      context.log.warn('purgeManager rejected request with invalid JSON body.');
      return buildJsonResponse(400, { error: 'Request body must be valid JSON.' });
    }

    const action = String(payload?.action ?? '').trim().toLowerCase();
    const applicationIdentifier = getRequiredApplicationIdentifier();
    const logContext = {
      applicationIdentifier,
      ...buildPurgeLogContext(payload),
    };

    context.log('purgeManager request started.', logContext);

    if (!['purge-all-trees', 'purge-all-nodes', 'purge-attachment', 'purge-node', 'purge-tree'].includes(action)) {
      context.log.warn('purgeManager rejected request with unsupported action.', logContext);
      return buildJsonResponse(400, { error: 'Invalid request, a supported action is required' });
    }

    try {
      const result = await withSqlConnection(async () => {
        if (action === 'purge-all-trees') {
          return purgeDeletedTrees(applicationIdentifier);
        }

        if (action === 'purge-all-nodes') {
          return purgeDeletedNodes(applicationIdentifier, { includeDeletedTrees: true });
        }

        if (action === 'purge-tree') {
          const treeId = Number(payload?.treeId);

          if (!Number.isFinite(treeId)) {
            throw new Error('Invalid request, treeId is required');
          }

          return purgeTree(applicationIdentifier, treeId);
        }

        if (action === 'purge-node') {
          const treeId = Number(payload?.treeId);
          const nodeId = Number(payload?.nodeId);

          if (!Number.isFinite(treeId) || !Number.isFinite(nodeId)) {
            throw new Error('Invalid request, treeId and nodeId are required');
          }

          return purgeNode(applicationIdentifier, treeId, nodeId);
        }

        const treeId = Number(payload?.treeId);
        const attachmentId = Number(payload?.attachmentId);

        if (!Number.isFinite(treeId) || !Number.isFinite(attachmentId)) {
          throw new Error('Invalid request, treeId and attachmentId are required');
        }

        return purgeAttachment(applicationIdentifier, treeId, attachmentId);
      });

      context.log('purgeManager request completed.', {
        ...logContext,
        result,
      });

      return buildJsonResponse(200, {
        success: true,
        action,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed';
      const status = message.includes('treeId and attachmentId are required')
        || message.includes('treeId and nodeId are required')
        || message === 'Invalid request, treeId is required'
        || message.includes('not found for purge')
        || message.includes('node is still deleted')
        || message.includes('must be soft-deleted')
        ? 400
        : 500;

      context.log.error('purgeManager request failed.', {
        ...logContext,
        status,
        message,
      });

      return buildJsonResponse(status, { error: message });
    }
  },
});