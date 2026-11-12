'use strict';
// BA 圖製作：照片只在瀏覽器裡處理，不上傳。外框素材由 tools/build_frame.py 從範例圖產出。

const SPEC = window.FRAME_SPEC;
const W = SPEC.canvas[0];
const H = SPEC.canvas[1];
const SLOTS = SPEC.slots; // {before:[x,y,w,h], after:[...]}
const SLOT_DX = SLOTS.after[0] - SLOTS.before[0];
const WORK_MAX = 2400; // 操作時的工作尺寸；匯出一律用原圖重算
const TREAT_KEY = 'ba-tool-treatments';
const FRAME_ID = 'lithe-lips-v1';
const TOOL_VERSION = window.TOOL_VERSION || '未標版本';

const PARTS = {
  lips: { pts: ['左鼻翼下緣', '右鼻翼下緣'], alt: '拍不到鼻翼就不要點，兩張會各自填滿格子，但大小沒有對齊。' },
  face: { pts: ['左內眼角', '右內眼角'], alt: '內眼角拍不到時可改點左右外眼角。' },
  chest: { pts: ['左鎖骨頭', '右鎖骨頭'], alt: '拍不到時可改點左右腋前線起點。' },
  abdomen: { pts: ['左腰前骨頭突起（髂前上棘）', '右腰前骨頭突起'], alt: '拍不到時可改點肚臍、胸骨下緣。' },
  arm: { pts: ['肩膀最外側骨頭（肩峰）', '肘尖'], alt: '拍不到時可改點肘尖、腕骨突起。' },
};
const SLOT_NAME = { before: 'Before', after: 'After' };
// 照片要填滿的範圍：格子頂端到淡出約九成的位置（再往下幾乎被白色蓋滿，露底也看不出來）
const VISIBLE_BOTTOM = SPEC.fade[1] + 125;
const FIT_MAX = 6; // 自動填滿最多放大幾倍

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const vctx = view.getContext('2d');

const state = {
  assets: {},
  photos: { before: null, after: null },
  title: '',
  part: 'lips',
  aligned: false,
  masks: [],
  mode: null,
  onion: false,
  raw: false,
  fontOk: false,
  drag: null,
  fitNote: '',
  autoAlign: null,
};

// ---------- 小工具 ----------
const c = (re, im) => ({ re, im });
const cAdd = (p, q) => c(p.re + q.re, p.im + q.im);
const cSub = (p, q) => c(p.re - q.re, p.im - q.im);
const cMul = (p, q) => c(p.re * q.re - p.im * q.im, p.re * q.im + p.im * q.re);
const cDiv = (p, q) => {
  const d = q.re * q.re + q.im * q.im;
  return c((p.re * q.re + p.im * q.im) / d, (p.im * q.re - p.re * q.im) / d);
};
const cAbs = (p) => Math.hypot(p.re, p.im);
const applyT = (t, z) => cAdd(cMul(t.a, z), t.b);
const invT = (t, w) => cDiv(cSub(w, t.b), t.a);

function storageGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 私密視窗等情況寫不進去，不影響使用 */ }
}

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`素材載入失敗：${src}`));
    // 單一檔案版把外框圖內嵌成 data URL（window.INLINE_ASSETS），雙擊開檔也不會讓畫布被瀏覽器鎖住
    img.src = (window.INLINE_ASSETS && window.INLINE_ASSETS[src]) || src;
  });
}

function setMsg(text) { $('#modeMsg').textContent = text || ''; }

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- 照片 ----------
function coverTransform(slot, iw, ih) {
  const [x, y, w, h] = SLOTS[slot];
  const s = Math.max(w / iw, h / ih);
  return { a: c(s, 0), b: c(x + w / 2 - (s * iw) / 2, y + h / 2 - (s * ih) / 2) };
}

// 每格記最新一次載入的序號：連續拖兩張進同一格時，只有最後拖的那張能放進去（大檔慢讀完也不會蓋掉新的）
const loadSeq = { before: 0, after: 0 };

async function loadPhoto(slot, file, opts = {}) {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buf], { type: file.type }), { imageOrientation: 'from-image' });
  } catch {
    alert(`這張照片讀不了（${file.name}）。如果是 iPhone 的 HEIC，請到「設定 > 相機 > 格式」改成「最相容」，或先轉成 JPG 再拖進來。`);
    return null;
  }
  const k = Math.min(1, WORK_MAX / Math.max(bitmap.width, bitmap.height));
  const work = document.createElement('canvas');
  work.width = Math.round(bitmap.width * k);
  work.height = Math.round(bitmap.height * k);
  work.getContext('2d').drawImage(bitmap, 0, 0, work.width, work.height);
  const photo = {
    name: file.name,
    hash,
    bitmap,
    work,
    k,
    t: coverTransform(slot, bitmap.width, bitmap.height),
    baseS: 0,
    points: [],
    manual: false,
    wb: { gains: [1, 1, 1], pending: null, preview: false, note: '原色', source: null },
    cache: null,
  };
  photo.baseS = cAbs(photo.t.a);
  if (opts.expectHash && opts.expectHash !== hash) return { mismatch: true, photo };
  if (opts.dryRun) return { photo };
  if (opts.token != null && opts.token !== loadSeq[slot]) return { stale: true };
  state.photos[slot] = photo;
  document.querySelector(`[data-fname="${slot}"]`).textContent = file.name;
  return { photo };
}

function wbFilter(src, gains) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  if (gains[0] === 1 && gains[1] === 1 && gains[2] === 1) return out;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [gr, gg, gb] = gains;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * gr);
    d[i + 1] = Math.min(255, d[i + 1] * gg);
    d[i + 2] = Math.min(255, d[i + 2] * gb);
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function effectiveGains(photo) {
  return photo.wb.gains;
}

function workSource(photo) {
  const g = effectiveGains(photo);
  const key = g.join(',');
  if (!photo.cache || photo.cache.key !== key) photo.cache = { key, canvas: wbFilter(photo.work, g) };
  return photo.cache.canvas;
}

// ---------- 白平衡 ----------
function gainsFromColor(rgb) {
  const [r, g, b] = rgb;
  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 1)) return null;
  const target = (r + g + b) / 3;
  const clamp = (v) => Math.min(1.5, Math.max(0.67, v));
  const gains = [clamp(target / r), clamp(target / g), clamp(target / b)].map((v) => Math.round(v * 1000) / 1000);
  return gains.every(Number.isFinite) ? gains : null;
}

// 自動白平衡：找照片裡本來就是白色或灰色的地方，用它們把色溫算回正常。找不到就維持原色，不拿皮膚來猜。
// 色溫偏掉時主要是藍色變多或變少，紅綠仍接近；皮膚則是紅明顯多於綠。所以先找「紅綠接近、顏色不太濃」的地方粗算一次，
// 再用校正後的顏色篩出真正接近灰色的地方細算。候選太少（不到畫面 5%）就不動；校正幅度有上限，避免誤判時整張校過頭。
const WB_MAX_SHIFT = [0.85, 1.18];
function wbPixels(photo) {
  const src = photo.work;
  const k = Math.min(1, 240 / Math.max(src.width, src.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(src.width * k));
  cv.height = Math.max(1, Math.round(src.height * k));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  return px;
}
function grayish(px, gains, maxChroma, maxRG) {
  return px.filter(([r0, g0, b0]) => {
    const r = r0 * gains[0], g = g0 * gains[1], b = b0 * gains[2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (Math.max(r0, g0, b0) >= 250 || mx < 70) return false;
    return (mx - mn) / mx < maxChroma && (maxRG == null || Math.abs(r - g) / mx < maxRG);
  });
}
function meanRGB(list) {
  return [0, 1, 2].map((ch) => list.reduce((s, q) => s + q[ch], 0) / list.length);
}
function autoWhiteBalance(photo) {
  const keep = (note) => ({ gains: [1, 1, 1], note });
  const px = wbPixels(photo);
  const first = grayish(px, [1, 1, 1], 0.32, 0.08);
  if (first.length < px.length * 0.05) return keep('照片裡找不到白色或灰色的地方，維持原色');
  let gains = gainsFromColor(meanRGB(first));
  if (!gains) return keep('算不出色溫，維持原色');
  const second = grayish(first, gains, 0.12, null);
  if (second.length >= first.length * 0.5) {
    const m = meanRGB(second);
    const g2 = gainsFromColor(m);
    if (g2) gains = g2;
  }
  gains = gains.map((g) => Math.round(Math.min(WB_MAX_SHIFT[1], Math.max(WB_MAX_SHIFT[0], g)) * 1000) / 1000);
  const shift = Math.max(...gains.map((g) => Math.abs(g - 1)));
  if (shift < 0.02) return keep('色溫本來就正常，不用校正');
  const tone = gains[2] > gains[0] + 0.01 ? '原本偏黃' : gains[0] > gains[2] + 0.01 ? '原本偏藍' : '原本偏色';
  return { gains, note: `已自動校正：${tone}，校正幅度 ${Math.round(shift * 100)}%` };
}

function applyAutoWB(slot) {
  const p = state.photos[slot];
  const r = autoWhiteBalance(p);
  p.wb = { gains: r.gains, pending: null, preview: false, note: r.note, source: 'auto' };
  setWBStatus(slot, r.note, r.gains.some((g) => g !== 1));
}

function setWBStatus(slot, text, ok = false) {
  const el = document.querySelector(`[data-wb-status="${slot}"]`);
  el.textContent = text;
  el.classList.toggle('ok', ok);
}

// ---------- 對齊 ----------
function tryAlign() {
  const B = state.photos.before;
  const A = state.photos.after;
  const el = $('#alignStatus');
  el.classList.remove('ok');
  if (!B || !A) { state.aligned = false; el.textContent = '兩張照片都放進來才能對齊'; return; }
  if (B.points.length < 2 || A.points.length < 2) {
    state.aligned = false;
    el.textContent = state.autoAlign && !state.autoAlign.ok
      ? '兩張照片對不起來（拍的角度或距離差太多），沒辦法自動對齊，兩張先各自填滿格子。建議用同樣角度、同樣距離重拍。'
      : '兩張照片都放進來，就會自動對齊。';
    return;
  }
  const fail = (msg) => { state.aligned = false; el.textContent = msg; };
  const off = c(SLOT_DX, 0);
  const w1 = cAdd(applyT(B.t, B.points[0]), off);
  const w2 = cAdd(applyT(B.t, B.points[1]), off);
  const z1 = A.points[0];
  const z2 = A.points[1];
  const a = cDiv(cSub(w2, w1), cSub(z2, z1));
  const ratio = cAbs(a) / cAbs(B.t.a);
  if (!Number.isFinite(a.re) || !Number.isFinite(a.im) || ratio < 0.2 || ratio > 5) {
    return fail('兩張照片大小差太多（超過 5 倍），沒辦法對齊，兩張先各自填滿格子。');
  }
  A.t = { a, b: cSub(w1, cMul(a, z1)) };
  A.manual = false;
  state.aligned = true;
  writeAlignStatus();
}

function writeAlignStatus() {
  const B = state.photos.before;
  const A = state.photos.after;
  const el = $('#alignStatus');
  const rot = (Math.atan2(A.t.a.im, A.t.a.re) * 180) / Math.PI - (Math.atan2(B.t.a.im, B.t.a.re) * 180) / Math.PI;
  const turn = Math.abs(rot) >= 0.5 ? `After 轉了 ${Math.abs(rot).toFixed(1)}°，` : '';
  el.textContent = `已自動對齊，兩張調成一樣大、擺在同一個位置。${turn}${state.fitNote}想確認的話，勾畫面下方的「疊圖檢查」看兩張有沒有疊好。`;
  el.classList.add('ok');
}

// 點參考點或白平衡取色時，那一格暫時顯示整張照片，格子外的位置也點得到
function containTransform(slot, iw, ih) {
  const [x, y, w, h] = SLOTS[slot];
  const s = Math.min(w / iw, h / ih);
  return { a: c(s, 0), b: c(x + w / 2 - (s * iw) / 2, y + h / 2 - (s * ih) / 2) };
}
function pickingSlot() {
  const m = state.mode;
  return m && (m.type === 'points' || m.type === 'wb') ? m.slot : null;
}
function viewT(slot, p) {
  return pickingSlot() === slot ? containTransform(slot, p.bitmap.width, p.bitmap.height) : p.t;
}

// 把多邊形裁到半平面 n·x ≤ k 裡
function clipHalf(poly, n, k) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i];
    const Q = poly[(i + 1) % poly.length];
    const dp = n.re * P.re + n.im * P.im - k;
    const dq = n.re * Q.re + n.im * Q.im - k;
    if (dp <= 0) out.push(P);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const r = dp / (dp - dq);
      out.push(c(P.re + r * (Q.re - P.re), P.im + r * (Q.im - P.im)));
    }
  }
  return out;
}

function nearestInPoly(poly, halves, p0) {
  if (halves.every((h) => h.n.re * p0.re + h.n.im * p0.im <= h.k + 1e-9)) return p0;
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i];
    const Q = poly[(i + 1) % poly.length];
    const d = cSub(Q, P);
    const L = d.re * d.re + d.im * d.im;
    const r = L > 0 ? Math.max(0, Math.min(1, ((p0.re - P.re) * d.re + (p0.im - P.im) * d.im) / L)) : 0;
    const q = c(P.re + r * d.re, P.im + r * d.im);
    const dist = cAbs(cSub(q, p0));
    if (dist < bestD) { bestD = dist; best = q; }
  }
  return best;
}

// 對齊後自動填滿：兩張一起縮放、平移，用最小的放大倍數讓 Before、After 都蓋滿格子，
// 優先只平移不放大；放大時以兩個參考點中間為中心。After 跟 Before 的相對關係（參考點對齊）不變。
function fitAligned() {
  const B = state.photos.before;
  const A = state.photos.after;
  const off = c(SLOT_DX, 0);
  const s0 = B.t.a.re; // Before 此時是填滿格子的初始擺法，沒有旋轉
  // R：After 原圖座標 → Before 原圖座標（只看參考點，跟 Before 怎麼縮放無關）
  const R = { a: cDiv(A.t.a, B.t.a), b: cDiv(cSub(cSub(A.t.b, off), B.t.b), B.t.a) };
  const [sx, sy, sw] = SLOTS.before;
  const swA = SLOTS.after[2]; // 兩格寬度可能差一兩個像素，各用各的
  const vh = VISIBLE_BOTTOM - sy;
  // 兩張照片在 Before 原圖座標裡共同涵蓋的範圍（凸多邊形），用半平面表示
  const halves = [];
  const addPoly = (pts, w) => {
    const cx = pts.reduce((s, q) => s + q.re, 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q.im, 0) / pts.length;
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i];
      const Q = pts[(i + 1) % pts.length];
      let n = c(Q.im - P.im, P.re - Q.re);
      let k = n.re * P.re + n.im * P.im;
      if (n.re * cx + n.im * cy > k) { n = c(-n.re, -n.im); k = -k; }
      halves.push({ n, k, w });
    }
  };
  const bw = B.bitmap.width, bh = B.bitmap.height, aw = A.bitmap.width, ah = A.bitmap.height;
  addPoly([c(0, 0), c(bw, 0), c(bw, bh), c(0, bh)], sw);
  addPoly([c(0, 0), c(aw, 0), c(aw, ah), c(0, ah)].map((z) => applyT(R, z)), swA);
  // 縮放 s 時，格子在 Before 原圖上是 (寬/s)×(vh/s) 的長方形；左上角 p 要讓四個角都在共同範圍裡
  const shifted = (s) => halves.map((h) => ({
    n: h.n,
    k: h.k - Math.max(0, h.n.re * (h.w / s)) - Math.max(0, h.n.im * (vh / s)),
  }));
  const feasible = (s) => {
    let poly = [c(-1e7, -1e7), c(1e7, -1e7), c(1e7, 1e7), c(-1e7, 1e7)];
    for (const h of shifted(s)) { poly = clipHalf(poly, h.n, h.k); if (!poly.length) return null; }
    return poly;
  };
  let s = s0;
  let poly = feasible(s0);
  if (!poly) {
    let lo = s0;
    let hi = s0 * FIT_MAX;
    if (!feasible(hi)) return { ok: false };
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (feasible(mid)) hi = mid; else lo = mid; }
    s = hi;
    poly = feasible(hi);
  }
  // 想要的位置：從初始擺法以參考點中點為中心放大（中點落在格子外就取格子裡最近的點）
  const mid = applyT(B.t, c((B.points[0].re + B.points[1].re) / 2, (B.points[0].im + B.points[1].im) / 2));
  const m = c(Math.max(sx, Math.min(sx + sw, mid.re)), Math.max(sy, Math.min(sy + vh, mid.im)));
  const Q0 = c(sx, sy);
  const b0 = cAdd(m, cMul(c(s / s0, 0), cSub(B.t.b, m)));
  const p0 = cDiv(cSub(Q0, b0), c(s, 0));
  const p = nearestInPoly(poly, shifted(s), p0);
  const b = cSub(Q0, cMul(c(s, 0), p));
  B.t = { a: c(s, 0), b };
  A.t = { a: cMul(c(s, 0), R.a), b: cAdd(cAdd(cMul(c(s, 0), R.b), b), off) };
  return { ok: true, zoom: s / s0 };
}

// 新照片、點完參考點、清除參考點都走這裡：從填滿格子的初始擺法重算，結果只跟照片和參考點有關
function alignAndFit() {
  for (const slot of ['before', 'after']) {
    const p = state.photos[slot];
    if (p) p.t = coverTransform(slot, p.bitmap.width, p.bitmap.height);
  }
  state.fitNote = '';
  tryAlign();
  if (!state.aligned) return;
  const r = fitAligned();
  if (!r.ok) state.fitNote = `兩張照片拍的範圍差太多，自動放大到 ${FIT_MAX} 倍還是填不滿格子，建議換一張拍得比較接近的照片。`;
  else if (r.zoom > 1.001) state.fitNote = `為了讓兩張都填滿格子，已自動放大 ${r.zoom.toFixed(2)} 倍。`;
  writeAlignStatus();
}

// ---------- 自動對齊 ----------
// 不靠使用者點參考點：把兩張照片轉成紋路圖（亮度變化的強弱），找出 After 要放大多少、轉幾度、移多少才最吻合 Before。
// 先在很小的圖上大範圍試倍數與角度（平移用 FFT 一次算完），再逐層放大照片微調。只比紋路不比顏色，白平衡不同也不影響。
const REG_P = 128; // 粗找時 FFT 的邊長
const REG_L = 40; // 粗找時照片長邊縮成幾像素
const REG_LEVELS = [80, 160, 320]; // 逐層微調的長邊像素
const REG_SURE = 0.5; // 吻合度到這裡就直接採用
const REG_MIN_SCORE = 0.12; // 低於這個一律當作對不上；中間的要看結果像不像正常拍的術前術後

function regGrad(photo, L) {
  const src = photo.work;
  const k = L / Math.max(src.width, src.height);
  const w = Math.max(8, Math.round(src.width * k));
  const h = Math.max(8, Math.round(src.height * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      out[i] = Math.sqrt(Math.hypot(gx, gy)); // 開根號，讓幾條特別強的邊不要壓過整片紋理
    }
  }
  return { w, h, k: w / photo.bitmap.width, data: out };
}

function bilinear(img, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= img.w - 1 || y0 >= img.h - 1) return NaN;
  const fx = x - x0, fy = y - y0, i = y0 * img.w + x0, d = img.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.w] * (1 - fx) + d[i + img.w + 1] * fx) * fy;
}

function fft1(re, im, n, inv) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function fft2(re, im, P, inv) {
  const rr = new Float64Array(P), ri = new Float64Array(P);
  for (let y = 0; y < P; y++) fft1(re.subarray(y * P, y * P + P), im.subarray(y * P, y * P + P), P, inv);
  for (let x = 0; x < P; x++) {
    for (let y = 0; y < P; y++) { rr[y] = re[y * P + x]; ri[y] = im[y * P + x]; }
    fft1(rr, ri, P, inv);
    for (let y = 0; y < P; y++) { re[y * P + x] = rr[y]; im[y * P + x] = ri[y]; }
  }
  if (inv) { const n = P * P; for (let i = 0; i < n * 1; i++) { re[i] /= n; im[i] /= n; } }
}

function spectrum(arr, P) {
  const re = Float64Array.from(arr), im = new Float64Array(P * P);
  fft2(re, im, P, false);
  return { re, im };
}

// 相關：corr(X,Y)(d) = Σ X(x+d)·Y(x)
function corr(X, Y, P) {
  const n = P * P, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = X.re[i] * Y.re[i] + X.im[i] * Y.im[i];
    im[i] = X.im[i] * Y.re[i] - X.re[i] * Y.im[i];
  }
  fft2(re, im, P, true);
  return re;
}

// 粗找：每組倍數＋角度做一次有遮罩的正規化相關（兩張都只算照片範圍內），平移一次全部算完
function regCoarse(Bg, Ag) {
  const P = REG_P, n = P * P;
  const F = new Float64Array(n), F2 = new Float64Array(n), Mf = new Float64Array(n);
  for (let y = 0; y < Ag.h; y++) for (let x = 0; x < Ag.w; x++) {
    const v = Ag.data[y * Ag.w + x];
    F[y * P + x] = v; F2[y * P + x] = v * v; Mf[y * P + x] = 1;
  }
  const SF = spectrum(F, P), SF2 = spectrum(F2, P), SMf = spectrum(Mf, P);
  let best = { score: -2 };
  const corners = [c(0, 0), c(Bg.w - 1, 0), c(Bg.w - 1, Bg.h - 1), c(0, Bg.h - 1)];
  for (let s = 0.5; s <= 2.0001; s *= 1.08) {
    for (let deg = -12; deg <= 12; deg += 4) {
      const th = (deg * Math.PI) / 180;
      const a = c(s * Math.cos(th), s * Math.sin(th));
      const q = corners.map((z) => cMul(a, z));
      const o = c(Math.floor(Math.min(...q.map((z) => z.re))), Math.floor(Math.min(...q.map((z) => z.im))));
      const wt = Math.ceil(Math.max(...q.map((z) => z.re))) - o.re + 1;
      const ht = Math.ceil(Math.max(...q.map((z) => z.im))) - o.im + 1;
      if (wt + Ag.w - 1 > P || ht + Ag.h - 1 > P) continue;
      const T = new Float64Array(n), T2 = new Float64Array(n), Mt = new Float64Array(n);
      let area = 0;
      for (let j = 0; j < ht; j++) for (let i = 0; i < wt; i++) {
        const v = cDiv(c(i + o.re, j + o.im), a);
        const val = bilinear(Bg, v.re, v.im);
        if (Number.isNaN(val)) continue;
        T[j * P + i] = val; T2[j * P + i] = val * val; Mt[j * P + i] = 1; area++;
      }
      if (area < 20) continue;
      const ST = spectrum(T, P), ST2 = spectrum(T2, P), SMt = spectrum(Mt, P);
      const sFT = corr(SF, ST, P), sF = corr(SF, SMt, P), sF2 = corr(SF2, SMt, P);
      const cnt = corr(SMf, SMt, P), sT = corr(SMf, ST, P), sT2 = corr(SMf, ST2, P);
      const minN = 0.35 * Math.min(area, Ag.w * Ag.h);
      for (let dy = -(ht - 1); dy <= Ag.h - 1; dy++) for (let dx = -(wt - 1); dx <= Ag.w - 1; dx++) {
        const idx = ((dy + P) % P) * P + ((dx + P) % P);
        const N = cnt[idx];
        if (N < minN) continue;
        const num = sFT[idx] - (sF[idx] * sT[idx]) / N;
        const den = (sF2[idx] - (sF[idx] * sF[idx]) / N) * (sT2[idx] - (sT[idx] * sT[idx]) / N);
        if (den <= 1e-9) continue;
        const score = num / Math.sqrt(den);
        if (score > best.score) best = { score, a, b: cSub(c(dx, dy), o) };
      }
    }
  }
  return best.score > -2 ? best : null;
}

// 微調用的吻合度：Before 每一格拿去 After 對應位置取值，算正規化相關
function regScore(Bg, Ag, M) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 1; y < Bg.h - 1; y++) for (let x = 1; x < Bg.w - 1; x++) {
    const u = applyT(M, c(x, y));
    const va = bilinear(Ag, u.re, u.im);
    if (Number.isNaN(va)) continue;
    const vb = Bg.data[y * Bg.w + x];
    n++; sx += vb; sy += va; sxx += vb * vb; syy += va * va; sxy += vb * va;
  }
  if (n < 0.35 * Math.min(Bg.w * Bg.h, Ag.w * Ag.h)) return -1;
  const den = (sxx - (sx * sx) / n) * (syy - (sy * sy) / n);
  return den > 1e-9 ? (sxy - (sx * sy) / n) / Math.sqrt(den) : -1;
}

function regRefine(Bg, Ag, M) {
  let p = [M.a.re, M.a.im, M.b.re, M.b.im];
  const toM = (q) => ({ a: c(q[0], q[1]), b: c(q[2], q[3]) });
  let score = regScore(Bg, Ag, M);
  let da = 0.02 * Math.hypot(p[0], p[1]);
  let db = 2;
  for (let iter = 0; iter < 80 && db > 0.2; iter++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      for (const sign of [1, -1]) {
        const q = p.slice();
        q[k] += sign * (k < 2 ? da : db);
        const sc = regScore(Bg, Ag, toM(q));
        if (sc > score) { score = sc; p = q; improved = true; }
      }
    }
    if (!improved) { da /= 2; db /= 2; }
  }
  return { M: toM(p), score };
}

// 回傳 Before 原圖座標 → After 原圖座標的對應，和吻合度（0～1）
function autoRegister(B, A) {
  let Bg = regGrad(B, REG_L);
  let Ag = regGrad(A, REG_L);
  const coarse = regCoarse(Bg, Ag);
  if (!coarse) return null;
  // 換成原圖座標：u_A = M(z_B)
  let M = { a: c((coarse.a.re * Bg.k) / Ag.k, (coarse.a.im * Bg.k) / Ag.k), b: c(coarse.b.re / Ag.k, coarse.b.im / Ag.k) };
  let score = coarse.score;
  for (const L of REG_LEVELS) {
    Bg = regGrad(B, L);
    Ag = regGrad(A, L);
    const lv = { a: c((M.a.re * Ag.k) / Bg.k, (M.a.im * Ag.k) / Bg.k), b: c(M.b.re * Ag.k, M.b.im * Ag.k) };
    const r = regRefine(Bg, Ag, lv);
    score = r.score;
    M = { a: c((r.M.a.re * Bg.k) / Ag.k, (r.M.a.im * Bg.k) / Ag.k), b: c(r.M.b.re / Ag.k, r.M.b.im / Ag.k) };
  }
  return { M, score };
}

// 結果像不像正常拍的術前術後：兩張互相蓋到八成以上、大小差不到三成、歪不到 8 度
function regPlausible(B, A, M) {
  const inside = (z, p) => z.re >= 0 && z.im >= 0 && z.re <= p.bitmap.width && z.im <= p.bitmap.height;
  const inv = { a: cDiv(c(1, 0), M.a) };
  inv.b = cMul(c(-1, 0), cMul(inv.a, M.b));
  let inB = 0, inA = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const fx = (x + 0.5) / 20, fy = (y + 0.5) / 20;
    if (inside(applyT(M, c(fx * B.bitmap.width, fy * B.bitmap.height)), A)) inB++;
    if (inside(applyT(inv, c(fx * A.bitmap.width, fy * A.bitmap.height)), B)) inA++;
  }
  const rel = cAbs(M.a) * (Math.max(B.bitmap.width, B.bitmap.height) / Math.max(A.bitmap.width, A.bitmap.height));
  const deg = Math.abs((Math.atan2(M.a.im, M.a.re) * 180) / Math.PI);
  return inB >= 320 && inA >= 320 && rel >= 0.75 && rel <= 1.33 && deg <= 8;
}

// 兩張都在時自動對齊：算出對應後，換成兩組虛擬參考點交給原本的對齊與填滿
async function autoAlign() {
  const B = state.photos.before;
  const A = state.photos.after;
  state.autoAlign = null;
  if (!B || !A) { alignAndFit(); return; }
  setMsg('正在自動對齊兩張照片…');
  await new Promise((r) => setTimeout(r, 30));
  let res = null;
  try { res = autoRegister(B, A); } catch (err) { console.error(err); }
  if (state.photos.before !== B || state.photos.after !== A) return; // 算的途中換了照片，交給新的那次
  setMsg('');
  const ok = res && (res.score >= REG_SURE || (res.score >= REG_MIN_SCORE && regPlausible(B, A, res.M)));
  if (!ok) {
    B.points = [];
    A.points = [];
    state.autoAlign = { ok: false, score: res ? res.score : 0 };
  } else {
    const z1 = c(B.bitmap.width * 0.3, B.bitmap.height * 0.5);
    const z2 = c(B.bitmap.width * 0.7, B.bitmap.height * 0.5);
    B.points = [z1, z2];
    A.points = [applyT(res.M, z1), applyT(res.M, z2)];
    state.autoAlign = { ok: true, score: res.score };
  }
  alignAndFit();
}

// ---------- 繪圖 ----------
function slotAt(x, y) {
  for (const slot of ['before', 'after']) {
    const [sx, sy, sw, sh] = SLOTS[slot];
    if (x >= sx && x < sx + sw && y >= sy && y < sy + sh) return slot;
  }
  return null;
}

function drawPhoto(ctx, slot, photo, source, scaleFromSource, extraOffset = 0, alpha = 1, t = photo.t) {
  const [sx, sy, sw, sh] = SLOTS[extraOffset ? 'before' : slot];
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx, sy, sw, sh);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.transform(t.a.re, t.a.im, -t.a.im, t.a.re, t.b.re - extraOffset, t.b.im);
  ctx.scale(scaleFromSource, scaleFromSource);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

// 馬賽克：框起來的範圍裡面是完整馬賽克（不淡化，確保遮乾淨），往框外再羽化 MOSAIC_FEATHER 像素，
// 從馬賽克慢慢淡回原圖、角落成圓弧；羽化只在同一張照片的格子裡，不會蓋到外框或另一張照片。
const MOSAIC_BLOCK = 18;
const MOSAIC_FEATHER = 24;
function pixelate(ctx, m, bounds) {
  const F = MOSAIC_FEATHER;
  const [sx, sy, sw, sh] = bounds;
  const x0 = Math.max(sx, Math.floor(m.x - F)), y0 = Math.max(sy, Math.floor(m.y - F));
  const x1 = Math.min(sx + sw, Math.ceil(m.x + m.w + F)), y1 = Math.min(sy + sh, Math.ceil(m.y + m.h + F));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return;
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  const orig = new Uint8ClampedArray(d);
  const bs = MOSAIC_BLOCK;
  for (let by = 0; by < h; by += bs) {
    for (let bx = 0; bx < w; bx += bs) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = by; yy < Math.min(by + bs, h); yy++) {
        for (let xx = bx; xx < Math.min(bx + bs, w); xx++) {
          const i = (yy * w + xx) * 4; r += orig[i]; g += orig[i + 1]; b += orig[i + 2]; n++;
        }
      }
      r /= n; g /= n; b /= n;
      for (let yy = by; yy < Math.min(by + bs, h); yy++) {
        for (let xx = bx; xx < Math.min(bx + bs, w); xx++) {
          const X = x0 + xx + 0.5, Y = y0 + yy + 0.5;
          const dx = Math.max(m.x - X, 0, X - (m.x + m.w));
          const dy = Math.max(m.y - Y, 0, Y - (m.y + m.h));
          const dist = Math.hypot(dx, dy);
          if (dist >= F) continue;
          const u = 1 - dist / F;
          const a = u * u * (3 - 2 * u); // 平滑淡出
          const i = (yy * w + xx) * 4;
          d[i] = orig[i] + (r - orig[i]) * a;
          d[i + 1] = orig[i + 1] + (g - orig[i + 1]) * a;
          d[i + 2] = orig[i + 2] + (b - orig[i + 2]) * a;
        }
      }
    }
  }
  ctx.putImageData(img, x0, y0);
}

// 遮蔽存在原圖座標（四個角），跟著照片移動縮放；畫的時候取外接矩形、裁在照片格內，寧可多遮不少遮
function maskCanvasPoints(m, exportMode = false) {
  const p = state.photos[m.slot];
  if (!p) return null;
  const t = exportMode ? p.t : viewT(m.slot, p);
  return m.quad.map((z) => applyT(t, z));
}

function maskCanvasRect(m, exportMode = false) {
  const pts = maskCanvasPoints(m, exportMode);
  if (!pts) return null;
  const [sx, sy, sw, sh] = SLOTS[m.slot];
  const x0 = Math.max(sx, Math.min(...pts.map((q) => q.re)));
  const y0 = Math.max(sy, Math.min(...pts.map((q) => q.im)));
  const x1 = Math.min(sx + sw, Math.max(...pts.map((q) => q.re)));
  const y1 = Math.min(sy + sh, Math.max(...pts.map((q) => q.im)));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function titleLayout(ctx, text) {
  const T = SPEC.title;
  ctx.font = `${T.fontWeight} ${T.fontSize}px "${T.fontFamily}"`;
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0) + T.letterSpacing * Math.max(0, chars.length - 1);
  return { chars, widths, total, fits: total <= T.maxWidth };
}

function drawTitle(ctx) {
  const T = SPEC.title;
  const text = state.title.trim();
  if (!text) return;
  const L = titleLayout(ctx, text);
  const m = ctx.measureText(text);
  const center = (T.inkTop + T.inkBottom) / 2;
  const baseline = center + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.fillStyle = T.color;
  ctx.textBaseline = 'alphabetic';
  let x = T.centerX - L.total / 2;
  L.chars.forEach((ch, i) => {
    ctx.fillText(ch, x, baseline);
    x += L.widths[i] + T.letterSpacing;
  });
}

function compose(ctx, { exportMode = false } = {}) {
  const A = state.assets;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(A.base, 0, 0);
  for (const slot of ['before', 'after']) {
    const p = state.photos[slot];
    const [sx, sy, sw, sh] = SLOTS[slot];
    if (!p) {
      if (!exportMode) {
        ctx.fillStyle = '#eceef1';
        ctx.fillRect(sx, sy, sw, sh);
        ctx.fillStyle = '#8a9099';
        ctx.font = '500 28px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${SLOT_NAME[slot]} 照片`, sx + sw / 2, sy + sh / 2 - 60);
        ctx.textAlign = 'start';
      }
      continue;
    }
    if (exportMode) { drawPhoto(ctx, slot, p, wbFilter(p.bitmap, p.wb.gains), 1); continue; }
    if (pickingSlot() === slot) {
      ctx.fillStyle = '#eceef1';
      ctx.fillRect(sx, sy, sw, sh);
    }
    drawPhoto(ctx, slot, p, workSource(p), 1 / p.k, 0, 1, viewT(slot, p));
  }
  if (!exportMode && !pickingSlot() && state.onion && state.photos.before && state.photos.after) {
    const p = state.photos.after;
    drawPhoto(ctx, 'after', p, workSource(p), 1 / p.k, SLOT_DX, 0.5);
  }
  for (const m of state.masks) {
    const r = maskCanvasRect(m, exportMode);
    if (r) pixelate(ctx, r, SLOTS[m.slot]);
  }
  if (exportMode || !(state.raw || pickingSlot())) {
    ctx.drawImage(A.fade, SPEC.fade[0], SPEC.fade[1]);
    ctx.drawImage(A.divider, SPEC.divider[0], SPEC.divider[1]);
    ctx.drawImage(A.pillBefore, SPEC.pills.before[0], SPEC.pills.before[1]);
    ctx.drawImage(A.pillAfter, SPEC.pills.after[0], SPEC.pills.after[1]);
  }
  drawTitle(ctx);
}

function drawOverlays(ctx) {
  ctx.save();
  ctx.textAlign = 'start';
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d0452f';
  for (const m of state.masks) {
    const pts = maskCanvasPoints(m);
    if (!pts) continue;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.re, q.im) : ctx.moveTo(q.re, q.im)));
    ctx.closePath();
    ctx.stroke();
  }
  if (state.drag && state.drag.type === 'mask') {
    const d = state.drag;
    ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  ctx.restore();
}

// 照片有沒有填滿照片格：把格子四個角反算回原圖，四個角都落在照片內才算填滿
function uncoveredSlots() {
  const out = [];
  for (const slot of ['before', 'after']) {
    const p = state.photos[slot];
    if (!p) continue;
    const [sx, sy, sw] = SLOTS[slot];
    const inside = [c(sx, sy), c(sx + sw, sy), c(sx + sw, VISIBLE_BOTTOM), c(sx, VISIBLE_BOTTOM)]
      .map((q) => invT(p.t, q))
      .every((z) => z.re >= -1.5 && z.im >= -1.5 && z.re <= p.bitmap.width + 1.5 && z.im <= p.bitmap.height + 1.5);
    if (!inside) out.push(slot);
  }
  return out;
}

let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    compose(vctx);
    drawOverlays(vctx);
    $('#dropHint').hidden = Boolean(state.photos.before || state.photos.after);
    const gaps = uncoveredSlots();
    $('#coverWarn').textContent = gaps.length
      ? `${gaps.map((s) => SLOT_NAME[s]).join('、')} 照片沒有填滿格子，邊緣會露出底色。兩張照片拍的範圍差太多，建議換一張拍得比較接近的照片。`
      : '';
  });
}

// ---------- 療程與字型 ----------
async function checkFont() {
  const T = SPEC.title;
  const font = `${T.fontWeight} ${T.fontSize}px "${T.fontFamily}"`;
  const text = state.title.trim() || '嘴唇玻尿酸';
  try {
    await document.fonts.load(font, text);
    const loaded = [...document.fonts].some((f) => f.family.replace(/["']/g, '') === T.fontFamily && f.status === 'loaded');
    state.fontOk = loaded && document.fonts.check(font, text);
  } catch {
    state.fontOk = false;
  }
  $('#fontWarn').textContent = state.fontOk ? '' : '標題字型沒有載入成功，為了不讓字型跑掉，暫時不能匯出。請重新整理頁面再試。';
}

async function setTitle(text) {
  state.title = text.trim();
  $('#treatment').value = state.title;
  await checkFont();
  const L = titleLayout(vctx, state.title);
  $('#titleWarn').textContent = state.title && !L.fits ? '療程名稱太長，放不進外框上的位置，請縮短（目前最多約 6 個中文字）。' : '';
  render();
}

function refreshTreatmentList() {
  const list = storageGet(TREAT_KEY, []);
  $('#treatmentList').innerHTML = list.map((t) => `<option value="${t.replace(/"/g, '&quot;')}"></option>`).join('');
}

function rememberTreatment(t) {
  if (!t) return;
  const list = storageGet(TREAT_KEY, []).filter((x) => x !== t);
  list.unshift(t);
  storageSet(TREAT_KEY, list.slice(0, 30));
  refreshTreatmentList();
}

function askTreatment() {
  if (state.title) return;
  const dlg = $('#treatmentDialog');
  $('#dialogTreatment').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'cancel' && $('#dialogTreatment').value.trim()) setTitle($('#dialogTreatment').value);
  }, { once: true });
}

// ---------- 模式與滑鼠 ----------
function setMode(mode) {
  state.mode = mode;
  view.classList.toggle('picking', Boolean(mode));
  $('#addMask').classList.remove('active');
  if (!mode) { setMsg(''); render(); return; }
  if (mode.type === 'mask') {
    $('#addMask').classList.add('active');
    setMsg('在預覽上拖一個框，框住要遮起來的地方（按 Esc 取消）');
  }
  render();
}

function toCanvas(e) {
  const r = view.getBoundingClientRect();
  return c(((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height);
}

view.addEventListener('pointerdown', (e) => {
  const pt = toCanvas(e);
  const mode = state.mode;
  if (mode && mode.type === 'mask') {
    state.drag = { type: 'mask', x0: pt.re, y0: pt.im, x1: pt.re, y1: pt.im };
    view.setPointerCapture(e.pointerId);
  }
});

view.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d) return;
  const pt = toCanvas(e);
  if (d.type === 'mask') {
    d.x1 = pt.re; d.y1 = pt.im;
  }
  render();
});

function endDrag() {
  const d = state.drag;
  if (!d) return;
  if (d.type === 'mask') {
    const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), x1 = Math.max(d.x0, d.x1), y1 = Math.max(d.y0, d.y1);
    // 框跨過中間分隔線時，拆成兩張照片各自的遮蔽，兩邊都遮到
    let added = 0;
    for (const slot of ['before', 'after']) {
      const photo = state.photos[slot];
      if (!photo) continue;
      const [sx, sy, sw, sh] = SLOTS[slot];
      const ix0 = Math.max(x0, sx), iy0 = Math.max(y0, sy), ix1 = Math.min(x1, sx + sw), iy1 = Math.min(y1, sy + sh);
      if (ix1 - ix0 < 4 || iy1 - iy0 < 4) continue;
      const quad = [c(ix0, iy0), c(ix1, iy0), c(ix1, iy1), c(ix0, iy1)].map((q) => invT(photo.t, q));
      state.masks.push({ slot, quad });
      added++;
    }
    setMode(null);
    if (!added && (x1 - x0 > 6 || y1 - y0 > 6)) setMsg('遮蔽框要拖在照片上');
    refreshMaskStatus();
  }
  state.drag = null;
  view.style.cursor = '';
  render();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.mode) setMode(null); });

function refreshMaskStatus() {
  $('#maskStatus').textContent = state.masks.length ? `已遮蔽 ${state.masks.length} 處（紅色虛線框，會跟著照片移動；匯出時不會出現虛線）` : '沒有遮蔽';
}

// ---------- 載入照片 ----------
async function handleFiles(files, preferSlot) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!imgs.length) return;
  let order;
  if (imgs.length >= 2) order = ['before', 'after'];
  else order = [preferSlot || (!state.photos.before ? 'before' : 'after')];
  const n = Math.min(imgs.length, order.length);
  const tokens = order.slice(0, n).map((slot) => ++loadSeq[slot]); // 拖進來的當下就領號，不等讀完
  for (let i = 0; i < n; i++) {
    const slot = order[i];
    const res = await loadPhoto(slot, imgs[i], { token: tokens[i] });
    if (!res || res.stale) continue;
    // 換了照片，正在進行的選點、取色、拖曳一律取消，避免舊照片的點跟新照片混在一起
    if (state.mode) {
      setMode(null);
      setMsg(`換了 ${SLOT_NAME[slot]} 照片，剛才進行到一半的操作已取消，請重新開始`);
    }
    state.drag = null;
    state.photos[slot].points = [];
    state.aligned = false;
    const before = state.masks.length;
    state.masks = state.masks.filter((m) => m.slot !== slot);
    if (state.masks.length !== before) setMsg(`換了 ${SLOT_NAME[slot]} 照片，原本這張的遮蔽已清除，請重新檢查要遮的地方`);
    refreshMaskStatus();
    applyAutoWB(slot);
    const lowRes = SLOTS[slot][2] / state.photos[slot].bitmap.width > 1.15 && SLOTS[slot][3] / state.photos[slot].bitmap.height > 1.15;
    if (lowRes) setMsg(`${SLOT_NAME[slot]} 照片解析度偏低，放進外框會被放大，可能有點糊`);
  }
  await autoAlign();
  render();
  askTreatment();
}

document.querySelectorAll('input[type="file"][data-slot]').forEach((input) => {
  input.addEventListener('change', () => { handleFiles(input.files, input.dataset.slot); input.value = ''; });
});

const wrap = $('#canvasWrap');
wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  wrap.classList.remove('dragover');
  const pt = toCanvas(e);
  const prefer = e.dataTransfer.files.length === 1 ? (pt.re < W / 2 ? 'before' : 'after') : null;
  handleFiles(e.dataTransfer.files, prefer);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------- 面板按鈕 ----------
$('#treatment').addEventListener('change', (e) => setTitle(e.target.value));
$('#optOnion').addEventListener('change', (e) => { state.onion = e.target.checked; render(); });
$('#optRaw').addEventListener('change', (e) => { state.raw = e.target.checked; render(); });

$('#addMask').addEventListener('click', () => setMode({ type: 'mask' }));
$('#clearMasks').addEventListener('click', () => { state.masks = []; refreshMaskStatus(); render(); });

// ---------- 匯出與專案檔 ----------
function projectData() {
  const ph = (p) => p && {
    name: p.name,
    hash: p.hash,
    size: [p.bitmap.width, p.bitmap.height],
    transform: { a: p.t.a, b: p.t.b },
    points: p.points,
    manual: p.manual,
    whiteBalance: { gains: p.wb.gains, source: p.wb.source },
  };
  return {
    tool: 'BA 圖製作',
    version: 1,
    toolVersion: TOOL_VERSION,
    frame: FRAME_ID,
    savedAt: new Date().toISOString(),
    treatment: state.title,
    part: state.part,
    aligned: state.aligned,
    alignNote: state.aligned ? '參考點對齊' : '尺度未經參考點確認',
    photos: { before: ph(state.photos.before), after: ph(state.photos.after) },
    masks: state.masks,
  };
}

// 專案檔欄位全部驗證；有問題就丟出一句白話原因
function parseProject(proj) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const cx = (z) => z && num(z.re) && num(z.im);
  const photos = {};
  for (const slot of ['before', 'after']) {
    const info = proj.photos && proj.photos[slot];
    const name = SLOT_NAME[slot];
    if (!info || typeof info.hash !== 'string') throw `${name} 的照片資料不見了`;
    const tr = info.transform;
    if (!tr || !cx(tr.a) || !cx(tr.b) || Math.hypot(tr.a.re, tr.a.im) < 1e-6) throw `${name} 的位置與縮放設定壞了`;
    const pts = info.points || [];
    if (!Array.isArray(pts) || pts.length > 2 || !pts.every(cx)) throw `${name} 的參考點設定壞了`;
    const gains = (info.whiteBalance && info.whiteBalance.gains) || [1, 1, 1];
    if (!Array.isArray(gains) || gains.length !== 3 || !gains.every((g) => num(g) && g >= 0.5 && g <= 2)) throw `${name} 的白平衡設定壞了`;
    photos[slot] = {
      t: { a: c(tr.a.re, tr.a.im), b: c(tr.b.re, tr.b.im) },
      points: pts.map((z) => c(z.re, z.im)),
      manual: Boolean(info.manual),
      gains: gains.slice(),
      source: (info.whiteBalance && info.whiteBalance.source) || null,
    };
  }
  const masks = proj.masks || [];
  if (!Array.isArray(masks) || !masks.every((m) => m && (m.slot === 'before' || m.slot === 'after') && Array.isArray(m.quad) && m.quad.length === 4 && m.quad.every(cx))) {
    throw '遮蔽設定壞了';
  }
  if (proj.treatment != null && typeof proj.treatment !== 'string') throw '療程名稱壞了';
  return {
    photos,
    masks: masks.map((m) => ({ slot: m.slot, quad: m.quad.map((z) => c(z.re, z.im)) })),
    part: PARTS[proj.part] ? proj.part : 'lips',
  };
}

function safeName(s) { return s.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 30) || 'BA'; }

$('#exportBtn').addEventListener('click', async () => {
  const problems = [];
  if (!state.photos.before || !state.photos.after) problems.push('兩張照片都要放進來');
  if (!state.title) problems.push('還沒填療程');
  else if (!titleLayout(vctx, state.title).fits) problems.push('療程名稱太長');
  await checkFont();
  if (!state.fontOk) problems.push('標題字型沒有載入成功');
  if (problems.length) { alert(`還不能匯出：\n・${problems.join('\n・')}`); return; }
  const gaps = uncoveredSlots();
  if (gaps.length && !confirm(`${gaps.map((s) => SLOT_NAME[s]).join('、')} 照片沒有填滿格子，匯出的圖邊緣會露出底色。確定照這樣匯出嗎？`)) return;
  const dlg = $('#exportDialog');
  dlg.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    setMsg('正在用原圖輸出，請稍等…');
    await new Promise((r) => setTimeout(r, 30));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    compose(out.getContext('2d'), { exportMode: true });
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const base = `BA_${safeName(state.title)}_${stamp}`;
    download(blob, `${base}.png`);
    rememberTreatment(state.title);
    setMsg(`已匯出 ${base}.png`);
    render();
  }, { once: true });
});

$('#projectInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let proj;
  try { proj = JSON.parse(await f.text()); } catch { alert('這個專案檔讀不了'); return; }
  if (proj.tool !== 'BA 圖製作' || !proj.photos) { alert('這不是 BA 圖製作的專案檔'); return; }
  // 沒寫版本的舊專案也當成「版本無法確認」提醒，不默認跟現在一樣
  if (proj.frame !== FRAME_ID || proj.toolVersion !== TOOL_VERSION) {
    alert(`這個專案是用 ${proj.toolVersion || '舊版'}（外框 ${proj.frame}）做的，目前工具是 ${TOOL_VERSION}（外框 ${FRAME_ID}）。要做出跟當初一模一樣的圖，請向維護的人拿 ${proj.toolVersion || '當時'} 那一版工具來開。`);
  }
  const dlg = $('#relinkDialog');
  $('#relinkInfo').textContent = `請選回原始照片：Before「${proj.photos.before?.name || '—'}」、After「${proj.photos.after?.name || '—'}」。工具會比對是不是同一張。`;
  $('#relinkWarn').textContent = '';
  $('#relinkBefore').value = '';
  $('#relinkAfter').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const files = { before: $('#relinkBefore').files[0], after: $('#relinkAfter').files[0] };
    // 先把專案所有欄位和兩張原圖都驗證完，全部對才一次換上；任何一項不對，目前的工作內容完全不動
    let parsed;
    try { parsed = parseProject(proj); } catch (msg) { alert(`專案檔內容有問題：${msg}。取消載入，目前的內容沒有變。`); return; }
    const staged = {};
    for (const slot of ['before', 'after']) {
      if (!files[slot]) { alert(`沒有選 ${SLOT_NAME[slot]} 原圖，取消載入，目前的內容沒有變。`); return; }
      const res = await loadPhoto(slot, files[slot], { expectHash: proj.photos[slot].hash, dryRun: true });
      if (!res) return;
      if (res.mismatch) { alert(`${SLOT_NAME[slot]} 選的不是當初那張原圖（內容不同），取消載入，目前的內容沒有變。`); return; }
      staged[slot] = res.photo;
    }
    setMode(null);
    for (const slot of ['before', 'after']) {
      const info = parsed.photos[slot];
      const p = staged[slot];
      p.t = info.t;
      p.points = info.points;
      p.manual = info.manual;
      p.wb.gains = info.gains;
      p.wb.source = info.source;
      p.wb.note = p.wb.gains.every((g) => g === 1) ? '維持原色（照專案檔）' : '照專案檔的校正';
      state.photos[slot] = p;
      document.querySelector(`[data-fname="${slot}"]`).textContent = p.name;
      setWBStatus(slot, p.wb.note, p.wb.note !== '原色');
    }
    state.part = parsed.part;
    state.masks = parsed.masks;
    refreshMaskStatus();
    state.aligned = Boolean(proj.aligned);
    state.fitNote = '';
    state.autoAlign = null;
    await setTitle(proj.treatment || '');
    // 照專案檔記的位置放回、不重新自動填滿，舊專案才做得出跟當初一模一樣的圖
    if (state.aligned) tryAlign();
    setMsg('專案已從原圖重建');
    render();
  }, { once: true });
});

// 取消鈕只認真的點擊；在輸入框按 Enter 會走「確定」
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('cancel')));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('cancel', () => { d.returnValue = 'cancel'; }));

// ---------- 啟動 ----------
(async function init() {
  try {
    const [base, fade, divider, pillBefore, pillAfter] = await Promise.all([
      loadImage('assets/frame-base.png'),
      loadImage('assets/fade.png'),
      loadImage('assets/divider.png'),
      loadImage('assets/pill-before.png'),
      loadImage('assets/pill-after.png'),
    ]);
    state.assets = { base, fade, divider, pillBefore, pillAfter };
  } catch (err) {
    setMsg(err.message);
    return;
  }
  $('#toolVer').textContent = `版本 ${TOOL_VERSION}`;
  refreshTreatmentList();
  await checkFont();
  render();
})();
