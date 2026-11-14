const test = require('node:test');
const assert = require('node:assert/strict');

const functionsPath = require.resolve('@azure/functions');
require.cache[functionsPath] = { id: functionsPath, filename: functionsPath, loaded: true, exports: {
  app: { http() {} },
} };
const { buildRecordResponse } = require('../src/functions/customSkillProcessor');

test('default caption threshold includes 0.35 and rejects values below it', (t) => {
  const original = process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD;
  delete process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD;
  t.after(() => {
    if (original === undefined) delete process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD;
    else process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD = original;
  });
  const result = buildRecordResponse({
    recordId: 'image',
    data: {
      captionTexts: ['below', 'boundary', 'newly accepted', 'higher'],
      captionConfidences: [0.349, 0.35, 0.39, 0.4],
    },
  });
  assert.deepEqual(result.data.filteredValues, ['boundary', 'newly accepted', 'higher']);
  assert.deepEqual(result.warnings, [{ message: 'Discarded 1 value below confidence threshold 0.35.' }]);
});

test('configured threshold and per-record override keep their existing precedence', (t) => {
  const original = process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD;
  process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD = '0.5';
  t.after(() => {
    if (original === undefined) delete process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD;
    else process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD = original;
  });
  const record = {
    recordId: 'image',
    data: { textValues: ['caption'], confidenceValues: [0.35] },
  };
  assert.deepEqual(buildRecordResponse(record).data.filteredValues, []);
  record.data.minConfidence = 0.35;
  assert.deepEqual(buildRecordResponse(record).data.filteredValues, ['caption']);
});
