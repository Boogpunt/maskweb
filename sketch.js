// ─── Config ───────────────────────────────────────────────────────────────────
const WEBCAM_RATIO      = 0.22;  // webcam preview = 22% of screen width
const NOISE_AMOUNT      = 18;    // film grain intensity (0 = off, higher = stronger)
const PLAYBACK_RATE     = 1.0;   // video speed (0.5 = half, 2.0 = double)
const VIGNETTE_STRENGTH = 0.6;  // vignette applied before invert (0 = off, higher = stronger)

// ─── Dynamic webcam dimensions ────────────────────────────────────────────────
let WEBCAM_W = Math.round(window.innerWidth * WEBCAM_RATIO);
let WEBCAM_H = Math.round(WEBCAM_W * (3 / 4));

// ─── State ────────────────────────────────────────────────────────────────────
let capture;
let bodyPose;
let poses = [];

let currentMaskIndex = 0;
let maskIsPlaying    = false;
let personWasAbsent  = false;   // true after person leaves; next appearance triggers next video

const maskVideos = [
  document.getElementById('mask1'),
  document.getElementById('mask2'),
  document.getElementById('mask3'),
];

const webcamContainer = document.getElementById('webcam-container');
const webcamCanvas    = document.getElementById('webcam-canvas');
const webcamCtx       = webcamCanvas.getContext('2d');

const offscreen = document.createElement('canvas');
const offCtx    = offscreen.getContext('2d', { willReadFrequently: true });

function applyCanvasSize() {
  webcamCanvas.width  = WEBCAM_W;
  webcamCanvas.height = WEBCAM_H;
  offscreen.width     = WEBCAM_W;
  offscreen.height    = WEBCAM_H;
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

    capture = p.createCapture(p.VIDEO, { flipped: true });
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
  };

  p.windowResized = function () {
    WEBCAM_W = Math.round(window.innerWidth * WEBCAM_RATIO);
    WEBCAM_H = Math.round(WEBCAM_W * (3 / 4));
    applyCanvasSize();
    if (capture) capture.size(WEBCAM_W, WEBCAM_H);
  };

});

// ─── Pose callback ────────────────────────────────────────────────────────────
function onPoses(results) {
  poses = results;
  const personPresent = poses.length > 0;

  webcamContainer.classList.toggle('detected', personPresent);

  if (!personPresent) {
    // Person left
    personWasAbsent = true;
    setStatus('No person');
    return;
  }

  // Person is present
  if (personWasAbsent) {
    // Re-appeared after absence → trigger next video (if current one finished)
    personWasAbsent = false;
    tryAdvanceMask();
  }

  const nose = poses[0].keypoints.find(k => k.name === 'nose');
  if (nose && nose.confidence > 0.3) {
    setStatus(`Person detected — mask ${currentMaskIndex + 1}`);
  }
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

// ─── Webcam preview draw — invert + noise ────────────────────────────────────
function drawWebcamPreview() {
  if (!capture || !capture.elt) return;

  // Draw mirrored frame to offscreen
  offCtx.save();
  offCtx.scale(-1, 1);
  offCtx.drawImage(capture.elt, -WEBCAM_W, 0, WEBCAM_W, WEBCAM_H);
  offCtx.restore();

  const id = offCtx.getImageData(0, 0, WEBCAM_W, WEBCAM_H);
  const px = id.data;
  const cx = WEBCAM_W / 2;
  const cy = WEBCAM_H / 2;

  for (let i = 0; i < px.length; i += 4) {
    // Grayscale
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;

    // Vignette — darken edges before invert
    const idx = i >> 2;
    const dx = ((idx % WEBCAM_W) - cx) / cx;
    const dy = ((idx / WEBCAM_W | 0) - cy) / cy;
    const vignette = Math.max(0, 1 - (dx * dx + dy * dy) * VIGNETTE_STRENGTH);
    const gv = (g * vignette) | 0;

    // Invert
    px[i]     = 255 - gv;
    px[i + 1] = 255 - gv;
    px[i + 2] = 255 - gv;

    // Noise
    const n = (Math.random() - 0.5) * NOISE_AMOUNT;
    px[i]     = Math.max(0, Math.min(255, px[i]     + n)) | 0;
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n)) | 0;
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n)) | 0;
  }

  webcamCtx.putImageData(id, 0, 0);
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
