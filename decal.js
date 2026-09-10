import * as THREE from 'three';

const OFFSET_MM = .05;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const clamp = THREE.MathUtils.clamp;
const radians = THREE.MathUtils.degToRad;
const degrees = THREE.MathUtils.radToDeg;
let activeEditor;

// Kept for converting the original cup's complete section into a project.
export function outsideProfile(section) {
  const bottom = section.reduce((best, point, i) => point[1] < section[best][1] ? i : best, 0);
  const top = section.reduce((best, point, i) => point[1] > section[best][1] ? i : best, 0);
  return section.slice(bottom, top + 1);
}

const pointHeight = point => Array.isArray(point) ? point[1] : point.heightMm;
const pointRadius = point => Array.isArray(point) ? point[0] : point.radiusMm;

export function radiusAt(profile, height) {
  const next = profile.findIndex(point => pointHeight(point) >= height);
  if (next <= 0) return pointRadius(profile[next === 0 ? 0 : profile.length - 1]);
  const a = profile[next - 1], b = profile[next];
  return THREE.MathUtils.lerp(pointRadius(a), pointRadius(b),
    (height - pointHeight(a)) / (pointHeight(b) - pointHeight(a)));
}

function minimumRadius(profile, lower, upper) {
  let minimum = Math.min(radiusAt(profile, lower), radiusAt(profile, upper));
  for (const point of profile) {
    const height = pointHeight(point);
    if (height > lower && height < upper) minimum = Math.min(minimum, pointRadius(point));
  }
  return minimum;
}

export function decalLayout(profile, lower, upper, aspect, angleLimitsDeg = [-180, 180]) {
  const span = angleLimitsDeg[1] - angleLimitsDeg[0];
  const fullCircle = span >= 360 - 1e-7;
  // Keep a small seam on a complete wrap. Restricted sectors already contain
  // the project's handle clearance; only a numerical margin is needed there.
  const maxAngle = radians(span) - (fullCircle ? .03 : Math.min(.00001, radians(span) * .00001));
  const middle = (lower + upper) / 2;
  const angleForHeight = height => height * aspect /
    minimumRadius(profile, middle - height / 2, middle + height / 2);
  let height = upper - lower;
  if (angleForHeight(height) > maxAngle) {
    // The minimum radius over a growing interval cannot increase. Bisection
    // therefore finds the largest image that fits even across a shoulder.
    let low = 0, high = height;
    for (let i = 0; i < 36; i++) {
      const candidate = (low + high) / 2;
      if (angleForHeight(candidate) <= maxAngle) low = candidate;
      else high = candidate;
    }
    height = low;
  }
  const actualLower = middle - height / 2, actualUpper = middle + height / 2;
  const minRadius = minimumRadius(profile, actualLower, actualUpper);
  return {
    lower: actualLower, upper: actualUpper, widthMm: height * aspect,
    angle: height * aspect / minRadius, minRadius,
    fitted: height < upper - lower - 1e-6,
  };
}

export function createDecalGeometry(profile, layout, rotation, uvBounds = [0, 0, 1, 1]) {
  const { lower, upper, angle } = layout;
  const profileHeights = [lower, ...profile.map(pointHeight).filter(height => height > lower && height < upper), upper];
  const maxRadius = Math.max(...profileHeights.map(height => radiusAt(profile, height)));
  const angularStep = Math.min(Math.PI * 2 / 256, Math.sqrt(OFFSET_MM / maxRadius));
  const heights = [lower];
  const edgeAngle = height => layout.widthMm === undefined ? angle / 2 : layout.widthMm / radiusAt(profile, height) / 2;
  function appendHeightInterval(a, b, depth = 0) {
    // A sparse tapered profile can otherwise put a twisted triangle through
    // the glass even when all of its vertices sit outside. Limit angular
    // change vertically as well as horizontally to keep the whole patch out.
    if (Math.abs(edgeAngle(b) - edgeAngle(a)) > angularStep && depth < 20) {
      const middle = (a + b) / 2;
      appendHeightInterval(a, middle, depth + 1);
      appendHeightInterval(middle, b, depth + 1);
    } else heights.push(b);
  }
  for (let i = 1; i < profileHeights.length; i++) appendHeightInterval(profileHeights[i - 1], profileHeights[i]);
  const columns = Math.max(16, Math.ceil(angle / angularStep));
  const vertices = [], uvs = [], indices = [];
  for (let row = 0; row < heights.length; row++) {
    const height = heights[row];
    const surfaceRadius = radiusAt(profile, height);
    const radius = (surfaceRadius + OFFSET_MM) / 1000;
    // Constant arc width keeps the image's horizontal scale consistent when
    // the cup narrows. The layout's angle is the largest angular footprint.
    const rowAngle = layout.widthMm === undefined ? angle : layout.widthMm / surfaceRadius;
    for (let col = 0; col <= columns; col++) {
      const u = col / columns, v = (height - lower) / (upper - lower);
      const theta = (u - .5) * rowAngle + rotation;
      vertices.push(radius * Math.sin(theta), height / 1000, radius * Math.cos(theta));
      uvs.push(THREE.MathUtils.lerp(uvBounds[0], uvBounds[2], u),
        THREE.MathUtils.lerp(uvBounds[1], uvBounds[3], v));
      if (row < heights.length - 1 && col < columns) {
        const a = row * (columns + 1) + col, b = a + columns + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createDecalEditor({ cup, stage, camera, controls, project, rebuildScene, onPanelChange, onChange }) {
  const byId = id => document.getElementById(`decal-${id}`);
  const panel = byId('panel'), toggle = byId('toggle'), fileInput = byId('file');
  const message = byId('message'), fieldset = byId('controls');
  const thumbnail = byId('thumbnail'), filename = byId('filename');
  const area = project.printArea, profile = area.profile;
  const [minHeight, maxHeight] = area.heightLimitsMm;
  const [minAngle, maxAngle] = area.angleLimitsDeg;
  const minGap = area.minHeightGapMm;
  const fullCircle = maxAngle - minAngle >= 360 - 1e-7;
  const initial = project.design ?? project.defaults;
  const state = {
    lowerMm: initial.lowerMm, upperMm: initial.upperMm, rotationDeg: initial.rotationDeg,
    showGuides: initial.showGuides ?? true, fileName: '', aspect: 1,
  };
  const owner = Symbol('cup decal editor');
  activeEditor = owner;
  let disposed = false, generation = 0, timer;
  let mesh, texture, thumbnailUrl, originalFile, layout, uvBounds = [0, 0, 1, 1];
  const listeners = [];
  const ownsUI = () => !disposed && activeEditor === owner;
  const abortError = () => new DOMException('贴图读取已取消。', 'AbortError');
  const ns = 'http://www.w3.org/2000/svg';
  const guides = document.createElementNS(ns, 'svg');
  guides.setAttribute('aria-hidden', 'true');
  guides.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
  stage.appendChild(guides);

  function listen(target, type, handler) {
    const guarded = event => { if (ownsUI()) handler(event); };
    target.addEventListener(type, guarded);
    listeners.push(() => target.removeEventListener(type, guarded));
  }

  function getDesign() {
    return { lowerMm: state.lowerMm, upperMm: state.upperMm,
      rotationDeg: state.rotationDeg, showGuides: state.showGuides };
  }

  function rotationBounds(candidateLayout = layout) {
    if (fullCircle || !candidateLayout) return [minAngle, maxAngle];
    const half = Math.min(degrees(candidateLayout.angle) / 2, (maxAngle - minAngle) / 2);
    return [minAngle + half, maxAngle - half];
  }

  function syncInputs() {
    if (!ownsUI()) return;
    for (const [key, value, min, max] of [
      ['lower', state.lowerMm, minHeight, state.upperMm - minGap],
      ['upper', state.upperMm, state.lowerMm + minGap, maxHeight],
    ]) {
      for (const id of [key, `${key}-number`]) {
        const input = byId(id);
        input.min = String(min);
        input.max = String(max);
        input.step = '0.1';
        input.value = String(value);
      }
    }
    const [rotationMin, rotationMax] = rotationBounds();
    const rotation = byId('rotation');
    rotation.min = String(rotationMin);
    rotation.max = String(rotationMax);
    rotation.step = '0.1';
    rotation.value = String(state.rotationDeg);
    byId('rotation-value').value = `${Number(state.rotationDeg.toFixed(1))}°`;
    byId('guides').checked = state.showGuides;
  }

  function showPanel(open) {
    if (!ownsUI()) return;
    if (open && !document.getElementById('contents-panel').hidden) document.getElementById('contents-close').click();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('decal-panel-open', open);
    updateGuides();
    onPanelChange?.();
  }
  listen(toggle, 'click', () => showPanel(panel.hidden));
  listen(byId('close'), 'click', () => { showPanel(false); toggle.focus(); });
  listen(panel, 'keydown', event => {
    if (event.key === 'Escape') { showPanel(false); toggle.focus(); }
  });

  function updateGuides() {
    if (disposed) return;
    guides.replaceChildren();
    if (!ownsUI() || panel.hidden || !mesh || !state.showGuides) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (width <= 0 || height <= 0) return;
    guides.setAttribute('viewBox', `0 0 ${width} ${height}`);
    cup.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    for (const [bound, color] of [[state.upperMm, '#f2c779'], [state.lowerMm, '#91e0d0']]) {
      const radius = (radiusAt(profile, bound) + .35) / 1000;
      const points = [];
      const segments = Math.max(12, Math.ceil(96 * (maxAngle - minAngle) / 360));
      for (let i = 0; i <= segments; i++) {
        const theta = radians(THREE.MathUtils.lerp(minAngle, maxAngle, i / segments));
        const point = cup.localToWorld(new THREE.Vector3(radius * Math.sin(theta), bound / 1000,
          radius * Math.cos(theta))).project(camera);
        points.push([(point.x + 1) * width / 2, (1 - point.y) * height / 2]);
      }
      const ring = document.createElementNS(ns, 'polyline');
      ring.setAttribute('points', points.map(point => point.map(value => value.toFixed(1)).join(',')).join(' '));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', '1.4');
      ring.setAttribute('stroke-dasharray', '4 4');
      guides.appendChild(ring);
      const right = points.reduce((a, b) => b[0] > a[0] ? b : a);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', Math.max(4, Math.min(right[0] + 7, width - 64)));
      label.setAttribute('y', clamp(right[1] + 4, 14, Math.max(14, height - 8)));
      label.setAttribute('fill', color);
      label.setAttribute('font-size', '11');
      label.setAttribute('font-family', 'sans-serif');
      label.setAttribute('paint-order', 'stroke');
      label.setAttribute('stroke', '#29343a');
      label.setAttribute('stroke-width', '2');
      label.textContent = `${Number(bound.toFixed(1))} mm`;
      guides.appendChild(label);
    }
  }

  function scheduleRebuild(immediate = false) {
    clearTimeout(timer);
    const rebuild = () => { if (ownsUI()) rebuildScene?.(); };
    if (immediate) rebuild();
    else timer = setTimeout(rebuild, 140);
  }

  function updateMesh(immediate = false) {
    if (!ownsUI() || !mesh) return;
    layout = decalLayout(profile, state.lowerMm, state.upperMm, state.aspect, area.angleLimitsDeg);
    state.rotationDeg = clamp(state.rotationDeg, ...rotationBounds());
    const previousGeometry = mesh.geometry;
    mesh.geometry = createDecalGeometry(profile, layout, radians(state.rotationDeg), uvBounds);
    previousGeometry.dispose();
    mesh.userData.decal = { ...getDesign(), fileName: state.fileName,
      actualLowerMm: layout.lower, actualUpperMm: layout.upper };
    message.textContent = layout.fitted ? '图片已等比适配到允许贴图的区域。' : '已贴合杯身，可调整上下边界与水平位置。';
    syncInputs();
    updateGuides();
    scheduleRebuild(immediate);
  }

  for (const key of ['lower', 'upper']) {
    for (const id of [key, `${key}-number`]) {
      const input = byId(id);
      listen(input, input.type === 'range' ? 'input' : 'change', () => {
        if (!mesh || input.value === '' || !Number.isFinite(Number(input.value))) return;
        const value = Math.round(Number(input.value) * 10) / 10;
        if (key === 'lower') state.lowerMm = clamp(value, minHeight, state.upperMm - minGap);
        else state.upperMm = clamp(value, state.lowerMm + minGap, maxHeight);
        updateMesh();
        onChange?.();
      });
      listen(input, 'blur', syncInputs);
    }
  }
  listen(byId('rotation'), 'input', event => {
    if (!mesh || !Number.isFinite(Number(event.target.value))) return;
    state.rotationDeg = clamp(Number(event.target.value), ...rotationBounds());
    updateMesh();
    onChange?.();
  });
  listen(byId('guides'), 'change', event => {
    state.showGuides = event.target.checked;
    updateGuides();
    onChange?.();
  });
  listen(controls, 'change', updateGuides);

  function releaseImage() {
    if (mesh) {
      cup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = undefined;
    }
    texture?.dispose();
    texture = undefined;
    originalFile = undefined;
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    thumbnailUrl = undefined;
  }

  async function setArtwork(file, { notify = true } = {}) {
    if (!ownsUI()) throw abortError();
    const ticket = ++generation;
    if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片请小于 20 MB。');
    message.textContent = '正在读取图片…';
    let bitmap, nextTexture, nextMaterial, nextGeometry, nextUrl, committed = false;
    try {
      bitmap = await createImageBitmap(file);
      if (ticket !== generation || !ownsUI()) throw abortError();
      if (!bitmap.width || !bitmap.height) throw new Error('图片尺寸无效。');
      // Retain enough pixels for fine logos and scattered artwork while
      // fitting the path tracer's 2048px material-texture layer.
      const scale = Math.min(1, 2044 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width + 4;
      canvas.height = height + 4;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法读取图片，请重试。');
      // Original bytes remain in originalFile; this padded canvas is only the
      // GPU preview. Inset UVs retain the original image's aspect ratio.
      context.drawImage(bitmap, 2, 2, width, height);
      nextTexture = new THREE.CanvasTexture(canvas);
      nextTexture.colorSpace = THREE.SRGBColorSpace;
      nextTexture.wrapS = nextTexture.wrapT = THREE.ClampToEdgeWrapping;
      nextTexture.name = file.name || 'artwork';
      const aspect = bitmap.width / bitmap.height;
      const nextLayout = decalLayout(profile, state.lowerMm, state.upperMm, aspect, area.angleLimitsDeg);
      const rotation = clamp(state.rotationDeg, ...rotationBounds(nextLayout));
      const nextUvBounds = [2 / canvas.width, 2 / canvas.height,
        (width + 2) / canvas.width, (height + 2) / canvas.height];
      nextGeometry = createDecalGeometry(profile, nextLayout, radians(rotation), nextUvBounds);
      // Printed artwork is opaque wherever the PNG has visible ink. A small
      // deterministic alpha cutout preserves antialiased edges without the
      // path tracer's stochastic transparent-surface noise.
      nextMaterial = new THREE.MeshStandardMaterial({ map: nextTexture, transparent: false,
        alphaTest: .08, opacity: 1, roughness: .38, metalness: 0, side: THREE.DoubleSide, depthWrite: true });
      nextMaterial.name = 'Cup body print';
      nextUrl = URL.createObjectURL(file);

      clearTimeout(timer);
      releaseImage();
      texture = nextTexture;
      originalFile = file;
      thumbnailUrl = nextUrl;
      layout = nextLayout;
      uvBounds = nextUvBounds;
      state.aspect = aspect;
      state.rotationDeg = rotation;
      state.fileName = file.name || 'artwork';
      mesh = new THREE.Mesh(nextGeometry, nextMaterial);
      mesh.name = 'Cup body artwork';
      mesh.renderOrder = 1;
      mesh.userData.decal = { ...getDesign(), fileName: state.fileName,
        actualLowerMm: layout.lower, actualUpperMm: layout.upper };
      cup.add(mesh);
      committed = true;
      thumbnail.src = thumbnailUrl;
      thumbnail.hidden = false;
      filename.textContent = state.fileName;
      fieldset.disabled = false;
      message.textContent = layout.fitted ? '图片已等比适配到允许贴图的区域。' : '已贴合杯身，可调整上下边界与水平位置。';
      syncInputs();
      updateGuides();
      if (notify) {
        scheduleRebuild(true);
        onChange?.();
      }
      return mesh;
    } catch (error) {
      if (ticket !== generation || !ownsUI()) throw abortError();
      throw error;
    } finally {
      bitmap?.close();
      if (!committed) {
        nextGeometry?.dispose();
        nextMaterial?.dispose();
        nextTexture?.dispose();
        if (nextUrl) URL.revokeObjectURL(nextUrl);
      }
    }
  }

  listen(fileInput, 'change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try { await setArtwork(file); }
    catch (error) {
      if (ownsUI() && error.name !== 'AbortError') {
        message.textContent = IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES
          ? '图片读取失败，请尝试另一张 PNG、JPG 或 WebP。' : error.message;
        console.error('Image import failed', error);
      }
    }
  });

  listen(byId('remove'), 'click', () => {
    generation++;
    clearTimeout(timer);
    releaseImage();
    layout = undefined;
    state.fileName = '';
    state.aspect = 1;
    thumbnail.removeAttribute('src');
    thumbnail.hidden = true;
    filename.textContent = '未导入图片';
    message.textContent = '已移除图片。';
    fieldset.disabled = true;
    syncInputs();
    updateGuides();
    scheduleRebuild(true);
    onChange?.();
  });

  function dispose() {
    if (disposed) return;
    const clearUI = activeEditor === owner;
    disposed = true;
    generation++;
    clearTimeout(timer);
    listeners.forEach(remove => remove());
    listeners.length = 0;
    releaseImage();
    guides.remove();
    if (clearUI) {
      activeEditor = undefined;
      thumbnail.removeAttribute('src');
      thumbnail.hidden = true;
      filename.textContent = '未导入图片';
      message.textContent = '';
      fieldset.disabled = true;
    }
  }

  thumbnail.removeAttribute('src');
  thumbnail.hidden = true;
  filename.textContent = '未导入图片';
  message.textContent = '';
  fieldset.disabled = true;
  fileInput.value = '';
  syncInputs();
  return {
    setArtwork, getDesign, updateGuides, dispose,
    get artworkFile() { return originalFile; },
    get mesh() { return mesh; },
    get state() { return { ...state, lower: state.lowerMm, upper: state.upperMm, rotation: state.rotationDeg }; },
    get layout() { return layout && { ...layout }; },
    get hasImage() { return Boolean(mesh); },
  };
}
