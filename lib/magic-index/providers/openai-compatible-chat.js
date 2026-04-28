'use strict';

const { assertMagicIndexResult } = require('../schema');

function buildPrompt(input) {
  return `You are MagicIndex for HomeSource, a private family document vault. Extract concise metadata as JSON only.\n\nFilename: ${input.filename}\nMIME: ${input.mimeType}\nText preview:\n${input.textPreview || '(no text preview available)'}`;
}

async function analyzeWithOpenAICompatible(input, config) {
  if (!config.compatible.base_url) throw new Error('MAGICINDEX_COMPAT_BASE_URL is required');
  if (!config.compatible.model) throw new Error('MAGICINDEX_COMPAT_MODEL is required');
  const base = config.compatible.base_url.replace(/\/$/, '');
  const requestBody = {
    model: config.compatible.model,
    messages: [
      { role: 'system', content: 'Return only valid JSON matching the requested document metadata shape. No markdown.' },
      { role: 'user', content: buildPrompt(input) }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1
  };

  let res = await postChatCompletion(base, config, requestBody);
  if (!res.ok && [400, 404, 422].includes(res.status)) {
    const fallbackBody = { ...requestBody };
    delete fallbackBody.response_format;
    res = await postChatCompletion(base, config, fallbackBody);
  }
  if (!res.ok) throw new Error(`MagicIndex local provider failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return assertMagicIndexResult(JSON.parse(stripJsonFence(content)));
}

function postChatCompletion(base, config, body) {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.compatible.api_key ? { Authorization: `Bearer ${config.compatible.api_key}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function stripJsonFence(content) {
  return String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

module.exports = { analyzeWithOpenAICompatible, stripJsonFence };
