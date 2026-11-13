/**
 * 宿主接口共用的小工具：把 query 和 POST body 合成一份参数。
 *
 * recipe-api.js / quest-api.js 里各有一份自己的实现（那些文件比较老，
 * 没去动它们）；从「装 mod」开始新写的接口统一用这里这份。
 */

/** 合并 query 参数和 JSON body；body 读不出来就只用 query，不让整个请求失败。 */
export async function readParams(request) {
  const out = {};
  const url = new URL(request.url);
  for (const [k, v] of url.searchParams) out[k] = v;
  if (request.method && request.method.toUpperCase() === 'POST') {
    try {
      const text = await request.text();
      if (text && text.trim()) {
        const body = JSON.parse(text);
        if (body && typeof body === 'object') Object.assign(out, body);
      }
    } catch {
      /* body 不是 JSON 就忽略 */
    }
  }
  return out;
}

/** 字符串数组：body 里是数组、query 里可能是 JSON 串或逗号分隔。 */
export function asList(value) {
  const clean = (list) => list.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (Array.isArray(value)) return clean(value);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return clean(parsed);
    } catch {
      /* 不是 JSON 就按逗号分隔 */
    }
    return clean(value.split(','));
  }
  return [];
}

/** 「没给就是 true，给了就按给的算」——布尔参数的常见写法，写错一次很坑。 */
export function boolOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}