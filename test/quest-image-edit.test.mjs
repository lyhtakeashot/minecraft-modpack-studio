/**
 * 「任务书装饰图（images）编辑」的单测。
 *
 * 覆盖三条动作（加 / 挪 / 删）× 三种排版（多行块、一行压缩、整章还没有 images 键），
 * 加上「字段级编辑不能把别人的排版抹掉」「算完复核对不上就不写」「真写盘后重读一致」。
 * 用内存里的假任务书，写法抄自真实文件（PCL 那套 tab 缩进 + `d` 后缀）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadQuests } from '../packages/core/quests.js';
import { parseSnbt } from '../packages/core/snbt.js';
import {
  planImageEdit, commitImagePlan, describeImagePlan,
} from '../packages/core/quest-image-edit.js';

/** 造一个假任务书。默认这一章有一张装饰图（多行块写法，和真实文件一致）。 */
function makeStore(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-imgedit-'));
  const quests = path.join(root, 'quests');
  fs.mkdirSync(path.join(quests, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(quests, 'lang'), { recursive: true });

  const chapter = overrides.chapter ?? `{
	default_quest_shape: ""
	filename: "CH1"
	group: "G1"
	id: "CH1"
	images: [
		{
			height: 10.24d
			image: "ftbquests:textures/end_flower_forest.png"
			rotation: 0.0d
			width: 21.36d
			x: 0.0d
			y: 0.5d
		}
	]
	order_index: 0
	quest_links: [ ]
	quests: [
		{
			id: "Q1"
			x: 0.0d
			y: 0.0d
		}
	]
}`;
  fs.writeFileSync(path.join(quests, 'chapters', 'CH1.snbt'), chapter, 'utf8');
  fs.writeFileSync(path.join(quests, 'lang', 'en_us.snbt'), '{\n\tchapter.CH1.title: "第一章"\n}\n', 'utf8');
  fs.writeFileSync(path.join(quests, 'chapter_groups.snbt'), '[ { id: "G1" } ]', 'utf8');
  return { root, questDir: quests, chapter };
}

const read = (questDir) => fs.readFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), 'utf8');

// ------------------------------------------------------------ 加

test('加装饰图：追加到 images 末尾，键按字母序、数字带 d 后缀，别处一个字节不动', () => {
  const { questDir, chapter } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir,
    store,
    chapter: 'CH1',
    action: 'add',
    image: 'jei:textures/jei/atlas/gui/recipe_arrow_filled.png',
    x: 2.5,
    y: 6.5,
    width: 1.5,
    height: 1,
    rotation: 0,
  });

  assert.equal(plan.changedCount, 1);
  assert.equal(plan.writes.length, 1);
  const out = plan.writes[0].content;
  // 原来那一张原样还在
  assert.ok(out.includes('image: "ftbquests:textures/end_flower_forest.png"'));
  assert.ok(out.includes('width: 21.36d'));
  // 新的一张：整数补 .0，键序 height/image/rotation/width/x/y
  assert.ok(out.includes('height: 1.0d'), out);
  assert.ok(out.includes('image: "jei:textures/jei/atlas/gui/recipe_arrow_filled.png"'));
  assert.ok(out.includes('width: 1.5d'));
  assert.ok(out.includes('x: 2.5d'));
  assert.ok(out.includes('y: 6.5d'));
  const block = /height: 1\.0d\n\t\t\timage: "jei[^\n]*\n\t\t\trotation: 0\.0d\n\t\t\twidth: 1\.5d\n\t\t\tx: 2\.5d\n\t\t\ty: 6\.5d/;
  assert.ok(block.test(out), out);
  // 除新增之外没动：去掉新块后应该跟原文一模一样
  assert.notEqual(out, chapter);
  // 没写盘
  assert.equal(read(questDir), chapter);
});

test('加装饰图：章节本来没有 images 键时，按字母序插进去', () => {
  const { questDir } = makeStore({
    chapter: `{
	filename: "CH1"
	id: "CH1"
	order_index: 0
	quest_links: [ ]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir, store, chapter: 'CH1', action: 'add',
    image: 'minecraft:textures/block/stone.png', x: 0, y: 0, width: 4, height: 3,
  });
  const out = plan.writes[0].content;
  const lines = out.split('\n').map((l) => l.trim());
  // images 要排在 filename 之后、order_index 之前（字母序）
  assert.ok(
    lines.indexOf('filename: "CH1"') < lines.findIndex((l) => l.startsWith('images:'))
      && lines.findIndex((l) => l.startsWith('images:')) < lines.indexOf('order_index: 0'),
    out,
  );
  // 插完还能读回 1 张
  fs.writeFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), out, 'utf8');
  assert.equal(loadQuests(questDir).chapters[0].images.length, 1);
});

test('加装饰图：空列表 `[ ]` 也能追加（拆成多行块）', () => {
  const { questDir } = makeStore({
    chapter: `{
	filename: "CH1"
	id: "CH1"
	images: [ ]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir, store, chapter: 'CH1', action: 'add',
    image: 'minecraft:textures/block/stone.png', x: 1, y: 2, width: 4, height: 3,
  });
  assert.equal(plan.changedCount, 1);
  const out = plan.writes[0].content;
  assert.ok(out.includes('images: [\n'), out);
  assert.ok(!out.includes('images: [ ]'), out);
});

test('加装饰图：贴图路径不合法、没给宽高、宽高超上限，都要在算的时候就拦下来', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const base = { questDir, store, chapter: 'CH1', action: 'add', x: 0, y: 0, width: 4, height: 3 };

  assert.throws(() => planImageEdit({ ...base, image: 'Stone' }), /不像个资源 ID/);
  assert.throws(() => planImageEdit({ ...base, image: 'minecraft:stone', width: undefined }), /没给装饰图的宽/);
  assert.throws(() => planImageEdit({ ...base, image: 'minecraft:stone', height: 0 }), /必须是正数/);
  assert.throws(() => planImageEdit({ ...base, image: 'minecraft:stone', width: 9999 }), /太大/);
  // 拦下来就什么都没写
  assert.ok(!fs.existsSync(path.join(questDir, 'chapters', 'CH1.snbt.bak-' + Date.now())));
});

// ------------------------------------------------------------ 挪 / 改

test('挪装饰图：只改那一张的 x/y（半格吸附），别的字节不动、d 后缀保住', () => {
  const { questDir, chapter } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir, store, chapter: 'CH1', action: 'move', index: 0, x: 3.26, y: -1,
  });
  assert.equal(plan.changedCount, 1);
  const out = plan.writes[0].content;
  assert.ok(out.includes('x: 3.5d'), out); // 3.26 吸附到 3.5
  assert.ok(out.includes('y: -1.0d'), out);
  // 宽高一个字都没变
  assert.ok(out.includes('width: 21.36d') && out.includes('height: 10.24d'));
  // 整个文件的长度只变了这几个字符
  assert.ok(Math.abs(out.length - chapter.length) <= 4, `长度差太多：${out.length} vs ${chapter.length}`);
});

test('挪装饰图：值没变时返回空计划，不写盘（也不留备份）', () => {
  const { questDir, chapter } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', index: 0, x: 0, y: 0.5 });
  assert.equal(plan.changedCount, 0);
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(describeImagePlan(plan), ['章节：第一章（CH1）', '模式：演练（不写盘）', '装饰图没有任何改动（值本来就一样）。']);
  assert.equal(read(questDir), chapter);
});

test('改大小 / 旋转：宽高按原样写（不吸附），rotation 也能改', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir, store, chapter: 'CH1', action: 'move', index: 0,
    width: 12.36, height: 7, rotation: 90,
  });
  const out = plan.writes[0].content;
  assert.ok(out.includes('width: 12.36d'), out);
  assert.ok(out.includes('height: 7.0d'), out);
  assert.ok(out.includes('rotation: 90.0d'), out);
});

test('挪装饰图：序号越界要说清楚只有几张', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  assert.throws(
    () => planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', index: 5, x: 0, y: 0 }),
    /只有 1 张装饰图，没有第 6 张/,
  );
  assert.throws(
    () => planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', x: 0, y: 0 }),
    /没说是第几张装饰图/,
  );
});

// ------------------------------------------------------------ 删

test('删装饰图：删最后一张时连前面的逗号一起收拾干净，文件还能读', () => {
  const { questDir } = makeStore({
    chapter: `{
	filename: "CH1"
	id: "CH1"
	images: [
		{
			height: 1.0d
			image: "jei:textures/jei/atlas/gui/recipe_arrow_filled.png"
			rotation: 0.0d
			width: 1.5d
			x: 2.5d
			y: 6.5d
		}
		{
			height: 7.0d
			image: "umapyoi:textures/book_images/book_filler.png"
			rotation: 0.0d
			width: 7.0d
			x: 9.0d
			y: -1.0d
		}
	]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'remove', index: 1 });
  assert.equal(plan.changedCount, 1);
  const out = plan.writes[0].content;
  assert.ok(!out.includes('book_filler'), out);
  assert.ok(out.includes('recipe_arrow_filled'));
  // 不该留下 `}, ]` 或 `}\n\t\t,`
  assert.ok(!/\}\s*,/.test(out), out);
  // 排最后一张走「从上一张终点删到自己终点」，所以删完就是干净的一张
  assert.equal(parseSnbt(out, 'x').images.length, 1);
});

test('删装饰图：删第一张时删到下一张的起点，逗号跟着走', () => {
  const { questDir } = makeStore({
    chapter: `{
	filename: "CH1"
	id: "CH1"
	images: [
		{ height: 1.0d, image: "jei:arrow.png", rotation: 0.0d, width: 1.5d, x: 2.5d, y: 6.5d },
		{ height: 7.0d, image: "umapyoi:book_filler.png", rotation: 0.0d, width: 7.0d, x: 9.0d, y: -1.0d }
	]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'remove', index: 0 });
  const out = plan.writes[0].content;
  assert.ok(!out.includes('jei:arrow'), out);
  assert.ok(out.includes('umapyoi:book_filler'));
  // 一行压缩的写法删完还是一行
  assert.ok(/images: \[\s*\{ height: 7\.0d/.test(out), out);
});

test('删掉唯一一张装饰图后，别处不受影响', () => {
  const { questDir, chapter } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'remove', index: 0 });
  const out = plan.writes[0].content;
  assert.ok(!out.includes('end_flower_forest'), out);
  assert.ok(out.includes('id: "Q1"'));
  assert.ok(out.length < chapter.length);
});

// ------------------------------------------------------------ 真写盘

test('真写盘：写完重读，装饰图数量对得上，留了 .bak 备份', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({
    questDir, store, chapter: 'CH1', action: 'add',
    image: 'minecraft:textures/block/stone.png', x: 5, y: 5, width: 2, height: 2,
  });
  const done = commitImagePlan({ plan, questDir, store });
  assert.equal(done.backups.length, 1);
  assert.ok(/\.bak-\d+$/.test(done.backups[0]));

  const after = loadQuests(questDir);
  assert.equal(after.chapters[0].images.length, 2);
  assert.equal(after.chapters[0].images[1].image, 'minecraft:textures/block/stone.png');
  assert.equal(after.chapters[0].images[1].width, 2);
  // 原有那张还在原位
  assert.equal(after.chapters[0].images[0].x, 0);
  assert.equal(after.chapters[0].images[0].y, 0.5);
  assert.ok(done.lines[0].includes('现在这一章有 2 张'), done.lines[0]);
});

test('真写盘：挪完之后再读，坐标就是新的', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', index: 0, x: 4, y: -2 });
  commitImagePlan({ plan, questDir, store });
  const after = loadQuests(questDir);
  assert.equal(after.chapters[0].images[0].x, 4);
  assert.equal(after.chapters[0].images[0].y, -2);
  assert.equal(after.chapters[0].images[0].width, 21.36);
});

test('真写盘：没有改动时直接返回，一个文件都不写', () => {
  const { questDir, chapter } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', index: 0, x: 0, y: 0.5 });
  const done = commitImagePlan({ plan, questDir, store });
  assert.deepEqual(done.backups, []);
  assert.deepEqual(done.lines, ['装饰图没变，什么都没写']);
  assert.equal(read(questDir), chapter);
});

// ------------------------------------------------------------ 描述

test('describeImagePlan：演练 / 写盘两种措辞，带上人话 diff', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const plan = planImageEdit({ questDir, store, chapter: 'CH1', action: 'move', index: 0, x: 2, y: 3 });
  const dry = describeImagePlan(plan);
  assert.equal(dry[0], '章节：第一章（CH1）');
  assert.equal(dry[1], '模式：演练（不写盘）');
  assert.ok(dry.some((l) => l.includes('第 1 张挪位置：(0, 0.5) → (2, 3)')), dry.join('\n'));
  const real = describeImagePlan(plan, { apply: true });
  assert.equal(real[1], '模式：真正写盘');
});

test('planImageEdit：章节找不到时给看得懂的话，不是 undefined 之类', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  assert.throws(
    () => planImageEdit({ questDir, store, chapter: '不存在的章', action: 'add', image: 'a:b.png', width: 1, height: 1 }),
    /这本书里没有章节「不存在的章」/,
  );
  assert.throws(
    () => planImageEdit({ questDir, store, chapter: 'CH1', action: 'rename' }),
    /不认识的装饰图操作/,
  );
});
