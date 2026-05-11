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

let currentMaskIndex  = 0;
let maskIsPlaying     = false;
let prevObserverCount = -1;    // triggers next video when observer count changes
let textLog           = [];    // accumulated message log (newest last)

const maskVideos = [
  document.getElementById('mask1'),
  document.getElementById('mask2'),
  document.getElementById('mask3'),
];

const webcamContainer    = document.getElementById('webcam-container');
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

// ─── Mask video setup ─────────────────────────────────────────────────────────

// Show first frame of mask1 on load
maskVideos[0].addEventListener('loadeddata', () => {
  maskVideos[0].currentTime = 0;
  maskVideos[0].pause();
}, { once: true });

// When a video finishes, allow next trigger
maskVideos.forEach(v => {
  v.addEventListener('ended', () => {
    maskIsPlaying = false;
  });
});

// ─── p5 sketch ────────────────────────────────────────────────────────────────
new p5(function (p) {

  p.setup = function () {
    let canvas = p.createCanvas(1, 1);
    canvas.hide();

    applyCanvasSize();

    capture = p.createCapture({ video: { facingMode: 'user', width: { ideal: WEBCAM_W }, height: { ideal: WEBCAM_H } }, audio: false });
    capture.size(WEBCAM_W, WEBCAM_H);
    capture.hide();

    showMask(0);
    setStatus('Loading model…');

    bodyPose = ml5.bodyPose('MoveNet', { flipped: true }, () => {
      setStatus('Ready — show yourself');
      bodyPose.detectStart(capture, onPoses);
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
const OBSERVER_MESSAGES = {
  0: "When i'm alone",
  1: "When I'm with my lover",
  2: "When i'm with my besties",
  3: "When i'm with my client",
};

const MASK_TEXTS = [
  { heading: "When I'm with my close friend",            desc: "I can show my negative aspects to them. Keep blaming world." },
  { heading: "When I'm with my business client",         desc: "I try to show me as a professional person. Be smart, act like a person who have a vision." },
  { heading: "When I'm surrounded with lots of people",  desc: "I have to show me as a positive person. Keep listening what people said and let them do it" },
];

function onPoses(results) {
  poses = results;
  const count = poses.length;

  webcamContainer.classList.toggle('detected', count > 0);

  if (count !== prevObserverCount) {
    prevObserverCount = count;
    tryAdvanceMask();
  }

  updateBottomBar(count);
}

function updateBottomBar(count) {
  const leftEl  = document.getElementById('bottom-left');
  const rightEl = document.getElementById('bottom-right');

  leftEl.textContent = count === 0 ? 'Observer (0)' : `Observer (${count})`;
  rightEl.textContent = OBSERVER_MESSAGES[Math.min(count, 3)] ?? '';
}

// ─── Mask video control ───────────────────────────────────────────────────────
function showMask(index) {
  maskVideos.forEach((v, i) => {
    v.classList.toggle('active', i === index);
    if (i !== index) v.pause();
  });
}

function tryAdvanceMask() {
  if (maskIsPlaying) return;

  currentMaskIndex = (currentMaskIndex + 1) % maskVideos.length;
  maskIsPlaying = true;

  const v = maskVideos[currentMaskIndex];
  v.playbackRate = PLAYBACK_RATE;

  // Seek to frame 0 while still hidden, show + play only after seek is ready
  const startPlay = () => {
    showMask(currentMaskIndex);
    v.play().catch(() => {});
    setStatus(`Playing mask ${currentMaskIndex + 1}`);
    addTextLogEntry(currentMaskIndex);
  };

  if (v.currentTime === 0) {
    startPlay();
  } else {
    v.addEventListener('seeked', startPlay, { once: true });
    v.currentTime = 0;
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
const FACE_KPS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
const BRACKET_W = 1.5;

function lb(x, y, dx, dy, arm) {
  detectionCtx.beginPath();
  detectionCtx.moveTo(x + dx * arm, y);
  detectionCtx.lineTo(x, y);
  detectionCtx.lineTo(x, y + dy * arm);
  detectionCtx.stroke();
}

function drawDetectionOverlay() {
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  const PAD = 24;
  const ARM_SCREEN = 28;
  const ARM_FACE   = 20;
  detectionCtx.clearRect(0, 0, W, H);

  // ── Screen-corner L-brackets (always visible) ────────────────────────────
  detectionCtx.strokeStyle = 'rgba(255,255,255,0.55)';
  detectionCtx.lineWidth   = 1.5;
  detectionCtx.lineCap     = 'square';
  lb(PAD,   PAD,    1,  1, ARM_SCREEN);
  lb(W-PAD, PAD,   -1,  1, ARM_SCREEN);
  lb(W-PAD, H-PAD, -1, -1, ARM_SCREEN);
  lb(PAD,   H-PAD,  1, -1, ARM_SCREEN);

  // ── Mask number — top left ────────────────────────────────────────────────
  const NUM_SIZE  = 88;
  const NUM_X     = PAD + 6;
  const NUM_Y     = PAD + 2;
  const maskLabel = String(currentMaskIndex + 1).padStart(2, '0');
  detectionCtx.font         = `200 ${NUM_SIZE}px apotek, sans-serif`;
  detectionCtx.fillStyle    = 'rgba(255,255,255,0.9)';
  detectionCtx.textAlign    = 'left';
  detectionCtx.textBaseline = 'top';
  detectionCtx.fillText(maskLabel, NUM_X, NUM_Y);
  const numW = detectionCtx.measureText(maskLabel).width;

  // ── Observer list — right of number ──────────────────────────────────────
  if (poses.length > 0) {
    const OBS_X    = NUM_X + numW + 16;
    const OBS_Y    = NUM_Y + 8;
    const PILL_H   = 22;
    const ROW_GAP  = 7;
    const PILL_PAD = 8;
    const LINE_MAX = Math.min(160, W - OBS_X - 55);
    const ARR      = 5;

    detectionCtx.textBaseline = 'middle';

    poses.forEach((pose, i) => {
      const fpts   = pose.keypoints.filter(k => FACE_KPS.includes(k.name) && k.confidence > 0.05);
      const conf   = fpts.length ? fpts.reduce((s, k) => s + k.confidence, 0) / fpts.length : 0;
      const pct    = Math.round(conf * 100);
      const row_y  = OBS_Y + i * (PILL_H + ROW_GAP) + PILL_H / 2;
      const label  = `Observer ${i + 1}`;

      detectionCtx.font = `200 11px apotek, sans-serif`;
      const pill_w = detectionCtx.measureText(label).width + PILL_PAD * 2;

      // Pill (outline only)
      detectionCtx.strokeStyle = 'rgba(255,255,255,0.65)';
      detectionCtx.lineWidth   = 1;
      detectionCtx.beginPath();
      detectionCtx.roundRect(OBS_X, row_y - PILL_H / 2, pill_w, PILL_H, 4);
      detectionCtx.stroke();

      detectionCtx.fillStyle = 'rgba(255,255,255,0.9)';
      detectionCtx.textAlign = 'left';
      detectionCtx.fillText(label, OBS_X + PILL_PAD, row_y);

      // Confidence line + arrowhead
      const lx0 = OBS_X + pill_w + 9;
      const lx1 = lx0 + Math.round((pct / 100) * LINE_MAX);
      detectionCtx.strokeStyle = 'rgba(255,255,255,0.65)';
      detectionCtx.lineWidth   = 1.5;
      detectionCtx.beginPath(); detectionCtx.moveTo(lx0, row_y); detectionCtx.lineTo(lx1, row_y); detectionCtx.stroke();
      detectionCtx.beginPath();
      detectionCtx.moveTo(lx1 - ARR, row_y - ARR / 2);
      detectionCtx.lineTo(lx1, row_y);
      detectionCtx.lineTo(lx1 - ARR, row_y + ARR / 2);
      detectionCtx.stroke();

      // Percentage
      detectionCtx.fillStyle = 'rgba(255,255,255,0.6)';
      detectionCtx.font      = `200 10px apotek, sans-serif`;
      detectionCtx.fillText(String(pct).padStart(2, '0') + ' %', lx1 + 7, row_y);
    });
  }

  // ── Bottom-left text log ──────────────────────────────────────────────────
  if (textLog.length > 0) {
    const LOG_X      = PAD + 6;
    const LOG_BOT    = H - PAD - 6;
    const LINE_H     = 15;
    const ENTRY_H    = LINE_H * 2 + 3;
    const ENTRY_GAP  = 10;
    const OPACITIES  = [1.0, 0.42, 0.18, 0.08, 0.04];

    detectionCtx.textAlign    = 'left';
    detectionCtx.textBaseline = 'bottom';

    const n = textLog.length;
    for (let age = 0; age < n; age++) {
      const e    = textLog[n - 1 - age];
      const op   = OPACITIES[age] ?? 0.03;
      const bot  = LOG_BOT - age * (ENTRY_H + ENTRY_GAP);

      detectionCtx.fillStyle = `rgba(255,255,255,${op})`;
      detectionCtx.font      = `200 11px apotek, sans-serif`;
      detectionCtx.fillText(`- ${e.desc}`, LOG_X + 10, bot);
      detectionCtx.fillText(`${e.num}  ${e.heading}`, LOG_X, bot - LINE_H - 2);
    }
  }

  // ── Face detection L-brackets ─────────────────────────────────────────────
  if (!poses.length) return;

  const srcW    = (capture && capture.elt.videoWidth)  || WEBCAM_W;
  const srcH    = (capture && capture.elt.videoHeight) || WEBCAM_H;
  const needSwap = (srcW > srcH) && (W < H);
  const scaleX  = needSwap ? W / srcH : W / WEBCAM_W;
  const scaleY  = needSwap ? H / srcW : H / WEBCAM_H;
  const toSX    = needSwap ? k => k.y * scaleX          : k => k.x * scaleX;
  const toSY    = needSwap ? k => (srcW - k.x) * scaleY : k => k.y * scaleY;

  detectionCtx.strokeStyle = 'rgba(255,255,255,0.7)';
  detectionCtx.lineWidth   = BRACKET_W;
  detectionCtx.lineCap     = 'square';

  poses.forEach(pose => {
    const fpts = pose.keypoints.filter(k => FACE_KPS.includes(k.name) && k.confidence > 0.05);
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

    lb(bx,      by,      1,  1, ARM_FACE);
    lb(bx + bw, by,     -1,  1, ARM_FACE);
    lb(bx + bw, by + bh, -1, -1, ARM_FACE);
    lb(bx,      by + bh,  1, -1, ARM_FACE);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const statusLog = document.getElementById('status-log');
const LOG_MAX   = 5;

let _lastStatus = '';
function setStatus(msg) {
  if (msg === _lastStatus) return;
  _lastStatus = msg;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = msg;
  statusLog.appendChild(entry);

  while (statusLog.children.length > LOG_MAX) {
    statusLog.removeChild(statusLog.firstChild);
  }
}
