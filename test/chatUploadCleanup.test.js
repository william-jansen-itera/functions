const test = require('node:test');
const assert = require('node:assert/strict');

const requests = [];
let documents = [{ id: 'document-1' }];

process.env.AZURE_SEARCH_ENDPOINT = 'https://search.example';
process.env.CHAT_UPLOAD_SEARCH_INDEX_NAME = 'chat-upload-index';
process.env.AZURE_SEARCH_ADMIN_KEY = 'test-key';

const { deleteSearchUpload } = require('../src/lib/chatUploadCleanup');

test.beforeEach(() => {
  requests.length = 0;
  documents = [{ id: 'document-1' }];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ value: url.includes('/search?')
      ? documents : documents.map(() => ({ status: true, statusCode: 200 })) }) };
  };
});

test('deletes only documents matching the upload ID', async () => {
  await deleteSearchUpload('upload-id');
  assert.equal(requests[0].body.filter, "uploadId eq 'upload-id'");
  assert.deepEqual(requests[1].body.value, [{ '@search.action': 'delete', id: 'document-1' }]);
});

test('does not silently leave documents when the search result is truncated', async () => {
  documents = Array.from({ length: 100 }, (_, index) => ({ id: `document-${index}` }));
  await assert.rejects(deleteSearchUpload('upload-id'), /Too many documents/);
  assert.equal(requests.length, 1);
});