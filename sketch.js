// ─── Config ───────────────────────────────────────────────────────────────────
const WEBCAM_SCALE      = 0.6;   // processing resolution as fraction of screen (CSS stretches to fullscreen)
const PLAYBACK_RATE     = 1.0;   // video speed (0.5 = half, 2.0 = double)
const VIGNETTE_STRENGTH = 0.6; // vignette edge darkening (0 = off, higher = stronger)

// ─── Dynamic webcam dimensions ────────────────────────────────────────────────
let WEBCAM_W = Math.round(window.innerWidth  * WEBCAM_SCALE);
let WEBCAM_H = Math.round(window.innerHeight * WEBCAM_SCALE);

// ─── State ────────────────────────────────────────────────────────────────────
let capture;
let bodyPose;
let poses = [];

let currentMaskNum    = 1;     // 1-indexed: which mask state we're in (1, 2, or 3)
let maskIsPlaying     = false;
let prevObserverCount = -1;
let activeElement     = null;  // currently visible element (video paused at last frame, or reverse canvas)
let textLog           = [];    // accumulated message log (newest last)

const reverseCanvas = document.getElementById('reverse-canvas');
const reverseCtx    = reverseCanvas.getContext('2d');

const transVideos = {};
[[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[1,0],[2,0],[3,0]].forEach(([f,t]) => {
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

    bodyPose = ml5.bodyPose('MoveNet', { flipped: false, minPoseScore: 0.15 }, () => {
      bodyPose.detectStart(offscreen, onPoses); // use already-transformed canvas → coords match display directly
    });
  };

  p.draw = function () {
    drawWebcamPreview();
    drawDetectionOverlay();
  };

  p.windowResized = function () {
    WEBCAM_W = Math.round(window.innerWidth  * WEBCAM_SCALE);
    WEBCAM_H = Math.round(window.innerHeight * WEBCAM_SCALE);
    applyCanvasSize();
    if (capture) capture.size(WEBCAM_W, WEBCAM_H);
  };

});

// ─── Pose callback ────────────────────────────────────────────────────────────
const MASK_TEXTS = [
  { heading: "When I'm with my close friend",            desc: "I can show my negative aspects to them. Keep blaming world." },
  { heading: "When I'm with my business client",         desc: "I try to show me as a professional person. Be smart, act like a person who have a vision." },
  { heading: "When I'm surrounded with lots of people",  desc: "I have to show me as a positive person. Keep listening what people said and let them do it" },
];

function onPoses(results) {
  poses = results;
  const count = poses.length;

  if (count !== prevObserverCount) {
    prevObserverCount = count;
    const targetNum = Math.min(count, 3);  // 0, 1, 2, or 3
    if (targetNum !== currentMaskNum) {
      tryTransition(currentMaskNum, targetNum);
    }
  }
}

// ─── Reverse playback — seeks mask_X_0 from end to start, draws frames to canvas ──
function playVideoReverse(video, onComplete) {
  reverseCanvas.width  = window.innerWidth;
  reverseCanvas.height = window.innerHeight;

  const STEP = 1 / 30;

  function tick() {
    const next = video.currentTime - STEP;
    if (next <= 0) {
      reverseCtx.drawImage(video, 0, 0, reverseCanvas.width, reverseCanvas.height);
      onComplete();
      return;
    }
    video.currentTime = next;
    video.addEventListener('seeked', () => {
      reverseCtx.drawImage(video, 0, 0, reverseCanvas.width, reverseCanvas.height);
      requestAnimationFrame(tick);
    }, { once: true });
  }

  const start = () => {
    video.currentTime = video.duration;
    video.addEventListener('seeked', () => {
      reverseCtx.drawImage(video, 0, 0, reverseCanvas.width, reverseCanvas.height);
      requestAnimationFrame(tick);
    }, { once: true });
  };

  if (video.readyState >= 1) {
    start();
  } else {
    video.addEventListener('loadedmetadata', start, { once: true });
  }
}

// ─── Mask video control ───────────────────────────────────────────────────────
function tryTransition(fromNum, toNum) {
  if (maskIsPlaying) return;
  maskIsPlaying = true;

  // 0 → N: reverse-play mask_N_0
  if (fromNum === 0) {
    const tv = transVideos[`${toNum}_0`];
    if (!tv) { currentMaskNum = toNum; maskIsPlaying = false; return; }

    if (activeElement) activeElement.classList.remove('active');
    reverseCanvas.classList.add('active');

    playVideoReverse(tv, () => {
      activeElement  = reverseCanvas;
      currentMaskNum = toNum;
      addTextLogEntry(toNum - 1);
      maskIsPlaying  = false;
    });
    return;
  }

  // N → M  or  N → 0: forward-play mask_N_M
  const tv = transVideos[`${fromNum}_${toNum}`];
  if (!tv) { maskIsPlaying = false; return; }

  tv.playbackRate = PLAYBACK_RATE;

  const startTrans = () => {
    if (activeElement && activeElement !== tv) activeElement.classList.remove('active');
    tv.classList.add('active');
    tv.play().catch(() => {});
  };

  tv.addEventListener('ended', () => {
    activeElement  = tv;  // leave visible, paused at last frame
    currentMaskNum = toNum;
    if (toNum > 0) addTextLogEntry(toNum - 1);
    maskIsPlaying = false;
  }, { once: true });

  if (tv.currentTime === 0) {
    startTrans();
  } else {
    tv.addEventListener('seeked', startTrans, { once: true });
    tv.currentTime = 0;
  }
}

function addTextLogEntry(maskIndex) {
  const t = MASK_TEXTS[maskIndex % MASK_TEXTS.length];
  textLog.push({ num: String(textLog.length + 1).padStart(2, '0'), heading: t.heading, desc: t.desc });
  if (textLog.length > 5) textLog = textLog.slice(-5);
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
  const FS  = 12;
  const LH  = 17;
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
    detectionCtx.fillStyle = `rgba(255,255,255,${labelOp})`;
    detectionCtx.fillText(label, TX, ty);
    detectionCtx.fillStyle = `rgba(255,255,255,${valueOp})`;
    detectionCtx.fillText(value, COL2, ty);
    ty += LH;
  }

  statusRow('mask',      maskLabel,          0.45, 0.9);
  statusRow('video',     maskIsPlaying ? 'playing' : 'idle', 0.45, maskIsPlaying ? 0.9 : 0.4);
  statusRow('observers', String(poses.length), 0.45, 0.9);

  poses.forEach((pose, i) => {
    const fpts = pose.keypoints.filter(k => FACE_KPS.includes(k.name) && k.confidence > 0.05);
    const conf = fpts.length ? fpts.reduce((s, k) => s + k.confidence, 0) / fpts.length : 0;
    const pct  = Math.round(conf * 100);
    statusRow(`  observer_${String(i + 1).padStart(2, '0')}`, `${pct} %`, 0.4, 0.85);
  });

  // ── Bottom-left text log ───────────────────────────────────────────────────
  if (textLog.length > 0) {
    const LX        = PAD + 2;
    const LOG_BOT   = H - PAD - 4;
    const ELH       = 15;
    const ENTRY_GAP = 10;
    const OPACITIES = [1.0, 0.42, 0.18, 0.08, 0.04];

    detectionCtx.textAlign    = 'left';
    detectionCtx.textBaseline = 'bottom';

    for (let age = 0; age < textLog.length; age++) {
      const e   = textLog[textLog.length - 1 - age];
      const op  = OPACITIES[age] ?? 0.03;
      const bot = LOG_BOT - age * (ELH * 2 + 3 + ENTRY_GAP);

      detectionCtx.font      = `400 ${FS}px 'Chakra Petch', sans-serif`;
      detectionCtx.fillStyle = `rgba(255,255,255,${op})`;
      detectionCtx.fillText(`  ${e.desc}`, LX, bot);
      detectionCtx.fillText(`[${e.num}] ${e.heading}`, LX, bot - ELH - 2);
    }
  }

  // ── Face detection boxes ───────────────────────────────────────────────────
  if (!poses.length) return;

  // offscreen canvas is already cover-cropped + mirrored → coords map directly to screen
  const toSX = k => k.x * W / WEBCAM_W;
  const toSY = k => k.y * H / WEBCAM_H;

  detectionCtx.strokeStyle = 'rgba(255,255,255,0.75)';
  detectionCtx.lineWidth   = 1.5;

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

    // Rounded detection box
    detectionCtx.beginPath();
    detectionCtx.roundRect(bx, by, bw, bh, 10);
    detectionCtx.stroke();

    // Observer label below box
    detectionCtx.font         = `400 ${FS}px 'Chakra Petch', sans-serif`;
    detectionCtx.fillStyle    = 'rgba(255,255,255,0.6)';
    detectionCtx.textAlign    = 'left';
    detectionCtx.textBaseline = 'top';
    detectionCtx.fillText(`observer_${String(i + 1).padStart(2, '0')}`, bx, by + bh + 4);
  });
}

