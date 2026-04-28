'use strict';

const fs = require('fs');
const path = require('path');
const { assertMagicIndexResult, responseJsonSchema } = require('../schema');

function canSendPdfFile(input, config) {
  return Boolean(
    config.openai.send_pdf_input !== false &&
    input.mimeType === 'application/pdf' &&
    input.filePath &&
    fs.existsSync(input.filePath)
  );
}

function buildUserContent(input, config) {
  const text = `Extract HomeSource metadata for this family document.\nFilename: ${input.filename}\nMIME: ${input.mimeType}\n${input.textPreview ? `Text preview:\n${input.textPreview}` : 'If a file is attached, read the file contents directly. If no file content is available, infer cautiously from filename only.'}`;
  const content = [{ type: 'input_text', text }];

  if (canSendPdfFile(input, config)) {
    const pdfBytes = fs.readFileSync(input.filePath);
    content.push({
      type: 'input_file',
      filename: path.basename(input.filename || input.filePath || 'document.pdf'),
      file_data: pdfBytes.toString('base64')
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
        content: 'You extract private family document metadata for HomeSource. Return structured JSON only. Be conservative: use null for unknown dates and add needs_review_reasons when uncertain.'
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
  let res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok && res.status === 400 && canSendPdfFile(input, config)) {
    const fallbackBody = stripInputFile(body);
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
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
  return assertMagicIndexResult(JSON.parse(text));
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

module.exports = { analyzeWithOpenAIResponses, buildResponseBody, buildUserContent, canSendPdfFile, stripInputFile };
