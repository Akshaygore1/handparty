/* MediaPipe 0.10.32. Inference stays off the UI thread and on this device. */
/* The CommonJS build has no require dependencies. Expose its exports in this classic worker. */
var exports = {};
importScripts('./vendor/vision_bundle.js');
const vision = exports;
let recognizer, delegate;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const files = await vision.FilesetResolver.forVisionTasks(new URL('./vendor/wasm', self.location.href).href);
      const response = await fetch(new URL('./vendor/gesture_recognizer.task',self.location.href));
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
      const model = new Uint8Array(await response.arrayBuffer());
      let gpuError;
      for (const backend of ['GPU','CPU']) {
        try {
          recognizer = await vision.GestureRecognizer.createFromOptions(files, {
            // Explicit canvas also avoids the browser-name fallback to document.
            canvas: new OffscreenCanvas(1,1),
            baseOptions: {modelAssetBuffer:model,delegate:backend},
            runningMode:'VIDEO',numHands:1,
            minHandDetectionConfidence:0.6,minHandPresenceConfidence:0.6,minTrackingConfidence:0.6
          });
          delegate = backend;
          break;
        } catch (error) {
          if (backend === 'CPU') throw new Error(`GPU: ${gpuError}; CPU: ${String(error)}`);
          gpuError = String(error);
        }
      }
      self.postMessage({type:'ready',delegate});
    } catch (error) { self.postMessage({type:'error',stage:'init',message:String(error)}); }
  } else if (data.type === 'frame') {
    try {
      const started = performance.now();
      const result = recognizer.recognizeForVideo(data.bitmap,data.timestamp);
      const gestures = result.gestures.map(hand => hand[0]).filter(Boolean);
      self.postMessage({type:'result',gestures,handCount:result.landmarks.length,timestamp:data.timestamp,inferenceMs:performance.now()-started});
    } catch (error) {self.postMessage({type:'error',stage:'frame',message:String(error)});}
    finally {data.bitmap.close();}
  }
};
