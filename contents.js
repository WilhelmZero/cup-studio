import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const PRESETS = {
  water:          { color:'#d7f1f5', clarity:85, transmission:1.00, roughness:.025, distanceMm:900 },
  'red-wine':     { color:'#6f0717', clarity:70, transmission:.95, roughness:.035, distanceMm:95 },
  'white-wine':   { color:'#eadb83', clarity:78, transmission:.96, roughness:.035, distanceMm:180 },
  'orange-juice': { color:'#f27d0c', clarity:38, transmission:.68, roughness:.09, distanceMm:42 },
  'apple-juice':  { color:'#c88b22', clarity:62, transmission:.86, roughness:.06, distanceMm:85 },
  cola:           { color:'#351006', clarity:48, transmission:.82, roughness:.055, distanceMm:35 },
  coffee:         { color:'#3a1608', clarity:12, transmission:.18, roughness:.16, distanceMm:18 },
  milk:           { color:'#f2ead8', clarity:4, transmission:.04, roughness:.22, distanceMm:8 },
};
const ICE_LEVELS = new Set([0, 3, 5, 8]);
let activeEditor;

function radiusAt(profile, height) {
  if (height <= profile[0].heightMm) return profile[0].radiusMm;
  for (let i = 1; i < profile.length; i++) {
    if (height <= profile[i].heightMm) {
      const a = profile[i - 1], b = profile[i];
      return THREE.MathUtils.lerp(a.radiusMm, b.radiusMm, (height - a.heightMm) / (b.heightMm - a.heightMm));
    }
  }
  return profile.at(-1).radiusMm;
}

function segmentVolume(a, b) {
  return Math.PI * (b.heightMm - a.heightMm) *
    (a.radiusMm ** 2 + a.radiusMm * b.radiusMm + b.radiusMm ** 2) / 3000;
}

function volumeTo(profile, floor, height) {
  let volume = 0, previous = { heightMm: floor, radiusMm: radiusAt(profile, floor) };
  for (const point of profile) {
    if (point.heightMm <= floor) continue;
    const nextHeight = Math.min(point.heightMm, height);
    const next = { heightMm: nextHeight, radiusMm: radiusAt(profile, nextHeight) };
    volume += segmentVolume(previous, next);
    previous = next;
    if (point.heightMm >= height) break;
  }
  return volume;
}

function heightForVolume(profile, limits, fraction) {
  const [floor, top] = limits;
  if (fraction <= 0) return floor;
  if (fraction >= 1) return top;
  const total = volumeTo(profile, floor, top), target = total * fraction;
  let low = floor, high = top;
  for (let i = 0; i < 36; i++) {
    const middle = (low + high) / 2;
    if (volumeTo(profile, floor, middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function hashSeed(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function randomFrom(seed) {
  let value = seed || 1;
  return () => ((value = Math.imul(value ^ value >>> 15, 1 | value), value ^= value + Math.imul(value ^ value >>> 7, 61 | value), ((value ^ value >>> 14) >>> 0) / 4294967296));
}

function disposeObject(root) {
  root.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    object.material.dispose();
  });
  root.removeFromParent();
}

export function createContentsEditor({ cup, project, reducedMotion, onPanelChange, onPreview, onCommit }) {
  const byId = id => document.getElementById(`contents-${id}`);
  const panel = byId('panel'), toggle = byId('toggle'), fieldset = byId('controls');
  const unavailable = byId('unavailable'), message = byId('message');
  const fillArea = project.fillArea;
  const fallback = { enabled:false, preset:'water', color:'#d7f1f5', clarity:85, fillPercent:60, iceCount:0, motion:true };
  const supplied = project.design?.contents ?? project.defaults?.contents ?? fallback;
  const state = { ...fallback, ...supplied };
  const owner = Symbol('cup contents editor');
  activeEditor = owner;
  const ownsUI = () => !disposed && activeEditor === owner;
  const listeners = [];
  const group = new THREE.Group();
  group.name = 'Cup contents';
  group.userData.cupContents = true;
  cup.add(group);
  let disposed = false, liquid, iceGroup, liquidBase, liquidHeight = 0, interactive = false;

  function listen(target, type, handler) {
    const guarded = event => { if (ownsUI()) handler(event); };
    target.addEventListener(type, guarded);
    listeners.push(() => target.removeEventListener(type, guarded));
  }

  function getDesign() { return { ...state }; }

  function syncInputs() {
    if (!ownsUI()) return;
    byId('enabled').checked = state.enabled;
    byId('preset').value = state.preset;
    byId('color').value = state.color;
    byId('clarity').value = String(state.clarity);
    byId('clarity-value').value = `${state.clarity}%`;
    byId('fill').value = String(state.fillPercent);
    byId('fill-value').value = `${state.fillPercent}% · 约 ${Math.round((fillArea?.capacityMl || 0) * state.fillPercent / 100)} mL`;
    byId('ice').value = String(state.iceCount);
    byId('motion').checked = state.motion;
    byId('motion').disabled = reducedMotion;
    [...fieldset.querySelectorAll('input,select,button')].forEach(control => {
      if (control.id !== 'contents-enabled' && control.id !== 'contents-clear') control.disabled = !state.enabled || !fillArea || (control.id === 'contents-motion' && reducedMotion);
    });
  }

  function showPanel(open) {
    if (!ownsUI()) return;
    if (open && !document.getElementById('decal-panel').hidden) document.getElementById('decal-close').click();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('contents-panel-open', open);
    onPanelChange?.();
  }

  function clearGeometry() {
    for (const child of [...group.children]) disposeObject(child);
    liquid = iceGroup = liquidBase = undefined;
  }

  function liquidMaterial() {
    const preset = PRESETS[state.preset], clarity = state.clarity / 100;
    const transmission = THREE.MathUtils.clamp(preset.transmission * (.28 + clarity * .72), 0, 1);
    const color = new THREE.Color(state.color);
    const material = new THREE.MeshPhysicalMaterial({
      color: preset.transmission < .25 ? color : new THREE.Color('#ffffff'),
      transmission, roughness: preset.roughness + (1 - clarity) * .08, metalness:0,
      ior:1.333, thickness:2.5, attenuationColor:color,
      attenuationDistance:preset.distanceMm * (.3 + clarity * 1.7) / 10,
      side:THREE.FrontSide,
    });
    material.name = `Drink · ${state.preset}`;
    material.userData.cupContent = 'liquid';
    return material;
  }

  function liquidGeometry(height) {
    const profile = fillArea.innerProfile, floor = fillArea.heightLimitsMm[0], clearance = .35;
    const points = [new THREE.Vector2(0, floor / 1000)];
    const heights = [floor, ...profile.map(p => p.heightMm).filter(h => h > floor && h < height), height];
    for (const h of heights) {
      const radius = Math.max(.05, radiusAt(profile, h) - clearance);
      if (h > floor + 1e-5) points.push(new THREE.Vector2(radius / 1000, h / 1000));
    }
    points.push(new THREE.Vector2(0, height / 1000));
    const geometry = new THREE.LatheGeometry(points, 128);
    geometry.computeVertexNormals();
    geometry.userData.fillHeight = height / 1000;
    return geometry;
  }

  function makeIce(height) {
    const requested = state.iceCount;
    if (!requested || state.fillPercent < 10) return { group:undefined, count:0 };
    const floor = fillArea.heightLimitsMm[0], depth = height - floor;
    const localRadius = radiusAt(fillArea.innerProfile, Math.max(floor, height - Math.min(10, depth * .25)));
    const size = THREE.MathUtils.clamp(Math.min(localRadius * .42, depth * .32), 7, 16);
    const maxCount = size < 7.5 || depth < 9 ? 0 : requested;
    if (!maxCount) return { group:undefined, count:0 };
    const holder = new THREE.Group();
    holder.name = 'Ice cubes';
    holder.userData.cupContent = 'ice';
    const random = randomFrom(hashSeed(`${project.id}:${requested}:${state.fillPercent}`));
    const positions = [];
    for (let i = 0; i < maxCount; i++) {
      let accepted;
      for (let attempt = 0; attempt < 60 && !accepted; attempt++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * Math.max(0, localRadius - size * 1.05);
        const x = Math.sin(angle) * distance, z = Math.cos(angle) * distance;
        if (positions.every(p => Math.hypot(p.x - x, p.z - z) > size * .9)) accepted = { x, z };
      }
      if (!accepted) break;
      positions.push(accepted);
      const sx = size * (.82 + random() * .24), sy = size * (.72 + random() * .28), sz = size * (.82 + random() * .24);
      const geometry = new RoundedBoxGeometry(sx / 1000, sy / 1000, sz / 1000, 3, Math.min(sx, sy, sz) * .16 / 1000);
      const material = new THREE.MeshPhysicalMaterial({color:'#e8fbff', transmission:.96, roughness:.11, ior:1.31,
        thickness:.7, attenuationColor:new THREE.Color('#d8f5fb'), attenuationDistance:8, side:THREE.FrontSide});
      material.name = 'Ice';
      material.userData.cupContent = 'ice';
      const cube = new THREE.Mesh(geometry, material);
      const bound = Math.hypot(sx, sy, sz) / 2;
      const centerHeight = Math.min(height - sy * .32 - random() * Math.min(2, depth * .08), fillArea.heightLimitsMm[1] - bound - .5);
      cube.position.set(accepted.x / 1000, centerHeight / 1000, accepted.z / 1000);
      cube.rotation.set((random() - .5) * .5, random() * Math.PI, (random() - .5) * .5);
      cube.userData.restPosition = cube.position.clone();
      cube.userData.restRotation = cube.rotation.clone();
      cube.userData.phase = random() * Math.PI * 2;
      holder.add(cube);
    }
    return { group:holder, count:holder.children.length };
  }

  function rebuild({ preview = false } = {}) {
    clearGeometry();
    if (fillArea && state.enabled && state.fillPercent > 0) {
      liquidHeight = heightForVolume(fillArea.innerProfile, fillArea.heightLimitsMm, state.fillPercent / 100);
      liquid = new THREE.Mesh(liquidGeometry(liquidHeight), liquidMaterial());
      liquid.name = 'Liquid';
      liquid.renderOrder = -1;
      liquidBase = liquid.geometry.attributes.position.array.slice();
      group.add(liquid);
      const ice = makeIce(liquidHeight);
      iceGroup = ice.group;
      if (iceGroup) group.add(iceGroup);
      message.textContent = ice.count < state.iceCount ? `当前液位可容纳 ${ice.count} 块冰块。` : '液体和冰块将随项目一起保存。';
    } else message.textContent = fillArea ? (state.enabled ? '液位为 0%，杯内为空。' : '杯内内容已关闭。') : '';
    group.userData.design = getDesign();
    syncInputs();
    if (preview) onPreview?.(); else onCommit?.();
  }

  function setInteractive(value) {
    interactive = Boolean(value && state.enabled && state.motion && !reducedMotion);
    if (!interactive) {
      if (liquid && liquidBase) {
        liquid.geometry.attributes.position.array.set(liquidBase);
        liquid.geometry.attributes.position.needsUpdate = true;
      }
      iceGroup?.children.forEach(cube => {
        cube.position.copy(cube.userData.restPosition);
        cube.rotation.copy(cube.userData.restRotation);
      });
    }
  }

  function update(time) {
    if (!interactive) return;
    if (liquid && liquidBase) {
      const position = liquid.geometry.attributes.position, array = position.array, top = liquidHeight / 1000;
      for (let i = 0; i < array.length; i += 3) {
        array[i] = liquidBase[i]; array[i + 2] = liquidBase[i + 2];
        array[i + 1] = liquidBase[i + 1] + (liquidBase[i + 1] > top - 1e-6
          ? .00042 * Math.sin(time * 2.7 + liquidBase[i] * 95 + liquidBase[i + 2] * 72) : 0);
      }
      position.needsUpdate = true;
    }
    iceGroup?.children.forEach(cube => {
      const phase = cube.userData.phase;
      cube.position.copy(cube.userData.restPosition);
      cube.position.y += Math.sin(time * 1.7 + phase) * .00045;
      cube.rotation.y = cube.userData.restRotation.y + Math.sin(time * .7 + phase) * .08;
    });
  }

  function setState(key, value, preview = false) {
    state[key] = value;
    rebuild({ preview });
  }

  listen(toggle, 'click', () => showPanel(panel.hidden));
  listen(byId('close'), 'click', () => { showPanel(false); toggle.focus(); });
  listen(panel, 'keydown', event => { if (event.key === 'Escape') { showPanel(false); toggle.focus(); } });
  listen(byId('enabled'), 'change', event => setState('enabled', event.target.checked));
  listen(byId('preset'), 'change', event => {
    state.preset = event.target.value;
    state.color = PRESETS[state.preset].color;
    state.clarity = PRESETS[state.preset].clarity;
    rebuild();
  });
  listen(byId('color'), 'input', event => setState('color', event.target.value, true));
  listen(byId('color'), 'change', event => setState('color', event.target.value));
  listen(byId('clarity'), 'input', event => setState('clarity', Number(event.target.value), true));
  listen(byId('clarity'), 'change', event => setState('clarity', Number(event.target.value)));
  listen(byId('fill'), 'input', event => setState('fillPercent', Number(event.target.value), true));
  listen(byId('fill'), 'change', event => setState('fillPercent', Number(event.target.value)));
  listen(byId('ice'), 'change', event => {
    const count = Number(event.target.value);
    setState('iceCount', ICE_LEVELS.has(count) ? count : 0);
  });
  listen(byId('motion'), 'change', event => setState('motion', event.target.checked));
  listen(byId('clear'), 'click', () => { state.enabled = false; state.iceCount = 0; rebuild(); });

  unavailable.hidden = Boolean(fillArea);
  fieldset.disabled = !fillArea;
  toggle.disabled = false;
  toggle.title = fillArea ? '杯内内容' : '当前项目缺少内腔数据';
  syncInputs();
  rebuild({ preview:true });

  function dispose() {
    if (disposed) return;
    const clearUI = activeEditor === owner;
    disposed = true;
    listeners.forEach(remove => remove());
    clearGeometry();
    group.removeFromParent();
    if (clearUI) {
      activeEditor = undefined;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('contents-panel-open');
    }
  }

  return { getDesign, setInteractive, update, dispose, rebuild,
    get group() { return group; }, get hasContents() { return Boolean(liquid); }, get available() { return Boolean(fillArea); } };
}
