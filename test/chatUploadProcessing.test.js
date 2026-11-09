const test = require('node:test');
const assert = require('node:assert/strict');

let noteText = 'Subject: contracts. Topics: renewal and obligations.';
let noteRequest;
let searchResult = { value: [{ content: 'Contract text', ocrText: ['Scanned clause'] }] };
const searches = [];

function mockModule(name, exports) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

mockModule('@azure/ai-projects', { AIProjectClient: class {
  getOpenAIClient() { return { responses: { create: async (request) => { noteRequest = request; return { output_text: noteText }; } } }; }
} });
mockModule('@azure/identity', { DefaultAzureCredential: class {} });
mockModule('../src/lib/sql', { getRequiredApplicationIdentifier: () => 'app' });
mockModule('../src/lib/chatUploadCleanup', {
  getSearchConfig: () => ({ endpoint: 'https://search.example', index: 'uploads', key: 'secret' }),
  getStagingContainer: () => ({ getBlobClient: () => ({
    getProperties: async () => ({ metadata: { uploadid: 'id' } }),
    setMetadata: async (metadata) => searches.push(metadata),
  }) }),
  searchRequest: async (_url, _key, body) => { searches.push(body); return searchResult; },
  deleteSearchUpload: async (id) => searches.push(['delete', id]),
});

const { waitForIndexedUpload, generateTemporaryNote, stopIndexingAndDeleteDocument } = require('../src/lib/chatUploadProcessing');

test.beforeEach(() => {
  searches.length = 0;
  noteRequest = undefined;
  noteText = 'Subject: contracts. Topics: renewal and obligations.';
  searchResult = { value: [{ content: 'Contract text', ocrText: ['Scanned clause'] }] };
  process.env.CHAT_UPLOAD_SEARCH_INDEXER_NAME = 'upload-indexer';
  process.env.AZURE_AI_PROJECT_ENDPOINT = 'https://project.example';
  process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME = 'test-model';
  global.fetch = async () => ({ ok: true, status: 202 });
});

test('extracts only the owner and application filtered text and bounds its length', async () => {
  searchResult = { value: [{ content: 'a'.repeat(12001), ocrText: ['scanned'] }] };
  const extraction = await waitForIndexedUpload({
    uploadId: 'upload', ownerObjectId: "owner'quoted", onProgress: async () => searches.push('renew'),
  });
  assert.equal(extraction.text.length, 12000);
  assert.equal(extraction.partial, true);
  assert.equal(searches[1].filter, "uploadId eq 'upload' and ownerObjectId eq 'owner''quoted' and appIdentifier eq 'app'");
});

test('rejects empty or oversized notes and labels partial extraction', async () => {
  assert.match(await generateTemporaryNote({ fileName: 'file.txt', text: 'data', partial: true }), /^Partial extraction:/);
  noteText = ' ';
  await assert.rejects(generateTemporaryNote({ fileName: 'file.txt', text: 'data', partial: false }), /valid short/);
  noteText = 'a'.repeat(1001);
  await assert.rejects(generateTemporaryNote({ fileName: 'file.txt', text: 'data', partial: false }), /valid short/);
});

test('asks the model to preserve short source text and condense only long text', async () => {
  await generateTemporaryNote({ fileName: 'example.txt', text: 'A worked geometry example', partial: false });
  assert.match(noteRequest.input[0].content, /preserve its content, language, wording, and distinctive details/);
  assert.match(noteRequest.input[0].content, /If the text is too long, condense it/);
  assert.deepEqual(JSON.parse(noteRequest.input[1].content), {
    fileName: 'example.txt', partial: false, extractedText: 'A worked geometry example',
  });
});

test('asks the model to interpret fragmented OCR without inventing chart relationships', async () => {
  const text = 'Nearer-term economy (5x total growth, 2x human output) 8.0% Primary 30.0% Secondary 61.0% Tertiary';
  await generateTemporaryNote({ fileName: 'chart.png', text, partial: false });
  assert.match(noteRequest.input[0].content, /fragmented OCR from a chart or image/);
  assert.match(noteRequest.input[0].content, /without copying OCR noise or guessing which figures belong to which labels/);
  assert.match(noteRequest.input[0].content, /If a relationship is unclear, say so/);
  assert.equal(JSON.parse(noteRequest.input[1].content).extractedText, text);
});

test('marks source blob to skip indexing before deleting its Search document', async () => {
  await stopIndexingAndDeleteDocument('blob', 'upload');
  assert.deepEqual(searches, [{ uploadid: 'id', azuresearch_skip: 'true' }, ['delete', 'upload']]);
});