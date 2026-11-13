/**
 * 把 `@deepseek-ai/dsh-tools` 解析到本地桩，只在测试里用。
 * 见 register.mjs 的说明。
 */
const STUB = new URL('./stub-dsh-tools.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
