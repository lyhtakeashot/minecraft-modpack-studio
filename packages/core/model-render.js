/**
 * 把方块/物品的**模型**画成一张等轴测（斜 45°）小图。
 *
 * 为什么需要它：用户明确要「和 JEI 里显示的差不多，只要手拿物品的样子」。
 * JEI 是拿游戏里的模型实时渲染的；我们手上只有 jar，没有渲染器，于是自己画：
 * 读 `models/x.json` 的 `elements`（一堆长方体）+ `textures`（指向贴图 PNG），
 * 按等轴测投影把「朝上、朝南、朝东」三个面画出来，贴图逐像素取样。
 *
 * 不追求像素级还原（不做光照、不做元素旋转、不做 tint），目标只是「一眼能认出是什么」，
 * 比拿其中一张贴图冒充强得多 —— 后者会把安山传送带漏斗画成普通安山漏斗。
 */

import { pngPixels, encodePng } from './png-frame.js';

/** 等轴测的 30°：横向压缩 cos30，纵向 sin30。 */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

/** 面名 → 法线（只说「朝哪边」，不归一化）。 */
const NORMALS = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

/** 面的明暗（跟 Minecraft 自己着色一致：顶面最亮、侧面次之）。 */
const SHADE = {
  up: 1,
  down: 0.5,
  north: 0.8,
  south: 0.8,
  west: 0.6,
  east: 0.6,
};

/**
 * 一个面在模型坐标里的四个角：(U,V) = (0,0) → (1,0) → (1,1) → (0,1)。
 * U 是贴图的右方向，V 是贴图的**下**方向（PNG 的 y 轴朝下）。
 * @returns {number[][]} 4 个 [x,y,z]
 */
function faceCorners(face, x1, y1, z1, x2, y2, z2) {
  switch (face) {
    case 'up':
      return [
        [x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2],
      ];
    case 'down':
      return [
        [x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1],
      ];
    case 'south':
      return [
        [x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2],
      ];
    case 'north':
      return [
        [x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1],
      ];
    case 'east':
      return [
        [x2, y2, z1], [x2, y2, z2], [x2, y1, z2], [x2, y1, z1],
      ];
    case 'west':
      return [
        [x1, y2, z2], [x1, y2, z1], [x1, y1, z1], [x1, y1, z2],
      ];
    default:
      return null;
  }
}

/**
 * 面没写 `uv` 时的默认取图区域（照 Minecraft 的规矩）。
 * @returns {number[]} [u1, v1, u2, v2]，单位是 0..16
 */
function defaultUv(face, x1, y1, z1, x2, y2, z2) {
  switch (face) {
    case 'up':
      return [x1, z1, x2, z2];
    case 'down':
      return [x1, z2, x2, z1];
    case 'south':
      return [x1, 16 - y2, x2, 16 - y1];
    case 'north':
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case 'east':
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
    case 'west':
      return [z1, 16 - y2, z2, 16 - y1];
    default:
      return [0, 0, 16, 16];
  }
}

/**
 * 把 `#name` 一层层解到真贴图路径（`create:block/x`）。解不开返回空串。
 */
function resolveTextureRef(textures, raw) {
  let ref = typeof raw === 'string' ? raw.trim() : '';
  for (let guard = 0; ref.startsWith('#') && guard < 6; guard += 1) {
    const key = ref.slice(1);
    const next = textures?.[key];
    if (typeof next !== 'string') return '';
    ref = next.trim();
  }
  return ref.startsWith('#') ? '' : ref;
}

/**
 * 顺着 `parent` 把模型链合并成一份：贴图按 key 由子覆盖父，`elements` 有就用子的。
 *
 * @param {(ref: string) => object|null} readJson 参数形如 `create:block/cube`（不带 models/ 前缀）
 * @param {string} startRef 起始模型，如 `create:block/funnel/item`
 * @param {{maxDepth?: number}} [opts]
 * @returns {{textures: Record<string, string>, elements: object[]}|null}
 */
export function loadModelChain(readJson, startRef, { maxDepth = 6 } = {}) {
  if (typeof startRef !== 'string' || !startRef.includes(':') || typeof readJson !== 'function') return null;
  const chain = [];
  let ref = startRef;
  for (let depth = 0; depth <= maxDepth && ref; depth += 1) {
    const json = readJson(ref);
    if (!json || typeof json !== 'object') break;
    chain.push({ ref, json });
    const parent = typeof json.parent === 'string' ? json.parent.trim() : '';
    if (!parent) break;
    // 不带命名空间的 parent 要补 `minecraft:`（Minecraft 的规矩），**不是**补模型自己的命名空间。
    // `{"parent": "item/template_spawn_egg"}` 在游戏里找的就是原版那个刷怪蛋模型；
    // 以前补成 `<mod>:item/template_spawn_egg`，于是整批刷怪蛋都画不出来。
    const [pns, ppath] = parent.includes(':') ? parent.split(':') : ['minecraft', parent];
    ref = `${pns}:${ppath}`;
  }
  if (!chain.length) return null;

  const textures = {};
  let elements = null;
  // 从最远的 parent 往回走，子模型覆盖父模型
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const { json } = chain[i];
    for (const [k, v] of Object.entries(json.textures ?? {})) {
      if (typeof v === 'string') textures[k] = v;
    }
    if (Array.isArray(json.elements) && json.elements.length) elements = json.elements;
  }
  if (!elements) return { textures, elements: [] };
  return { textures, elements };
}

/** 等轴测投影：模型坐标 (0..16, y 朝上) → 屏幕坐标（y 朝下，未缩放未平移）。 */
function project(x, y, z) {
  return [(x - z) * COS30, (x + z) * SIN30 - y];
}

/**
 * 画一个三角形（屏幕空间），UV 用重心坐标插值。
 * @returns {number} 实际写进去的像素数（透明的地方不算）
 */
function fillTriangle(buf, size, p0, p1, p2, uv0, uv1, uv2, tex, shade) {
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  if (maxX < minX || maxY < minY) return 0;
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (!area) return 0;
  let painted = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
      let w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
      let w2 = 1 - w0 - w1;
      // 容差半像素，避免边缘漏点
      if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
      w0 = Math.max(0, w0);
      w1 = Math.max(0, w1);
      w2 = 1 - w0 - w1;

      const u = w0 * uv0[0] + w1 * uv1[0] + w2 * uv2[0];
      const v = w0 * uv0[1] + w1 * uv1[1] + w2 * uv2[1];
      const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
      const ty = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
      const ti = (ty * tex.width + tx) * 4;
      if (tex.rgba[ti + 3] < 128) continue; // 透明像素留着，让后面的面透出来

      const o = (y * size + x) * 4;
      buf[o] = Math.min(255, Math.round(tex.rgba[ti] * shade));
      buf[o + 1] = Math.min(255, Math.round(tex.rgba[ti + 1] * shade));
      buf[o + 2] = Math.min(255, Math.round(tex.rgba[ti + 2] * shade));
      buf[o + 3] = tex.rgba[ti + 3];
      painted += 1;
    }
  }
  return painted;
}

/**
 * 画一个四边形（两个三角形），UV 四角分别是 (0,0),(1,0),(1,1),(0,1) 映射过去的贴图位置。
 */
function fillQuad(buf, size, corners, uvs, tex, shade) {
  let painted = 0;
  painted += fillTriangle(buf, size, corners[0], corners[1], corners[2], uvs[0], uvs[1], uvs[2], tex, shade);
  painted += fillTriangle(buf, size, corners[0], corners[2], corners[3], uvs[0], uvs[2], uvs[3], tex, shade);
  return painted;
}

/**
 * 把模型渲染成 PNG。
 *
 * @param {object} opts
 * @param {{textures: Record<string,string>, elements: object[]}} opts.model `loadModelChain` 的产物
 * @param {(ref: string) => ({width: number, height: number, rgba: Buffer}|null)} opts.loadTexture
 *        给贴图引用（`create:block/x`）拿解好的像素；拿不到返回 null
 * @param {number} [opts.size] 输出边长（正方形，默认 64）
 * @returns {{png: Buffer, drawn: number, faces: number, missing: string[]}|null}
 */
export function renderModelIcon({ model, loadTexture, size = 64 }) {
  const spec = Math.max(16, Math.min(256, Math.round(size)));
  if (!model || !Array.isArray(model.elements) || !model.elements.length || typeof loadTexture !== 'function') {
    return null;
  }

  const texCache = new Map();
  const missing = [];
  const getTex = (ref) => {
    if (texCache.has(ref)) return texCache.get(ref);
    let tex = null;
    try {
      tex = loadTexture(ref) ?? null;
    } catch {
      tex = null;
    }
    if (tex && (!tex.width || !tex.height || !tex.rgba)) tex = null;
    if (!tex && !missing.includes(ref)) missing.push(ref);
    texCache.set(ref, tex);
    return tex;
  };

  // 1. 收集要画的面（只画朝向观察者的三个方向），并算好投影后的角点
  const faces = [];
  for (const el of model.elements) {
    const from = el?.from;
    const to = el?.to;
    if (!Array.isArray(from) || !Array.isArray(to)) continue;
    const x1 = Math.min(Number(from[0]), Number(to[0]));
    const x2 = Math.max(Number(from[0]), Number(to[0]));
    const y1 = Math.min(Number(from[1]), Number(to[1]));
    const y2 = Math.max(Number(from[1]), Number(to[1]));
    const z1 = Math.min(Number(from[2]), Number(to[2]));
    const z2 = Math.max(Number(from[2]), Number(to[2]));
    if (![x1, x2, y1, y2, z1, z2].every((n) => Number.isFinite(n))) continue;

    for (const [faceName, face] of Object.entries(el?.faces ?? {})) {
      const normal = NORMALS[faceName];
      if (!normal) continue;
      // 相机在 (+x,+y,+z) 方向：法线与 (1,1,1) 点乘 > 0 才看得见
      if (normal[0] + normal[1] + normal[2] <= 0) continue;
      const ref = resolveTextureRef(model.textures, face?.texture);
      if (!ref) continue;
      const corners3 = faceCorners(faceName, x1, y1, z1, x2, y2, z2);
      if (!corners3) continue;
      const uv = Array.isArray(face?.uv) && face.uv.length === 4
        ? face.uv.map((n) => Number(n))
        : defaultUv(faceName, x1, y1, z1, x2, y2, z2);
      const u1 = uv[0] / 16;
      const v1 = uv[1] / 16;
      const u2 = uv[2] / 16;
      const v2 = uv[3] / 16;
      faces.push({
        ref,
        faceName,
        corners: corners3.map(([x, y, z]) => project(x, y, z)),
        uvCorners: [
          [u1, v1], [u2, v1], [u2, v2], [u1, v2],
        ],
        // 画家算法：离相机（+x,+y,+z）越远越先画
        depth: (x1 + x2 + y1 + y2 + z1 + z2) / 2,
      });
    }
  }
  if (!faces.length) return null;

  // 2. 归一化到画布：算包围盒 → 等比缩放 → 居中
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of faces) {
    for (const [px, py] of f.corners) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = (spec * 0.94) / Math.max(w, h);
  const offX = (spec - w * scale) / 2 - minX * scale;
  const offY = (spec - h * scale) / 2 - minY * scale;

  // 3. 逐个面画上去（远的先画）
  const buf = Buffer.alloc(spec * spec * 4);
  faces.sort((a, b) => a.depth - b.depth);
  let drawn = 0;
  for (const f of faces) {
    const tex = getTex(f.ref);
    if (!tex) continue;
    const corners = f.corners.map(([px, py]) => [px * scale + offX, py * scale + offY]);
    drawn += fillQuad(buf, spec, corners, f.uvCorners, tex, SHADE[f.faceName] ?? 1);
  }
  if (!drawn) return null;

  return { png: encodePng(spec, spec, buf), drawn, faces: faces.length, missing };
}

/** 解码 PNG 给渲染用（动图取第一帧，调用方可以先自己裁好）。 */
export function decodeTexture(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  return pngPixels(buf);
}