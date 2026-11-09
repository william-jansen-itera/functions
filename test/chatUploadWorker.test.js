const test = require('node:test');
const assert = require('node:assert/strict');

let handler;
let queueConnection;
let claimedUpload;
let extractionError;
const calls = [];

const jobPath = require.resolve('../src/lib/chatUploadJob');
const processingPath = require.resolve('../src/lib/chatUploadProcessing');
const functionsPath = require.resolve('@azure/functions');
require.cache[jobPath] = { id: jobPath, filename: jobPath, loaded: true, exports: {
  claimUpload: async () => claimedUpload,
  renewUpload: async () => { calls.push('renew'); },
  finishUpload: async (...args) => { calls.push(['finish', ...args]); },
  releaseUpload: async (...args) => { calls.push(['release', ...args]); },
} };
require.cache[processingPath] = { id: processingPath, filename: processingPath, loaded: true, exports: {
  waitForIndexedUpload: async () => {
    calls.push('extract');
    if (extractionError) throw extractionError;
    return { text: 'Readable content', partial: false };
  },
  generateTemporaryNote: async () => { calls.push('note'); return 'Temporary note'; },
  stopIndexingAndDeleteDocument: async () => { calls.push('deleteSearch'); },
} };
require.cache[functionsPath] = { id: functionsPath, filename: functionsPath, loaded: true, exports: {
  app: { storageQueue: (_name, config) => { handler = config.handler; queueConnection = config.connection; } },
} };
require('../src/functions/processUploadWorker');

const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
const context = { log() {}, error() {}, triggerMetadata: { dequeueCount: 1 } };

test('listens on the separate chat upload storage account', () => {
  assert.equal(queueConnection, 'CHAT_UPLOAD_STORAGE_CONNECTION_STRING');
});

test.beforeEach(() => {
  calls.length = 0;
  extractionError = null;
  claimedUpload = { attemptToken: 'token', ownerObjectId: 'owner', fileName: 'file.txt', blobName: 'file' };
});

test('finishes only after temporary Search document deletion', async () => {
  await handler({ uploadId }, context);
  assert.deepEqual(calls, ['extract', 'note', 'deleteSearch', ['finish', uploadId, 'token', 'Temporary note']]);
});

test('releases failed extraction for retry and rethrows', async () => {
  extractionError = new Error('Search unavailable');
  await assert.rejects(handler({ uploadId }, context), /Search unavailable/);
  assert.deepEqual(calls, ['extract', ['release', uploadId, 'token', { failed: false, reason: null }]]);
});

test('marks final failed attempt and rejects malformed jobs', async () => {
  extractionError = new Error('Search unavailable');
  await assert.rejects(handler({ uploadId }, { ...context, triggerMetadata: { dequeueCount: 5 } }));
  assert.deepEqual(calls.at(-1), ['release', uploadId, 'token', { failed: true, reason: 'File processing failed after multiple attempts.' }]);
  await assert.rejects(handler({ uploadId: 'invalid' }, context), /Invalid chat upload job/);
});