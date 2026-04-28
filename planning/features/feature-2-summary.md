# Feature 2: MVP Hardening

## Purpose

Fix all bugs and UX issues discovered during real-device testing on iOS (WKWebView) and desktop. The initial build worked on desktop but had significant issues on mobile: camera scanning failures, upload size errors swallowed silently, layout breaking on small screens, iOS-specific viewport behaviors, and incomplete UI wiring.

## Scope

### iOS / WKWebView Fixes
- Camera access requires user gesture before `getUserMedia` (iOS rejects unprompted calls)
- PDF iframes trigger Safari overlay with no back button — show original image on mobile instead
- `target="_blank"` on file links opens system viewer with no way back — switched to `download` attribute
- Form inputs below 16px trigger iOS auto-zoom — bumped all inputs to 1rem
- `drawImage(video)` can produce black frames when racing with OpenCV interval reads — stop interval first, use requestAnimationFrame, retry on black frame detection

### Scanner Overhaul
- jscanify `highlightPaper()` returns a new canvas (doesn't draw to passed canvas) — use returned canvas
- Built complete manual corner registration with draggable handles as reliable fallback
- Corner canvas invisible due to CSS `position: absolute` collapsing container — targeted specific elements
- Corner handles at position zero when container hidden — show panel before reading dimensions
- `object-fit: contain` causes letterboxing that misaligns handles — removed
- Client-side image compression (max 2400px, 85% JPEG) to work within upload limits
- Tunable auto-crop looseness and document filter (high contrast) toggles

### Upload / Storage Fixes
- `express.json()` consuming multipart request bodies — skip multipart content-types
- nginx 413 response (HTML, not JSON) swallowed by API.upload — catch 413 specifically
- Thumbnail generation using processed PDF instead of original image — use original as thumbnail source

### UI / Polish
- Document detail grid bleeding on mobile — replaced inline styles with CSS class + media query
- Share link API paths resolving incorrectly (relative URL from `/share/:token`) — compute basePath
- Tags editor button present but non-functional — wired up modal with checkboxes, save, quick-add
- Added permanent delete alongside archive
- systemd StateDirectory for automatic data dir creation

## Shipped

20 commits from `ffa05d0` through `ff0ec20` (2026-04-27)
