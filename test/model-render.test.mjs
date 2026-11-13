import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng, pngPixels } from '../packages/core/png-frame.js';
import { loadModelChain, renderModelIcon } from '../packages/core/model-render.js';

/** 造一张纯色 PNG（渲染测试只需要颜色，不需要花样）。 */
function solid(w, h, [r, g, b, a = 255]) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return encodePng(w, h, rgba);
}

/** 统计渲染结果里出现过的颜色（去重，忽略全透明）。 */
function colorsOf(png) {
  const px = pngPixels(png);
  assert.ok(px, '渲染结果必须是能解码的 PNG');
  const seen = new Map();
  for (let i = 0; i < px.width * px.height; i += 1) {
    const o = i * 4;
    if (px.rgba[o + 3] < 128) continue;
    const key = `${px.rgba[o]},${px.rgba[o + 1]},${px.rgba[o + 2]}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return { px, seen };
}

function near(seen, want, tol = 4) {
  for (const key of seen.keys()) {
    const [r, g, b] = key.split(',').map(Number);
    if (Math.abs(r - want[0]) <= tol && Math.abs(g - want[1]) <= tol && Math.abs(b - want[2]) <= tol) return true;
  }
  return false;
}

const CUBE = {
  textures: { up: 't:up', east: 't:east', south: 't:south' },
  elements: [
    {
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: {
        up: { texture: '#up' },
        east: { texture: '#east' },
        south: { texture: '#south' },
      },
    },
  ],
};

test('等轴测渲染：顶面最亮、两个侧面按 Minecraft 的明暗压暗', () => {
  const tex = {
    't:up': solid(16, 16, [255, 0, 0]),
    't:east': solid(16, 16, [0, 255, 0]),
    't:south': solid(16, 16, [0, 0, 255]),
  };
  const out = renderModelIcon({
    model: CUBE,
    loadTexture: (ref) => (tex[ref] ? pngPixels(tex[ref]) : null),
    size: 64,
  });
  assert.ok(out, '立方体必须能渲染出来');
  assert.equal(out.png.length > 0, true);
  const { px, seen } = colorsOf(out.png);
  assert.equal(px.width, 64);
  assert.equal(px.height, 64);
  assert.ok(near(seen, [255, 0, 0]), '顶面应保留原色');
  assert.ok(near(seen, [0, 153, 0]), '东面按 0.6 压暗');
  assert.ok(near(seen, [0, 0, 204]), '南面按 0.8 压暗');
  assert.equal(out.missing.length, 0);
});

test('等轴测渲染：背对相机的面不画（只有 north 面时没有可用像素）', () => {
  const model = {
    textures: { n: 't:n' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#n' } } }],
  };
  const out = renderModelIcon({
    model,
    loadTexture: () => pngPixels(solid(16, 16, [9, 9, 9])),
    size: 32,
  });
  assert.equal(out, null);
});

test('等轴测渲染：贴图拿不到就如实失败，并说出缺哪张', () => {
  const out = renderModelIcon({
    model: CUBE,
    loadTexture: () => null,
    size: 32,
  });
  assert.equal(out, null);
});

test('等轴测渲染：没有 elements 的纯平面模型不画', () => {
  const out = renderModelIcon({
    model: { textures: { layer0: 't:x' }, elements: [] },
    loadTexture: () => pngPixels(solid(16, 16, [1, 2, 3])),
    size: 32,
  });
  assert.equal(out, null);
});

test('模型链：parent 的 elements 会被继承，子模型的 textures 覆盖父模型', () => {
  const files = {
    'demo:block/cube_all': { textures: { all: 'demo:block/stone', particle: 'demo:block/stone' } },
    'demo:block/cube_thin': {
      parent: 'demo:block/cube_all',
      textures: { all: 'demo:block/planks' },
      elements: [{ from: [0, 0, 0], to: [16, 2, 16], faces: { up: { texture: '#all' } } }],
    },
  };
  const model = loadModelChain((ref) => files[ref] ?? null, 'demo:block/cube_thin');
  assert.ok(model);
  assert.equal(model.textures.all, 'demo:block/planks');
  assert.equal(model.textures.particle, 'demo:block/stone');
  assert.equal(model.elements.length, 1);
});

test('模型链：parent 的 elements 在没有自己的 elements 时顶上', () => {
  const files = {
    'demo:block/base': {
      textures: { all: 'demo:block/base' },
      elements: [{ from: [0, 0, 0], to: [16, 16, 0], faces: { up: { texture: '#all' } } }],
    },
    'demo:item/thing': { parent: 'demo:block/base', textures: {} },
  };
  const model = loadModelChain((ref) => files[ref] ?? null, 'demo:item/thing');
  assert.equal(model.elements.length, 1);
  assert.equal(model.textures.all, 'demo:block/base');
});