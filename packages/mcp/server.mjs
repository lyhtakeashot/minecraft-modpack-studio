#!/usr/bin/env node
/**
 * MCP 服务器主入口：stdio 传输，一行一条 JSON-RPC 消息。
 *
 * 规矩：
 * ① stdout 只能出现 JSON-RPC 消息。诊断信息一律走 stderr —— 脏一行就会让客户端解析崩。
 * ② 只用 Node 内置模块，成品目录里没有 node_modules。
 * ③ 业务逻辑全在 tools.mjs 里，走的是 lib/host/api.js 的 dispatchStudioRequest，
 *    和界面点着改走的是同一套底层函数。
 *
 * 用法：
 *   node packages/mcp/server.mjs            —— 当 MCP 服务器跑（等客户端连）
 *   node packages/mcp/server.mjs --self-test —— 自己握手一次，打印工具数
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { handleLine, runSelfTest } from './protocol.mjs';

/** 往 stdout 写一条 JSON-RPC 消息。 */
function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 往 stderr 写一行诊断信息。 */
function note(text) {
  process.stderr.write(`[mcstudio-mcp] ${text}\n`);
}

/**
 * 按行读 stdin。
 *
 * data 事件给的是任意长度的块，自己攒缓冲、按 \n 切行；最后一块（没有换行结尾）也要处理。
 */
function startStdio() {
  let buffer = '';
  let chain = Promise.resolve();

  const handleChunk = (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        // 一行一行来，后一条等前一条做完，顺序不能乱。
        chain = chain.then(async () => {
          const response = await handleLine(line);
          if (response) writeMessage(response);
        }).catch((error) => {
          note(`处理消息出错：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        });
      }
      index = buffer.indexOf('\n');
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handleChunk);
  process.stdin.on('end', () => {
    const rest = buffer.trim();
    buffer = '';
    if (rest) {
      chain = chain.then(async () => {
        const response = await handleLine(rest);
        if (response) writeMessage(response);
      });
    }
    chain.then(() => {
      process.exit(0);
    });
  });
  process.stdin.on('error', (error) => {
    note(`stdin 出错：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  note('已就绪，等客户端连上来（stdio）。');
}

/** 自检：自己握手一次，把结果打到 stdout，退出码 0 成功 / 1 失败。 */
async function selfTest() {
  const result = await runSelfTest();
  if (result.ok) {
    process.stdout.write(`自检通过：${result.toolCount} 个工具可以用了。\n`);
    process.stdout.write(`协议版本 ${result.protocolVersion}；服务器 ${result.serverInfo?.name ?? '?'} ${result.serverInfo?.version ?? ''}\n`);
    process.stdout.write(`工具清单：${(result.toolNames ?? []).join('、')}\n`);
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`自检没过：${result.error}\n`);
  process.exitCode = 1;
}

/** 只有被直接运行才启动（被 import 时什么都不做，方便测试和宿主层复用）。 */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    await selfTest();
  } else {
    startStdio();
  }
}
