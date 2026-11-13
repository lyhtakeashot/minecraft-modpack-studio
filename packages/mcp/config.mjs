/**
 * MCP 服务器的配置：给界面显示的 DSH 配置片段，以及这台机器上「该用什么命令跑」。
 *
 * 这里只算路径和拼 YAML，不碰 stdio，方便宿主层（lib/host/api.js）直接复用。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** MCP 服务器的名字。DSH 会把它拼成工具名：mcp__<serverName>__<工具名>。 */
export const SERVER_NAME = 'mcstudio';

/** DSH 里这条 MCP 配置的 id。 */
export const CONFIG_ID = 'mcp-mcstudio';

/** DSH 侧负责连 MCP 的客户端包名。 */
export const CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** 本文件所在目录（成品里是 resources/app/packages/mcp）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 应用根目录（成品里是 resources/app）。 */
export const APP_ROOT = path.resolve(HERE, '..', '..');

/** MCP 服务器脚本的绝对路径。 */
export function serverScriptPath() {
  return path.join(APP_ROOT, 'packages', 'mcp', 'server.mjs');
}

/**
 * 跑这个脚本该用什么命令。
 *
 * 成品里桌面 exe 是 GUI 程序，得设 ELECTRON_RUN_AS_NODE=1 才会以纯 node 模式跑脚本，
 * 否则 stdin/stdout 接不上；开发机上直接用 node 跑就行，不用这个变量。
 */
export function commandSpec() {
  const electron = Boolean(process.versions?.electron);
  return {
    command: process.execPath,
    args: [serverScriptPath()],
    env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    electron,
  };
}

/** YAML 里的单引号字符串：反斜杠原样保留，只要把单引号写成两个。 */
function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成可以直接贴进 DSH 配置里的 YAML。
 *
 * 形如：
 * - id: mcp-mcstudio
 *   name: '@deepseek-ai/dsh-mcp-client'
 *   config:
 *     serverName: mcstudio
 *     transport: stdio
 *     command: 'C:\...\mcstudio.exe'
 *     args: ['C:\...\resources\app\packages\mcp\server.mjs']
 *     env:
 *       ELECTRON_RUN_AS_NODE: '1'
 *
 * @param {{command: string, args: string[], env: Record<string,string>}} spec
 */
export function buildConfigYaml(spec) {
  const lines = [
    `- id: ${CONFIG_ID}`,
    `  name: ${yamlQuote(CLIENT_PACKAGE)}`,
    '  config:',
    `    serverName: ${SERVER_NAME}`,
    '    transport: stdio',
    `    command: ${yamlQuote(spec.command)}`,
    `    args: [${spec.args.map(yamlQuote).join(', ')}]`,
  ];
  const envEntries = Object.entries(spec.env ?? {});
  if (envEntries.length) {
    lines.push('    env:');
    for (const [key, value] of envEntries) {
      lines.push(`      ${key}: ${yamlQuote(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 给界面用的完整配置包。
 *
 * @param {{packDir?: string}} options packDir 会写进 env 的 MCSTUDIO_PACK_DIR，
 *   这样模型调工具时不用每次都报一遍整合包在哪。
 */
export function buildConfig(options = {}) {
  const spec = commandSpec();
  const packDir = String(options.packDir ?? '').trim();
  const env = { ...spec.env };
  if (packDir) env.MCSTUDIO_PACK_DIR = packDir;
  return {
    yaml: buildConfigYaml({ ...spec, env }),
    serverName: SERVER_NAME,
    configId: CONFIG_ID,
    clientPackage: CLIENT_PACKAGE,
    transport: 'stdio',
    command: spec.command,
    args: spec.args,
    env,
    serverPath: serverScriptPath(),
    appRoot: APP_ROOT,
    packDir,
    /** 成品 exe 是 GUI 程序，需要这个变量才会以纯 node 模式跑脚本。 */
    needsRunAsNode: spec.electron,
  };
}
