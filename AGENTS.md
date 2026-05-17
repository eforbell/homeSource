# Agent Learnings

## Web UI: iOS Input Auto-Zoom Guard

- iOS Safari/WKWebView auto-zooms focused text-entry controls when their computed font-size is below 16px; keep login/PIN and other interactive `input`, `select`, and `textarea` controls at `font-size: 1rem` minimum
- When forms already use shared classes like `.form-input` / `.form-select`, preserve explicit 16px control sizing there so auth and share-entry screens remain safe by default
