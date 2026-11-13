import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../packages/core/zip.js';
import { resolveInstance } from '../packages/core/instance.js';

const inst = resolveInstance(path.resolve('lab','重度机械症 - 实验','versions','Mechanomania'));
const jar = fs.readdirSync(inst.modsDir).find(f=>f.startsWith('create-')&&f.endsWith('.jar'));
const zip = openZip(fs.readFileSync(path.join(inst.modsDir, jar)));
const t = zip.text('assets/create/models/block/water_wheel/textures.json');
console.log('textures.json 长度', t?.length);
console.log(t);
