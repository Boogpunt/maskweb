// ─── Config ───────────────────────────────────────────────────────────────────
const WEBCAM_SCALE      = 0.6;   // processing resolution as fraction of screen (CSS stretches to fullscreen)
const PLAYBACK_RATE     = 1.0;   // video speed (0.5 = half, 2.0 = double)
const VIGNETTE_STRENGTH = 0.6;   // vignette edge darkening (0 = off, higher = stronger)
const DETECT_INTERVAL   = 6;     // run pose detection every N draw frames
const STABLE_FRAMES     = 5;     // consecutive detections (× DETECT_INTERVAL frames) before triggering
const BOX_SMOOTH        = 0.2;   // EMA factor for box position (lower = smoother)
const TEXT_DELAY_MS     = 1500;  // ms after video starts before bottom text updates

// ─── Dynamic webcam dimensions ────────────────────────────────────────────────
let WEBCAM_W = Math.round(window.innerWidth  * WEBCAM_SCALE);
let WEBCAM_H = Math.round(window.innerHeight * WEBCAM_SCALE);

// ─── State ────────────────────────────────────────────────────────────────────
let capture;
let bodyPose;
let poses = [];

let currentMaskNum    = 0;     // 0 = blank, 1-3 = mask state
let maskIsPlaying     = false;
let activeElement     = null;  // currently visible video, paused at last frame

let candidateCount    = -1;   // raw count currently being observed
let stableFrames      = 0;    // consecutive detections candidateCount has held
let modelReady        = false;
let detectReady       = true;
let framesSinceDetect = 0;
let smoothedBoxes     = [];   // per-observer EMA-smoothed { bx, by, bw, bh }
let trackedPoses      = [];   // previous-frame poses used for stable ordering

const transVideos = {};
[[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[1,0],[2,0],[3,0],[0,1],[0,2],[0,3]].forEach(([f,t]) => {
  transVideos[`${f}_${t}`] = document.getElementById(`trans_${f}_${t}`);
});

const webcamCanvas       = document.getElementById('webcam-canvas');
const webcamCtx          = webcamCanvas.getContext('2d');
const detectionCanvas    = document.getElementById('detection-overlay');
const detectionCtx       = detectionCanvas.getContext('2d');

const offscreen = document.createElement('canvas');
const offCtx    = offscreen.getContext('2d', { willReadFrequently: true });

function applyCanvasSize() {
  const dpr = window.devicePixelRatio || 1;

  webcamCanvas.width      = WEBCAM_W;
  webcamCanvas.height     = WEBCAM_H;
  offscreen.width         = WEBCAM_W;
  offscreen.height        = WEBCAM_H;

  detectionCanvas.width         = Math.round(window.innerWidth  * dpr);
  detectionCanvas.height        = Math.round(window.innerHeight * dpr);
  detectionCanvas.style.width   = window.innerWidth  + 'px';
  detectionCanvas.style.height  = window.innerHeight + 'px';
  detectionCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─── p5 sketch ────────────────────────────────────────────────────────────────
new p5(function (p) {

  p.setup = function () {
    let canvas = p.createCanvas(1, 1);
    canvas.hide();

    applyCanvasSize();

    capture = p.createCapture({ video: { facingMode: 'user' }, audio: false });
    capture.size(WEBCAM_W, WEBCAM_H);
    capture.hide();

    bodyPose = ml5.bodyPose('MoveNet', { flipped: false, minPoseScore: 0.4 }, () => {
      modelReady = true;
    });
  };

  p.draw = function () {
    drawWebcamPreview();
    drawDetectionOverlay();

    if (modelReady && detectReady) {
      framesSinceDetect++;
      if (framesSinceDetect >= DETECT_INTERVAL) {
        framesSinceDetect = 0;
        detectReady = false;
        bodyPose.detect(offscreen, (results) => {
          onPoses(results);
          detectReady = true;
        });
      }
    }
  };

  p.windowResized = function () {
    WEBCAM_W = Math.round(window.innerWidth  * WEBCAM_SCALE);
    WEBCAM_H = Math.round(window.innerHeight * WEBCAM_SCALE);
    applyCanvasSize();
    if (capture) capture.size(WEBCAM_W, WEBCAM_H);
  };

});

// ─── Typewriter ───────────────────────────────────────────────────────────────
function typewrite(el, text, speed = 38) {
  if (el._tw) { clearTimeout(el._tw); }
  el.textContent = '';
  let i = 0;
  (function step() {
    if (i < text.length) { el.textContent += text[i++]; el._tw = setTimeout(step, speed); }
  })();
}

// ─── Messages ─────────────────────────────────────────────────────────────────
const OBSERVER_MESSAGES = [
  'Evangelion - Tsubasa wo Kudasai',
  'Franco Micalizzi: Stridulum - Sadness Theme',
  'Fred again.. feat. The Blessed Madonna - Marea',
  'Jai Paul - Jasmine (Demo)',
];
const msgCombined       = document.getElementById('msg-combined');
const zeroMsg           = document.getElementById('zero-msg');
const bgLayer           = document.getElementById('bg-layer');
let   _textTimer        = null;
let   _zeroTimer        = null;

function updateBottomText(toNum) {
  const newMsg = OBSERVER_MESSAGES[toNum];
  if (msgCombined.dataset.target === newMsg) return;
  msgCombined.dataset.target = newMsg;
  typewrite(msgCombined, newMsg);
}

// Initialize on load with observer-0 message
updateBottomText(0);

// ─── Pose callback ────────────────────────────────────────────────────────────

function deduplicatePoses(results) {
  // Sort highest-confidence first, then drop any pose whose nose is too close to an already-kept one
  const MIN_DIST = Math.min(WEBCAM_W, WEBCAM_H) * 0.3;
  const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept = [];
  for (const pose of sorted) {
    const nose = pose.keypoints.find(k => k.name === 'nose' && k.confidence > 0.1);
    if (nose) {
      const isDup = kept.some(p => {
        const n = p.keypoints.find(k => k.name === 'nose');
        if (!n) return false;
        const dx = nose.x - n.x, dy = nose.y - n.y;
        return Math.sqrt(dx * dx + dy * dy) < MIN_DIST;
      });
      if (isDup) continue;
    }
    kept.push(pose);
  }
  return kept;
}

function stableOrderPoses(newPoses) {
  if (!trackedPoses.length) return newPoses;
  const MATCH_DIST = Math.min(WEBCAM_W, WEBCAM_H) * 0.4;
  const used = new Array(newPoses.length).fill(false);
  const result = [];
  for (const prev of trackedPoses) {
    const pn = prev.keypoints.find(k => k.name === 'nose' && k.confidence > 0.05);
    let bestIdx = -1, bestDist = MATCH_DIST;
    for (let j = 0; j < newPoses.length; j++) {
      if (used[j]) continue;
      const nn = newPoses[j].keypoints.find(k => k.name === 'nose' && k.confidence > 0.05);
      if (!pn || !nn) continue;
      const dx = pn.x - nn.x, dy = pn.y - nn.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    if (bestIdx >= 0) { used[bestIdx] = true; result.push(newPoses[bestIdx]); }
  }
  newPoses.forEach((p, j) => { if (!used[j]) result.push(p); });
  return result;
}

function onPoses(results) {
  const deduped = deduplicatePoses(results);
  poses = stableOrderPoses(deduped);
  trackedPoses = poses;
  const raw = Math.min(poses.length, 3);

  if (raw === candidateCount) {
    stableFrames++;
  } else {
    candidateCount = raw;
    stableFrames   = 1;
  }

  const isZero = poses.length === 0;
  bgLayer.style.opacity = isZero ? '0' : '1';
  if (isZero && zeroMsg.dataset.showing !== '1') {
    zeroMsg.dataset.showing = '1';
    if (!_zeroTimer) {
      _zeroTimer = setTimeout(() => {
        _zeroTimer = null;
        zeroMsg.style.opacity = '1';
        typewrite(zeroMsg, 'Then, Who are you when no one is watching', 60);
      }, 1000);
    }
  } else if (!isZero && zeroMsg.dataset.showing === '1') {
    zeroMsg.dataset.showing = '0';
    if (_zeroTimer) { clearTimeout(_zeroTimer); _zeroTimer = null; }
    zeroMsg.style.opacity = '0';
  }

  if (stableFrames >= STABLE_FRAMES && raw !== currentMaskNum) {
    stableFrames = 0;  // reset so we don't spam tryTransition while maskIsPlaying blocks
    tryTransition(currentMaskNum, raw);
  }
}

// ─── Video lazy loading ───────────────────────────────────────────────────────
function preloadFrom(fromNum) {
  [0, 1, 2, 3].filter(n => n !== fromNum).forEach(toNum => {
    const tv = transVideos[`${fromNum}_${toNum}`];
    if (tv && tv.readyState === 0) { tv.preload = 'auto'; tv.load(); }
  });
}
preloadFrom(0);  // on startup, only load transitions from initial state

// ─── Mask video control ───────────────────────────────────────────────────────
function tryTransition(fromNum, toNum) {
  if (maskIsPlaying) return;
  maskIsPlaying = true;

  const tv = transVideos[`${fromNum}_${toNum}`];
  if (!tv) { maskIsPlaying = false; return; }

  tv.playbackRate = PLAYBACK_RATE;

  const startTrans = () => {
    if (activeElement && activeElement !== tv) activeElement.classList.remove('active');
    tv.classList.add('active');
    tv.play().catch(() => {
      // play() rejected — restore previous visual state and unlock
      tv.classList.remove('active');
      if (activeElement) activeElement.classList.add('active');
      maskIsPlaying = false;
    });

    if (_textTimer) { clearTimeout(_textTimer); _textTimer = null; }
    _textTimer = setTimeout(() => updateBottomText(toNum), TEXT_DELAY_MS);
  };

  tv.addEventListener('ended', () => {
    activeElement  = tv;  // leave visible, paused at last frame
    currentMaskNum = toNum;
    maskIsPlaying  = false;
    preloadFrom(toNum);  // preload next possible transitions
  }, { once: true });

  if (tv.currentTime === 0) {
    startTrans();
  } else {
    // On iOS, 'seeked' can silently not fire — fall back after 1.5s
    let seekTimer;
    const onSeeked = () => { clearTimeout(seekTimer); startTrans(); };
    tv.addEventListener('seeked', onSeeked, { once: true });
    seekTimer = setTimeout(() => {
      tv.removeEventListener('seeked', onSeeked);
      startTrans();
    }, 1500);
    tv.currentTime = 0;
  }
}

// ─── Webcam preview draw — grayscale invert + vignette ───────────────────────
function drawWebcamPreview() {
  if (!capture || !capture.elt) return;

  // Draw mirrored frame to offscreen — cover crop to preserve aspect ratio
  const srcW = capture.elt.videoWidth  || WEBCAM_W;
  const srcH = capture.elt.videoHeight || WEBCAM_H;
  const srcAspect = srcW / srcH;
  const dstAspect = WEBCAM_W / WEBCAM_H;
  let sx, sy, sw, sh;
  if (srcAspect > dstAspect) {
    sh = srcH; sw = srcH * dstAspect; sx = (srcW - sw) / 2; sy = 0;
  } else {
    sw = srcW; sh = srcW / dstAspect; sx = 0; sy = (srcH - sh) / 2;
  }
  offCtx.save();
  offCtx.scale(-1, 1);
  offCtx.drawImage(capture.elt, sx, sy, sw, sh, -WEBCAM_W, 0, WEBCAM_W, WEBCAM_H);
  offCtx.restore();

  const id = offCtx.getImageData(0, 0, WEBCAM_W, WEBCAM_H);
  const px = id.data;
  const cx = WEBCAM_W / 2;
  const cy = WEBCAM_H / 2;

  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;

    const idx = i >> 2;
    const dx = ((idx % WEBCAM_W) - cx) / cx;
    const dy = ((idx / WEBCAM_W | 0) - cy) / cy;
    const vignette = Math.max(0, 1 - (dx * dx + dy * dy) * VIGNETTE_STRENGTH);
    const gv = (g * vignette) | 0;

    px[i] = px[i + 1] = px[i + 2] = gv;
  }

  webcamCtx.putImageData(id, 0, 0);
}

// ─── Detection overlay — HUD design ──────────────────────────────────────────
const FACE_KPS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
                  'left_shoulder', 'right_shoulder'];
const BOX_KPS  = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];

function drawDetectionOverlay() {
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  const PAD = 20;
  const FS  = 14;
  const LH  = 20;
  detectionCtx.clearRect(0, 0, W, H);

  // ── Top-left status panel ──────────────────────────────────────────────────
  const TX = PAD + 2;
  let   ty = PAD + 2;
  const maskLabel = String(currentMaskNum).padStart(2, '0');

  detectionCtx.font         = `400 ${FS}px 'Chakra Petch', sans-serif`;
  detectionCtx.textAlign    = 'left';
  detectionCtx.textBaseline = 'top';

  const COL2 = TX + 120; // value column x

  function statusRow(label, value, labelOp, valueOp) {
    detectionCtx.fillStyle = `rgba(60,60,60,${labelOp})`;
    detectionCtx.fillText(label, TX, ty);
    detectionCtx.fillStyle = `rgba(60,60,60,${valueOp})`;
    detectionCtx.fillText(value, COL2, ty);
    ty += LH;
  }

  statusRow('mask',      maskLabel,          0.45, 0.9);
  statusRow('video',     maskIsPlaying ? 'playing' : 'idle', 0.45, maskIsPlaying ? 0.9 : 0.4);
  statusRow('observers', String(poses.length), 0.45, 0.9);

  const BAR_W = 80;
  const BAR_H = 3;
  poses.forEach((pose, i) => {
    const fpts = pose.keypoints.filter(k => FACE_KPS.includes(k.name) && k.confidence > 0.05);
    const conf = fpts.length ? fpts.reduce((s, k) => s + k.confidence, 0) / fpts.length : 0;

    detectionCtx.fillStyle = `rgba(60,60,60,0.4)`;
    detectionCtx.fillText(`  observer_${String(i + 1).padStart(2, '0')}`, TX, ty);

    const barX = COL2;
    const barY = ty + (LH - BAR_H) / 2;
    detectionCtx.fillStyle = 'rgba(60,60,60,0.12)';
    detectionCtx.fillRect(barX, barY, BAR_W, BAR_H);
    detectionCtx.fillStyle = 'rgba(60,60,60,0.8)';
    detectionCtx.fillRect(barX, barY, BAR_W * conf, BAR_H);

    ty += LH;
  });

  // ── Face detection boxes ───────────────────────────────────────────────────
  smoothedBoxes = smoothedBoxes.slice(0, poses.length);
  if (!poses.length) return;

  // offscreen canvas is already cover-cropped + mirrored → coords map directly to screen
  const toSX = k => k.x * W / WEBCAM_W;
  const toSY = k => k.y * H / WEBCAM_H;

  poses.forEach((pose, i) => {
    const fpts    = pose.keypoints.filter(k => BOX_KPS.includes(k.name) && k.confidence > 0.05);
    const MIN_BOX = Math.min(W, H) * 0.22;
    let bx, by, bw, bh;

    if (fpts.length >= 2) {
      const xs = fpts.map(toSX), ys = fpts.map(toSY);
      const x1 = Math.min(...xs), x2 = Math.max(...xs);
      const y1 = Math.min(...ys), y2 = Math.max(...ys);
      const px = Math.max((x2 - x1) * 0.25, MIN_BOX * 0.2);
      const py = Math.max((y2 - y1) * 0.65, MIN_BOX * 0.4);
      bx = x1 - px; by = y1 - py;
      bw = Math.max((x2 - x1) + px * 2, MIN_BOX);
      bh = Math.max((y2 - y1) + py * 2, MIN_BOX * 1.2);
    } else {
      const ls   = pose.keypoints.find(k => k.name === 'left_shoulder'  && k.confidence > 0.1);
      const rs   = pose.keypoints.find(k => k.name === 'right_shoulder' && k.confidence > 0.1);
      const nose = pose.keypoints.find(k => k.name === 'nose'           && k.confidence > 0.03);
      if (!ls && !rs && !nose) return;
      let midX, midY, boxW;
      if (ls && rs) {
        midX = (toSX(ls) + toSX(rs)) / 2; midY = (toSY(ls) + toSY(rs)) / 2;
        boxW = Math.max(Math.abs(toSX(rs) - toSX(ls)) * 1.1, MIN_BOX);
      } else {
        midX = toSX(nose); midY = toSY(nose); boxW = MIN_BOX;
      }
      bw = boxW; bh = boxW * 1.3;
      bx = midX - bw / 2;
      by = (ls && rs) ? midY - bh * 1.5 : midY - bh * 0.4;
    }

    // EMA smoothing
    if (!smoothedBoxes[i]) {
      smoothedBoxes[i] = { bx, by, bw, bh };
    } else {
      const s = smoothedBoxes[i];
      s.bx = BOX_SMOOTH * bx + (1 - BOX_SMOOTH) * s.bx;
      s.by = BOX_SMOOTH * by + (1 - BOX_SMOOTH) * s.by;
      s.bw = BOX_SMOOTH * bw + (1 - BOX_SMOOTH) * s.bw;
      s.bh = BOX_SMOOTH * bh + (1 - BOX_SMOOTH) * s.bh;
    }
    ({ bx, by, bw, bh } = smoothedBoxes[i]);

    // Rounded detection box
    detectionCtx.strokeStyle = 'rgba(60,60,60,0.75)';
    detectionCtx.lineWidth   = 1.5;
    detectionCtx.beginPath();
    detectionCtx.roundRect(bx, by, bw, bh, 10);
    detectionCtx.stroke();

    // Observer label below box
    detectionCtx.font         = `400 ${FS}px 'Chakra Petch', sans-serif`;
    detectionCtx.fillStyle    = 'rgba(60,60,60,0.6)';
    detectionCtx.textAlign    = 'left';
    detectionCtx.textBaseline = 'top';
    detectionCtx.fillText(`observer_${String(i + 1).padStart(2, '0')}`, bx, by + bh + 4);
  });
}

