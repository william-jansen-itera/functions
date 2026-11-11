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

const { classifyUpload, waitForIndexedUpload, generateTemporaryNote, stopIndexingAndDeleteDocument } = require('../src/lib/chatUploadProcessing');

test('classifies complete extracted source independently of captions and placement notes', () => {
  for (const length of [3999, 4000]) {
    assert.deepEqual(classifyUpload({ fileName: 'file.pdf', sourceText: 'x'.repeat(length) }),
      { saveKind: 'note', extractedNoteText: 'x'.repeat(length) });
  }
  assert.deepEqual(classifyUpload({ fileName: 'file.pdf', sourceText: 'x'.repeat(4001) }),
    { saveKind: 'attachment', extractedNoteText: null });
  assert.deepEqual(classifyUpload({ fileName: 'photo.jpg', sourceText: 'x'.repeat(100) }),
    { saveKind: 'attachment', extractedNoteText: null });
  assert.deepEqual(classifyUpload({ fileName: 'file.pdf', sourceText: 'short', incomplete: true }),
    { saveKind: 'attachment', extractedNoteText: null });
  assert.deepEqual(classifyUpload({ fileName: 'file.pdf', sourceText: '' }),
    { saveKind: 'attachment', extractedNoteText: null });
});

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
  assert.equal(extraction.sourceText.length, 12009);
  assert.equal(searches[1].filter, "uploadId eq 'upload' and ownerObjectId eq 'owner''quoted' and appIdentifier eq 'app'");
});

test('returns filtered captions separately while preserving text and OCR for the note', async () => {
  searchResult = { value: [{ content: 'Contract text', ocrText: ['Scanned clause'], imageDescriptionFiltered: ['A signed document', ' '] }] };
  const extraction = await waitForIndexedUpload({ uploadId: 'upload', ownerObjectId: 'owner', onProgress: async () => {} });
  assert.deepEqual(extraction, { text: 'Contract text\nScanned clause', sourceText: 'Contract text\nScanned clause', partial: false, captions: ['A signed document'] });
  assert.equal(searches[0].select, 'content,ocrText,imageDescriptionFiltered');
});

test('uses filtered captions as fallback for an image with no readable text', async () => {
  searchResult = { value: [{ content: '', ocrText: [], imageDescriptionFiltered: ['An aerial view of a harbor'] }] };
  const extraction = await waitForIndexedUpload({ uploadId: 'upload', ownerObjectId: 'owner', onProgress: async () => {} });
  assert.deepEqual(extraction, { text: 'An aerial view of a harbor', sourceText: '', partial: false, captions: ['An aerial view of a harbor'] });
});

test('rejects empty or oversized notes and leaves partial-extraction wording to the model', async () => {
  assert.equal(await generateTemporaryNote({ fileName: 'file.txt', text: 'data', partial: true }), noteText);
  assert.match(noteRequest.input[0].content, /If extraction is partial, say so/);
  noteText = ' ';
  await assert.rejects(generateTemporaryNote({ fileName: 'file.txt', text: 'data'.repeat(251), partial: false }), /valid short/);
  noteText = 'a'.repeat(1001);
  await assert.rejects(generateTemporaryNote({ fileName: 'file.txt', text: 'data'.repeat(251), partial: false }), /valid short/);
});

test('preserves short readable source text instead of accepting a model paraphrase', async () => {
  const text = 'The triangle has a base of 6 cm and a height of 4 cm. Its area is 12 cm². The prism is 10 cm long, so its volume is 120 cm³.';
  assert.equal(await generateTemporaryNote({ fileName: 'geometry.pdf', text, partial: false }), text);
  assert.equal(await generateTemporaryNote({ fileName: 'geometry.pdf', text: 'Rumfang af trekantet prisme', partial: false }), 'Rumfang af trekantet prisme');
  assert.equal(await generateTemporaryNote({ fileName: 'geometry.txt', text: 'x'.repeat(1000), partial: false }), 'x'.repeat(1000));
  assert.equal(noteRequest, undefined);
});

test('asks the model to preserve the original language when condensing long text', async () => {
  await generateTemporaryNote({ fileName: 'example.txt', text: 'A worked geometry example'.repeat(50), partial: false });
  assert.match(noteRequest.input[0].content, /Keep the original language for all output; never translate/);
  assert.match(noteRequest.input[0].content, /If the text is too long, condense it in the original language/);
  assert.deepEqual(JSON.parse(noteRequest.input[1].content), {
    fileName: 'example.txt', partial: false, extractedText: 'A worked geometry example'.repeat(50),
  });
});

test('asks the model to interpret fragmented OCR without inventing chart relationships', async () => {
  const text = 'Nearer-term economy (5x total growth, 2x human output). 8.0% Primary 30.0% Secondary 61.0% Tertiary';
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

test('classification preserves original whitespace in a complete extracted document', () => {
  assert.deepEqual(classifyUpload({ fileName: 'file.txt', sourceText: ' First line\n  second line\n' }), {
    saveKind: 'note', extractedNoteText: ' First line\n  second line\n',
  });
});