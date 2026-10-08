'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), stage = $('stage'), canvas = $('effects'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let stream = null, phase = 'idle', cameraSession = 0;
let worker = null, detectorPromise = null, cancelDetector = null, visionReady = false;
let frameTimer = 0, frameInFlight = false, lastVideoTime = -1, candidate = '', candidateSince = 0, armed = true, absentSince = 0;
let particles = [], animation = 0, lastDrawTime = 0, toastTimer = 0, activeTimer = 0;
let width = 0, height = 0;

function setCameraStatus(label) { $('cameraStatusText').textContent = label; }
function resetGesture() {
  candidate = ''; candidateSince = 0; armed = true; absentSince = 0;
  $('holdTrack').hidden = true; $('holdProgress').style.width = '0%';
}
function tracking(text) { $('trackingText').textContent = text; }
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
    const acquired = await navigator.mediaDevices.getUserMedia({audio:false, video:{
      facingMode:'user',width:{ideal:portrait?720:1280},height:{ideal:portrait?1280:720},
      aspectRatio:{ideal:bounds.width/bounds.height},frameRate:{ideal:24,max:30}
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
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null;
  cancelDetector?.(); cancelDetector = null;
  worker?.terminate(); worker = null; detectorPromise = null; visionReady = false;
  frameInFlight = false; resetGesture(); setPhase('idle');
  $('cameraMessage').textContent = message;
}

function loadDetector() {
  if (detectorPromise) return detectorPromise;
  if (!window.Worker || !window.createImageBitmap || !window.OffscreenCanvas) return Promise.reject(new Error('unsupported'));
  detectorPromise = new Promise((resolve,reject) => {
    const activeWorker = new Worker('gesture-worker.js');
    worker = activeWorker;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('timeout')), 30000);
    function fail(error) {
      clearTimeout(timeout);
      if (worker === activeWorker) { worker = null; visionReady = false; detectorPromise = null; frameInFlight = false; }
      activeWorker.terminate();
      if (!settled) { settled = true; cancelDetector = null; reject(error); }
      else if (phase === 'live' && $('gestureToggle').checked) {
        resetGesture(); tracking('Toggle gestures to retry, or tap a move.');
      }
    }
    cancelDetector = () => fail(new Error('cancelled'));
    activeWorker.onmessage = ({data}) => {
      if (worker !== activeWorker) return;
      if (data.type === 'ready') {
        clearTimeout(timeout); settled = true; cancelDetector = null; visionReady = true; resolve();
      } else if (data.type === 'result') {
        frameInFlight = false;
        if (phase === 'live' && $('gestureToggle').checked) {
          processGesture(data.gestures,data.timestamp);
          scheduleFrame(cameraSession);
        }
      } else if (data.type === 'error') fail(new Error(data.message));
    };
    activeWorker.onerror = () => fail(new Error('worker'));
    activeWorker.postMessage({type:'init'});
  });
  return detectorPromise;
}

async function enableRecognition(session) {
  tracking('Loading gestures…');
  try {
    await loadDetector();
    if (session !== cameraSession || phase !== 'live' || !$('gestureToggle').checked) return;
    tracking('Hold ✋ or ✌️');
    scheduleFrame(session);
  } catch (error) {
    if (session !== cameraSession || phase !== 'live' || !$('gestureToggle').checked) return;
    tracking('Toggle gestures to retry, or tap a move.');
  }
}

function scheduleFrame(session) {
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => sendFrame(session), 80);
}
async function sendFrame(session) {
  if (session !== cameraSession || phase !== 'live' || !visionReady || !worker || !$('gestureToggle').checked) return;
  if (frameInFlight) {scheduleFrame(session); return;}
  if (document.hidden || video.readyState < 2 || !video.videoWidth || !video.videoHeight || !width || !height || video.currentTime === lastVideoTime) {scheduleFrame(session); return;}
  lastVideoTime = video.currentTime;
  const activeWorker = worker;
  frameInFlight = true;
  try {
    // Match the centered object-fit: cover preview, including after phone rotation.
    const previewScale = Math.max(width/video.videoWidth,height/video.videoHeight);
    const cropWidth = Math.min(video.videoWidth,width/previewScale);
    const cropHeight = Math.min(video.videoHeight,height/previewScale);
    const bitmapScale = 480/Math.max(cropWidth,cropHeight);
    const bitmap = await createImageBitmap(video,
      (video.videoWidth-cropWidth)/2,(video.videoHeight-cropHeight)/2,cropWidth,cropHeight,
      {resizeWidth:Math.max(1,Math.round(cropWidth*bitmapScale)),resizeHeight:Math.max(1,Math.round(cropHeight*bitmapScale))});
    if (session !== cameraSession || worker !== activeWorker || !$('gestureToggle').checked) {bitmap.close(); if(worker === activeWorker) frameInFlight=false; return;}
    activeWorker.postMessage({type:'frame',bitmap,timestamp:performance.now()},[bitmap]);
  } catch (error) {
    if (session === cameraSession && phase === 'live') {
      frameInFlight = false; visionReady = false; resetGesture();
      tracking('Toggle gestures to retry, or tap a move.');
      worker?.terminate(); worker = null; detectorPromise = null;
    }
  }
}

function processGesture(gestures, now) {
  const supported = gestures.filter(g => g.score >= .65 && ['Open_Palm','Victory'].includes(g.categoryName)).sort((a,b) => b.score-a.score);
  const gesture = supported[0]?.categoryName || '';
  if (!gesture) {
    candidate = ''; candidateSince = 0; $('holdTrack').hidden = true;
    if (!absentSince) absentSince = now;
    if (now-absentSince >= 450) armed = true;
    tracking(armed ? 'Hold ✋ or ✌️' : 'Lower your hand');
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
  const sprite = document.createElement('canvas');sprite.width=320;sprite.height=416;
  const paint = sprite.getContext('2d');paint.translate(160,190);paint.scale(142,142);
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
  const ratio = Math.min(devicePixelRatio || 1,2);
  canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);
}
new ResizeObserver(resizeCanvas).observe(stage);

function celebrate(effect) {
  const now = performance.now(), gentle = reducedMotion.matches;
  clearTimeout(toastTimer); clearTimeout(activeTimer);
  $('reactionToast').textContent = effect === 'confetti' ? 'Confetti ✨' : 'Balloons 🎈';
  $('reactionToast').classList.add('show');
  toastTimer = setTimeout(() => $('reactionToast').classList.remove('show'),2200);
  document.querySelectorAll('.reaction-button').forEach(button => button.classList.toggle('active',button.dataset.effect===effect));
  activeTimer = setTimeout(() => document.querySelectorAll('.reaction-button').forEach(b => b.classList.remove('active')),1800);
  if (effect === 'confetti') {
    for (let i=0;i<(gentle?35:230);i++) {
      const left = i%2===0;
      particles.push({type:'confetti',x:gentle?random(0,width):(left?width*.08:width*.92),y:gentle?random(0,height):height*.88,
        vx:gentle?0:(left?1:-1)*random(60,440),vy:gentle?15:random(-height*1.9,-height*.9),
        angle:random(0,Math.PI*2),spin:random(-7,7),size:random(12,23)*(width<450?.85:1),
        shape:i%9===0?'disc':i%5===0?'ribbon':'paper',phase:random(0,Math.PI*2),
        color:colors[i%colors.length],born:now,life:gentle?1000:random(4000,6200),gentle});
    }
  } else {
    const balloonScale = Math.min(1.25,width/760,height/440);
    for (let i=0;i<(gentle?5:14);i++) {
      particles.push({type:'balloon',x:random(width*.06,width*.94),y:gentle?random(height*.3,height*.75):height+random(35,height*.7),
        speed:gentle?8:random(height*.16,height*.23),size:random(49,79)*Math.max(.75,balloonScale),
        color:colors[i%colors.length],phase:random(0,6.28),born:now,life:gentle?1300:12000,gentle});
    }
  }
  particles = particles.slice(-480);
  if (!animation) {lastDrawTime=now; animation=requestAnimationFrame(drawEffects);}
}

function drawEffects(now) {
  const delta = Math.min((now-lastDrawTime)/1000,.05); lastDrawTime = now;
  ctx.clearRect(0,0,width,height);
  particles = particles.filter(p => now-p.born < p.life && p.y < height+height*.9 && (p.type!=='balloon' || p.y > -p.size*4));
  for (const p of particles) {
    const age = now-p.born;
    ctx.save(); ctx.globalAlpha = Math.min(1,(p.life-age)/450);
    if (p.type === 'confetti') {
      p.x += (p.vx+(p.gentle?0:Math.sin(age/230+p.phase)*28))*delta; p.y += p.vy*delta; p.vy += (p.gentle?0:height*.52)*delta;
      p.vx *= Math.pow(.985,delta*60); p.angle += (p.gentle?0:p.spin)*delta;
      ctx.translate(p.x,p.y); ctx.rotate(p.angle);
      const flip = p.gentle?1:Math.cos(age/210+p.phase);
      ctx.scale(1,Math.sign(flip)*Math.max(.1,Math.abs(flip)));
      ctx.fillStyle=flip<0?tint(p.color,-.18):p.color;
      if(p.shape==='disc') {ctx.beginPath();ctx.arc(0,0,p.size*.38,0,Math.PI*2);ctx.fill();}
      else {
        const length = p.shape==='ribbon'?p.size*1.6:p.size;
        const breadth = p.shape==='ribbon'?p.size*.3:p.size*.65;
        ctx.fillRect(-length/2,-breadth/2,length,breadth);
        ctx.fillStyle='#ffffff48';ctx.fillRect(-length/2,-breadth/2,length,1);
      }
    } else {
      p.y -= p.speed*delta;
      const sway=p.gentle?0:Math.sin(age/1100+p.phase)*22;
      ctx.translate(p.x+sway,p.y); ctx.rotate(p.gentle?0:Math.sin(age/1300+p.phase)*.09);
      const size=p.size;
      ctx.beginPath();ctx.moveTo(0,size*1.17);
      ctx.bezierCurveTo(-size*.3,size*1.8,size*.25,size*2.25,Math.sin(age/750+p.phase)*size*.18,size*3.45);
      ctx.strokeStyle='#17141b38';ctx.lineWidth=2;ctx.stroke();
      ctx.strokeStyle='#fff9';ctx.lineWidth=.9;ctx.stroke();
      ctx.drawImage(balloonSprite(p.color),-size*160/142,-size*190/142,size*320/142,size*416/142);
    }
    ctx.restore();
  }
  if (particles.length) animation=requestAnimationFrame(drawEffects);
  else {animation=0;ctx.clearRect(0,0,width,height);}
}
function clearEffects() {
  particles=[];cancelAnimationFrame(animation);animation=0;ctx.clearRect(0,0,width,height);
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
  else tracking('Gestures paused. Tap a move.');
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
