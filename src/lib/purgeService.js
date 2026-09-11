const { sql } = require('./sql');
const { deleteNodeAttachmentBlobIfExists } = require('./blobStorage');
const {
  buildAttachmentSearchDocumentId,
  buildTreeNodeSearchDocumentId,
  deleteSearchDocumentsById,
} = require('./azureSearch');

const SOFT_DELETE_RETENTION_DAYS = 7;

function addDeletedBeforeInput(request, deletedBefore) {
  if (deletedBefore instanceof Date && Number.isFinite(deletedBefore.getTime())) {
    request.input('deleted_before', sql.DateTime2, deletedBefore);
  }

  return request;
}

function buildDeletedTreeCondition({ deletedBefore = null } = {}) {
  return deletedBefore
    ? 'ti.deleted_at IS NOT NULL AND ti.deleted_at < @deleted_before'
    : 'ti.deleted_at IS NOT NULL';
}

function buildDeletedNodeCondition({ deletedBefore = null, includeDeletedTrees = true } = {}) {
  if (!includeDeletedTrees) {
    return deletedBefore
      ? 'tn.deleted_at IS NOT NULL AND tn.deleted_at < @deleted_before AND ti.deleted_at IS NULL'
      : 'tn.deleted_at IS NOT NULL AND ti.deleted_at IS NULL';
  }

  if (deletedBefore) {
    return `(
        (tn.deleted_at IS NOT NULL AND tn.deleted_at < @deleted_before)
        OR (ti.deleted_at IS NOT NULL AND ti.deleted_at < @deleted_before)
      )`;
  }

  return '(tn.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL)';
}

function buildDeletedAttachmentCondition({ deletedBefore = null } = {}) {
  return deletedBefore
    ? 'files.deleted_at IS NOT NULL AND files.deleted_at < @deleted_before AND tn.deleted_at IS NULL AND ti.deleted_at IS NULL'
    : 'files.deleted_at IS NOT NULL AND tn.deleted_at IS NULL AND ti.deleted_at IS NULL';
}

async function getDeletedTreeAttachmentBlobs(applicationIdentifier, { deletedBefore = null } = {}) {
  const treeCondition = buildDeletedTreeCondition({ deletedBefore });
  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const result = await request.query(`
      SELECT
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${treeCondition};
    `);

  return result.recordset;
}

async function getDeletedTreeNodeIds(applicationIdentifier, { deletedBefore = null } = {}) {
  const treeCondition = buildDeletedTreeCondition({ deletedBefore });
  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const result = await request.query(`
      SELECT
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${treeCondition};
    `);

  return result.recordset;
}

async function getDeletedNodeAttachmentBlobs(applicationIdentifier, { deletedBefore = null, includeDeletedTrees = true } = {}) {
  const nodeCondition = buildDeletedNodeCondition({ deletedBefore, includeDeletedTrees });
  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const result = await request.query(`
      SELECT
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${nodeCondition};
    `);

  return result.recordset;
}

async function getDeletedNodeIds(applicationIdentifier, { deletedBefore = null, includeDeletedTrees = true } = {}) {
  const nodeCondition = buildDeletedNodeCondition({ deletedBefore, includeDeletedTrees });
  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const result = await request.query(`
      SELECT
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${nodeCondition};
    `);

  return result.recordset;
}

async function getDeletedAttachmentItems(applicationIdentifier, { deletedBefore = null } = {}) {
  const attachmentCondition = buildDeletedAttachmentCondition({ deletedBefore });
  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const result = await request.query(`
      SELECT
        CAST(files.id AS VARCHAR(20)) AS attachmentId,
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId,
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${attachmentCondition};
    `);

  return result.recordset;
}

async function deleteAttachmentArtifacts(attachments) {
  const searchDocumentIds = attachments
    .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
    .filter(Boolean);
  const searchResult = await deleteSearchDocumentsById(searchDocumentIds);

  for (const attachment of attachments) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  return {
    deletedBlobCount: attachments.length,
    deletedSearchDocumentCount: searchResult.deletedDocumentCount,
  };
}

async function purgeDeletedTrees(applicationIdentifier, { deletedBefore = null } = {}) {
  const [nodes, attachments] = await Promise.all([
    getDeletedTreeNodeIds(applicationIdentifier, { deletedBefore }),
    getDeletedTreeAttachmentBlobs(applicationIdentifier, { deletedBefore }),
  ]);
  const searchDocumentIds = [
    ...nodes.map((node) => buildTreeNodeSearchDocumentId(node.treeId, node.nodeId)),
    ...attachments
      .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
      .filter(Boolean),
  ];
  const searchResult = await deleteSearchDocumentsById(searchDocumentIds);

  for (const attachment of attachments) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const treeCondition = buildDeletedTreeCondition({ deletedBefore });
  const result = await request.query(`
      DELETE ti
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${treeCondition};
    `);

  return {
    purgedTreeCount: Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, count) => sum + count, 0) : 0,
    deletedBlobCount: attachments.length,
    deletedSearchDocumentCount: searchResult.deletedDocumentCount,
  };
}

async function purgeDeletedNodes(
  applicationIdentifier,
  { deletedBefore = null, includeDeletedTrees = true } = {},
) {
  const [nodes, attachments] = await Promise.all([
    getDeletedNodeIds(applicationIdentifier, { deletedBefore, includeDeletedTrees }),
    getDeletedNodeAttachmentBlobs(applicationIdentifier, { deletedBefore, includeDeletedTrees }),
  ]);
  const searchDocumentIds = [
    ...nodes.map((node) => buildTreeNodeSearchDocumentId(node.treeId, node.nodeId)),
    ...attachments
      .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
      .filter(Boolean),
  ];
  const searchResult = await deleteSearchDocumentsById(searchDocumentIds);

  for (const attachment of attachments) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const nodeCondition = buildDeletedNodeCondition({ deletedBefore, includeDeletedTrees });
  const result = await request.query(`
      DELETE tn
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${nodeCondition};
    `);

  return {
    purgedNodeCount: Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, count) => sum + count, 0) : 0,
    deletedBlobCount: attachments.length,
    deletedSearchDocumentCount: searchResult.deletedDocumentCount,
  };
}

async function purgeDeletedAttachments(applicationIdentifier, { deletedBefore = null } = {}) {
  const attachments = await getDeletedAttachmentItems(applicationIdentifier, { deletedBefore });
  const deletedArtifacts = await deleteAttachmentArtifacts(attachments);

  const request = addDeletedBeforeInput(
    new sql.Request().input('application_identifier', sql.NVarChar, applicationIdentifier),
    deletedBefore,
  );
  const attachmentCondition = buildDeletedAttachmentCondition({ deletedBefore });
  const result = await request.query(`
      DELETE files
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ${attachmentCondition};
    `);

  return {
    purgedAttachmentCount: Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, count) => sum + count, 0) : 0,
    deletedBlobCount: deletedArtifacts.deletedBlobCount,
    deletedSearchDocumentCount: deletedArtifacts.deletedSearchDocumentCount,
  };
}

async function purgeAttachment(applicationIdentifier, treeId, attachmentId) {
  const attachmentResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .query(`
      SELECT TOP 1
        files.blob_name AS blobName,
        files.blob_url AS blobUrl,
        CAST(files.id AS VARCHAR(20)) AS attachmentId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  const attachment = attachmentResult.recordset[0] ?? null;

  if (!attachment) {
    throw new Error('Attachment was not found for purge or its node is still deleted');
  }

  const deletedArtifacts = await deleteAttachmentArtifacts([attachment]);

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .query(`
      DELETE files
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Attachment was not found for purge or its node is still deleted');
  }

  return {
    purgedAttachmentId: String(attachmentId),
    treeId: String(treeId),
    nodeId: String(attachment.nodeId),
    deletedBlobCount: deletedArtifacts.deletedBlobCount,
    deletedSearchDocumentCount: deletedArtifacts.deletedSearchDocumentCount,
  };
}

async function purgeTree(applicationIdentifier, treeId) {
  const treeResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .query(`
      SELECT TOP 1 ti.deleted_at AS deletedAt
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id;
    `);

  const deletedAt = treeResult.recordset[0]?.deletedAt ?? null;

  if (!deletedAt) {
    throw new Error('Tree must be soft-deleted before it can be purged');
  }

  const [nodes, attachments] = await Promise.all([
    new sql.Request()
      .input('application_identifier', sql.NVarChar, applicationIdentifier)
      .input('tree_instance_id', sql.Int, Number(treeId))
      .query(`
        SELECT CAST(tn.id AS VARCHAR(20)) AS nodeId
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND ti.id = @tree_instance_id;
      `),
    new sql.Request()
      .input('application_identifier', sql.NVarChar, applicationIdentifier)
      .input('tree_instance_id', sql.Int, Number(treeId))
      .query(`
        SELECT files.blob_name AS blobName, files.blob_url AS blobUrl
        FROM tree_node_detail_files files
        INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND ti.id = @tree_instance_id;
      `),
  ]);
  const searchDocumentIds = [
    ...nodes.recordset.map((node) => buildTreeNodeSearchDocumentId(treeId, node.nodeId)),
    ...attachments.recordset
      .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
      .filter(Boolean),
  ];
  const searchResult = await deleteSearchDocumentsById(searchDocumentIds);

  for (const attachment of attachments.recordset) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  const purgeResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .query(`
      DELETE ti
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at IS NOT NULL;
    `);

  if (!purgeResult.rowsAffected[0]) {
    throw new Error('Tree was not found for purge');
  }

  return {
    purgedTreeId: String(treeId),
    deletedBlobCount: attachments.recordset.length,
    deletedSearchDocumentCount: searchResult.deletedDocumentCount,
  };
}

function buildSoftDeleteRetentionCutoff(now = new Date()) {
  return new Date(now.getTime() - (SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}

async function runExpiredRetentionPurge(applicationIdentifier, { now = new Date() } = {}) {
  const deletedBefore = buildSoftDeleteRetentionCutoff(now);
  const attachmentResult = await purgeDeletedAttachments(applicationIdentifier, { deletedBefore });
  const nodeResult = await purgeDeletedNodes(applicationIdentifier, {
    deletedBefore,
    includeDeletedTrees: false,
  });
  const treeResult = await purgeDeletedTrees(applicationIdentifier, { deletedBefore });

  return {
    retentionDays: SOFT_DELETE_RETENTION_DAYS,
    deletedBefore,
    purgedAttachmentCount: attachmentResult.purgedAttachmentCount,
    purgedNodeCount: nodeResult.purgedNodeCount,
    purgedTreeCount: treeResult.purgedTreeCount,
    deletedBlobCount: attachmentResult.deletedBlobCount + nodeResult.deletedBlobCount + treeResult.deletedBlobCount,
    deletedSearchDocumentCount: attachmentResult.deletedSearchDocumentCount
      + nodeResult.deletedSearchDocumentCount
      + treeResult.deletedSearchDocumentCount,
  };
}

module.exports = {
  SOFT_DELETE_RETENTION_DAYS,
  buildSoftDeleteRetentionCutoff,
  purgeAttachment,
  purgeDeletedAttachments,
  purgeDeletedNodes,
  purgeDeletedTrees,
  purgeTree,
  runExpiredRetentionPurge,
};