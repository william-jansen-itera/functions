const test = require('node:test');
const assert = require('node:assert/strict');

let handler;
let queueConnection;
let claimedUpload;
let extractionError;
let extractedCaptions;
let extractedSource;
const calls = [];

const jobPath = require.resolve('../src/lib/chatUploadJob');
const processingPath = require.resolve('../src/lib/chatUploadProcessing');
const functionsPath = require.resolve('@azure/functions');
require.cache[jobPath] = { id: jobPath, filename: jobPath, loaded: true, exports: {
  claimUpload: async () => claimedUpload,
  renewUpload: async () => { calls.push('renew'); },
  completeChatUploadProcessing: async (...args) => { calls.push(['completeProcessing', ...args]); },
  releaseUpload: async (...args) => { calls.push(['release', ...args]); },
} };
require.cache[processingPath] = { id: processingPath, filename: processingPath, loaded: true, exports: {
  waitForIndexedUpload: async () => {
    calls.push('extract');
    if (extractionError) throw extractionError;
    return { text: extractedSource || extractedCaptions.join('\n'), sourceText: extractedSource, partial: false, captions: extractedCaptions };
  },
  classifyUpload: ({ fileName, sourceText }) => fileName.endsWith('.png') || !sourceText
    || sourceText.length > 4000
    ? { saveKind: 'attachment', extractedNoteText: null }
    : { saveKind: 'note', extractedNoteText: sourceText },
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
  extractedCaptions = [];
  extractedSource = 'Readable content';
  claimedUpload = { attemptToken: 'token', ownerObjectId: 'owner', fileName: 'file.txt', blobName: 'file' };
});

test('finishes only after temporary Search document deletion', async () => {
  await handler({ uploadId }, context);
  assert.deepEqual(calls, ['extract', 'note', 'deleteSearch', ['completeProcessing', uploadId, 'token', {
    note: 'Temporary note', caption: null, saveKind: 'note', extractedNoteText: 'Readable content',
  }]]);
});

test('saves image captions alongside the note in source order', async () => {
  extractedCaptions = ['A chart showing trends', 'A map showing locations'];
  await handler({ uploadId }, context);
  assert.deepEqual(calls, ['extract', 'note', 'deleteSearch',
    ['completeProcessing', uploadId, 'token', { note: 'Temporary note', caption: 'A chart showing trends\nA map showing locations',
      saveKind: 'note', extractedNoteText: 'Readable content' }]]);
});

test('bounds stored captions without changing the note', async () => {
  extractedCaptions = ['A'.repeat(2100)];
  await handler({ uploadId }, context);
  assert.equal(calls.at(-1)[3].note, 'Temporary note');
  assert.equal(calls.at(-1)[3].caption.length, 2000);
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

test('image with caption is saved as an attachment, not as caption text', async () => {
  claimedUpload.fileName = 'chart.png';
  extractedSource = '';
  extractedCaptions = ['Chart of receipts'];
  await handler({ uploadId }, context);
  assert.deepEqual(calls.at(-1)[3], {
    note: 'Temporary note', caption: 'Chart of receipts', saveKind: 'attachment', extractedNoteText: null,
  });
});

test('unreadable image succeeds as an attachment without fabricated notes', async () => {
  claimedUpload.fileName = 'chart.png';
  extractedSource = '';
  await handler({ uploadId }, context);
  assert.deepEqual(calls, ['extract', 'deleteSearch', ['completeProcessing', uploadId, 'token', {
    note: null, caption: null, saveKind: 'attachment', extractedNoteText: null,
  }]]);
});

test('long document keeps the original file rather than the placement note', async () => {
  extractedSource = 'x'.repeat(4001);
  await handler({ uploadId }, context);
  assert.equal(calls.at(-1)[3].saveKind, 'attachment');
  assert.equal(calls.at(-1)[3].extractedNoteText, null);
});