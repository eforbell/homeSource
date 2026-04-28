# Feature Iteration Agent Instructions

1. Read `planning/current-feature.json` to find active feature
2. Read the PRD at the path specified in `prdPath` (e.g., `planning/features/feature-3-prd.json`)
3. Read `planning/progress.txt` (check Codebase Patterns first)
4. Read `planning/camera-scanning-gotchas.md` if the feature touches camera/scanning
5. Check you're on the correct branch (from `current-feature.json`)
   - If branch doesn't exist, create it from `main`
6. Start with the highest priority unfinished story, but use judgment:
   - complete one story when the work is naturally bounded
   - complete multiple tightly-coupled stories in one pass when the implementation and verification are materially shared
   - avoid artificial pauses when the work can be carried further safely
7. Prefer implementing end-to-end slices instead of partial scaffolding
8. Run the relevant tests for the touched area; run broader test passes when the change warrants it
9. Update PRD status fields for stories completed in the pass
10. Append learnings to progress.txt
11. Commit when asked or when the operating mode explicitly expects commits
12. Don't ever commit DB credentials or other sensitive private data to git

## Progress Format

APPEND to progress.txt:

```
## [Date] - [Story ID]
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
```

Consolidate progress items after feature is delivered.

## Codebase Patterns

Add reusable patterns to the TOP of progress.txt:

```
## Codebase Patterns
- Pattern name: Description
```

## iOS / Mobile Testing

This app runs in WKWebView on iOS. Before marking camera or mobile-related stories complete:
- Review `planning/camera-scanning-gotchas.md` for known pitfalls
- Test touch interactions (pointer events, not just mouse)
- Verify no iOS auto-zoom triggers (inputs >= 16px)
- Check that no `target="_blank"` links exist (use `download` attribute)
- Ensure no PDF iframes on mobile (show image + download button instead)

## File Structure

```
planning/
├── current-feature.json        # READ THIS FIRST - active feature config
├── iteration-process.md        # These instructions
├── progress.txt                # Development log (append here)
├── camera-scanning-gotchas.md  # iOS/WKWebView camera lessons
├── README.md                   # Planning overview
└── features/
    ├── feature-1-summary.md
    ├── feature-2-summary.md
    ├── feature-3-prd.json      # (future)
    └── feature-3-summary.md    # (future)
```

## Stop Condition

If ALL stories in current feature pass, reply:
<promise>COMPLETE</promise>

Otherwise end normally after completing a coherent implementation slice.

## Bash Guidelines
- DO NOT pipe output through `head`, `tail`, `less`, or `more` — causes buffering issues
- Use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can buffer indefinitely
