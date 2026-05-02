# Feature Idea: Coversheet Detection + Adaptive Re-extraction

Date: 2026-05-02
Status: Idea (not scheduled)
Related: Feature #4 MagicInsight (document_quality scanner will flag these)

## Problem

MagicIndex extracts text from pages 1-5 (pdftotext) or 1-3 (OCR). Some documents have cover/transmittal sheets, title pages, or blank first pages that waste the extraction window. A 30-page mortgage agreement where page 1 is a fax coversheet gets indexed on the coversheet content, not the actual terms.

## Proposed Solution

### Detection (built into Feature #4 document_quality scanner)

Signals that suggest a coversheet:
- Very low text_preview_chars relative to file_size_bytes or page_count
- Extracted text contains coversheet patterns: "TRANSMITTAL", "FAX TO:", "COVER SHEET", "PLEASE DELIVER TO"
- High ratio of whitespace/formatting to content in extracted text
- Document type is `contract`, `legal`, `property`, or `mortgage` but extracted text lacks expected terms

### Re-extraction (future feature)

When a coversheet is detected:
1. Flag document with `document_quality` MagicData record
2. Offer "Re-analyze" button that re-runs MagicIndex with:
   - Extended page range (pages 2-10 instead of 1-5)
   - Or skip-first-N-pages option
3. New extraction replaces previous MagicIndex result
4. Re-triggers cross-reference and gap detection for updated metadata

### Adaptive Extraction (longer-term)

- On first extraction, if text_preview_chars < threshold, automatically try pages 2-6
- Store extraction_strategy in metadata so re-scans use the same approach
- Learn per-provider/source patterns (e.g., "documents from StateFarm always have a coversheet")

## Implementation Notes

- Detection is nearly free — just SQL + pattern matching on existing extraction_evidence data
- Re-extraction reuses the existing MagicIndex pipeline with modified page parameters
- Requires adding `MAGICINDEX_START_PAGE` or similar parameter to the extraction config
- Could also add `page_count` to document_files if not already present (it is — column exists)
