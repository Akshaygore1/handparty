# Handparty

A browser camera playground with open-palm confetti and peace-sign balloons. Click either move to play without a camera.

## Run locally

From this directory, run:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4173 in your browser. Enable the camera, allow access, and hold an open palm or a peace sign for about one second. Lower your hand before repeating. No microphone is requested, no video is recorded or uploaded, and all gesture inference happens in a local Web Worker.

## Hosting

The `dist` folder is a buildless static site published on GitHub Pages at https://akshaygore1.github.io/handparty/.

The workflow in `.github/workflows/deploy.yml` publishes `dist` on every push to `main`, or when run manually from GitHub Actions. GitHub Pages must use **GitHub Actions** as its publishing source. All asset paths are relative so the site works under `/handparty/`.

## Implementation

- MediaPipe Tasks Vision 0.10.32 and the Google Gesture Recognizer float16 model are bundled in `dist/vendor`.
- Official API reference: https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js
- Camera and recognition failures keep manual reaction controls usable.
- The recognizer receives an explicit worker canvas. Camera frames are cropped and resized through an HTML canvas before transfer. Loading allows 90 seconds on slower connections; stalled frames time out after 20 seconds. Recognition errors are available under `?` → Recognition details.
- Recognition prefers GPU with CPU fallback and tracks one hand. Sampling adapts to processing time and slows during effects. Phone rendering uses smaller frames, bounded canvas resolution, fewer particles, and elapsed-time movement. `?` contains performance timings and a Full motion override for the system reduced-motion default.
- Gesture hold time: 850ms. Confidence threshold: 0.65. Return to a neutral gesture for 450ms to rearm.
- Mirroring, camera stop, clearing reactions, fullscreen, responsive layout, and reduced-motion effects are included.
- The camera fills the available screen, with large reaction buttons and compact controls below it. Phone safe areas and landscape layouts are supported; recognition uses the same crop as the visible preview.

Automated tests and live camera verification were not performed, following the user's instruction not to test unless requested.
