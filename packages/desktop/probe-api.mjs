/**
 * 探一下：`import('electron')` 拿到的 default 到底是什么形状。
 *
 * 上一轮的结果很怪：动态导入成功，但 default 上 Object.keys() 是空数组，
 * .app 也不是对象。这说明 Electron 的 ESM 入口把东西藏在了别处（可能挂在原型上，
 * 或者用 getter 定义在不可枚举的位置）。这里把能摸到的线索全打出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'lab', 'desktop-api-probe2.json');

const result = { steps: [], shape: {}, gotApp: false };

const mod = await import('electron');
result.steps.push(`namespace keys：${JSON.stringify(Object.keys(mod))}`);

const def = mod.default;
result.shape.defaultType = typeof def;
result.shape.defaultIsNull = def === null;
result.shape.defaultKeys = def ? Object.keys(def) : [];
result.shape.ownNames = def ? Object.getOwnPropertyNames(def).slice(0, 60) : [];
result.shape.protoKeys = def ? Object.getOwnPropertyNames(Object.getPrototypeOf(def) ?? {}).slice(0, 60) : [];

try {
  result.shape.appType = typeof def?.app;
  result.shape.appWhenReady = typeof def?.app?.whenReady;
  result.shape.windowType = typeof def?.BrowserWindow;
} catch (error) {
  result.shape.accessError = String(error instanceof Error ? error.message : error);
}

// 直接取一个已知存在的属性，看是不是 getter
if (def) {
  const desc = Object.getOwnPropertyDescriptor(def, 'app');
  result.shape.appDescriptor = desc
    ? { hasGet: typeof desc.get === 'function', enumerable: desc.enumerable, configurable: desc.configurable }
    : null;
}

result.gotApp = typeof def?.app?.whenReady === 'function';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

try {
  def?.app?.quit?.();
} catch {
  /* 拿不到就硬退 */
}
process.exit(0);
