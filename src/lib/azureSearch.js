const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX_NAME;
const searchAdminKey = process.env.AZURE_SEARCH_ADMIN_KEY;
const SEARCH_API_VERSION = '2024-07-01';

function getRequiredSearchWriteConfig() {
  if (!searchEndpoint) {
    throw new Error('Azure Search endpoint env var is not configured');
  }

  if (!searchIndexName) {
    throw new Error('Azure Search index name env var is not configured');
  }

  if (!searchAdminKey) {
    throw new Error('Azure Search admin key env var is not configured');
  }

  return {
    endpoint: searchEndpoint.replace(/\/$/, ''),
    indexName: searchIndexName,
    adminKey: searchAdminKey,
  };
}

function encodeSearchKey(value) {
  const normalizedValue = String(value ?? '');

  if (!normalizedValue) {
    return '';
  }

  const base64Value = Buffer.from(normalizedValue, 'utf8').toString('base64');
  let endPosition = base64Value.length;

  while (endPosition > 0 && base64Value[endPosition - 1] === '=') {
    endPosition -= 1;
  }

  const encodedCharacters = new Array(endPosition + 1);
  encodedCharacters[endPosition] = String(base64Value.length - endPosition);

  for (let index = 0; index < endPosition; index += 1) {
    const currentCharacter = base64Value[index];

    if (currentCharacter === '+') {
      encodedCharacters[index] = '-';
    } else if (currentCharacter === '/') {
      encodedCharacters[index] = '_';
    } else {
      encodedCharacters[index] = currentCharacter;
    }
  }

  return encodedCharacters.join('');
}

function chunkValues(values, chunkSize) {
  const chunks = [];

  for (let startIndex = 0; startIndex < values.length; startIndex += chunkSize) {
    chunks.push(values.slice(startIndex, startIndex + chunkSize));
  }

  return chunks;
}

function buildTreeNodeSearchDocumentId(treeId, nodeId) {
  return `node-${treeId}-${nodeId}`;
}

function buildAttachmentSearchDocumentId(blobUrl) {
  const normalizedBlobUrl = String(blobUrl ?? '').trim();

  if (!normalizedBlobUrl) {
    return null;
  }

  return encodeSearchKey(normalizedBlobUrl);
}

async function deleteSearchDocumentsById(documentIds) {
  const normalizedIds = Array.from(new Set(
    (Array.isArray(documentIds) ? documentIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  ));

  if (normalizedIds.length === 0) {
    return {
      deletedDocumentCount: 0,
      batchCount: 0,
    };
  }

  const config = getRequiredSearchWriteConfig();
  const batches = chunkValues(normalizedIds, 500);
  const failures = [];

  for (const batch of batches) {
    const response = await fetch(
      `${config.endpoint}/indexes/${encodeURIComponent(config.indexName)}/docs/index?api-version=${SEARCH_API_VERSION}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.adminKey,
        },
        body: JSON.stringify({
          value: batch.map((id) => ({
            '@search.action': 'delete',
            id,
          })),
        }),
      },
    );

    if (!response.ok) {
      const errorText = (await response.text()).trim();
      throw new Error(`Azure Search document delete failed (${response.status}): ${errorText || 'No error details were returned.'}`);
    }

    const payload = await response.json();
    const results = Array.isArray(payload.value) ? payload.value : [];

    results.forEach((result) => {
      const succeeded = result?.status !== false && Number(result?.statusCode ?? 200) < 400;

      if (!succeeded) {
        failures.push({
          key: String(result?.key ?? ''),
          statusCode: Number(result?.statusCode ?? 0),
          errorMessage: String(result?.errorMessage ?? '').trim(),
        });
      }
    });
  }

  if (failures.length > 0) {
    const summary = failures
      .slice(0, 5)
      .map((failure) => `${failure.key || '<unknown>'} (${failure.statusCode || 'unknown'}${failure.errorMessage ? `: ${failure.errorMessage}` : ''})`)
      .join(', ');
    throw new Error(`Azure Search rejected ${failures.length} purge document delete operation(s): ${summary}`);
  }

  return {
    deletedDocumentCount: normalizedIds.length,
    batchCount: batches.length,
  };
}

module.exports = {
  buildAttachmentSearchDocumentId,
  buildTreeNodeSearchDocumentId,
  deleteSearchDocumentsById,
};