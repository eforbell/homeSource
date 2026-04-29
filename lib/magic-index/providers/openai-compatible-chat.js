'use strict';

const { assertMagicIndexResult } = require('../schema');
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MAGICINDEX_FETCH_TIMEOUT_MS || 90000));

function buildPrompt(input) {
  return `You are MagicIndex for HomeSource, a private family document vault.
Return ONLY valid JSON.

Prioritize document content over filename guesses.
If text preview contains dates, amounts, parties, account/policy/claim numbers, or doc type clues, extract them.
Do NOT say "not available from filename alone" when text is present.
Use null for unknown dates/amounts and explain uncertainty in needs_review_reasons.

Filename: ${input.filename}
MIME: ${input.mimeType}
Text preview:
${input.textPreview || '(no text preview available)'}`;
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
  return {
    result: assertMagicIndexResult(JSON.parse(stripJsonFence(content))),
    diagnostics: {
      path: input.textPreview ? 'text_preview' : 'filename_only',
      attempted_input_file: false,
      used_input_file: false,
      used_input_image: false,
      used_fallback_without_file: false,
      text_preview_chars: Number(input.textPreview?.length || 0)
    }
  };
}

function postChatCompletion(base, config, body) {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
