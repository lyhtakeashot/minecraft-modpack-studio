/**
 * MCP 协议层：把一条 JSON-RPC 请求变成一条 JSON-RPC 响应。
 *
 * 单独拆出来是为了两处都能用：
 * ① packages/mcp/server.mjs —— stdio 传输的主循环；
 * ② lib/host/api.js 的 /mcp/selftest 路由 —— 在桌面界面里跑一次握手体检。
 *
 * 这里不碰 stdin/stdout，所以随便在哪 import 都安全。
 */

import { callTool, toolManifest } from './tools.mjs';

/** 我们能谈的协议版本。DSH 侧首选 2026-07-28，老客户端往后排。 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** 客户端要了个不认识的版本，就退到这一个。 */
export const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** 这台服务器叫什么、什么版本。 */
export const SERVER_INFO = { name: 'mcstudio', version: '0.1.0' };

/** JSON-RPC 错误码。 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** 成功响应。 */
function ok(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** 错误响应。 */
function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * 挑一个协议版本：客户端要的在我们支持列表里就原样回，不在就退到 2025-06-18。
 */
export function pickProtocolVersion(requested) {
  const wanted = String(requested ?? '').trim();
  if (wanted && SUPPORTED_PROTOCOL_VERSIONS.includes(wanted)) return wanted;
  return FALLBACK_PROTOCOL_VERSION;
}

/**
 * 处理一条 JSON-RPC 消息。
 *
 * 返回：
 * ① 响应对象（要给客户端回一条）；
 * ② null（通知，客户端不需要回）。
 */
export async function handleRequest(message) {
  if (!message || typeof message !== 'object') {
    return fail(null, INVALID_REQUEST, '请求不是一个 JSON 对象');
  }
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  const isNotification = message.id === undefined;

  switch (method) {
    case 'initialize': {
      const version = pickProtocolVersion(message.params?.protocolVersion);
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '这是 Minecraft 整合包工作室的 MCP 服务器。工具前缀是 mcp__mcstudio__。'
          + '改东西的工具默认只预览不写盘，要真的落盘请把 apply 设为 true。'
          + '改之前先调只读工具看清楚现状。',
      });
    }

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: toolManifest() });

    case 'tools/call': {
      const name = message.params?.name;
      if (!name) {
        return fail(id, INVALID_PARAMS, 'tools/call 少了参数 name（要调哪个工具）');
      }
      const args = message.params?.arguments ?? {};
      const result = await callTool(name, args);
      return ok(id, result);
    }

    case 'resources/list':
      return ok(id, { resources: [] });

    case 'prompts/list':
      return ok(id, { prompts: [] });

    default: {
      if (isNotification) return null;
      return fail(id, METHOD_NOT_FOUND, `不认识的请求：${method}`, {
        supported: ['initialize', 'tools/list', 'tools/call', 'ping'],
      });
    }
  }
}

/** 处理一行 JSON 文本（坏 JSON 也要给客户端一个像样的答复）。 */
export async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return fail(null, PARSE_ERROR, '这一行不是合法的 JSON', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return handleRequest(message);
}

/**
 * 自己跑一次握手：initialize + tools/list。
 *
 * 给界面上的「自检」按钮用，也给 --self-test 用。
 */
export async function runSelfTest() {
  try {
    const init = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'mcstudio-selftest', version: '0.1.0' } },
    });
    if (!init?.result) {
      return { ok: false, toolCount: 0, error: `握手没成功：${init?.error?.message ?? '未知原因'}` };
    }
    const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = list?.result?.tools ?? [];
    if (!tools.length) {
      return { ok: false, toolCount: 0, error: '握手成功了，但一个工具都没有' };
    }
    const bad = tools.filter((t) => !t.name || !t.description || t.inputSchema?.type !== 'object');
    if (bad.length) {
      return {
        ok: false,
        toolCount: tools.length,
        error: `有 ${bad.length} 个工具的清单不完整（缺 name / description / inputSchema）`,
      };
    }
    return {
      ok: true,
      toolCount: tools.length,
      protocolVersion: init.result.protocolVersion,
      serverInfo: init.result.serverInfo,
      toolNames: tools.map((t) => t.name),
    };
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
