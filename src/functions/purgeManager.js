const { app } = require('@azure/functions');
const { getRequiredApplicationIdentifier, withSqlConnection } = require('../lib/sql');
const {
  purgeAttachment,
  purgeDeletedNodes,
  purgeDeletedTrees,
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

app.http('purgeManager', {
  route: 'purge',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request) => {
    let payload;

    try {
      payload = await request.json();
    } catch {
      return buildJsonResponse(400, { error: 'Request body must be valid JSON.' });
    }

    const action = String(payload?.action ?? '').trim().toLowerCase();
    const applicationIdentifier = getRequiredApplicationIdentifier();

    if (!['purge-all-trees', 'purge-all-nodes', 'purge-attachment', 'purge-tree'].includes(action)) {
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

        const treeId = Number(payload?.treeId);
        const attachmentId = Number(payload?.attachmentId);

        if (!Number.isFinite(treeId) || !Number.isFinite(attachmentId)) {
          throw new Error('Invalid request, treeId and attachmentId are required');
        }

        return purgeAttachment(applicationIdentifier, treeId, attachmentId);
      });

      return buildJsonResponse(200, {
        success: true,
        action,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed';
      const status = message.includes('treeId and attachmentId are required')
        || message === 'Invalid request, treeId is required'
        || message.includes('not found for purge')
        || message.includes('node is still deleted')
        || message.includes('must be soft-deleted')
        ? 400
        : 500;

      return buildJsonResponse(status, { error: message });
    }
  },
});