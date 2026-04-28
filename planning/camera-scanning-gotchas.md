# Camera Scanning Gotchas (iOS / WKWebView / Mobile Safari)

Hard-won lessons from building client-side document scanning with jscanify + OpenCV.js targeting iOS WKWebView and mobile Safari. These apply to any web-based camera capture flow.

## getUserMedia Requires User Gesture on iOS

iOS Safari and WKWebView reject `getUserMedia()` calls that aren't triggered by a user gesture (tap/click). You cannot auto-start the camera on page load or in a `setTimeout`. The camera must be started inside a click/tap event handler.

```javascript
// WRONG — will fail silently or throw on iOS
window.addEventListener('load', () => navigator.mediaDevices.getUserMedia({video: true}));

// RIGHT — user taps a button to start
startBtn.addEventListener('click', () => navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}}));
```

## drawImage(video) Can Produce Black Frames

On iOS, calling `canvas.getContext('2d').drawImage(video, ...)` immediately after stopping an interval that was also reading the video element can produce a fully black frame. The video element and canvas appear to contend for the video buffer.

**Fix**: Stop any intervals reading the video first, then use `requestAnimationFrame` to delay the capture by one frame. Add black-frame detection (sample a few pixels) and retry once if black:

```javascript
clearInterval(highlightInterval);
highlightInterval = null;
requestAnimationFrame(() => {
  ctx.drawImage(video, 0, 0);
  const sample = ctx.getImageData(w/2, h/2, 1, 1).data;
  if (sample[0] === 0 && sample[1] === 0 && sample[2] === 0) {
    // Black frame — retry once
    requestAnimationFrame(() => { ctx.drawImage(video, 0, 0); proceed(); });
  } else { proceed(); }
});
```

## jscanify API Surprises

- `highlightPaper(image, options)` **returns a new canvas** — it does not draw onto a canvas you pass as the second argument. The second arg is treated as an options object. You must take the returned canvas and draw it onto your overlay.
- `extractPaper(image, width, height)` returns `null` when no document contour is found. Always check for null.
- `findPaperContour(image)` uses Canny edge detection internally. Results are sensitive to lighting and contrast. Auto-detection is unreliable enough that a manual corner fallback is essential.

## Manual Corner Registration is Essential

Auto-edge detection fails often enough (low contrast documents, busy backgrounds, poor lighting) that manual corner adjustment must exist as a first-class path, not a fallback. Design the UI so the user always reviews and can adjust corners before cropping.

### Handle Positioning Gotchas

- **Container must be visible** before reading `offsetWidth`/`offsetHeight` for handle placement. If the container is `display: none` when you calculate positions, all handles land at (0, 0).
- **`object-fit: contain`** on the image/canvas causes letterboxing — the visual content doesn't fill the element bounds, so handle coordinates mapped to element dimensions won't align with the image content. Avoid `object-fit` on the canvas; instead size the canvas to match the image aspect ratio.
- **`position: absolute`** on canvas elements collapses their parent container height to zero. Use it only on overlay canvases (highlight), not on the primary corner-adjustment canvas.
- **Touch events**: Use `touch-action: none` on handles and listen for `pointerdown`/`pointermove`/`pointerup` (works for both touch and mouse). Set `cursor: grab` for desktop UX.

## CSS Targeting for Multiple Canvases

If you have both an overlay canvas (for highlight drawing) and a content canvas (for corner adjustment), do NOT use a shared CSS rule like `.scanner-container canvas { position: absolute }`. Target each canvas by ID:

```css
#scan-highlight { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
#corner-canvas { width: 100%; display: block; /* NOT position: absolute */ }
```

## PDF Iframe on iOS

Embedding a PDF in an `<iframe>` on iOS triggers Safari's native PDF viewer overlay, which takes over the screen with no way to return to the app (especially in WKWebView wrappers). On mobile, show the original image or a thumbnail instead, with a download button for the PDF:

```javascript
if (isMobile && file.mime_type === 'application/pdf') {
  // Show thumbnail + download button instead of iframe
}
```

Similarly, `target="_blank"` on download links opens the system viewer with no back button in WKWebView. Use the `download` attribute instead.

## Client-Side Image Compression

Phone cameras produce 4000+ pixel images that exceed server upload limits. Compress client-side before upload:

- Max dimension: 2400px (sufficient for document legibility)
- JPEG quality: 0.85 (good balance of size vs. readability)
- Skip compression for PDFs and already-small files
- Use `canvas.toBlob()` with JPEG mime type for compression

## iOS Auto-Zoom on Inputs

iOS Safari auto-zooms the viewport when focusing an input with `font-size < 16px`. Set all form inputs to at least `1rem` (16px) to prevent this. This affects the entire page layout, not just the input.

## OpenCV.js Loading

OpenCV.js is large (~8MB). Load it only on the upload page, not globally. Use a loading indicator and defer camera initialization until OpenCV signals ready via its `onRuntimeInitialized` callback. If OpenCV fails to load, the scanner tab should gracefully degrade (show an error, still allow file upload and URL import).

## Video Constraints for Document Scanning

Request the rear camera with high resolution for document scanning:

```javascript
{ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } }
```

`facingMode: 'environment'` gets the rear camera on phones. `ideal` constraints are best-effort — the browser picks the closest match without failing.
