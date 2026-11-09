const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const { sql, withSqlConnection, getRequiredApplicationIdentifier } = require('./sql');

function getStagingContainer() {
  const containerName = process.env.CHAT_UPLOAD_CONTAINER_NAME;
  const connectionString = process.env.CHAT_UPLOAD_STORAGE_CONNECTION_STRING;
  const accountUrl = process.env.CHAT_UPLOAD_STORAGE_ACCOUNT_URL;
  if (!containerName || (!connectionString && !accountUrl)) {
    throw new Error('Temporary chat upload storage is not configured.');
  }
  const client = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  return client.getContainerClient(containerName);
}

function getSearchConfig() {
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT?.replace(/\/$/, '');
  const index = process.env.CHAT_UPLOAD_SEARCH_INDEX_NAME;
  const key = process.env.AZURE_SEARCH_ADMIN_KEY;
  if (!endpoint || !index || !key) {
    throw new Error('Temporary chat upload Search configuration is incomplete.');
  }
  return { endpoint, index, key };
}

async function searchRequest(url, key, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Temporary chat upload Search request failed (${response.status}).`);
  }
  return response.json();
}

async function deleteSearchUpload(uploadId) {
  const { endpoint, index, key } = getSearchConfig();
  const indexUrl = `${endpoint}/indexes/${encodeURIComponent(index)}/docs`;
  const filter = `uploadId eq '${uploadId}'`;
  const found = await searchRequest(`${indexUrl}/search?api-version=2024-07-01`, key, {
    search: '*', filter, select: 'id', top: 100,
  });
  const documents = found.value || [];
  if (documents.length === 0) return;
  if (documents.length === 100) throw new Error('Too many documents for a single upload.');

  const result = await searchRequest(`${indexUrl}/index?api-version=2024-07-01`, key, {
    value: documents.map((document) => ({ '@search.action': 'delete', id: document.id })),
  });
  if (!result.value?.every((entry) => entry.status === true && entry.statusCode < 400)) {
    throw new Error('Temporary upload Search document deletion was rejected.');
  }
}

async function claimExpiredUploads() {
  const result = await withSqlConnection(() => new sql.Request()
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      ;WITH expired AS (
        SELECT TOP (25) u.id
        FROM dbo.chat_uploads u WITH (UPDLOCK)
        INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
        WHERE ai.app_identifier = @application_identifier AND u.expires_at <= SYSUTCDATETIME()
          AND (u.status NOT IN ('running', 'purging') OR u.lease_until < SYSUTCDATETIME())
        ORDER BY u.expires_at
      )
      UPDATE u SET status = N'purging', lease_until = DATEADD(minute, 10, SYSUTCDATETIME()),
        updated_at = SYSUTCDATETIME()
      OUTPUT inserted.id, inserted.blob_name AS blobName
      FROM dbo.chat_uploads u INNER JOIN expired ON expired.id = u.id;
    `));
  return result.recordset;
}

async function deleteExpiredUpload({ id, blobName }) {
  await getStagingContainer().getBlobClient(blobName).deleteIfExists({ deleteSnapshots: 'include' });
  await deleteSearchUpload(String(id));
  await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, id)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      DELETE u FROM dbo.chat_uploads u
      INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
      WHERE u.id = @id AND ai.app_identifier = @application_identifier AND u.status = N'purging';
    `));
}

async function purgeExpiredChatUploads(context) {
  getSearchConfig();
  getStagingContainer();
  const expiredUploads = await claimExpiredUploads();
  let failed = 0;
  for (const upload of expiredUploads) {
    try {
      await deleteExpiredUpload(upload);
    } catch (error) {
      failed += 1;
      context.error(`Failed to delete expired chat upload ${upload.id}.`, error);
    }
  }
  if (failed) throw new Error(`Cleanup failed for ${failed} expired chat upload(s); they will be retried.`);
  return expiredUploads.length;
}

module.exports = { deleteSearchUpload, getSearchConfig, getStagingContainer, purgeExpiredChatUploads, searchRequest };