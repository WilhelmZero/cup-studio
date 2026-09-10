import * as THREE from 'three';
import { unzip, zip, strFromU8, strToU8 } from 'three/addons/libs/fflate.module.js';

const MAX_ZIP = 100 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
const drinkPresets = ['water', 'red-wine', 'white-wine', 'orange-juice', 'apple-juice', 'cola', 'coffee', 'milk'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
  !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

export function validateManifest(input) {
  assert(input && typeof input === 'object', '项目配置不是有效对象。');
  const p = structuredClone(input);
  assert(p.schemaVersion === 1, '不支持此项目版本，请使用版本 1 的杯型项目包。');
  assert(typeof p.id === 'string' && p.id.length && typeof p.name === 'string' && p.name.length, '项目缺少名称或标识。');
  assert(safePath(p.model) && p.model.endsWith('.glb'), '项目需要包内的 GLB 模型。');
  const d = p.dimensionsMm;
  assert(d && ['height', 'mouthOuterDiameter', 'bodyMaxDiameter'].every(k => finite(d[k]) && d[k] > 0), '杯高、杯口外径和杯身最大直径必须为正数，单位为毫米。');
  assert(d.mouthOuterDiameter <= d.bodyMaxDiameter + .5, '杯口外径不能大于杯身最大外径。');
  const area = p.printArea;
  assert(area?.kind === 'revolved', '此版本支持旋转对称杯身，项目未提供可用的圆周贴图表面。');
  assert(Array.isArray(area.profile) && area.profile.length >= 2 && area.profile.length <= 10000, '杯身外壁轮廓至少需要两个采样点。');
  let previous = -Infinity;
  for (const point of area.profile) {
    assert(finite(point.heightMm) && finite(point.radiusMm) && point.radiusMm > 0 && point.heightMm > previous,
      '外壁轮廓高度必须严格递增，半径必须为正数。');
    assert(point.heightMm >= 0 && point.heightMm <= d.height + .1, '外壁轮廓超出了杯子高度。');
    assert(point.radiusMm * 2 <= d.bodyMaxDiameter + .5, '外壁轮廓大于声明的杯身直径。');
    previous = point.heightMm;
  }
  const limits = area.heightLimitsMm, angles = area.angleLimitsDeg;
  assert(Array.isArray(limits) && limits.length === 2 && limits.every(finite) && limits[0] >= 0 && limits[1] <= d.height && limits[1] > limits[0], '可印高度范围无效。');
  assert(finite(area.minHeightGapMm) && area.minHeightGapMm > 0 && area.minHeightGapMm <= limits[1] - limits[0], '贴图最小高度间距无效。');
  assert(area.profile[0].heightMm <= limits[0] && area.profile.at(-1).heightMm >= limits[1], '外壁轮廓未覆盖全部可印高度。');
  assert(Array.isArray(angles) && angles.length === 2 && angles.every(finite) && angles[1] > angles[0] && angles[1] - angles[0] <= 360, '可印角度必须是宽度不超过 360° 的连续区间。');
  if (p.fillArea !== undefined) {
    const fill = p.fillArea, inner = fill?.innerProfile, fillLimits = fill?.heightLimitsMm;
    assert(fill?.kind === 'revolved' && Array.isArray(inner) && inner.length >= 3 && inner.length <= 10000, '杯内区域需要有效的旋转内壁轮廓。');
    let innerPrevious = -Infinity;
    inner.forEach((point, index) => {
      assert(finite(point.heightMm) && finite(point.radiusMm) && point.radiusMm >= 0 && (!index || point.radiusMm > 0) && point.heightMm > innerPrevious,
        '内壁轮廓高度必须严格递增，杯底之后的半径必须为正数。');
      assert(point.heightMm >= 0 && point.heightMm <= d.height + .1, '内壁轮廓超出了杯子高度。');
      innerPrevious = point.heightMm;
    });
    assert(Array.isArray(fillLimits) && fillLimits.length === 2 && fillLimits.every(finite) && fillLimits[0] >= 0 && fillLimits[1] <= d.height && fillLimits[1] > fillLimits[0], '杯内液位范围无效。');
    assert(inner[0].heightMm <= fillLimits[0] + 1e-6 && inner.at(-1).heightMm >= fillLimits[1] - 1e-6, '内壁轮廓未覆盖液位范围。');
    assert(finite(fill.capacityMl) && fill.capacityMl > 0, '杯子估算容量必须为正数。');
  }
  function contents(value, label) {
    if (value === undefined) return;
    assert(value && typeof value === 'object' && typeof value.enabled === 'boolean' && typeof value.motion === 'boolean', `${label}状态无效。`);
    assert(drinkPresets.includes(value.preset) && /^#[0-9a-f]{6}$/i.test(value.color), `${label}饮品或颜色无效。`);
    assert(finite(value.clarity) && value.clarity >= 0 && value.clarity <= 100 && finite(value.fillPercent) && value.fillPercent >= 0 && value.fillPercent <= 100, `${label}通透度或液位无效。`);
    assert([0, 3, 5, 8].includes(value.iceCount), `${label}冰块数量无效。`);
  }
  function placement(value, label) {
    assert(value && ['lowerMm', 'upperMm', 'rotationDeg'].every(k => finite(value[k])), `${label}缺少上下界或水平位置。`);
    assert(value.lowerMm >= limits[0] && value.upperMm <= limits[1] && value.upperMm - value.lowerMm >= area.minHeightGapMm - 1e-6, `${label}超出可印高度或小于最小间距。`);
    assert(value.rotationDeg >= angles[0] && value.rotationDeg <= angles[1], `${label}超出可印角度。`);
  }
  placement(p.defaults, '默认贴图范围');
  contents(p.defaults.contents, '默认杯内内容');
  p.design ??= { ...p.defaults, showGuides: true };
  placement(p.design, '当前贴图范围');
  contents(p.design.contents, '当前杯内内容');
  p.design.showGuides ??= true;
  assert(typeof p.design.showGuides === 'boolean', '范围线设置无效。');
  assert(p.fillArea || !(p.defaults.contents?.enabled || p.design.contents?.enabled), '启用杯内内容的项目缺少内壁轮廓。');
  if (p.design.artwork) {
    const a = p.design.artwork;
    assert(safePath(a.path) && typeof a.name === 'string' && imageTypes.includes(a.mimeType), '贴图需要包内的 PNG、JPG 或 WebP 图片。');
    assert(a.path !== p.model && a.path !== 'project.json', '贴图资源路径与项目文件冲突。');
  }
  if (p.preview !== undefined) assert(safePath(p.preview) && /\.(png|jpe?g|webp)$/i.test(p.preview) && ![p.model, 'project.json', p.design.artwork?.path].includes(p.preview), '项目预览图路径无效。');
  p.view ??= { theme: 'dark' };
  p.view.theme ??= 'dark';
  assert(['dark', 'light', 'warm'].includes(p.view.theme), '背景设置无效。');
  assert(Array.isArray(p.dimensionSources) && p.dimensionSources.length > 0, '项目需要记录尺寸来源或估算说明。');
  assert(p.dimensionSources.every(s => s && typeof s.field === 'string' && ['user', 'image', 'estimated'].includes(s.source) && typeof s.note === 'string' && finite(s.valueMm)), '尺寸来源记录无效。');
  return p;
}

// Inspect central-directory sizes before allowing the decompressor to allocate.
function inspectZip(bytes) {
  assert(bytes.byteLength >= 22, '文件不是有效的 ZIP 项目包。');
  assert(bytes.byteLength <= MAX_ZIP, '项目包请小于 100 MB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // fflate selects the first signature found while searching backwards. Do not
  // skip a misleading signature in a comment and inspect a different directory.
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  assert(end >= 0, '文件不是有效的 ZIP 项目包。');
  assert(end + 22 + view.getUint16(end + 20, true) === bytes.length, '项目包结尾或注释记录无效。');
  const diskCount = view.getUint16(end + 8, true), count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  assert(count > 0 && count <= 128 && diskCount === count && view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0, '项目包文件数量不一致、过多或使用了不支持的分卷格式。');
  assert(directorySize > 0 && offset + directorySize === end, '项目包目录大小或位置无效。');
  let position = offset, size = 0;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert(position + 46 <= end && view.getUint32(position, true) === 0x02014b50, '项目包目录损坏。');
    const nameLength = view.getUint16(position + 28, true), extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true);
    assert(position + 46 + nameLength + extraLength + commentLength <= end, '项目包目录不完整。');
    const flags = view.getUint16(position + 8, true), compression = view.getUint16(position + 10, true);
    // Use the same UTF-8 flag and legacy decoding as fflate's central-directory reader.
    const name = strFromU8(bytes.subarray(position + 46, position + 46 + nameLength), !(flags & 2048));
    const plainName = name.endsWith('/') ? name.slice(0, -1) : name;
    assert(safePath(plainName) && !entries.has(name) && name !== '__proto__', '项目包包含无效路径或重复文件。');
    assert(!(flags & 1), '不支持加密项目包。');
    assert(compression === 0 || compression === 8, '项目包使用了不支持的压缩方式。');
    assert(view.getUint16(position + 34, true) === 0, '不支持分卷项目包。');
    const compressedSize = view.getUint32(position + 20, true), originalSize = view.getUint32(position + 24, true);
    assert(compression !== 0 || compressedSize === originalSize, '项目包文件大小记录不一致。');
    const localOffset = view.getUint32(position + 42, true);
    assert(localOffset + 30 <= offset && view.getUint32(localOffset, true) === 0x04034b50, '项目包文件位置无效。');
    const localFlags = view.getUint16(localOffset + 6, true), localNameLength = view.getUint16(localOffset + 26, true);
    const dataOffset = localOffset + 30 + localNameLength + view.getUint16(localOffset + 28, true);
    assert(dataOffset + compressedSize <= offset, '项目包文件数据超出了有效范围。');
    const localName = strFromU8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength), !(localFlags & 2048));
    assert(localName === name && localFlags === flags && view.getUint16(localOffset + 8, true) === compression, '项目包文件与目录记录不一致。');
    entries.set(name, { size: compressedSize, originalSize, compression });
    size += originalSize;
    assert(size <= MAX_EXPANDED, '项目包解压后超过 256 MB。');
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert(position === end, '项目包目录条目数与目录大小不一致。');
  return entries;
}

export function validateGlb(bytes) {
  assert(bytes.length >= 20, 'GLB 模型不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.length, 'GLB 模型头部或长度无效。');
  const length = view.getUint32(12, true);
  assert(view.getUint32(16, true) === 0x4e4f534a && 20 + length <= bytes.length, 'GLB 模型缺少有效的描述信息。');
  let json;
  try { json = JSON.parse(strFromU8(bytes.subarray(20, 20 + length))); } catch { throw new Error('GLB 模型描述无法读取。'); }
  assert(json.meshes?.length > 0, 'GLB 没有杯子网格。');
  assert(!json.skins?.length && !json.animations?.length, '杯型项目需要静态模型。');
  for (const asset of [...(json.buffers || []), ...(json.images || [])]) {
    assert(!asset.uri || /^data:/i.test(asset.uri), '模型包含外部资源，请先将资源嵌入 GLB。');
  }
  return json;
}

export async function readProjectPackage(source) {
  if (typeof source?.size === 'number') assert(source.size <= MAX_ZIP, '项目包请小于 100 MB。');
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source instanceof ArrayBuffer ? source : await source.arrayBuffer());
  const entries = inspectZip(bytes), visited = new Set();
  const files = await new Promise((resolve, reject) => {
    let filterError;
    unzip(bytes, { filter(entry) {
      if (filterError) return false;
      const expected = entries.get(entry.name);
      if (!expected || visited.has(entry.name) || entry.size !== expected.size ||
          entry.originalSize !== expected.originalSize || entry.compression !== expected.compression) {
        filterError = new Error('项目包解压目录与检查结果不一致。');
        return false;
      }
      visited.add(entry.name);
      return true;
    } }, (error, result) => {
      if (filterError || error) reject(filterError || new Error('项目包解压失败。'));
      else if (visited.size !== entries.size) reject(new Error('项目包解压条目不完整。'));
      else resolve(result);
    });
  });
  for (const [name, entry] of entries) {
    assert(Object.hasOwn(files, name) && files[name].length === entry.originalSize, '项目包文件实际大小与目录记录不一致。');
  }
  assert(files['project.json'], '项目包根目录缺少 project.json。');
  assert(Object.values(files).reduce((sum, data) => sum + data.length, 0) <= MAX_EXPANDED, '项目资源超过大小限制。');
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['project.json'])); } catch { throw new Error('project.json 不是有效的 JSON。'); }
  manifest = validateManifest(manifest);
  const modelBytes = files[manifest.model];
  assert(modelBytes, '项目包缺少配置指定的 GLB 模型。');
  validateGlb(modelBytes);
  let artworkFile;
  if (manifest.design.artwork) {
    const a = manifest.design.artwork, data = files[a.path];
    assert(data?.length && data.length <= MAX_IMAGE, '项目贴图缺失或超过 20 MB。');
    artworkFile = new File([data], a.name, { type: a.mimeType });
    try { const bitmap = await createImageBitmap(artworkFile); bitmap.close(); } catch { throw new Error('项目贴图无法读取，请使用有效的 PNG、JPG 或 WebP。'); }
  }
  const previewBytes = manifest.preview ? files[manifest.preview] : undefined;
  if (manifest.preview) assert(previewBytes?.length, '项目包缺少配置指定的预览图。');
  return { manifest, modelBytes, artworkFile, previewBytes };
}

export async function writeProjectPackage(project, design, artworkFile, theme) {
  const manifest = structuredClone(project.manifest);
  manifest.design = { ...design };
  delete manifest.design.artwork;
  manifest.view = { ...manifest.view, theme };
  const files = { [manifest.model]: project.modelBytes };
  if (artworkFile) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[artworkFile.type];
    assert(extension, '贴图格式不支持保存。');
    const path = `artwork.${extension}`;
    assert(path !== manifest.model && path !== manifest.preview, '项目贴图保存路径冲突。');
    manifest.design.artwork = { path, name: artworkFile.name, mimeType: artworkFile.type };
    files[path] = new Uint8Array(await artworkFile.arrayBuffer());
  }
  if (manifest.preview && project.previewBytes) files[manifest.preview] = project.previewBytes;
  files['project.json'] = strToU8(JSON.stringify(validateManifest(manifest), null, 2));
  const bytes = await new Promise((resolve, reject) => zip(files, { level: 6 }, (error, result) => error ? reject(error) : resolve(result)));
  inspectZip(bytes);
  return bytes;
}

function profileRadius(profile, height) {
  const next = profile.findIndex(p => p.heightMm >= height);
  if (next <= 0) return profile[next === 0 ? 0 : profile.length - 1].radiusMm;
  const a = profile[next - 1], b = profile[next];
  return THREE.MathUtils.lerp(a.radiusMm, b.radiusMm, (height - a.heightMm) / (b.heightMm - a.heightMm));
}

export function validateModelSurface(model, manifest) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const heightMm = (box.max.y - box.min.y) * 1000;
  assert(Number.isFinite(heightMm) && Math.abs(heightMm - manifest.dimensionsMm.height) <= Math.max(.5, manifest.dimensionsMm.height * .01), '模型实际高度与项目尺寸不一致，请检查米／毫米单位。');
  assert(Math.abs(box.min.y * 1000) <= .5, '模型杯底需要位于 Y = 0。');
  const meshes = [];
  model.traverse(object => { if (object.isMesh) meshes.push(object); });
  const area = manifest.printArea, raycaster = new THREE.Raycaster();
  const [min, max] = area.heightLimitsMm, [start, end] = area.angleLimitsDeg;
  const distance = Math.max(box.getSize(new THREE.Vector3()).length(), manifest.dimensionsMm.bodyMaxDiameter / 1000) * 2;
  for (const fraction of [.04, .25, .5, .75, .96]) {
    const h = THREE.MathUtils.lerp(min, max, fraction), radius = profileRadius(area.profile, h);
    for (const a of [.2, .5, .8]) {
      const theta = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(start, end, a));
      const direction = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
      raycaster.set(new THREE.Vector3(direction.x * distance, h / 1000, direction.z * distance), direction.clone().negate());
      const hit = raycaster.intersectObjects(meshes, false)[0];
      assert(hit && Math.abs(Math.hypot(hit.point.x, hit.point.z) * 1000 - radius) <= Math.max(.35, radius * .01), '可印区域轮廓与模型外壁不一致，或区域内包含把手。');
    }
  }
  if (manifest.fillArea) {
    const fill = manifest.fillArea, [floor, top] = fill.heightLimitsMm;
    for (const fraction of [.08, .3, .55, .8, .96]) {
      const h = THREE.MathUtils.lerp(floor, top, fraction);
      const expected = profileRadius(fill.innerProfile, h);
      for (const theta of [0, Math.PI * .5, Math.PI, Math.PI * 1.5]) {
        const direction = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
        raycaster.set(new THREE.Vector3(0, h / 1000, 0), direction);
        const hit = raycaster.intersectObjects(meshes, false)[0];
        assert(hit && Math.abs(hit.distance * 1000 - expected) <= Math.max(.45, expected * .015),
          '杯内轮廓与模型内壁不一致，请使用对应生成器重新打包。');
      }
    }
  }
  return box;
}

let dbPromise;
function database() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('cup-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('浏览器本地保存暂不可用。'));
  }).catch(error => { dbPromise = undefined; throw error; });
  return dbPromise;
}

export async function loadRecentProject() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').get('recent');
    request.onsuccess = () => resolve(request.result?.bytes);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecentProject(bytes) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put({ bytes, savedAt: Date.now() }, 'recent');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
