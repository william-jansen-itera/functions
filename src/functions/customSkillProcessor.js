const { app } = require('@azure/functions');

const DEFAULT_THRESHOLD = 0.6;

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function toNumber(value) {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function normalizeThreshold(rawThreshold) {
  const parsedThreshold = toNumber(rawThreshold);

  if (parsedThreshold === null) {
    return DEFAULT_THRESHOLD;
  }

  return Math.min(Math.max(parsedThreshold, 0), 1);
}

function getInputValues(data) {
  return data.textValues ?? data.captionTexts;
}

function getConfidenceValues(data) {
  return data.confidenceValues ?? data.captionConfidences;
}

function filterValuesByConfidence({ textValues, confidenceValues, minConfidence }) {
  const normalizedTexts = toArray(textValues)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const normalizedConfidences = toArray(confidenceValues).map(toNumber);
  const threshold = normalizeThreshold(minConfidence ?? process.env.CUSTOM_SKILL_CONFIDENCE_THRESHOLD);
  const filteredValues = [];
  const warnings = [];
  let discardedCount = 0;

  normalizedTexts.forEach((text, index) => {
    const confidence = normalizedConfidences[index];

    if (confidence === null) {
      discardedCount += 1;
      return;
    }

    if (confidence >= threshold) {
      filteredValues.push(text);
      return;
    }

    discardedCount += 1;
  });

  if (discardedCount > 0) {
    warnings.push({
      message: `Discarded ${discardedCount} value${discardedCount === 1 ? '' : 's'} below confidence threshold ${threshold}.`,
    });
  }

  return {
    filteredValues,
    warnings,
  };
}

function buildRecordResponse(record) {
  const recordId = record?.recordId ?? null;

  if (!recordId) {
    return {
      recordId: '',
      data: {
        filteredValues: [],
      },
      errors: [{ message: 'recordId is required.' }],
      warnings: null,
    };
  }

  const data = record?.data ?? {};
  const { filteredValues, warnings } = filterValuesByConfidence({
    textValues: getInputValues(data),
    confidenceValues: getConfidenceValues(data),
    minConfidence: data.minConfidence,
  });

  return {
    recordId,
    data: {
      filteredValues,
    },
    errors: null,
    warnings: warnings.length > 0 ? warnings : null,
  };
}

app.http('customSkillProcessor', {
  route: 'custom-skill-processor',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let payload;

    try {
      payload = await request.json();
    } catch {
      return {
        status: 400,
        jsonBody: {
          message: 'Request body must be valid JSON.',
        },
      };
    }

    if (!Array.isArray(payload?.values)) {
      return {
        status: 400,
        jsonBody: {
          message: 'Request body must contain a values array.',
        },
      };
    }

    context.log(`Processing ${payload.values.length} custom skill record(s).`);

    return {
      status: 200,
      jsonBody: {
        values: payload.values.map(buildRecordResponse),
      },
      headers: {
        'Content-Type': 'application/json',
      },
    };
  },
});

module.exports = {
  buildRecordResponse,
  filterValuesByConfidence,
  normalizeThreshold,
};