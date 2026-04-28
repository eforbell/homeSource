'use strict';

const { assertMagicIndexResult, responseJsonSchema } = require('../schema');

async function analyzeWithOpenAIResponses(input, config) {
  if (!config.openai.api_key) throw new Error('OPENAI_API_KEY or MAGICINDEX_OPENAI_API_KEY is required');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.api_key}`
    },
    body: JSON.stringify({
      model: config.openai.model,
      input: [
        { role: 'system', content: 'You extract private family document metadata for HomeSource. Return structured JSON only.' },
        { role: 'user', content: `Filename: ${input.filename}\nMIME: ${input.mimeType}\nText preview:\n${input.textPreview || '(no text preview available)'}` }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'magicindex_v1',
          strict: true,
          schema: responseJsonSchema()
        }
      }
    })
  });
  if (!res.ok) throw new Error(`MagicIndex OpenAI provider failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const text = data.output_text || data.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
  return assertMagicIndexResult(JSON.parse(text));
}

module.exports = { analyzeWithOpenAIResponses };
