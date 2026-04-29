'use strict';

const fs = require('fs');
const path = require('path');
const { assertMagicIndexResult, responseJsonSchema } = require('../schema');
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MAGICINDEX_FETCH_TIMEOUT_MS || 90000));

function canSendPdfFile(input, config) {
  return Boolean(
    config.openai.send_pdf_input !== false &&
    input.mimeType === 'application/pdf' &&
    input.filePath &&
    fs.existsSync(input.filePath)
  );
}

function canSendImageInput(input) {
  return Boolean(
    input.filePath &&
    fs.existsSync(input.filePath) &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(input.mimeType)
  );
}

function buildUserContent(input, config) {
  const text = `Extract HomeSource metadata for this family document.
Filename: ${input.filename}
MIME: ${input.mimeType}

Priority order:
1) Attached file contents
2) Text preview
3) Filename

When available, extract date(s), document type, amount, and party names from actual content.
Only rely on filename if content is unavailable or unreadable.
Return concise, factual values. Use null when unknown.
Include field_confidence for each core field.
${input.textPreview ? `Text preview:\n${input.textPreview}` : ''}`;
  const content = [{ type: 'input_text', text }];

  if (canSendPdfFile(input, config)) {
    const pdfBytes = fs.readFileSync(input.filePath);
    content.push({
      type: 'input_file',
      filename: path.basename(input.filename || input.filePath || 'document.pdf'),
      file_data: pdfBytes.toString('base64')
    });
  }
  if (canSendImageInput(input)) {
    const imageBytes = fs.readFileSync(input.filePath);
    content.push({
      type: 'input_image',
      image_url: `data:${input.mimeType};base64,${imageBytes.toString('base64')}`,
      detail: 'high'
    });
  }

  return content;
}

function buildResponseBody(input, config) {
  return {
    model: config.openai.model,
    input: [
      {
        role: 'system',
        content: 'You extract private family document metadata for HomeSource. Return structured JSON only. Prioritize file/text evidence over filename guesses. Be conservative: use null for unknown dates and add needs_review_reasons when uncertain.'
      },
      {
        role: 'user',
        content: buildUserContent(input, config)
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'magicindex_v1',
        strict: true,
        schema: responseJsonSchema()
      }
    }
  };
}

async function analyzeWithOpenAIResponses(input, config) {
  if (!config.openai.api_key) throw new Error('OPENAI_API_KEY or MAGICINDEX_OPENAI_API_KEY is required');
  const body = buildResponseBody(input, config);
  const diagnostics = {
    path: 'filename_only',
    attempted_input_file: canSendPdfFile(input, config),
    used_input_file: canSendPdfFile(input, config),
    used_input_image: canSendImageInput(input),
    used_fallback_without_file: false,
    text_preview_chars: Number(input.textPreview?.length || 0)
  };
  let res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok && res.status === 400 && canSendPdfFile(input, config)) {
    const fallbackBody = stripInputFile(body);
    diagnostics.used_fallback_without_file = true;
    diagnostics.used_input_file = false;
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.api_key}`
      },
      body: JSON.stringify(fallbackBody)
    });
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`MagicIndex OpenAI provider failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }

  const data = await res.json();
  const text = data.output_text || data.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
  diagnostics.path = diagnostics.used_input_file
    ? (diagnostics.used_input_image ? 'input_file+image' : 'input_file')
    : (diagnostics.used_input_image ? 'image_input' : (diagnostics.text_preview_chars > 0 ? 'text_preview' : 'filename_only'));
  return {
    result: assertMagicIndexResult(JSON.parse(text)),
    diagnostics
  };
}

function stripInputFile(body) {
  const cloned = JSON.parse(JSON.stringify(body));
  const user = cloned.input?.find(item => item.role === 'user');
  if (!user || !Array.isArray(user.content)) return cloned;
  user.content = user.content.filter(part => part.type !== 'input_file');
  return cloned;
}

async function safeErrorDetail(res) {
  try {
    const data = await res.json();
    return data?.error?.message || JSON.stringify(data).slice(0, 300);
  } catch {
    try {
      const text = await res.text();
      return String(text || '').trim().slice(0, 300);
    } catch {
      return '';
    }
  }
}

module.exports = { analyzeWithOpenAIResponses, buildResponseBody, buildUserContent, canSendPdfFile, canSendImageInput, stripInputFile };
