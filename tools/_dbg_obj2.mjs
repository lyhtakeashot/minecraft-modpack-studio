import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../packages/core/zip.js';
import { resolveInstance } from '../packages/core/instance.js';

const inst = resolveInstance(path.resolve('lab','重度机械症 - 实验','versions','Mechanomania'));
const jar = fs.readdirSync(inst.modsDir).find(f=>f.startsWith('create-')&&f.endsWith('.jar'));
const zip = openZip(fs.readFileSync(path.join(inst.modsDir, jar)));
console.log('== models/block/water_wheel/textures.json ==');
console.log(zip.text('assets/create/models/block/water_wheel/textures.json'));
console.log('== 同目录文件 ==');
console.log(zip.names.filter(n=>n.includes('models/block/water_wheel/')).slice(0,12));
console.log('== mtl ==');
const mtl = zip.text('assets/create/models/block/water_wheel/water_wheel_item.mtl');
console.log(mtl ? mtl.slice(0,600) : '（没有 mtl）');
console.log('== obj 里 vt/vn 数量 ==');
const obj = zip.text('assets/create/models/block/water_wheel/water_wheel_item.obj');
for (const k of ['v ','vt ','vn ','f ']) console.log(k, obj.split('\n').filter(l=>l.startsWith(k)).length);
