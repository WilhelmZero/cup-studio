import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WebGLPathTracer } from './vendor/pathtracer/package/src/core/WebGLPathTracer.js';
import { GradientEquirectTexture } from './vendor/pathtracer/package/src/textures/GradientEquirectTexture.js';
import { DenoiseMaterial } from './vendor/pathtracer/package/src/materials/fullscreen/DenoiseMaterial.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createDecalEditor } from './decal.js';
import { createContentsEditor } from './contents.js';
import { readProjectPackage, writeProjectPackage, validateModelSurface, loadRecentProject, saveRecentProject } from './project.js';

const stage = document.querySelector('#stage');
const loading = document.querySelector('#loading');
const status = document.querySelector('#status-text');
const renderProgress = document.querySelector('#render-progress');
const renderPercent = document.querySelector('#render-percent');
const BASE_PATH_TRACING_SAMPLES = 512;
const ARTWORK_PATH_TRACING_SAMPLES = 1024;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Centimetres inside the renderer avoid numerical offsets skipping thin glass.
// The original downloadable GLB remains in metres.
const WORLD_SCALE = 100;
let pathTracer;
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch (error) {
  document.querySelector('#loading-text').innerHTML = '浏览器未启用 3D 加速。<a class="error-link" href="/glass_cup/preview_clear_glass.png">查看渲染预览</a>';
  document.querySelector('.spinner').remove();
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(33, stage.clientWidth / stage.clientHeight, .1, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 6.9, 0);
controls.enableDamping = true;
controls.dampingFactor = .09;
controls.enablePan = false;
controls.minDistance = 11.5;
controls.maxDistance = 85;
controls.minPolarAngle = .06;
controls.maxPolarAngle = Math.PI - .08;
controls.autoRotateSpeed = .7;
controls.rotateSpeed = .6;
controls.zoomSpeed = .65;

const environment = new THREE.Scene();
environment.background = new THREE.Color('#192127');
function softbox(x, y, z, width, height, intensity) {
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({color:new THREE.Color(intensity,intensity,intensity),side:THREE.DoubleSide}));
  panel.position.set(x,y,z);
  panel.lookAt(0,1,0);
  environment.add(panel);
}
softbox(-4,2,1,1,7,5);
softbox(4,3,0,1.5,8,6);
softbox(0,6,-1,4,4,3);
softbox(-2,1,-4,3,5,2);
const environmentTarget = new THREE.WebGLCubeRenderTarget(256, {type:THREE.HalfFloatType});
const environmentCamera = new THREE.CubeCamera(.1,100,environmentTarget);
environmentCamera.update(renderer, environment);
scene.environment = environmentTarget.texture;
scene.environmentIntensity = 1;
environment.traverse(object => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } });

function background(top, middle, bottom) {
  const texture = new GradientEquirectTexture(256);
  texture.topColor.set(top);
  texture.bottomColor.set(bottom);
  texture.exponent = 1;
  texture.update();
  return texture;
}
const themes = {
  light: background('#dadbd6', '#eeede9', '#f5f4ef'),
  dark: background('#242e35', '#414e55', '#687579'),
  warm: background('#b7a189', '#d8c9b4', '#eee4d4'),
};
scene.background = themes.dark;
document.body.dataset.theme = 'dark';
document.querySelectorAll('button[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === 'dark')));

let cup, decalEditor, contentEditor, activeProject, previewUrl;
let importTicket = 0, saveRevision = 0, saveTimer, activationQueue = Promise.resolve(), storageQueue = Promise.resolve();
let switchingProject = false, exportDone = Promise.resolve();
let bounds, fitDistance = 40;
const projectMessage = document.querySelector('#project-message');
const exampleUrl = './examples/can-glass.cup.zip';
function message(text, error = false) {
  projectMessage.textContent = text;
  projectMessage.classList.toggle('error', error);
}
function renderSampleTarget() {
  return decalEditor?.hasImage || contentEditor?.hasContents ? ARTWORK_PATH_TRACING_SAMPLES : BASE_PATH_TRACING_SAMPLES;
}
function updateRenderProgress(samples, target, visible = true) {
  renderProgress.hidden = renderPercent.hidden = !visible;
  if (!visible) return;
  const percent = Math.min(100, Math.max(0, Math.floor(samples / target * 100)));
  renderProgress.style.setProperty('--render-progress', percent / 100);
  renderProgress.setAttribute('aria-valuenow', String(percent));
  renderPercent.textContent = `${percent}%`;
}
function fittedDistance() {
  if (!bounds) return 40;
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const v = THREE.MathUtils.degToRad(camera.fov), h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
  return radius / Math.sin(Math.min(v, h) / 2) * 1.12;
}
function reset() {
  controls.autoRotate = false;
  controls.enableDamping = false;
  controls.update();
  if (bounds) bounds.getCenter(controls.target);
  else controls.target.set(0, 6.9, 0);
  fitDistance = fittedDistance();
  camera.position.copy(controls.target).add(new THREE.Vector3(0, .36, 1).normalize().multiplyScalar(fitDistance));
  document.querySelector('#rotate').setAttribute('aria-pressed', 'false');
  controls.update();
  controls.enableDamping = true;
}
reset();

pathTracer = new WebGLPathTracer(renderer);
pathTracer.bounces = 12;
pathTracer.transmissiveBounces = 24;
pathTracer.dynamicLowRes = true;
pathTracer.lowResScale = .25;
pathTracer.renderScale = 1;
pathTracer.tiles.set(2, 2);
pathTracer.renderDelay = 100;
pathTracer.minSamples = 2;
pathTracer.fadeDuration = 180;
// Keep the denoiser conservative so small artwork text and thin strokes do not
// get blended into the refracted glass behind them.
const denoiseQuad = new FullScreenQuad(new DenoiseMaterial({sigma:1.5, kSigma:1, threshold:.035, transparent:true}));
pathTracer.renderToCanvasCallback = (target, outputRenderer, blendQuad) => {
  const previousAutoClear = outputRenderer.autoClear;
  outputRenderer.autoClear = false;
  denoiseQuad.material.map = target.texture;
  denoiseQuad.material.opacity = blendQuad.material.opacity;
  denoiseQuad.material.blending = blendQuad.material.blending;
  denoiseQuad.render(outputRenderer);
  outputRenderer.autoClear = previousAutoClear;
};

function materialsOf(root) {
  const materials = new Set();
  root.traverse(object => {
    if (object.isMesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m));
  });
  return materials;
}
function disposeModel(root) {
  if (!root) return;
  const geometries = new Set(), textures = new Set();
  root.traverse(object => { if (object.isMesh) geometries.add(object.geometry); });
  for (const material of materialsOf(root)) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  textures.forEach(t => { t.dispose(); t.source?.data?.close?.(); });
  geometries.forEach(g => g.dispose());
}
function rebuildScene() {
  if (!cup) return;
  pathTracer.textureSize.set(decalEditor?.hasImage ? 2048 : 256, decalEditor?.hasImage ? 2048 : 256);
  pathTracer.setScene(scene, camera);
}
function editorFor(model, manifest) {
  return createDecalEditor({ cup: model, stage, camera, controls, project: manifest, rebuildScene,
    onPanelChange: () => requestAnimationFrame(resizeStage), onChange: scheduleSave });
}
function contentsFor(model, manifest) {
  return createContentsEditor({ cup:model, project:manifest, reducedMotion,
    onPanelChange: () => requestAnimationFrame(resizeStage),
    onPreview: () => { beginCameraPreview(); settleCameraPreview(220); },
    onCommit: () => {
      clearTimeout(cameraSettleTimer);
      cameraPreviewActive = false;
      contentEditor?.setInteractive(false);
      rebuildScene();
      pathTracer.pausePathTracing = false;
      scheduleSave();
    },
  });
}
function updateProjectInfo() {
  const p = activeProject.manifest;
  document.querySelector('#project-name').textContent = p.name;
  document.title = `${p.name} · 杯子定制`;
  document.querySelector('#spec-height').textContent = Number(p.dimensionsMm.height.toFixed(1));
  document.querySelector('#spec-mouth').textContent = Number(p.dimensionsMm.mouthOuterDiameter.toFixed(1));
  document.querySelector('#spec-description').textContent = `杯身最大直径 ${Number(p.dimensionsMm.bodyMaxDiameter.toFixed(1))} mm · 高透玻璃`;
  const sourceText = p.dimensionSources.map(s => `${s.field}: ${s.valueMm} mm — ${s.note}`).join('\n');
  const source = document.querySelector('#spec-sources');
  source.textContent = p.dimensionSources.some(s => s.source === 'estimated') ? '部分尺寸为参考估算' : '尺寸按提供的参考资料建立';
  source.title = sourceText;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  const preview = document.querySelector('.render-link');
  preview.hidden = !activeProject.previewBytes;
  if (activeProject.previewBytes) {
    const extension = p.preview.split('.').at(-1).toLowerCase();
    previewUrl = URL.createObjectURL(new Blob([activeProject.previewBytes], { type: extension === 'webp' ? 'image/webp' : /jpe?g/.test(extension) ? 'image/jpeg' : 'image/png' }));
    preview.href = previewUrl;
  }
  document.querySelector('#project-save').disabled = false;
  document.querySelector('.download').setAttribute('aria-disabled', 'false');
}
function setTheme(theme, save = true) {
  document.body.dataset.theme = theme;
  scene.background = themes[theme];
  if (cup) pathTracer.updateEnvironment();
  document.querySelectorAll('button[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
  if (save) scheduleSave();
}

async function activateProject(project, model, ticket) {
  const previous = activeProject && { project: activeProject, cup, design: decalEditor.getDesign(), contents:contentEditor?.getDesign(), artwork: decalEditor.artworkFile, theme: document.body.dataset.theme };
  const previousView = { position: camera.position.clone(), target: controls.target.clone(), near: camera.near, far: camera.far,
    min: controls.minDistance, max: controls.maxDistance, bounds: bounds?.clone(), fitDistance, autoRotate: controls.autoRotate };
  saveRevision++;
  clearTimeout(saveTimer);
  decalEditor?.dispose();
  contentEditor?.dispose();
  const candidate = new THREE.Group();
  candidate.name = 'Cup project';
  candidate.add(model);
  candidate.scale.setScalar(WORLD_SCALE);
  for (const material of materialsOf(candidate)) {
    if (material.isMeshStandardMaterial) material.envMapIntensity = 1;
    if (material.transmission > 0) {
      if (Number.isFinite(material.attenuationDistance)) material.attenuationDistance *= WORLD_SCALE;
      material.side = THREE.DoubleSide;
    }
    material.needsUpdate = true;
  }
  let nextEditor, nextContents;
  try {
    nextEditor = editorFor(candidate, project.manifest);
    nextContents = contentsFor(candidate, project.manifest);
    if (project.artworkFile) await nextEditor.setArtwork(project.artworkFile, { notify: false });
    if (ticket !== importTicket) throw new DOMException('项目读取已取消。', 'AbortError');
    if (cup) scene.remove(cup);
    cup = candidate;
    decalEditor = nextEditor;
    contentEditor = nextContents;
    activeProject = project;
    scene.add(cup);
    bounds = new THREE.Box3().setFromObject(cup);
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    controls.minDistance = radius * 1.05;
    controls.maxDistance = radius * 15;
    camera.near = Math.max(.005, radius / 1000);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    setTheme(project.manifest.view.theme, false);
    reset();
    rebuildScene();
    updateProjectInfo();
    document.body.dataset.loaded = 'true';
    loading.classList.add('done');
    loading.setAttribute('aria-hidden', 'true');
    if (previous) disposeModel(previous.cup);
  } catch (error) {
    nextEditor?.dispose();
    nextContents?.dispose();
    scene.remove(candidate);
    disposeModel(candidate);
    if (previous) {
      cup = previous.cup;
      activeProject = previous.project;
      const restoredManifest = { ...previous.project.manifest, design: { ...previous.design, contents:previous.contents } };
      decalEditor = editorFor(cup, restoredManifest);
      contentEditor = contentsFor(cup, restoredManifest);
      if (previous.artwork) await decalEditor.setArtwork(previous.artwork, { notify: false });
      scene.add(cup);
      bounds = previousView.bounds;
      fitDistance = previousView.fitDistance;
      camera.position.copy(previousView.position);
      camera.near = previousView.near;
      camera.far = previousView.far;
      camera.updateProjectionMatrix();
      controls.target.copy(previousView.target);
      controls.minDistance = previousView.min;
      controls.maxDistance = previousView.max;
      controls.autoRotate = previousView.autoRotate;
      document.querySelector('#rotate').setAttribute('aria-pressed', String(controls.autoRotate));
      setTheme(previous.theme, false);
      rebuildScene();
      updateProjectInfo();
      scheduleSave(false);
    } else { cup = undefined; activeProject = undefined; decalEditor = undefined; contentEditor = undefined; }
    throw error;
  }
}

async function openProject(source, { restored = false, ticket = ++importTicket } = {}) {
  if (ticket !== importTicket) return;
  message('正在读取杯型项目…');
  let model;
  try {
    const project = await readProjectPackage(source);
    const gltf = await new GLTFLoader().parseAsync(project.modelBytes.buffer.slice(project.modelBytes.byteOffset, project.modelBytes.byteOffset + project.modelBytes.byteLength), '');
    model = gltf.scene;
    validateModelSurface(model, project.manifest);
    if (ticket !== importTicket) { disposeModel(model); return; }
    const activation = activationQueue.catch(() => {}).then(async () => {
      await exportDone;
      if (ticket !== importTicket) { disposeModel(model); return; }
      const candidate = model;
      model = undefined; // activateProject owns the candidate, including failure disposal.
      switchingProject = true;
      try { await activateProject(project, candidate, ticket); }
      finally { switchingProject = false; }
      if (ticket === importTicket) {
        message(restored ? '已恢复上次编辑的项目' : '项目已导入，可开始定制');
        scheduleSave();
      }
    });
    activationQueue = activation;
    await activation;
  } catch (error) {
    disposeModel(model);
    if (ticket === importTicket) message(error.message || '项目导入失败，当前项目已保留。', true);
    throw error;
  }
}

function projectBytes() {
  if (!activeProject || !decalEditor) throw new Error('请先导入杯型项目。');
  return writeProjectPackage(activeProject, { ...decalEditor.getDesign(), contents:contentEditor?.getDesign() }, decalEditor.artworkFile, document.body.dataset.theme);
}
function scheduleSave(showStatus = true) {
  if (!activeProject) return;
  const revision = ++saveRevision;
  clearTimeout(saveTimer);
  if (showStatus) message('正在保存到本机…');
  saveTimer = setTimeout(async () => {
    try {
      const bytes = await projectBytes();
      if (revision !== saveRevision) return;
      storageQueue = storageQueue.catch(() => {}).then(() => revision === saveRevision ? saveRecentProject(bytes) : undefined);
      await storageQueue;
      if (showStatus && revision === saveRevision && !projectMessage.classList.contains('error')) message('已自动保存在本机');
    } catch {
      if (revision === saveRevision) message('本机自动保存不可用，请使用“保存项目”下载备份。', true);
    }
  }, 650);
}
function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const safeName = name => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'cup-project';
document.querySelector('#project-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) openProject(file).catch(() => {});
});
async function loadExample(ticket = ++importTicket) {
  const response = await fetch(exampleUrl);
  if (!response.ok) throw new Error('内置示例未能加载。');
  await openProject(await response.arrayBuffer(), { ticket });
}
document.querySelector('#project-example').addEventListener('click', () => loadExample().catch(error => message(error.message, true)));
document.querySelector('#project-save').addEventListener('click', async event => {
  if (switchingProject) { message('正在切换项目，请稍后保存。'); return; }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const name = safeName(activeProject.manifest.name);
    downloadBytes(await projectBytes(), `${name}.cup.zip`, 'application/zip');
    message('项目包已下载，可再次导入继续编辑');
  } catch (error) { message(error.message || '项目保存失败，请重试。', true); }
  finally { button.disabled = !activeProject; }
});

async function start() {
  const ticket = ++importTicket;
  try {
    const recent = await loadRecentProject();
    if (ticket !== importTicket) return;
    if (recent) { await openProject(recent, { restored: true, ticket }); return; }
  } catch { message('上次项目未能恢复，正在打开内置示例。', true); }
  if (ticket !== importTicket) return;
  try { await loadExample(ticket); }
  catch (error) {
    message(error.message, true);
    loading.classList.add('done');
    loading.setAttribute('aria-hidden', 'true');
    status.textContent = '请导入杯型项目';
  }
}
start();

document.querySelectorAll('button[data-theme]').forEach(button => button.addEventListener('click', () => {
  setTheme(button.dataset.theme);
}));
document.querySelector('#rotate').addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  document.querySelector('#rotate').setAttribute('aria-pressed', String(controls.autoRotate));
  if (controls.autoRotate) beginCameraPreview();
  else settleCameraPreview();
});
document.querySelector('#reset').addEventListener('click', reset);
document.querySelector('#top').addEventListener('click', () => {
  controls.autoRotate = false;
  controls.enableDamping = false;
  controls.update();
  document.querySelector('#rotate').setAttribute('aria-pressed', 'false');
  if (bounds) bounds.getCenter(controls.target);
  camera.position.copy(controls.target).add(new THREE.Vector3(.07, 1, .45).normalize().multiplyScalar(fittedDistance()));
  controls.update();
  controls.enableDamping = true;
});
stage.addEventListener('keydown', event => {
  if (event.key === 'Home' || event.key === 'r') { reset(); event.preventDefault(); }
  if (event.key === '+' || event.key === '=') { camera.position.sub(controls.target).multiplyScalar(.9).add(controls.target);controls.update();event.preventDefault(); }
  if (event.key === '-') { camera.position.sub(controls.target).multiplyScalar(1.1).add(controls.target);controls.update();event.preventDefault(); }
});
function resizeStage() {
  const oldDistance = fitDistance;
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  fitDistance = fittedDistance();
  if (bounds && oldDistance > 0) camera.position.sub(controls.target).multiplyScalar(fitDistance / oldDistance).add(controls.target);
  pathTracer?.updateCamera();
  decalEditor?.updateGuides();
}
new ResizeObserver(resizeStage).observe(stage);
window.addEventListener('resize', resizeStage);
let cameraPreviewActive = false, cameraSettleTimer;
function beginCameraPreview() {
  clearTimeout(cameraSettleTimer);
  cameraPreviewActive = true;
  if (pathTracer) pathTracer.pausePathTracing = true;
  contentEditor?.setInteractive(true);
}
function settleCameraPreview(delay = 150) {
  clearTimeout(cameraSettleTimer);
  if (controls.autoRotate) return;
  cameraSettleTimer = setTimeout(() => {
    cameraPreviewActive = false;
    contentEditor?.setInteractive(false);
    if (pathTracer) {
      if (contentEditor?.hasContents) rebuildScene();
      else pathTracer.updateCamera();
      pathTracer.pausePathTracing = false;
    }
  }, delay);
}
controls.addEventListener('start', beginCameraPreview);
controls.addEventListener('change', () => {
  beginCameraPreview();
  if (!controls.autoRotate) settleCameraPreview();
});
controls.addEventListener('end', () => settleCameraPreview());

let exporting = false;
document.querySelector('.download').addEventListener('click', async event => {
  event.preventDefault();
  if (exporting || !cup) return;
  if (switchingProject) { message('正在切换项目，请稍后导出。'); return; }
  contentEditor?.setInteractive(false);
  const fileName = safeName(activeProject.manifest.name);
  if (!decalEditor?.hasImage && !contentEditor?.hasContents) {
    downloadBytes(activeProject.modelBytes, `${fileName}.glb`, 'model/gltf-binary');
    return;
  }
  exporting = true;
  let finishExport;
  exportDone = new Promise(resolve => { finishExport = resolve; });
  const link = event.currentTarget;
  link.setAttribute('aria-busy', 'true');
  const clonedMaterials = [];
  try {
    // Export the cup only in metres, with its imported artwork embedded.
    const exportCup = cup.clone(true);
    exportCup.scale.setScalar(1);
    const clones = new Map();
    function cloneMaterial(material) {
      if (clones.has(material)) return clones.get(material);
      const copy = material.clone();
      if (copy.transmission > 0 && Number.isFinite(copy.attenuationDistance)) copy.attenuationDistance /= WORLD_SCALE;
      if (copy.userData?.cupContent && copy.thickness > 0) copy.thickness /= WORLD_SCALE;
      clones.set(material, copy);
      clonedMaterials.push(copy);
      return copy;
    }
    exportCup.traverse(object => { if (object.isMesh) object.material = Array.isArray(object.material) ? object.material.map(cloneMaterial) : cloneMaterial(object.material); });
    const data = await new GLTFExporter().parseAsync(exportCup, { binary: true, onlyVisible: true });
    downloadBytes(data, `${fileName}_定制.glb`, 'model/gltf-binary');
    message('已导出包含贴图的 GLB 模型');
  } catch (error) {
    console.error('GLB export failed', error);
    message('模型导出失败，请重试。', true);
  } finally {
    clonedMaterials.forEach(material => material.dispose());
    exporting = false;
    finishExport();
    link.removeAttribute('aria-busy');
  }
});
let previous = performance.now();
renderer.setAnimationLoop(now => {
  const delta = Math.min((now - previous) / 1000, .05);
  previous = now;
  controls.update(delta);
  contentEditor?.update(now / 1000);
  if (pathTracer && cup) {
    if (cameraPreviewActive || controls.autoRotate) {
      renderer.render(scene, camera);
      const state = controls.autoRotate ? '旋转中 · 实时玻璃预览' : '拖动中 · 实时玻璃预览';
      if (status.textContent !== state) status.textContent = state;
      document.body.dataset.refraction = 'interactive';
      updateRenderProgress(0, renderSampleTarget(), false);
      return;
    }
    // Camera, theme and size changes reset samples to zero. Once converged,
    // leave the finished image on screen without continually spending GPU time.
    const sampleTarget = renderSampleTarget();
    if (pathTracer.samples < sampleTarget) pathTracer.renderSample();
    const state = pathTracer.isCompiling ? '正在准备玻璃效果…' : pathTracer.samples < sampleTarget ? '高质量玻璃渲染中' : '高透玻璃 · 渲染完成';
    if (status.textContent !== state) status.textContent = state;
    updateRenderProgress(pathTracer.samples, sampleTarget);
    document.body.dataset.refraction = pathTracer.samples >= 2 ? 'ready' : 'refining';
  } else {
    renderer.render(scene, camera);
    updateRenderProgress(0, BASE_PATH_TRACING_SAMPLES, false);
  }
});
// Read-only diagnostics for testing and future viewer maintenance.
window.cupPreview = { scene, camera, controls, renderer, get model() { return cup; }, get pathTracer() { return pathTracer; }, get decal() { return decalEditor; }, get contents() { return contentEditor; }, get project() { return activeProject?.manifest; }, get interactivePreview() { return cameraPreviewActive; }, reducedMotion };
