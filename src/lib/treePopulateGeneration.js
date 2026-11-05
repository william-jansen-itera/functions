const { AIProjectClient } = require('@azure/ai-projects');
const { DefaultAzureCredential } = require('@azure/identity');

const MAX_ROOTS = 8;
const MAX_CHILDREN = 8;
const MAX_LEAVES = 10;
const MAX_TITLE = 255;
const MAX_NOTES = 4000;

const title = { type: 'string', minLength: 1, maxLength: MAX_TITLE };
const leaf = {
  type: 'object', properties: { title, notes: { type: 'string', minLength: 1, maxLength: MAX_NOTES } },
  required: ['title', 'notes'], additionalProperties: false,
};
const levelThree = {
  type: 'object', properties: { title, children: { type: 'array', minItems: 1, maxItems: MAX_LEAVES, items: leaf } },
  required: ['title', 'children'], additionalProperties: false,
};
const levelTwo = {
  type: 'object', properties: { title, children: { type: 'array', minItems: 1, maxItems: MAX_CHILDREN, items: levelThree } },
  required: ['title', 'children'], additionalProperties: false,
};
const rootSchema = {
  type: 'object', properties: {
    declaredRootCount: { type: 'integer', minimum: 0, maximum: MAX_ROOTS },
    rootTitles: { type: 'array', minItems: 1, maxItems: MAX_ROOTS, items: title },
  }, required: ['declaredRootCount', 'rootTitles'], additionalProperties: false,
};
const branchSchema = {
  type: 'object', properties: { children: { type: 'array', minItems: 1, maxItems: MAX_CHILDREN, items: levelTwo } },
  required: ['children'], additionalProperties: false,
};

function buildRootTitlePrompt({ name, description }) {
  return [
    `Tree name: ${name}.`,
    'Extract only the top-level topics from the stored tree description. Return root titles only, not descendants.',
    'Extract every explicitly enumerated overall area as a separate top-level topic, regardless of the description language or list format.',
    'Recognize numbered and inline lists, including their final item when it is joined by a conjunction rather than a separator. Count all named items before returning the titles.',
    'Set declaredRootCount to the number explicitly stated for the overall areas, or 0 if no number is stated. The rootTitles array must contain every stated area.',
    'Extract only major conceptual groups; do not infer new categories.',
    'Preserve each root topic in its original language and wording; do not translate or combine listed topics.',
    `Return between 1 and ${MAX_ROOTS} distinct root titles, matching the number of explicitly listed overall areas.`,
    'Do not use detailed descriptions of individual areas as additional roots.',
    'Return valid JSON only, matching the provided schema.',
    '', 'Stored tree description:', description,
  ].filter(Boolean).join('\n');
}

function buildRootBranchPrompt({ name, description, rootTitle }) {
  return [
    `Tree name: ${name}.`,
    `Fixed root title: ${rootTitle}.`,
    'Generate only the descendants of this fixed root in a four-level tree: root, level-2, level-3, and level-4 leaf nodes.',
    'Return the children of the fixed root only; do not generate or rename root nodes or include content for other top-level topics.',
    'Use the stored tree description to enrich this root branch, but keep every descendant consistent with its ancestor chain.',
    'Write generated descendants in the language of the stored tree description.',
    'Use concise, specific titles at every level; each title must fit its parent and the full path back to the fixed root.',
    'Return valid JSON only, matching the provided schema.',
    '', 'Level-2 instruction:',
    `Generate between 1 and ${MAX_CHILDREN} children per root node.`,
    'Each level-2 node must be a coherent subtopic of its root node and semantically derived from it.',
    'Use domain knowledge to expand the root topic into meaningful subtopics while staying fully aligned with the root.',
    '', 'Level-3 instruction:',
    `Generate between 1 and ${MAX_CHILDREN} children per level-2 node.`,
    'Each level-3 node must be a narrow, specific subtopic of its level-2 parent and root ancestor.',
    'Use domain knowledge to refine the level-2 topic into more specific areas that naturally support leaf-level detail.',
    '', 'Leaf instruction:',
    `Generate between 1 and ${MAX_LEAVES} leaf nodes per level-3 node.`,
    'Preferred number of leaf nodes is 5\u201310. Generate fewer than 5 only when the level-3 topic is genuinely narrow.',
    'Leaf nodes must be narrow, concrete, and actionable.',
    'Each leaf must be semantically derived from the entire ancestor chain (root \u2192 level-2 \u2192 level-3).',
    'Do not introduce concepts not implied by the ancestors.',
    'Use domain knowledge to produce realistic, actionable leaf-level details.',
    'For each leaf, write notes as exactly one substantive sentence with a concrete fact or practical guidance specific to its title and ancestor path.',
    '', 'General constraints:',
    'Upper levels organize the topic; leaves carry actionable detail.',
    'Do not produce duplicate sibling titles, empty categories, or structural-node notes.',
    'Do not place content intended for one level into another.',
    'All descendant nodes must reinforce the fixed root topic.',
    '', 'Stored tree description:', description,
  ].filter(Boolean).join('\n');
}

function normalizedTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

function validateNode(node, depth) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || !normalizedTitle(node.title)) {
    throw new Error('Generated node must have a title.');
  }
  if (depth === 3) {
    if ('children' in node || !String(node.notes ?? '').trim()) throw new Error('Generated leaf must have notes and no children.');
    return { title: normalizedTitle(node.title), notes: String(node.notes).trim().slice(0, MAX_NOTES) };
  }
  const maximum = depth === 2 ? MAX_LEAVES : MAX_CHILDREN;
  if ('notes' in node || !Array.isArray(node.children) || !node.children.length || node.children.length > maximum) {
    throw new Error('Generated branch has invalid children.');
  }
  return { title: normalizedTitle(node.title), children: node.children.map((child) => validateNode(child, depth + 1)) };
}

function validateRoots(payload) {
  const titles = payload?.rootTitles;
  if (!Array.isArray(titles) || !titles.length || titles.length > MAX_ROOTS ||
      !Number.isInteger(payload.declaredRootCount) || payload.declaredRootCount < 0 || payload.declaredRootCount > MAX_ROOTS ||
      (payload.declaredRootCount && payload.declaredRootCount !== titles.length) ||
      titles.some((item) => typeof item !== 'string' || !item.trim() || item.length > MAX_TITLE)) {
    throw new Error('Generated root titles are invalid.');
  }
  const normalized = titles.map(normalizedTitle);
  if (new Set(normalized.map((item) => item.toLocaleLowerCase())).size !== normalized.length) {
    throw new Error('Generated root titles must be distinct.');
  }
  return normalized;
}

async function generateTreeNodesFromDescription(tree, onProgress = async () => {}) {
  const endpoint = process.env.AZURE_AI_PROJECT_ENDPOINT;
  const model = process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME;
  if (!endpoint || !model) throw new Error('Foundry project endpoint and model deployment are required.');
  const responses = new AIProjectClient(endpoint, new DefaultAzureCredential()).getOpenAIClient().responses;

  async function request(prompt, schema, schemaName, validate) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await responses.create({
        model, input: [{ type: 'message', role: 'system', content: prompt }],
        text: { verbosity: 'medium', format: { type: 'json_schema', name: schemaName, strict: true, schema } },
      });
      try {
        const output = String(response?.output_text ?? '').trim();
        if (!output) throw new Error('Model returned an empty response.');
        return validate(JSON.parse(output));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  const rootTitles = await request(buildRootTitlePrompt(tree), rootSchema, 'generated_root_titles', validateRoots);
  const nodes = [];
  for (const rootTitle of rootTitles) {
    const branch = await request(buildRootBranchPrompt({ ...tree, rootTitle }), branchSchema, 'generated_root_branch',
      (payload) => validateNode({ title: rootTitle, children: payload?.children }, 0));
    nodes.push(branch);
    await onProgress();
  }
  return nodes;
}

module.exports = { generateTreeNodesFromDescription, validateNode, validateRoots };