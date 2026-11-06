import { setupMediaLibrary } from './media-library.js';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// --- CONFIGURATION ---
const CONFIG = {
  colors: {
    bg: 0x000000,
    champagneGold: 0xffd966,
    deepGreen: 0x031c0c,
    accentRed: 0xad0000,
    starGold: 0xffdd88,
    warmInner: 0xffaa00
  },
  particles: {
    count: 1750,
    dustCount: 2200,
    treeHeight: 24,
    treeRadius: 8.5
  },
  camera: {
    fov: 42,
    z: 50
  },
  preloadImages: [
    '/photos/magic_focusee.jpg',
    '/photos/voice_enhancement.jpg',
    '/photos/auto_pan_zoom.jpg',
    '/photos/cursor_effects.jpg',
    '/photos/smart_spotlight.jpg',
    '/photos/noise_reduction.jpg',
    '/photos/cut_filler_words.jpg',
    '/photos/ai_avatars.jpg',
    '/photos/dynamic_layout.jpg'
  ]
};

// --- APPLICATION STATE ---
const STATE = {
  view: 'tree',
  mode: 'TREE', // 'TREE' | 'SCATTER' | 'FOCUS'
  focusIndex: 0,
  focusTarget: null,
  hand: {
    detected: false,
    x: 0,
    y: 0,
    gesture: 'NONE'
  },
  rotation: { x: 0, y: 0 },
  targetRotation: { x: 0, y: 0 },
  soundEnabled: false,
  isCameraRunning: false,
  isDragging: false,
  previousMousePosition: { x: 0, y: 0 }
};

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, composer;
let mainGroup, photoMeshGroup;
let clock = new THREE.Clock();
let particleSystem = [];
let topStarMesh = null;
let caneTexture = null;
let handLandmarker = null;
let video = null;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let audioCtx = null;
const libraryPhotoRequests = new Map();
let cameraStarting = false;
let cameraAnimationFrame = null;

// DOM Elements
const canvasContainer = document.getElementById('canvas-container');
const uiLayer = document.getElementById('ui-layer');
const loader = document.getElementById('loader');
const debugInfo = document.getElementById('debug-info');
const camBtn = document.getElementById('cam-btn');
const audioBtn = document.getElementById('audio-btn');
const toastEl = document.getElementById('toast');
const webcamWrapper = document.getElementById('webcam-wrapper');

// --- TOAST NOTIFICATIONS ---
let toastTimer = null;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 2200);
}

// --- PROCEDURAL AUDIO (Web Audio API) ---
function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playHolidayChime(type) {
  if (!STATE.soundEnabled || !audioCtx) return;

  const now = audioCtx.currentTime;
  const playNote = (freq, start, duration, gainLevel = 0.15) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(gainLevel, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(start);
    osc.stop(start + duration);
  };

  if (type === 'TREE') {
    // Warm harmonic descent
    playNote(523.25, now, 0.8, 0.12);       // C5
    playNote(392.00, now + 0.12, 0.8, 0.12); // G4
    playNote(329.63, now + 0.24, 0.9, 0.12); // E4
    playNote(261.63, now + 0.36, 1.2, 0.15); // C4
  } else if (type === 'SCATTER') {
    // Twinkling magical burst
    playNote(523.25, now, 0.6, 0.10);        // C5
    playNote(659.25, now + 0.08, 0.6, 0.10); // E5
    playNote(783.99, now + 0.16, 0.7, 0.12); // G5
    playNote(987.77, now + 0.24, 0.8, 0.12); // B5
    playNote(1046.50, now + 0.32, 1.2, 0.15);// C6
  } else if (type === 'FOCUS') {
    // Shimmering harp ping
    playNote(659.25, now, 0.5, 0.12);
    playNote(880.00, now + 0.07, 0.7, 0.15);
    playNote(1318.51, now + 0.15, 1.0, 0.15);
  }
}

// --- THREE.JS INITIALIZATION ---
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.bg);
  scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.012);

  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 2, CONFIG.camera.z);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 2.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasContainer.appendChild(renderer.domElement);

  mainGroup = new THREE.Group();
  scene.add(mainGroup);

  photoMeshGroup = new THREE.Group();
  mainGroup.add(photoMeshGroup);
}

function setupEnvironment() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
}

function setupLights() {
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  // Warm radiant point light inside tree
  const innerLight = new THREE.PointLight(CONFIG.colors.warmInner, 2.5, 25);
  innerLight.position.set(0, 4, 0);
  mainGroup.add(innerLight);

  // Top-right golden spotlight
  const spotGold = new THREE.SpotLight(0xffd777, 1200);
  spotGold.position.set(30, 40, 40);
  spotGold.angle = 0.55;
  spotGold.penumbra = 0.5;
  scene.add(spotGold);

  // Back-left blue fill light
  const spotBlue = new THREE.SpotLight(0x6688ff, 600);
  spotBlue.position.set(-30, 25, -30);
  scene.add(spotBlue);

  // Soft front fill
  const fill = new THREE.DirectionalLight(0xfff0d0, 0.9);
  fill.position.set(0, 0, 50);
  scene.add(fill);
}

function setupPostProcessing() {
  const renderScene = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.6,  // strength
    0.45, // radius
    0.68  // threshold
  );

  composer = new EffectComposer(renderer);
  composer.addPass(renderScene);
  composer.addPass(bloomPass);
}

function createTextures() {
  // Striped Candy Cane Texture
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#aa0000';
  ctx.beginPath();
  for (let i = -128; i < 256; i += 32) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 32, 128);
    ctx.lineTo(i + 16, 128);
    ctx.lineTo(i - 16, 0);
  }
  ctx.fill();

  caneTexture = new THREE.CanvasTexture(canvas);
  caneTexture.wrapS = THREE.RepeatWrapping;
  caneTexture.wrapT = THREE.RepeatWrapping;
  caneTexture.repeat.set(3, 3);
}

// --- PARTICLE CLASS ---
class Particle {
  constructor(mesh, type, isDust = false) {
    this.mesh = mesh;
    this.type = type; // 'BOX' | 'GOLD_BOX' | 'GOLD_SPHERE' | 'RED' | 'CANE' | 'PHOTO' | 'DUST' | 'STAR'
    this.isDust = isDust;

    this.posTree = new THREE.Vector3();
    this.posScatter = new THREE.Vector3();
    this.baseScale = mesh.scale.x;

    const speedMult = (type === 'PHOTO') ? 0.35 : 1.8;
    this.spinSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * speedMult,
      (Math.random() - 0.5) * speedMult,
      (Math.random() - 0.5) * speedMult
    );

    this.calculatePositions();
  }

  calculatePositions() {
    if (this.type === 'PHOTO') {
      this.posTree.set(0, 0, 0); // updated by updatePhotoLayout
      const rScatter = 9 + Math.random() * 11;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      this.posScatter.set(
        rScatter * Math.sin(phi) * Math.cos(theta),
        rScatter * Math.sin(phi) * Math.sin(theta),
        rScatter * Math.cos(phi)
      );
      return;
    }

    if (this.type === 'STAR') {
      this.posTree.set(0, CONFIG.particles.treeHeight / 2 + 1.2, 0);
      this.posScatter.set(0, 14, 0);
      return;
    }

    const h = CONFIG.particles.treeHeight;
    const halfH = h / 2;
    let t = Math.random();
    t = Math.pow(t, 0.85); // cone density distribution
    const y = (t * h) - halfH;

    let rMax = CONFIG.particles.treeRadius * (1.0 - t);
    if (rMax < 0.6) rMax = 0.6;

    const angle = t * 55 * Math.PI + Math.random() * Math.PI;
    const r = rMax * (0.8 + Math.random() * 0.4);
    this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);

    const rScatter = this.isDust ? (12 + Math.random() * 20) : (8 + Math.random() * 14);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this.posScatter.set(
      rScatter * Math.sin(phi) * Math.cos(theta),
      rScatter * Math.sin(phi) * Math.sin(theta),
      rScatter * Math.cos(phi)
    );
  }

  update(dt, mode, focusTargetMesh) {
    let target = this.posTree;

    if (mode === 'SCATTER') {
      target = this.posScatter;
    } else if (mode === 'FOCUS') {
      if (this.mesh === focusTargetMesh) {
        // Safe world-to-local conversion for centered foreground focus
        const targetWorld = new THREE.Vector3(0, 1.2, 32);
        mainGroup.updateWorldMatrix(true, true);
        if (this.mesh.parent) {
          target = this.mesh.parent.worldToLocal(targetWorld);
        }
      } else {
        target = this.posScatter;
      }
    }

    const lerpSpeed = (mode === 'FOCUS' && this.mesh === focusTargetMesh) ? 5.5 : 2.2;
    if (target && !isNaN(target.x) && !isNaN(target.y) && !isNaN(target.z)) {
      this.mesh.position.lerp(target, lerpSpeed * dt);
    }

    // Rotation update
    if (mode === 'SCATTER') {
      this.mesh.rotation.x += this.spinSpeed.x * dt;
      this.mesh.rotation.y += this.spinSpeed.y * dt;
      this.mesh.rotation.z += this.spinSpeed.z * dt;
    } else if (mode === 'TREE') {
      if (this.type === 'PHOTO') {
        this.mesh.lookAt(0, this.mesh.position.y, 0);
        this.mesh.rotateY(Math.PI);
      } else if (this.type === 'STAR') {
        this.mesh.rotation.y += 0.8 * dt;
      } else {
        this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, 1.5 * dt);
        this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, 1.5 * dt);
        this.mesh.rotation.y += 0.5 * dt;
      }
    }

    if (mode === 'FOCUS' && this.mesh === focusTargetMesh) {
      // Invert parent group rotation so focused photo always faces camera perfectly flat
      this.mesh.quaternion.copy(mainGroup.quaternion).invert();
    }

    // Scale update
    let s = this.baseScale;
    if (this.isDust) {
      s = this.baseScale * (0.8 + 0.4 * Math.sin(clock.elapsedTime * 4 + this.mesh.id));
      if (mode === 'TREE') s *= 0.35; // gentle ambient sparkles in tree mode
    } else if (mode === 'SCATTER' && this.type === 'PHOTO') {
      s = this.baseScale * 2.5;
    } else if (mode === 'FOCUS') {
      if (this.mesh === focusTargetMesh) {
        s = 5.2; // Enlarged photo in focus
      } else {
        s = this.baseScale * 0.75;
      }
    }

    this.mesh.scale.lerp(new THREE.Vector3(s, s, s), 4 * dt);
  }
}

// --- CREATE SCENE PARTICLES ---
function createParticles() {
  const sphereGeo = new THREE.SphereGeometry(0.5, 24, 24);
  const boxGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);

  // Candy cane curve
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.5, 0),
    new THREE.Vector3(0, 0.3, 0),
    new THREE.Vector3(0.1, 0.5, 0),
    new THREE.Vector3(0.3, 0.4, 0)
  ]);
  const candyGeo = new THREE.TubeGeometry(curve, 16, 0.08, 8, false);

  // Materials
  const goldMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.champagneGold,
    metalness: 0.95,
    roughness: 0.12,
    envMapIntensity: 2.2,
    emissive: 0x443300,
    emissiveIntensity: 0.35
  });

  const greenMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.deepGreen,
    metalness: 0.2,
    roughness: 0.75,
    emissive: 0x002200,
    emissiveIntensity: 0.2
  });

  const redMat = new THREE.MeshPhysicalMaterial({
    color: CONFIG.colors.accentRed,
    metalness: 0.3,
    roughness: 0.2,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    emissive: 0x330000,
    emissiveIntensity: 0.3
  });

  const candyMat = new THREE.MeshStandardMaterial({
    map: caneTexture,
    roughness: 0.4
  });

  for (let i = 0; i < CONFIG.particles.count; i++) {
    const rand = Math.random();
    let mesh, type;

    if (rand < 0.42) {
      mesh = new THREE.Mesh(boxGeo, greenMat);
      type = 'BOX';
    } else if (rand < 0.72) {
      mesh = new THREE.Mesh(boxGeo, goldMat);
      type = 'GOLD_BOX';
    } else if (rand < 0.90) {
      mesh = new THREE.Mesh(sphereGeo, goldMat);
      type = 'GOLD_SPHERE';
    } else if (rand < 0.96) {
      mesh = new THREE.Mesh(sphereGeo, redMat);
      type = 'RED';
    } else {
      mesh = new THREE.Mesh(candyGeo, candyMat);
      type = 'CANE';
    }

    const s = 0.4 + Math.random() * 0.45;
    mesh.scale.set(s, s, s);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);

    mainGroup.add(mesh);
    particleSystem.push(new Particle(mesh, type, false));
  }

  // --- TOP STAR / DIAMOND TOPPER ---
  createTopStar();
}

function createTopStar() {
  // Brilliant glowing golden diamond star
  const starShape = new THREE.Shape();
  const points = 5;
  const outerRadius = 1.6;
  const innerRadius = 0.75;

  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points + Math.PI / 2;
    const r = (i % 2 === 0) ? outerRadius : innerRadius;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) starShape.moveTo(x, y);
    else starShape.lineTo(x, y);
  }
  starShape.closePath();

  const starGeo = new THREE.ExtrudeGeometry(starShape, {
    depth: 0.45,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.1,
    bevelSegments: 3
  });
  starGeo.center();

  const starMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.starGold,
    emissive: 0xffaa00,
    emissiveIntensity: 1.4,
    metalness: 1.0,
    roughness: 0.08
  });

  topStarMesh = new THREE.Mesh(starGeo, starMat);
  topStarMesh.position.set(0, CONFIG.particles.treeHeight / 2 + 1.2, 0);
  mainGroup.add(topStarMesh);
  particleSystem.push(new Particle(topStarMesh, 'STAR', false));
}

function createDust() {
  const geo = new THREE.TetrahedronGeometry(0.08, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffeebb,
    transparent: true,
    opacity: 0.85
  });

  for (let i = 0; i < CONFIG.particles.dustCount; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(0.5 + Math.random() * 0.9);
    mainGroup.add(mesh);
    particleSystem.push(new Particle(mesh, 'DUST', true));
  }
}

// --- PHOTO FRAMES SYSTEM ---
function updatePhotoLayout() {
  const photos = particleSystem.filter(p => p.type === 'PHOTO');
  const count = photos.length;
  if (count === 0) return;

  const h = CONFIG.particles.treeHeight * 0.88;
  const bottomY = -h / 2;
  const stepY = h / count;
  const loops = 2.8;

  photos.forEach((p, i) => {
    const y = bottomY + stepY * i + stepY / 2;
    const fullH = CONFIG.particles.treeHeight;
    const normalizedH = (y + fullH / 2) / fullH;

    let rMax = CONFIG.particles.treeRadius * (1.0 - normalizedH);
    if (rMax < 1.0) rMax = 1.0;

    const r = rMax + 2.8;
    const angle = normalizedH * Math.PI * 2 * loops + (Math.PI / 4);

    p.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
  });
}

function addPhotoToScene(texture, caption = '', mediaId = null) {
  const frameGeo = new THREE.BoxGeometry(1.4, 1.4, 0.05);
  const frameMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.champagneGold,
    metalness: 0.98,
    roughness: 0.12,
    emissive: 0x332200,
    emissiveIntensity: 0.2
  });
  const frame = new THREE.Mesh(frameGeo, frameMat);

  let width = 1.2;
  let height = 1.2;

  if (texture.image) {
    const aspect = texture.image.width / texture.image.height;
    if (aspect > 1) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
  }

  const photoGeo = new THREE.PlaneGeometry(width, height);
  const photoMat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide
  });
  const photo = new THREE.Mesh(photoGeo, photoMat);
  photo.position.z = 0.038;

  const group = new THREE.Group();
  group.add(frame);
  group.add(photo);
  group.userData = { isPhoto: true, caption, mediaId };

  frame.scale.set(width / 1.2, height / 1.2, 1);

  const s = 0.8;
  group.scale.set(s, s, s);

  photoMeshGroup.add(group);
  particleSystem.push(new Particle(group, 'PHOTO', false));

  updatePhotoLayout();
}

function addLibraryPhoto(item, src) {
  const request = {};
  libraryPhotoRequests.set(item.id, request);
  new THREE.TextureLoader().load(src, texture => {
    if (libraryPhotoRequests.get(item.id) !== request) {
      texture.dispose();
      return;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    addPhotoToScene(texture, item.name, item.id);
  }, undefined, () => {
    libraryPhotoRequests.delete(item.id);
    showToast(`No se pudo mostrar la foto ${item.name}.`);
  });
}

function removeLibraryPhoto(id) {
  libraryPhotoRequests.delete(id);
  const index = particleSystem.findIndex(p => p.type === 'PHOTO' && p.mesh.userData.mediaId === id);
  if (index < 0) return;
  const [particle] = particleSystem.splice(index, 1);
  if (STATE.focusTarget === particle.mesh) setMode('TREE');
  particle.mesh.removeFromParent();
  particle.mesh.traverse(child => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach(material => {
      material.map?.dispose();
      material.dispose();
    });
  });
  updatePhotoLayout();
}

function stopCamera() {
  STATE.isCameraRunning = false;
  STATE.hand.detected = false;
  STATE.hand.gesture = 'NONE';
  cancelAnimationFrame(cameraAnimationFrame);
  cameraAnimationFrame = null;
  if (video?.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  document.body.dataset.cameraRunning = 'false';
  camBtn.classList.remove('active');
  camBtn.setAttribute('aria-pressed', 'false');
  camBtn.innerText = '📷 Activar cámara';
  debugInfo.innerText = 'Cámara apagada.';
}

// --- MEDIAPIPE HAND TRACKING ---
async function initMediaPipe() {
  if (cameraStarting) return;
  video = document.getElementById('webcam');
  if (!video) return;
  cameraStarting = true;
  camBtn.disabled = true;
  try {
    debugInfo.innerText = 'Loading AI Gesture Model...';
    // Load local wasm for instant loading, fallback to CDN
    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    } catch {
      vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
      );
    }

    if (!handLandmarker) handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/mediapipe/hand_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      }
    });

    if (STATE.view !== 'tree') {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    video.srcObject = stream;
    await video.play();
    STATE.isCameraRunning = true;
    lastVideoTime = -1;
    document.body.dataset.cameraRunning = 'true';
    camBtn.classList.add('active');
    camBtn.setAttribute('aria-pressed', 'true');
    camBtn.innerText = '🟢 Cámara activa';
    debugInfo.innerText = 'Gestos: mano abierta, puño y pellizco';
    predictWebcam();
    showToast('Cámara conectada.');
  } catch (err) {
    stopCamera();
    console.warn('Webcam or MediaPipe error:', err);
    debugInfo.innerText = 'Camera unavailable. Use touch/mouse.';
    showToast('Camera off. Interactive touch & mouse ready.');
  } finally {
    cameraStarting = false;
    camBtn.disabled = false;
  }
}

let lastVideoTime = -1;
function predictWebcam() {
  if (!STATE.isCameraRunning) return;
  if (STATE.view === 'tree' && video?.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    if (handLandmarker) {
      const result = handLandmarker.detectForVideo(video, performance.now());
      processGestures(result);
    }
  }
  if (STATE.isCameraRunning) {
    cameraAnimationFrame = requestAnimationFrame(predictWebcam);
  }
}

// Adaptive Ratio-Based Gesture Analysis
function processGestures(result) {
  if (result.landmarks && result.landmarks.length > 0) {
    STATE.hand.detected = true;
    const lm = result.landmarks[0];

    // Normalized coordinates (-1 to 1)
    STATE.hand.x = (lm[9].x - 0.5) * 2;
    STATE.hand.y = (lm[9].y - 0.5) * 2;

    const thumb = lm[4];
    const index = lm[8];
    const wrist = lm[0];
    const middleMCP = lm[9]; // Middle knuckle

    // 1. Hand scale (wrist to middle knuckle)
    const handSize = Math.hypot(middleMCP.x - wrist.x, middleMCP.y - wrist.y);
    if (handSize < 0.02) return;

    // 2. Average tip extension
    const tips = [lm[8], lm[12], lm[16], lm[20]];
    let avgTipDist = 0;
    tips.forEach(t => avgTipDist += Math.hypot(t.x - wrist.x, t.y - wrist.y));
    avgTipDist /= 4;

    // 3. Pinch distance (thumb to index)
    const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);

    const extensionRatio = avgTipDist / handSize;
    const pinchRatio = pinchDist / handSize;

    // Gesture Classification
    let gestureName = 'Open Hand';
    if (extensionRatio < 1.48) {
      gestureName = '✊ Fist';
      setMode('TREE');
    } else if (pinchRatio < 0.36) {
      gestureName = '👌 Pinch / Grab';
      if (STATE.mode !== 'FOCUS') {
        focusNextPhoto();
      }
    } else if (extensionRatio > 1.70) {
      gestureName = '🖐️ Open Hand';
      setMode('SCATTER');
    } else {
      gestureName = '👋 Relaxed';
    }

    STATE.hand.gesture = gestureName;
    debugInfo.innerText = `${gestureName} • State: ${STATE.mode}`;
  } else {
    STATE.hand.detected = false;
    debugInfo.innerText = 'Show hand to control';
  }
}

// --- STATE SWITCHING ---
function setMode(newMode) {
  if (newMode === 'FOCUS' && !particleSystem.some(p => p.type === 'PHOTO')) {
    showToast('Añade una foto desde el menú para acercarla.');
    return;
  }
  if (STATE.mode === newMode && newMode !== 'FOCUS') return;

  STATE.mode = newMode;
  if (newMode !== 'FOCUS' || STATE.focusTarget) playHolidayChime(newMode);

  // Update UI mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    if (btn.dataset.mode === newMode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (newMode === 'TREE') {
    STATE.focusTarget = null;
    showToast('Tree Assembled 🎄');
  } else if (newMode === 'SCATTER') {
    STATE.focusTarget = null;
    showToast('Cosmic Scatter ✨');
  } else if (newMode === 'FOCUS') {
    if (!STATE.focusTarget) {
      focusNextPhoto();
    }
  }
}

function focusNextPhoto() {
  const photos = particleSystem.filter(p => p.type === 'PHOTO');
  if (!photos.length) return;

  STATE.focusIndex = (STATE.focusIndex + 1) % photos.length;
  STATE.focusTarget = photos[STATE.focusIndex].mesh;
  STATE.mode = 'FOCUS';

  playHolidayChime('FOCUS');

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === 'FOCUS');
  });

  const caption = STATE.focusTarget.userData?.caption || 'Photo Memory';
  showToast(`🔍 ${caption}`);
}

// --- MOUSE, TOUCH, AND KEYBOARD EVENTS ---
function setupEvents() {
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  // Photo Click / Tap with Raycaster
  let pointerStart = null;
  const onPointerDown = (e) => {
    if (STATE.view !== 'tree' || e.button !== 0 || e.isPrimary === false) return;
    initAudio();
    pointerStart = { x: e.clientX, y: e.clientY, moved: false };
    STATE.isDragging = true;
    STATE.previousMousePosition = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e) => {
    if (!STATE.isDragging) return;
    if (pointerStart && Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 6) {
      pointerStart.moved = true;
    }
    const deltaX = e.clientX - STATE.previousMousePosition.x;
    const deltaY = e.clientY - STATE.previousMousePosition.y;

    STATE.targetRotation.y += deltaX * 0.006;
    STATE.targetRotation.x += deltaY * 0.004;

    STATE.previousMousePosition = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e) => {
    if (!STATE.isDragging) return;
    STATE.isDragging = false;
    if (!pointerStart || pointerStart.moved || STATE.view !== 'tree') return;

    // Check if clicked on a photo
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const photos = particleSystem.filter(p => p.type === 'PHOTO').map(p => p.mesh);
    const intersects = raycaster.intersectObjects(photos, true);

    if (intersects.length > 0) {
      // Find top photo group
      let obj = intersects[0].object;
      while (obj.parent && obj.parent !== photoMeshGroup) {
        obj = obj.parent;
      }
      STATE.focusTarget = obj;
      STATE.mode = 'FOCUS';
      playHolidayChime('FOCUS');
      document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === 'FOCUS');
      });
      showToast(`🔍 ${obj.userData?.caption || 'Memory'}`);
    } else if (STATE.mode === 'FOCUS') {
      // Clicked outside focused photo -> return to Tree
      setMode('TREE');
    }
  };

  canvasContainer.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => { STATE.isDragging = false; pointerStart = null; });

  // Mode Buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      initAudio();
      setMode(btn.dataset.mode);
    });
  });

  // Cam Toggle Button
  camBtn?.addEventListener('click', () => {
    initAudio();
    if (!STATE.isCameraRunning) {
      initMediaPipe();
    } else {
      stopCamera();
      showToast('Cámara apagada.');
    }
  });

  // Audio Toggle Button
  audioBtn?.addEventListener('click', () => {
    initAudio();
    STATE.soundEnabled = !STATE.soundEnabled;
    audioBtn.classList.toggle('active', STATE.soundEnabled);
    audioBtn.setAttribute('aria-pressed', String(STATE.soundEnabled));
    audioBtn.innerText = STATE.soundEnabled ? '🔔 Sonido activado' : '🔕 Sonido apagado';
    showToast(STATE.soundEnabled ? 'Holiday Chimes Enabled' : 'Muted');
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || STATE.view !== 'tree' || document.body.dataset.menuOpen === 'true'
      || e.target.closest('button, input, textarea, select, a, video, [contenteditable="true"]')) return;
    initAudio();
    const key = e.key.toLowerCase();
    if (key === 'h') {
      // Toggle UI for clean video capture
      uiLayer.classList.toggle('ui-hidden');
      webcamWrapper.classList.toggle('ui-hidden');
      showToast(uiLayer.classList.contains('ui-hidden') ? 'UI Hidden (Press H to restore)' : 'UI Restored');
    } else if (key === ' ') {
      e.preventDefault();
      // Cycle modes: TREE -> SCATTER -> FOCUS -> TREE
      if (STATE.mode === 'TREE') setMode('SCATTER');
      else if (STATE.mode === 'SCATTER') setMode('FOCUS');
      else setMode('TREE');
    } else if (key === 'escape') {
      setMode('TREE');
    }
  });
}

// --- ANIMATION LOOP ---
function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(Math.max(rawDt, 0.001), 0.1);
  if (STATE.view !== 'tree' || document.hidden) return;

  // Rotation damping & gestures
  if (STATE.mode === 'SCATTER' && STATE.hand.detected) {
    const handTargetRotY = STATE.hand.x * Math.PI * 0.9;
    const handTargetRotX = STATE.hand.y * Math.PI * 0.25;
    STATE.targetRotation.y += (handTargetRotY - STATE.targetRotation.y) * 2.5 * dt;
    STATE.targetRotation.x += (handTargetRotX - STATE.targetRotation.x) * 2.5 * dt;
  } else if (!STATE.isDragging) {
    if (STATE.mode === 'TREE') {
      STATE.targetRotation.y += 0.35 * dt;
      STATE.targetRotation.x += (0 - STATE.targetRotation.x) * 2.0 * dt;
    } else if (STATE.mode === 'SCATTER') {
      STATE.targetRotation.y += 0.12 * dt;
    } else if (STATE.mode === 'FOCUS') {
      STATE.targetRotation.x = THREE.MathUtils.lerp(STATE.targetRotation.x, 0, 3.0 * dt);
    }
  }

  STATE.rotation.y += (STATE.targetRotation.y - STATE.rotation.y) * 4.0 * dt;
  STATE.rotation.x += (STATE.targetRotation.x - STATE.rotation.x) * 4.0 * dt;

  mainGroup.rotation.y = STATE.rotation.y;
  mainGroup.rotation.x = STATE.rotation.x;

  // Update all particles & photos
  particleSystem.forEach(p => p.update(dt, STATE.mode, STATE.focusTarget));

  // Render post-processed scene with bloom
  composer.render();
}

// Global debug access
window.STATE = STATE;
window.THREE = THREE;
window.particleSystem = particleSystem;
window.mainGroup = mainGroup;

// --- APP ENTRY POINT ---
async function startApp() {
  initThree();
  setupEnvironment();
  setupLights();
  createTextures();
  createParticles();
  createDust();
  setupPostProcessing();
  setupEvents();
  setupMediaLibrary({
    defaults: [
      ...CONFIG.preloadImages.map(url => ({
        id: `builtin-${url.split('/').pop().replace(/\.[^/.]+$/, '')}`,
        url,
        name: url.split('/').pop().replace(/_/g, ' '),
        type: 'image',
        mimeType: 'image/jpeg'
      })),
      { id: 'builtin-background-video', url: '/background.mp4', name: 'Recuerdo navideño.mp4', type: 'video', mimeType: 'video/mp4' }
    ],
    onImageAdded: addLibraryPhoto,
    onImageRemoved: removeLibraryPhoto,
    onNotice: showToast,
    onViewChange(view) {
      STATE.view = view;
      STATE.isDragging = false;
      if (view === 'gallery' && STATE.isCameraRunning) stopCamera();
    }
  });

  // Fade out loader
  if (loader) {
    loader.style.opacity = '0';
    setTimeout(() => {
      loader.remove();
      showToast('Welcome to 3D Christmas Memories ✨');
    }, 800);
  }

  animate();
}

// Start
startApp();
