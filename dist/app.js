'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), stage = $('stage'), canvas = $('effects'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const touchDevice = matchMedia('(pointer: coarse)').matches;
const frameCanvas = document.createElement('canvas'), frameContext = frameCanvas.getContext('2d', {alpha:false});
let stream = null, phase = 'idle', cameraSession = 0;
let worker = null, detectorPromise = null, cancelDetector = null, visionReady = false;
let frameTimer = 0, frameTimeout = 0, frameInFlight = false, lastVideoTime = -1, candidate = '', candidateSince = 0, armed = true, absentSince = 0;
let particles = [], animation = 0, lastDrawTime = 0, toastTimer = 0, activeTimer = 0;
let width = 0, height = 0;
let frameSentAt = 0, recognitionCost = 0, inferenceCost = 0, recognitionPeriod = 0, lastResultAt = 0, backend = '';
let paintCost = 0, effectPeriod = 0, performanceUpdatedAt = 0, motionOverride = null;
const motionEnabled = () => motionOverride ?? !reducedMotion.matches;
$('motionToggle').checked = motionEnabled();
$('motionToggle').addEventListener('change', () => {motionOverride = $('motionToggle').checked; clearEffects();});
reducedMotion.addEventListener('change', () => {
  if (motionOverride === null) {$('motionToggle').checked = motionEnabled(); clearEffects();}
});

function setCameraStatus(label) { $('cameraStatusText').textContent = label; }
function resetGesture() {
  candidate = ''; candidateSince = 0; armed = true; absentSince = 0;
  $('holdTrack').hidden = true; $('holdProgress').style.width = '0%';
}
function tracking(text) { if ($('trackingText').textContent !== text) $('trackingText').textContent = text; }
function recognitionState(text) { if ($('recognitionState').textContent !== text) $('recognitionState').textContent = text; }
function updatePerformance(now) {
  if (now-performanceUpdatedAt < 1000) return;
  performanceUpdatedAt = now;
  const recognition = recognitionPeriod ? `${Math.round(1000/recognitionPeriod)} fps, ${Math.round(inferenceCost)} ms inference, ${Math.round(recognitionCost)} ms total` : 'starting';
  const effects = animation && effectPeriod ? `${Math.round(1000/effectPeriod)} fps, ${Math.round(paintCost)} ms/draw` : 'idle';
  $('performanceStatus').textContent = `${backend || 'Recognizer'}: ${recognition}. Effects: ${effects}. Motion: ${motionEnabled() ? 'full' : 'reduced'}.`;
}
function recognitionFailure(error, step) {
  resetGesture();
  recognitionState(`Failed during ${step}.`);
  $('recognitionError').textContent = String(error?.message || error).slice(0,2000);
  $('recognitionError').hidden = false;
  $('recognitionDetails').hidden = false;
  const message = error?.message === 'unsupported' ? 'Update your browser for gestures.'
    : error?.message === 'timeout' ? 'Loading timed out. Toggle gestures to retry.'
    : 'Gestures unavailable. Open ? for details.';
  tracking(message);
}
function setPhase(next) {
  phase = next;
  const live = next === 'live';
  stage.classList.toggle('live', live);
  $('trackingStatus').hidden = !live;
  $('cameraButton').disabled = !live;
  $('startButton').disabled = next === 'starting';
  $('startButton').querySelector('span').textContent = next === 'starting' ? 'Opening…' : 'Start camera';
  setCameraStatus(live ? 'Live' : next === 'starting' ? 'Opening…' : 'Camera off');
}

async function startCamera() {
  if (phase === 'starting' || phase === 'live') return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('cameraMessage').textContent = 'Camera needs HTTPS or localhost.';
    return;
  }
  const session = ++cameraSession;
  setPhase('starting');
  $('cameraMessage').textContent = 'Allow camera access to start.';
  try {
    const bounds = stage.getBoundingClientRect();
    const portrait = bounds.height > bounds.width;
    const shortEdge = touchDevice ? 540 : 720, longEdge = touchDevice ? 960 : 1280;
    const acquired = await navigator.mediaDevices.getUserMedia({audio:false, video:{
      facingMode:'user',width:{ideal:portrait?shortEdge:longEdge},height:{ideal:portrait?longEdge:shortEdge},
      aspectRatio:{ideal:bounds.width/bounds.height},frameRate:{ideal:30,max:30}
    }});
    if (session !== cameraSession) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    video.srcObject = stream;
    await video.play();
    if (session !== cameraSession) return;
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (session === cameraSession) stopCamera('Camera disconnected. Try again.');
    }));
    resetGesture(); lastVideoTime = -1; setPhase('live');
    if ($('gestureToggle').checked) await enableRecognition(session);
    else tracking('Gestures paused. Tap a move.');
  } catch (error) {
    if (session !== cameraSession) return;
    const messages = {
      NotAllowedError:'Allow camera access in browser settings.',
      NotFoundError:'No camera found. Tap a move instead.',
      NotReadableError:'Camera busy. Close other camera apps.',
      AbortError:'Camera could not start. Try again.'
    };
    stopCamera(messages[error.name] || 'Camera unavailable. Retry or tap a move.');
  }
}

function stopCamera(message = 'Hold ✋ or ✌️ to play') {
  ++cameraSession;
  clearTimeout(frameTimer);
  clearTimeout(frameTimeout);
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null;
  cancelDetector?.(); cancelDetector = null;
  worker?.terminate(); worker = null; detectorPromise = null; visionReady = false;
  frameInFlight = false; resetGesture(); setPhase('idle');
  recognitionState('Camera off');
  backend = ''; recognitionCost = 0; inferenceCost = 0; recognitionPeriod = 0; lastResultAt = 0; frameSentAt = 0;
  $('performanceStatus').textContent = '';
  $('cameraMessage').textContent = message;
}

function loadDetector() {
  if (detectorPromise) return detectorPromise;
  if (!window.Worker || !window.createImageBitmap || !window.OffscreenCanvas || !frameContext) return Promise.reject(new Error('unsupported'));
  let activeWorker;
  try { activeWorker = new Worker('gesture-worker.js?v=5'); }
  catch (error) { return Promise.reject(error); }
  worker = activeWorker;
  detectorPromise = new Promise((resolve,reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('timeout')), 90000);
    function fail(error) {
      clearTimeout(timeout);
      const current = worker === activeWorker;
      if (current) {
        clearTimeout(frameTimer); clearTimeout(frameTimeout);
        worker = null; visionReady = false; detectorPromise = null; frameInFlight = false;
      }
      activeWorker.terminate();
      if (!settled) { settled = true; if (current) cancelDetector = null; reject(error); }
      else if (current && phase === 'live' && $('gestureToggle').checked) {
        recognitionFailure(error,error.stage || 'recognition');
      }
    }
    cancelDetector = () => fail(new Error('cancelled'));
    activeWorker.onmessage = ({data}) => {
      if (worker !== activeWorker) return;
      if (data.type === 'ready') {
        clearTimeout(timeout); settled = true; cancelDetector = null; visionReady = true;
        backend = data.delegate; recognitionCost = 0; inferenceCost = 0; recognitionPeriod = 0; lastResultAt = 0;
        recognitionState('Model ready. Waiting for camera frames.'); resolve();
      } else if (data.type === 'result') {
        frameInFlight = false;
        clearTimeout(frameTimeout);
        const now = performance.now();
        const cost = now-frameSentAt;
        recognitionCost = recognitionCost ? recognitionCost*.8+cost*.2 : cost;
        inferenceCost = inferenceCost ? inferenceCost*.8+data.inferenceMs*.2 : data.inferenceMs;
        if (lastResultAt) recognitionPeriod = recognitionPeriod ? recognitionPeriod*.8+(now-lastResultAt)*.2 : now-lastResultAt;
        lastResultAt = now;
        updatePerformance(now);
        recognitionState(data.handCount ? 'Running. Hand detected.' : 'Running. No hand detected.');
        if (phase === 'live' && $('gestureToggle').checked) {
          processGesture(data.gestures,data.timestamp,data.handCount);
          scheduleFrame(cameraSession);
        }
      } else if (data.type === 'error') fail(Object.assign(new Error(data.message),{stage:data.stage}));
    };
    activeWorker.onerror = event => fail(new Error(event.message || 'Worker could not start.'));
    activeWorker.postMessage({type:'init'});
  });
  return detectorPromise;
}

async function enableRecognition(session) {
  tracking('Loading gestures…');
  recognitionState('Loading the recognition model.');
  $('recognitionError').textContent = '';
  $('recognitionError').hidden = true;
  $('recognitionDetails').hidden = false;
  $('performanceStatus').textContent = '';
  try {
    await loadDetector();
    if (session !== cameraSession || phase !== 'live' || !$('gestureToggle').checked) return;
    tracking('Hold ✋ or ✌️');
    scheduleFrame(session);
  } catch (error) {
    if (session !== cameraSession || phase !== 'live' || !$('gestureToggle').checked) return;
    recognitionFailure(error,'model loading');
  }
}

function scheduleFrame(session) {
  clearTimeout(frameTimer);
  // Leave processing headroom, especially while an effect is animating.
  const interval = Math.max(animation ? 250 : 100,recognitionCost*1.7);
  const elapsed = frameSentAt ? performance.now()-frameSentAt : 0;
  frameTimer = setTimeout(() => sendFrame(session), Math.max(16,interval-elapsed));
}
async function sendFrame(session) {
  if (session !== cameraSession || phase !== 'live' || !visionReady || !worker || !$('gestureToggle').checked) return;
  if (frameInFlight) {scheduleFrame(session); return;}
  if (document.hidden || video.readyState < 2 || !video.videoWidth || !video.videoHeight || !width || !height || video.currentTime === lastVideoTime) {scheduleFrame(session); return;}
  lastVideoTime = video.currentTime;
  const activeWorker = worker;
  frameInFlight = true;
  frameSentAt = performance.now();
  frameTimeout = setTimeout(() => {
    if (session !== cameraSession || worker !== activeWorker) return;
    clearTimeout(frameTimer);
    activeWorker.terminate(); worker = null; detectorPromise = null;
    frameInFlight = false; visionReady = false;
    if (phase === 'live' && $('gestureToggle').checked) recognitionFailure(new Error('No response from the recognizer within 20 seconds.'),'frame processing');
  },20000);
  try {
    // Match the centered object-fit: cover preview, including after phone rotation.
    const previewScale = Math.max(width/video.videoWidth,height/video.videoHeight);
    const cropWidth = Math.min(video.videoWidth,width/previewScale);
    const cropHeight = Math.min(video.videoHeight,height/previewScale);
    const bitmapScale = (touchDevice ? 320 : 480)/Math.max(cropWidth,cropHeight);
    const frameWidth = Math.max(1,Math.round(cropWidth*bitmapScale));
    const frameHeight = Math.max(1,Math.round(cropHeight*bitmapScale));
    if (frameCanvas.width !== frameWidth) frameCanvas.width = frameWidth;
    if (frameCanvas.height !== frameHeight) frameCanvas.height = frameHeight;
    // Capture and resize through a regular canvas instead of a video bitmap overload.
    frameContext.drawImage(video,(video.videoWidth-cropWidth)/2,(video.videoHeight-cropHeight)/2,cropWidth,cropHeight,0,0,frameWidth,frameHeight);
    const bitmap = await createImageBitmap(frameCanvas);
    if (session !== cameraSession || worker !== activeWorker || !$('gestureToggle').checked) {
      bitmap.close();
      if(worker === activeWorker) {frameInFlight=false;clearTimeout(frameTimeout);}
      return;
    }
    activeWorker.postMessage({type:'frame',bitmap,timestamp:performance.now()},[bitmap]);
  } catch (error) {
    if (session === cameraSession && worker === activeWorker && phase === 'live') {
      frameInFlight = false; visionReady = false; resetGesture();
      clearTimeout(frameTimer); clearTimeout(frameTimeout);
      recognitionFailure(error,'frame capture');
      worker?.terminate(); worker = null; detectorPromise = null;
    }
  }
}

function processGesture(gestures, now, handCount) {
  const supported = gestures.filter(g => g.score >= .65 && ['Open_Palm','Victory'].includes(g.categoryName)).sort((a,b) => b.score-a.score);
  const gesture = supported[0]?.categoryName || '';
  if (!gesture) {
    candidate = ''; candidateSince = 0; $('holdTrack').hidden = true;
    if (!absentSince) absentSince = now;
    if (now-absentSince >= 450) armed = true;
    tracking(armed ? (handCount ? 'Try ✋ or ✌️' : 'Show your whole hand') : 'Lower your hand');
    return;
  }
  absentSince = 0;
  if (!armed) {tracking('Lower your hand'); return;}
  if (candidate !== gesture) {candidate = gesture; candidateSince = now;}
  const progress = Math.min(1,(now-candidateSince)/850);
  tracking(gesture === 'Open_Palm' ? 'Hold ✋…' : 'Hold ✌️…');
  $('holdTrack').hidden = false; $('holdProgress').style.width = `${progress*100}%`;
  if (progress >= 1) {
    armed = false; candidate = ''; $('holdTrack').hidden = true;
    celebrate(gesture === 'Open_Palm' ? 'confetti' : 'balloons');
    tracking('Lower your hand');
  }
}

const colors = ['#a97cf2','#fa6e91','#ffd447','#50c55c','#35a2f6','#ff9c50'];
const darkColors = colors.map(color => tint(color,-.18));
const confettiDrag = -60*Math.log(.985);
const random = (min,max) => min+Math.random()*(max-min);
function tint(hex, amount) {
  const value = parseInt(hex.slice(1),16);
  const target = amount < 0 ? 0 : 255, mix = Math.abs(amount);
  return `rgb(${[16,8,0].map(shift => {
    const channel = (value >> shift) & 255;
    return Math.round(channel + (target-channel)*mix);
  }).join(',')})`;
}
function balloonOutline(context) {
  context.beginPath();context.moveTo(0,1.07);
  context.bezierCurveTo(-.18,1.04,-.28,.84,-.52,.57);
  context.bezierCurveTo(-.83,.22,-1.01,-.19,-.98,-.52);
  context.bezierCurveTo(-.94,-1.02,-.57,-1.3,0,-1.3);
  context.bezierCurveTo(.57,-1.3,.94,-1.02,.98,-.52);
  context.bezierCurveTo(1.01,-.19,.83,.22,.52,.57);
  context.bezierCurveTo(.28,.84,.18,1.04,0,1.07);
  context.closePath();
}
// Render latex shading once per color, rather than rebuilding it for every frame.
const balloonSprites = new Map();
function balloonSprite(color) {
  if (balloonSprites.has(color)) return balloonSprites.get(color);
  const sprite = document.createElement('canvas'), resolution = touchDevice ? .5 : 1;
  sprite.width=320*resolution;sprite.height=416*resolution;
  const paint = sprite.getContext('2d');paint.scale(resolution,resolution);paint.translate(160,190);paint.scale(142,142);
  balloonOutline(paint);
  const body = paint.createRadialGradient(-.37,-.7,.04,.15,-.19,1.48);
  body.addColorStop(0,tint(color,.47));body.addColorStop(.24,tint(color,.22));
  body.addColorStop(.58,color);body.addColorStop(.82,tint(color,-.16));body.addColorStop(1,tint(color,-.48));
  paint.fillStyle=body;paint.fill();
  paint.save();paint.clip();
  const reflected = paint.createRadialGradient(.42,.42,0,.42,.42,.8);
  reflected.addColorStop(0,'#ffffff30');reflected.addColorStop(1,'#ffffff00');
  paint.fillStyle=reflected;paint.fillRect(-1,-1.35,2,2.7);
  const sheen = paint.createRadialGradient(-.4,-.76,0,-.4,-.76,.34);
  sheen.addColorStop(0,'#ffffffd9');sheen.addColorStop(.35,'#ffffff63');sheen.addColorStop(1,'#ffffff00');
  paint.save();paint.translate(-.4,-.76);paint.rotate(-.35);paint.scale(.66,1);
  paint.translate(.4,.76);paint.fillStyle=sheen;paint.fillRect(-1,-1.35,2,2.7);paint.restore();
  paint.beginPath();paint.ellipse(-.42,-.82,.045,.15,-.35,0,Math.PI*2);paint.fillStyle='#ffffffb0';paint.fill();
  paint.restore();
  balloonOutline(paint);paint.strokeStyle=tint(color,-.3);paint.lineWidth=.012;paint.stroke();
  paint.beginPath();paint.moveTo(0,1.04);paint.lineTo(-.075,1.19);paint.quadraticCurveTo(0,1.16,.075,1.19);paint.closePath();
  paint.fillStyle=tint(color,-.18);paint.fill();
  paint.beginPath();paint.moveTo(-.027,1.09);paint.lineTo(.028,1.09);paint.strokeStyle=tint(color,.3);paint.lineWidth=.025;paint.stroke();
  balloonSprites.set(color,sprite);return sprite;
}
function resizeCanvas() {
  const rect = stage.getBoundingClientRect(); width = rect.width; height = rect.height;
  const ratio = Math.min(devicePixelRatio || 1,touchDevice ? 1.5 : 2,Math.sqrt((touchDevice?700000:1600000)/Math.max(1,width*height)));
  canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);
}
new ResizeObserver(resizeCanvas).observe(stage);

function celebrate(effect) {
  const now = performance.now(), gentle = !motionEnabled();
  clearTimeout(toastTimer); clearTimeout(activeTimer);
  $('reactionToast').textContent = effect === 'confetti' ? 'Confetti ✨' : 'Balloons 🎈';
  $('reactionToast').classList.add('show');
  toastTimer = setTimeout(() => $('reactionToast').classList.remove('show'),2200);
  document.querySelectorAll('.reaction-button').forEach(button => button.classList.toggle('active',button.dataset.effect===effect));
  activeTimer = setTimeout(() => document.querySelectorAll('.reaction-button').forEach(b => b.classList.remove('active')),1800);
  if (effect === 'confetti') {
    for (let i=0;i<(gentle?35:touchDevice?90:230);i++) {
      const left = i%2===0;
      particles.push({type:'confetti',x:gentle?random(0,width):(left?width*.08:width*.92),y:gentle?random(0,height):height*.88,
        vx:gentle?0:(left?1:-1)*random(60,440),vy:gentle?15:random(-height*1.9,-height*.9),
        angle:random(0,Math.PI*2),spin:random(-7,7),size:random(12,23)*(width<450?.85:1),
        shape:i%9===0?'disc':i%5===0?'ribbon':'paper',phase:random(0,Math.PI*2),
        color:colors[i%colors.length],darkColor:darkColors[i%colors.length],born:now,life:gentle?1000:random(4000,6200),gentle});
    }
  } else {
    const balloonScale = Math.min(1.25,width/760,height/440);
    for (let i=0;i<(gentle?5:touchDevice?8:14);i++) {
      particles.push({type:'balloon',x:random(width*.06,width*.94),y:gentle?random(height*.3,height*.75):height+random(35,height*.7),
        speed:gentle?8:random(height*.16,height*.23),size:random(49,79)*Math.max(.75,balloonScale),
        color:colors[i%colors.length],phase:random(0,6.28),born:now,life:gentle?1300:12000,gentle});
    }
  }
  particles = particles.slice(-(touchDevice?150:480));
  if (!animation) {lastDrawTime=0; effectPeriod=0; animation=requestAnimationFrame(drawEffects);}
}

function drawEffects(now) {
  const started = performance.now();
  if (lastDrawTime) effectPeriod = effectPeriod ? effectPeriod*.9+(now-lastDrawTime)*.1 : now-lastDrawTime;
  lastDrawTime = now;
  ctx.clearRect(0,0,width,height);
  particles = particles.filter(p => now-p.born < p.life);
  for (const p of particles) {
    const age = Math.max(0,now-p.born), seconds = age/1000;
    ctx.save(); ctx.globalAlpha = Math.min(1,(p.life-age)/450);
    if (p.type === 'confetti') {
      // Position follows elapsed time, so dropped frames cannot slow the flight.
      const x = p.x+(p.gentle?0:p.vx*(1-Math.exp(-confettiDrag*seconds))/confettiDrag+28*.23*(Math.cos(p.phase)-Math.cos(seconds/.23+p.phase)));
      const y = p.y+p.vy*seconds+(p.gentle?0:height*.26*seconds*seconds);
      ctx.translate(x,y); ctx.rotate(p.angle+(p.gentle?0:p.spin*seconds));
      const flip = p.gentle?1:Math.cos(age/210+p.phase);
      ctx.scale(1,Math.sign(flip)*Math.max(.1,Math.abs(flip)));
      ctx.fillStyle=flip<0?p.darkColor:p.color;
      if(p.shape==='disc') {ctx.beginPath();ctx.arc(0,0,p.size*.38,0,Math.PI*2);ctx.fill();}
      else {
        const length = p.shape==='ribbon'?p.size*1.6:p.size;
        const breadth = p.shape==='ribbon'?p.size*.3:p.size*.65;
        ctx.fillRect(-length/2,-breadth/2,length,breadth);
        ctx.fillStyle='#ffffff48';ctx.fillRect(-length/2,-breadth/2,length,1);
      }
    } else {
      const sway=p.gentle?0:Math.sin(age/1100+p.phase)*22;
      ctx.translate(p.x+sway,p.y-p.speed*seconds); ctx.rotate(p.gentle?0:Math.sin(age/1300+p.phase)*.09);
      const size=p.size;
      ctx.beginPath();ctx.moveTo(0,size*1.17);
      ctx.bezierCurveTo(-size*.3,size*1.8,size*.25,size*2.25,Math.sin(age/750+p.phase)*size*.18,size*3.45);
      ctx.strokeStyle='#17141b38';ctx.lineWidth=2;ctx.stroke();
      ctx.strokeStyle='#fff9';ctx.lineWidth=.9;ctx.stroke();
      ctx.drawImage(balloonSprite(p.color),-size*160/142,-size*190/142,size*320/142,size*416/142);
    }
    ctx.restore();
  }
  const cost = performance.now()-started;
  paintCost = paintCost ? paintCost*.9+cost*.1 : cost;
  updatePerformance(now);
  if (particles.length) animation=requestAnimationFrame(drawEffects);
  else {animation=0;ctx.clearRect(0,0,width,height);}
}
function clearEffects() {
  particles=[];cancelAnimationFrame(animation);animation=0;ctx.clearRect(0,0,width,height);
  lastDrawTime=0; effectPeriod=0; paintCost=0;
  clearTimeout(toastTimer);clearTimeout(activeTimer);$('reactionToast').classList.remove('show');
  document.querySelectorAll('.reaction-button').forEach(b => b.classList.remove('active'));
}

$('startButton').addEventListener('click',startCamera);
$('cameraButton').addEventListener('click',() => stopCamera());
$('mirrorButton').addEventListener('click',() => {
  const mirrored = video.classList.toggle('mirrored');
  $('mirrorButton').setAttribute('aria-pressed',String(mirrored));
});
$('confettiButton').addEventListener('click',() => celebrate('confetti'));
$('balloonsButton').addEventListener('click',() => celebrate('balloons'));
$('clearButton').addEventListener('click',clearEffects);
$('gestureToggle').addEventListener('change',() => {
  clearTimeout(frameTimer);resetGesture();
  if (phase !== 'live') return;
  if ($('gestureToggle').checked) enableRecognition(cameraSession);
  else {tracking('Gestures paused. Tap a move.');recognitionState('Gestures paused.');}
});
const exitFullscreen = document.createElement('button');
exitFullscreen.className='fullscreen-exit';exitFullscreen.textContent='Close';exitFullscreen.setAttribute('aria-label','Exit fullscreen');exitFullscreen.hidden=true;
stage.append(exitFullscreen);
async function leaveFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
  stage.classList.remove('expanded');exitFullscreen.hidden=true;document.body.style.overflow='';
  $('fullscreenButton').setAttribute('aria-label','Enter fullscreen');
}
$('fullscreenButton').addEventListener('click',async () => {
  if (document.fullscreenElement || stage.classList.contains('expanded')) {await leaveFullscreen();return;}
  try {
    if (!stage.requestFullscreen) throw new Error('unsupported');
    await stage.requestFullscreen();
  } catch {stage.classList.add('expanded');document.body.style.overflow='hidden';}
  exitFullscreen.hidden=false;
  $('fullscreenButton').setAttribute('aria-label','Exit fullscreen');
});
exitFullscreen.addEventListener('click',leaveFullscreen);
document.addEventListener('fullscreenchange',() => {
  const expanded = !!document.fullscreenElement || stage.classList.contains('expanded');
  exitFullscreen.hidden=!expanded;
  $('fullscreenButton').setAttribute('aria-label',expanded?'Exit fullscreen':'Enter fullscreen');
});
document.addEventListener('keydown',event => {if(event.key==='Escape' && stage.classList.contains('expanded')) leaveFullscreen();});
$('helpButton').addEventListener('click',() => $('helpDialog').showModal());
$('closeHelp').addEventListener('click',() => $('helpDialog').close());
$('gotItButton').addEventListener('click',() => $('helpDialog').close());
$('helpDialog').addEventListener('click',event => {if(event.target===$('helpDialog')) {
  const r=$('helpDialog').getBoundingClientRect();
  if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) $('helpDialog').close();
}});
document.addEventListener('visibilitychange',() => {resetGesture();if(!document.hidden && phase==='live') scheduleFrame(cameraSession);});
window.addEventListener('pagehide',() => {stopCamera();clearEffects();});
