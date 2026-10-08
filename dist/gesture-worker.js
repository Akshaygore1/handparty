/* MediaPipe 0.10.32. Inference stays off the UI thread and on this device. */
/* The CommonJS build has no require dependencies. Expose its exports in this classic worker. */
var exports = {};
importScripts('./vendor/vision_bundle.js');
const vision = exports;
let recognizer;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const files = await vision.FilesetResolver.forVisionTasks(new URL('./vendor/wasm', self.location.href).href);
      recognizer = await vision.GestureRecognizer.createFromOptions(files, {
        // Avoid MediaPipe's browser-name check falling back to document in a worker.
        canvas: new OffscreenCanvas(1,1),
        baseOptions: {modelAssetPath:new URL('./vendor/gesture_recognizer.task',self.location.href).href,delegate:'CPU'},
        runningMode:'VIDEO',numHands:2,
        minHandDetectionConfidence:0.6,minHandPresenceConfidence:0.6,minTrackingConfidence:0.6
      });
      self.postMessage({type:'ready'});
    } catch (error) { self.postMessage({type:'error',stage:'init',message:String(error)}); }
  } else if (data.type === 'frame') {
    try {
      const result = recognizer.recognizeForVideo(data.bitmap,data.timestamp);
      const gestures = result.gestures.map(hand => hand[0]).filter(Boolean);
      self.postMessage({type:'result',gestures,handCount:result.landmarks.length,timestamp:data.timestamp});
    } catch (error) {self.postMessage({type:'error',stage:'frame',message:String(error)});}
    finally {data.bitmap.close();}
  }
};
