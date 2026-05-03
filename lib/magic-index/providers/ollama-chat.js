'use strict';

const { assertMagicIndexResult, responseJsonSchema } = require('../schema');
const { buildMagicIndexRules, buildEvidenceHeader } = require('../prompt');
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MAGICINDEX_FETCH_TIMEOUT_MS || 90000));

function buildPrompt(input) {
  return `Extract metadata for this family document.
${buildEvidenceHeader(input)}

Text preview:
${input.textPreview || '(no text preview available)'}`;
}

function parseOllamaJsonContent(content) {
  const cleaned = String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const candidates = extractJsonCandidates(cleaned);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {}
  }
  throw new Error('Ollama returned invalid JSON content');
}

function extractJsonCandidates(input) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaping) escaping = false;
      else if (ch === '\\') escaping = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(input.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
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
        { role: 'system', content: buildMagicIndexRules(input) },
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
    result: assertMagicIndexResult(parseOllamaJsonContent(content)),
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

module.exports = { analyzeWithOllamaChat, parseOllamaJsonContent, extractJsonCandidates };
