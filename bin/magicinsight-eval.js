#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { analyzeDocument } = require('../lib/magic-index');
const { getMagicIndexConfig } = require('../lib/magic-index/config');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function usage() {
  console.log(`
Usage:
  npm run magicinsight:eval -- --sample-dir ./planning/eval-samples --provider ollama --model qwen3-4b-nothink --base-url http://192.168.1.100:11434
  node bin/magicinsight-eval.js --sample ./planning/eval-samples/example-offer-letter.json --provider ollama --model qwen3-4b-nothink --base-url http://192.168.1.100:11434

Sample file format:
  {
    "case": "offer_letter",
    "task": "amount_date_extraction",
    "filename": "Offer Letter.pdf",
    "mimeType": "application/pdf",
    "filePath": "./docs/Offer Letter.pdf",
    "textPreview": "optional direct text preview",
    "expected": {
      "title_includes": "Offer Letter",
      "document_type": "contract",
      "issued_date": "2023-12-01",
      "expiry_date": null,
      "summary_nonempty": true
    }
  }
`);
}

function buildConfig(overrides) {
  const base = getMagicIndexConfig();
  const provider = overrides.provider || base.provider || 'ollama';
  const clone = structuredClone(base);
  clone.provider = provider;

  if (provider === 'ollama') {
    if (overrides.baseUrl) clone.ollama.base_url = overrides.baseUrl;
    if (overrides.model) clone.ollama.model = overrides.model;
    if (overrides.apiKey) clone.ollama.api_key = overrides.apiKey;
  } else if (provider === 'openai_compatible') {
    if (overrides.baseUrl) clone.compatible.base_url = overrides.baseUrl;
    if (overrides.model) clone.compatible.model = overrides.model;
    if (overrides.apiKey) clone.compatible.api_key = overrides.apiKey;
  } else if (provider === 'openai') {
    if (overrides.model) clone.openai.model = overrides.model;
    if (overrides.apiKey) clone.openai.api_key = overrides.apiKey;
  }
  return clone;
}

function listSamples(args) {
  if (args.sample) return [path.resolve(args.sample)];
  const sampleDir = path.resolve(args.sampleDir || args['sample-dir'] || 'planning/eval-samples');
  if (!fs.existsSync(sampleDir)) throw new Error(`Sample directory not found: ${sampleDir}`);
  return fs.readdirSync(sampleDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(sampleDir, name));
}

function loadSample(samplePath) {
  const dir = path.dirname(samplePath);
  const raw = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  return {
    ...raw,
    _path: samplePath,
    filePath: raw.filePath ? path.resolve(dir, raw.filePath) : null
  };
}

function approxEqual(a, b, tolerance = 0.01) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function evaluateExpected(result, expected = {}) {
  const checks = {};
  if (expected.title_includes !== undefined) {
    checks.title = String(result.title || '').toLowerCase().includes(String(expected.title_includes).toLowerCase()) ? 'pass' : 'fail';
  }
  if (expected.document_type !== undefined) {
    checks.document_type = result.document_type === expected.document_type ? 'pass' : 'fail';
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'issued_date')) {
    checks.issued_date = result.issued_date === expected.issued_date ? 'pass' : 'fail';
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'expiry_date')) {
    checks.expiry_date = result.expiry_date === expected.expiry_date ? 'pass' : 'fail';
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'amount_value')) {
    checks.amount = approxEqual(result.amount?.value, expected.amount_value) ? 'pass' : 'fail';
  }
  if (expected.summary_nonempty !== undefined) {
    checks.summary = expected.summary_nonempty
      ? (String(result.summary || '').trim() ? 'pass' : 'fail')
      : (!String(result.summary || '').trim() ? 'pass' : 'fail');
  }
  if (expected.confidence_min !== undefined) {
    checks.confidence = Number(result.confidence || 0) >= Number(expected.confidence_min) ? 'pass' : 'fail';
  }
  return checks;
}

function summarizeCounts(records) {
  return records.reduce((acc, rec) => {
    acc.total++;
    if (rec.parse_ok) acc.parse_ok++;
    else acc.parse_failed++;
    if (rec.all_checks_passed) acc.passed++;
    else acc.failed++;
    return acc;
  }, { total: 0, parse_ok: 0, parse_failed: 0, passed: 0, failed: 0 });
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeArtifacts(records, config) {
  const outDir = path.resolve('planning/evals');
  ensureDir(outDir);
  const stamp = nowStamp();
  const jsonlPath = path.join(outDir, `magicinsight-local-model-${stamp}.jsonl`);
  const mdPath = path.join(outDir, `magicinsight-local-model-${stamp}.md`);
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, jsonl);

  const counts = summarizeCounts(records);
  const providerModel = [
    config.provider,
    config.provider === 'ollama' ? config.ollama.model
      : config.provider === 'openai_compatible' ? config.compatible.model
      : config.openai.model
  ].filter(Boolean).join(' / ');
  const lines = [
    `# MagicInsight Local Model Eval`,
    ``,
    `- Date: ${new Date().toISOString()}`,
    `- Provider/model: ${providerModel}`,
    `- Total cases: ${counts.total}`,
    `- Parse OK: ${counts.parse_ok}`,
    `- Parse failed: ${counts.parse_failed}`,
    `- Cases fully passing expectations: ${counts.passed}`,
    `- Cases with failed expectations: ${counts.failed}`,
    ``,
    `| Case | Task | Parse | Latency ms | Checks | Notes |`,
    `|---|---|---:|---:|---|---|`,
    ...records.map((r) => {
      const checks = Object.entries(r.field_results || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '—';
      const notes = (r.notes || []).join('; ') || '—';
      return `| ${r.case} | ${r.task} | ${r.parse_ok ? 'yes' : 'no'} | ${r.latency_ms} | ${checks} | ${notes} |`;
    }),
    ``
  ];
  fs.writeFileSync(mdPath, lines.join('\n'));
  return { jsonlPath, mdPath };
}

async function runSample(sample, config) {
  const started = Date.now();
  const notes = [];
  try {
    const { result, provider, model } = await analyzeDocument({
      enabled: true,
      filename: sample.filename || path.basename(sample.filePath || sample._path),
      mimeType: sample.mimeType || 'application/pdf',
      filePath: sample.filePath || null,
      textPreview: sample.textPreview || ''
    }, config);
    const latencyMs = Date.now() - started;
    const fieldResults = evaluateExpected(result, sample.expected || {});
    const allChecksPassed = Object.values(fieldResults).every((value) => value === 'pass');
    if (!result.title) notes.push('blank title');
    if ((sample.textPreview || result.extraction_evidence?.text_preview_chars > 0) && !result.summary) notes.push('blank summary with text provided');
    return {
      case: sample.case || path.basename(sample._path, '.json'),
      task: sample.task || 'amount_date_extraction',
      model,
      provider,
      parse_ok: true,
      latency_ms: latencyMs,
      field_results: fieldResults,
      all_checks_passed: allChecksPassed,
      notes,
      result,
      sample_path: sample._path
    };
  } catch (err) {
    return {
      case: sample.case || path.basename(sample._path, '.json'),
      task: sample.task || 'amount_date_extraction',
      model: config.provider === 'ollama' ? config.ollama.model
        : config.provider === 'openai_compatible' ? config.compatible.model
        : config.openai.model,
      provider: config.provider,
      parse_ok: false,
      latency_ms: Date.now() - started,
      field_results: {},
      all_checks_passed: false,
      notes: [String(err.message || err)],
      sample_path: sample._path
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const config = buildConfig({
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl || args['base-url'],
    apiKey: args.apiKey || args['api-key']
  });
  const samplePaths = listSamples(args);
  const samples = samplePaths.map(loadSample);
  const records = [];

  for (const sample of samples) {
    const record = await runSample(sample, config);
    records.push(record);
    console.log(`${record.parse_ok ? '✔' : '✖'} ${record.case} (${record.task}) ${record.latency_ms}ms`);
    if (!record.parse_ok || !record.all_checks_passed) {
      console.log(`   notes: ${(record.notes || []).join('; ') || 'check failed'}`);
    }
  }

  const { jsonlPath, mdPath } = writeArtifacts(records, config);
  const counts = summarizeCounts(records);
  console.log(`\nWrote:`);
  console.log(`- ${jsonlPath}`);
  console.log(`- ${mdPath}`);
  console.log(`Summary: ${counts.passed}/${counts.total} cases passed expectations; parse_ok=${counts.parse_ok}/${counts.total}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
