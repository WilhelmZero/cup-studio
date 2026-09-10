export const BRIDGE = 'engraving-preview-v1';
export function validPayload(p) {
  return Boolean(p && p.blob instanceof Blob && p.blob.type === 'image/png' && p.blob.size > 0 && p.blob.size <= 20 * 1024 * 1024 &&
    typeof p.name === 'string' && p.name.length <= 200 && ['dither', 'grayscale'].includes(p.mode) &&
    Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width * p.height <= 40_000_000 &&
    [p.widthMm, p.heightMm, p.dpi].every(n => Number.isFinite(n) && n > 0) && p.dpi >= 72 && p.dpi <= 1200 &&
    Math.abs(p.widthMm - p.width / p.dpi * 25.4) < .1 && Math.abs(p.heightMm - p.height / p.dpi * 25.4) < .1);
}
export function frostedPixels(data) {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = Math.round((data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722) * data[i + 3] / 255);
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = alpha;
  }
  return data;
}
export function externalSession(search) {
  const q = new URLSearchParams(search);
  return q.get('engravingPreview') === '1' ? q.get('session') || 'invalid' : null;
}
export function startReceiver(session, apply, status, host = window) {
  const opener = host.opener;
  const allowed = new Set(['https://wilhelmzero.github.io']);
  if (['localhost', '127.0.0.1'].includes(host.location.hostname)) {
    allowed.add('http://127.0.0.1:5179');
    allowed.add('http://localhost:5179');
  }
  let phase = 'waiting', senderOrigin = '';
  const send = (type, message) => opener?.postMessage({ bridge: BRIDGE, session, type, message }, senderOrigin);
  const timer = setTimeout(() => {
    if (phase === 'complete' || phase === 'closed') return;
    phase = 'closed';
    status('接收超时，请返回雕刻预览重新打开，或下载图片后手动导入。');
  }, 120000);
  status('等待接收雕刻图片 · 独立预览，不覆盖草稿');
  const receive = async event => {
    if (phase === 'closed' || !opener || event.source !== opener || !allowed.has(event.origin) || event.data?.bridge !== BRIDGE || event.data?.session !== session) return;
    senderOrigin = event.origin;
    if (event.data.type === 'hello') { send(phase === 'complete' ? 'applied' : 'ready'); return; }
    if (event.data.type !== 'image' || phase === 'pending') return;
    if (phase === 'complete') { send('applied'); return; }
    if (!validPayload(event.data.payload)) { send('error', '图片格式或尺寸无效（PNG最大20MB）'); status('图片格式或尺寸无效，请下载后手动导入。'); return; }
    phase = 'pending';
    status('正在加载默认杯型与雕刻贴图…');
    try {
      const detail = await apply(event.data.payload);
      if (phase === 'closed') return;
      phase = 'complete'; clearTimeout(timer);
      status(`雕刻贴图已导入${detail || ''} · 高质量渐进渲染 · 不覆盖草稿`);
      send('applied');
    } catch {
      if (phase === 'closed') return;
      phase = 'closed'; clearTimeout(timer);
      status('雕刻贴图导入失败，请返回重试，或下载图片后手动导入。');
      send('error', '贴图导入失败');
    }
  };
  host.addEventListener('message', receive);
  return () => { phase = 'closed'; clearTimeout(timer); host.removeEventListener('message', receive); };
}
