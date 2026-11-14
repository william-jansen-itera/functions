const test = require('node:test');
const assert = require('node:assert/strict');
const modelRequests = [];
for (const [name, exports] of [
  ['@azure/ai-projects', { AIProjectClient: class {
    getOpenAIClient() {
      return { responses: { create: async (request) => {
        modelRequests.push(request);
        return { output_text: JSON.stringify(request.text.format.name === 'generated_root_titles'
          ? { declaredRootCount: 1, rootTitles: ['Root'] }
          : { children: [{ title: 'Area', children: [{ title: 'Topic', children: [{ title: 'Leaf', notes: 'Specific guidance.' }] }] }] }) };
      } } };
    }
  } }],
  ['@azure/identity', { DefaultAzureCredential: class {} }],
]) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const { generateTreeNodesFromDescription, validateNode, validateRoots } = require('../src/lib/treePopulateGeneration');

test('accepts a four-level branch and preserves a leaf note', () => {
  const root = validateNode({
    title: 'Root',
    children: [{ title: 'Area', children: [{ title: 'Topic', children: [{ title: 'Leaf', notes: 'Specific guidance.' }] }] }],
  }, 0);

  assert.equal(root.children[0].children[0].children[0].notes, 'Specific guidance.');
});

test('rejects malformed or oversized branches before SQL insertion', () => {
  assert.throws(() => validateNode({ title: 'Root', children: [] }, 0));
  assert.throws(() => validateNode({ title: 'Leaf', notes: 'Note', children: [] }, 3));
  assert.throws(() => validateNode({ title: 'Root', children: Array(9).fill({ title: 'Area' }) }, 0));
});

test('root titles honor declared count and uniqueness', () => {
  assert.deepEqual(validateRoots({ rootTitles: ['A', 'B'], declaredRootCount: 2 }), ['A', 'B']);
  assert.throws(() => validateRoots({ rootTitles: ['A', 'A'], declaredRootCount: 2 }));
  assert.throws(() => validateRoots({ rootTitles: ['A'], declaredRootCount: 2 }));
});

test('GPT-5.4 root and branch requests enable medium reasoning without changing GPT-4.1 generation', async (t) => {
  const keys = ['AZURE_AI_PROJECT_ENDPOINT', 'AZURE_AI_MODEL_DEPLOYMENT_NAME'];
  const original = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (original[index] === undefined) delete process.env[key];
    else process.env[key] = original[index];
  }));
  process.env.AZURE_AI_PROJECT_ENDPOINT = 'https://project.example';
  const requestsByModel = [];
  for (const model of ['gpt-4.1', 'gpt-5.4']) {
    modelRequests.length = 0;
    process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME = model;
    const nodes = await generateTreeNodesFromDescription({ name: 'Knowledge', description: 'One overall area: Root.' });
    assert.equal(nodes[0].children[0].children[0].children[0].notes, 'Specific guidance.');
    assert.equal(modelRequests.length, 2);
    for (const request of modelRequests) {
      assert.equal(request.model, model);
      if (model === 'gpt-5.4') assert.deepEqual(request.reasoning, { effort: 'medium' });
      else assert.ok(!Object.hasOwn(request, 'reasoning'));
    }
    requestsByModel.push(modelRequests.map(({ model, reasoning, ...rest }) => rest));
  }
  assert.deepEqual(requestsByModel[0], requestsByModel[1]);
});