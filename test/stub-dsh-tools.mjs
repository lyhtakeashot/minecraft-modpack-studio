/**
 * `@deepseek-ai/dsh-tools` 的测试桩。
 *
 * 为什么不是简单 return：`defineTool` 的 `parameters` 与 `output.schema` 走的是
 * **两套不同的** author DSL，混用会在真机注册时抛 authorError。真机实现在 asar 里
 * （`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`），提示词库也解析不到它，
 * 所以这里按它的真实规则重实现一遍最小校验：
 *
 *   parameters      → compilePropertyMap：字段名 → 值 schema 的扁平映射，
 *                     必填靠字段自身的 `required: true`（值 schema 里不允许出现 required）
 *   output.schema   → compileValueSchema：值 schema，object 节点必须显式
 *                     `additionalProperties: true|false`，必填用 required 数组
 *
 * 这样「把 parameters 写成 object 节点」这类错误会在单测里就炸掉，不用等到装机。
 */

const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

function authorError(message) {
  throw new Error(`defineTool: ${message}`);
}

function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (allowed.has(key) || ANNOTATION_KEYS.has(key)) continue;
    authorError(`${path}.${key} is not a supported keyword`);
  }
}

/** 值 schema（输出用）。object 节点必须显式 additionalProperties。 */
function compileValue(node, path) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) authorError(`${path} must be a schema object`);
  if (node.oneOf) {
    if (node.type) authorError(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) authorError(`${path}.oneOf must be an array of at least two schemas`);
    return { oneOf: node.oneOf.map((n, i) => compileValue(n, `${path}.oneOf[${i}]`)) };
  }
  switch (node.type) {
    case 'json':
      return {};
    case 'object': {
      assertKeys(node, path, new Set(['type', 'properties', 'additionalProperties']));
      if (typeof node.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties must be explicitly true or false`);
      }
      const out = { type: 'object', additionalProperties: node.additionalProperties };
      if (node.description) out.description = node.description;
      if (node.properties) {
        out.properties = {};
        // 值 schema 里的 properties 也是 property-map：子字段的 required 是**非法**的
        for (const [k, v] of Object.entries(node.properties)) out.properties[k] = compileValue(v, `${path}.properties.${k}`);
      }
      if (Array.isArray(node.required)) out.required = [...node.required];
      return out;
    }
    case 'array': {
      assertKeys(node, path, new Set(['type', 'items']));
      const out = { type: 'array' };
      if (node.description) out.description = node.description;
      if (node.items) out.items = compileValue(node.items, `${path}.items`);
      return out;
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      const out = { type: node.type };
      for (const key of ANNOTATION_KEYS) if (node[key] !== undefined) out[key] = node[key];
      if (node.enum) out.enum = [...node.enum];
      return out;
    }
    default:
      return authorError(`${path} has unsupported type ${JSON.stringify(node.type)}`);
  }
}

/** 参数映射（parameters 用）：扁平，必填在字段上。 */
function compilePropertyMap(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) authorError(`${path} must be a property map object`);
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) authorError(`${path}.${key} must be a schema object`);
    if ('additionalProperties' in value) {
      // 这就是最常见的错法：把 parameters 写成了 object 节点
      authorError(
        `${path}.${key} looks like an object node — parameters is a property map (field name → field schema), `
        + 'not an object schema. Drop the outer {type:"object"} wrapper.',
      );
    }
    if (value.type === 'object') {
      properties[key] = compileValue(value, `${path}.${key}`);
    } else {
      const out = compileValue(value, `${path}.${key}`);
      properties[key] = out;
    }
    if (value.required === true) required.push(key);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

export function defineTool(definition) {
  if (!definition || typeof definition.name !== 'string') authorError('缺 name');
  if (typeof definition.execute !== 'function') authorError(`${definition.name}: 缺 execute`);
  if (typeof definition.description !== 'string' || !definition.description) authorError(`${definition.name}: 缺 description`);
  if (!definition.output || typeof definition.output.render !== 'function') {
    authorError(`${definition.name}: output.render 必填`);
  }
  const parameters = compilePropertyMap(definition.parameters, `${definition.name}.parameters`);
  const outputSchema = compileValue(definition.output.schema, `${definition.name}.output.schema`);
  if (outputSchema.type !== 'object') authorError(`${definition.name}.output.schema must be object-rooted`);
  return { ...definition, parameters, output: { ...definition.output, schema: outputSchema } };
}
