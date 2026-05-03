# MagicInsight eval samples

Drop private sample JSON files here, then run:

```bash
npm run magicinsight:eval -- \
  --sample-dir ./planning/eval-samples \
  --provider ollama \
  --model qwen3-4b-nothink \
  --base-url http://192.168.1.100:11434
```

You can also point at a single sample:

```bash
node bin/magicinsight-eval.js \
  --sample ./planning/eval-samples/example-offer-letter.json \
  --provider ollama \
  --model qwen3-4b-nothink \
  --base-url http://192.168.1.100:11434
```

To see the exact preview HomeSource would feed into MagicIndex for a real file:

```bash
npm run magicindex:preview -- /path/to/file.pdf
```

Or JSON output you can paste into an eval sample:

```bash
npm run magicindex:preview -- /path/to/file.pdf --json
```

## Sample format

```json
{
  "case": "offer_letter",
  "task": "amount_date_extraction",
  "filename": "Offer Letter.pdf",
  "mimeType": "application/pdf",
  "filePath": "./docs/Offer Letter.pdf",
  "textPreview": "optional direct text preview instead of filePath",
  "expected": {
    "title_includes": "Offer Letter",
    "title_includes_any_of": ["Offer Letter", "Employment Offer"],
    "document_type": "contract",
    "document_type_any_of": ["contract", "employment"],
    "issued_date": "2023-12-01",
    "issued_date_any_of": ["2023-12-01", "2023-12-02"],
    "expiry_date": null,
    "expiry_date_any_of": [null, "2023-12-31"],
    "amount_value_any_of": [1199, 1199.27],
    "summary_nonempty": true,
    "confidence_min": 0.5
  }
}
```

Notes:

- `filePath` is resolved relative to the sample JSON file.
- `textPreview` can be used by itself for text-only evaluation.
- `expected.amount_value` compares against `result.amount.value` with a small numeric tolerance.
- `*_any_of` fields let you encode acceptable ambiguity for titles, doc types, dates, or amounts.
- Output artifacts are written to `planning/evals/`.
