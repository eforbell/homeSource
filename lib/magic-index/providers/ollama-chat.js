'use strict';

const { assertMagicIndexResult, responseJsonSchema } = require('../schema');
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MAGICINDEX_FETCH_TIMEOUT_MS || 90000));

function buildPrompt(input) {
  return `Extract metadata for this family document.
Filename: ${input.filename}
MIME: ${input.mimeType}

Use document content first, filename second.
If text contains dates, parties, amounts, or document type hints, extract them.
Return JSON only matching the required schema.

Text preview:
${input.textPreview || '(no text preview available)'}`;
}

async function analyzeWithOllamaChat(input, config) {
  if (!config.ollama.base_url) throw new Error('MAGICINDEX_OLLAMA_BASE_URL is required');
  if (!config.ollama.model) throw new Error('MAGICINDEX_OLLAMA_MODEL is required');
  const base = config.ollama.base_url.replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...(config.ollama.api_key ? { Authorization: `Bearer ${config.ollama.api_key}` } : {})
    },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [
        { role: 'system', content: 'Return only JSON following the provided schema.' },
        { role: 'user', content: buildPrompt(input) }
      ],
      stream: false,
      format: responseJsonSchema(),
      options: { temperature: 0 }
    })
  });
  if (!res.ok) throw new Error(`MagicIndex Ollama provider failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const content = data?.message?.content || '{}';
  return {
    result: assertMagicIndexResult(JSON.parse(content)),
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

module.exports = { analyzeWithOllamaChat };
