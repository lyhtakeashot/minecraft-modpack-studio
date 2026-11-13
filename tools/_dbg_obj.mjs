import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../packages/core/zip.js';
import { resolveInstance } from '../packages/core/instance.js';

const inst = resolveInstance(path.resolve('lab','重度机械症 - 实验','versions','Mechanomania'));
const jar = fs.readdirSync(inst.modsDir).find(f=>f.startsWith('create-')&&f.endsWith('.jar'));
const zip = openZip(fs.readFileSync(path.join(inst.modsDir, jar)));
console.log('textures.json:', zip.text('assets/create/models/block/water_wheel/textures.json'));
const objPath = 'assets/create/models/block/water_wheel/water_wheel_item.obj';
console.log('obj 存在:', zip.has(objPath));
const obj = zip.text(objPath);
console.log('obj 行数:', obj.split('\n').length);
console.log('前 25 行:\n' + obj.split('\n').slice(0,25).join('\n'));
console.log('usemtl:', [...new Set(obj.split('\n').filter(l=>l.startsWith('usemtl')))].slice(0,10));
console.log('mtllib:', obj.split('\n').filter(l=>l.startsWith('mtllib')));
console.log('vt 示例:', obj.split('\n').filter(l=>l.startsWith('vt ')).slice(0,3));
console.log('f 示例:', obj.split('\n').filter(l=>l.startsWith('f ')).slice(0,3));
