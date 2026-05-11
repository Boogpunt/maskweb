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
  };

  if (v.currentTime === 0) {
    startPlay();
  } else {
    v.addEventListener('seeked', startPlay, { once: true });
    v.currentTime = 0;
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
const FACE_KPS  = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
const UPPER_KPS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder'];
const BRACKET   = 18;
const BRACKET_W = 1.5;

function drawDetectionOverlay() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  detectionCtx.clearRect(0, 0, W, H);

  // ── Large mask number — top right ────────────────────────────────────────
  const maskLabel = String(currentMaskIndex + 1).padStart(2, '0');
  detectionCtx.font = '400 96px apotek, serif';
  detectionCtx.fillStyle = 'rgba(255,255,255,0.18)';
  detectionCtx.textAlign = 'right';
  detectionCtx.textBaseline = 'top';
  detectionCtx.fillText(maskLabel, W - 28, 20);

  if (!poses.length) return;

  // ml5 returns keypoints in CSS pixel space (WEBCAM_W × WEBCAM_H)
  const scaleX = W / WEBCAM_W;
  const scaleY = H / WEBCAM_H;

  // ── Observer list — top left ──────────────────────────────────────────────
  const PILL_H    = 24;
  const PILL_PAD  = 10;
  const LINE_MAX  = 120;
  const LINE_GAP  = 12;   // gap between pill and line
  const ARROWHEAD = 6;
  const ROW_GAP   = 10;
  const START_X   = 24;
  const START_Y   = 24;

  detectionCtx.textAlign    = 'left';
  detectionCtx.textBaseline = 'middle';
  detectionCtx.font         = '400 11px apotek, -apple-system, sans-serif';

  poses.forEach((pose, i) => {
    // Face keypoints for confidence display (low threshold)
    const facePts = pose.keypoints.filter(k => FACE_KPS.includes(k.name) && k.confidence > 0.05);
    const conf = facePts.length
      ? facePts.reduce((s, k) => s + k.confidence, 0) / facePts.length
      : 0;
    const confPct = Math.round(conf * 100);

    const row_y = START_Y + i * (PILL_H + ROW_GAP) + PILL_H / 2;

    // Pill background
    const label  = `Observer ${i + 1}`;
    const tw     = detectionCtx.measureText(label).width;
    const pill_w = tw + PILL_PAD * 2;

    detectionCtx.fillStyle = 'rgba(30,30,30,0.72)';
    detectionCtx.strokeStyle = 'rgba(255,255,255,0.14)';
    detectionCtx.lineWidth = 1;
    detectionCtx.beginPath();
    detectionCtx.roundRect(START_X, row_y - PILL_H / 2, pill_w, PILL_H, 6);
    detectionCtx.fill();
    detectionCtx.stroke();

    // Pill text
    detectionCtx.fillStyle = '#fff';
    detectionCtx.fillText(label, START_X + PILL_PAD, row_y);

    // Confidence line — scaled to confPct
    const lineStart = START_X + pill_w + LINE_GAP;
    const lineLen   = Math.round((confPct / 100) * LINE_MAX);
    const lineEnd   = lineStart + lineLen;

    detectionCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    detectionCtx.lineWidth   = 1.5;
    detectionCtx.beginPath();
    detectionCtx.moveTo(lineStart, row_y);
    detectionCtx.lineTo(lineEnd,  row_y);
    detectionCtx.stroke();

    // Arrowhead
    detectionCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    detectionCtx.lineWidth   = 1.5;
    detectionCtx.beginPath();
    detectionCtx.moveTo(lineEnd - ARROWHEAD, row_y - ARROWHEAD / 2);
    detectionCtx.lineTo(lineEnd, row_y);
    detectionCtx.lineTo(lineEnd - ARROWHEAD, row_y + ARROWHEAD / 2);
    detectionCtx.stroke();

    // Percentage text
    detectionCtx.fillStyle    = 'rgba(255,255,255,0.55)';
    detectionCtx.font         = '400 10px apotek, -apple-system, sans-serif';
    detectionCtx.fillText(`${confPct} %`, lineEnd + 8, row_y);
    detectionCtx.font         = '400 11px apotek, -apple-system, sans-serif';

    // ── L-bracket corners around face box ──────────────────────────────────
    {
      let bx, by, bw, bh;
      const MIN_BOX = Math.min(W, H) * 0.22;  // minimum box size

      if (facePts.length >= 2) {
        // Use face keypoints
        const xs = facePts.map(k => k.x * scaleX);
        const ys = facePts.map(k => k.y * scaleY);
        const x1 = Math.min(...xs), x2 = Math.max(...xs);
        const y1 = Math.min(...ys), y2 = Math.max(...ys);
        const padX = Math.max((x2 - x1) * 0.25, MIN_BOX * 0.2);
        const padY = Math.max((y2 - y1) * 0.65, MIN_BOX * 0.4);
        bx = x1 - padX;
        by = y1 - padY;
        bw = Math.max((x2 - x1) + padX * 2, MIN_BOX);
        bh = Math.max((y2 - y1) + padY * 2, MIN_BOX * 1.2);
      } else {
        // Fallback: estimate head position from shoulders
        const ls = pose.keypoints.find(k => k.name === 'left_shoulder'  && k.confidence > 0.1);
        const rs = pose.keypoints.find(k => k.name === 'right_shoulder' && k.confidence > 0.1);
        const nose = pose.keypoints.find(k => k.name === 'nose' && k.confidence > 0.03);
        if (!ls && !rs && !nose) return;

        let midX, midY, boxW;
        if (ls && rs) {
          midX  = ((ls.x + rs.x) / 2) * scaleX;
          midY  = ((ls.y + rs.y) / 2) * scaleY;
          boxW  = Math.max(Math.abs(rs.x - ls.x) * scaleX * 1.1, MIN_BOX);
        } else if (nose) {
          midX  = nose.x * scaleX;
          midY  = nose.y * scaleY;
          boxW  = MIN_BOX;
        } else {
          return;
        }
        bw = boxW;
        bh = boxW * 1.3;
        bx = midX - bw / 2;
        by = (ls && rs) ? midY - bh * 1.5 : midY - bh * 0.4;
      }

      detectionCtx.strokeStyle = 'rgba(255,255,255,0.7)';
      detectionCtx.lineWidth   = BRACKET_W;
      detectionCtx.lineCap     = 'square';

      // top-left
      detectionCtx.beginPath();
      detectionCtx.moveTo(bx,            by + BRACKET);
      detectionCtx.lineTo(bx,            by);
      detectionCtx.lineTo(bx + BRACKET,  by);
      detectionCtx.stroke();

      // top-right
      detectionCtx.beginPath();
      detectionCtx.moveTo(bx + bw - BRACKET, by);
      detectionCtx.lineTo(bx + bw,           by);
      detectionCtx.lineTo(bx + bw,           by + BRACKET);
      detectionCtx.stroke();

      // bottom-right
      detectionCtx.beginPath();
      detectionCtx.moveTo(bx + bw,           by + bh - BRACKET);
      detectionCtx.lineTo(bx + bw,           by + bh);
      detectionCtx.lineTo(bx + bw - BRACKET, by + bh);
      detectionCtx.stroke();

      // bottom-left
      detectionCtx.beginPath();
      detectionCtx.moveTo(bx + BRACKET, by + bh);
      detectionCtx.lineTo(bx,           by + bh);
      detectionCtx.lineTo(bx,           by + bh - BRACKET);
      detectionCtx.stroke();
    }
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
