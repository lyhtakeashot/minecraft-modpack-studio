/**
 * 「选文件夹」对话框（lib/host/pick-folder.js）的单测。
 *
 * 这层的风险是「弹不出来还假装成功」——用户点了按钮什么都没发生，
 * 或者选了取消却当成选了某个路径。所以每条分支都要么给出真路径、要么
 * 明确返回 null（取消）、要么抛一个带 hint 的错。
 *
 * 弹窗本身没法在测试里真点，所以 spawn 和 Electron 都做成可注入的假货。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  beginPickFolder,
  encodeCommand,
  pickFolder,
  pickFolderStatus,
  pickerScript,
  resetPickFolderState,
} from '../lib/host/pick-folder.js';

/** 假 Electron：只实现 dialog.showOpenDialog。 */
function fakeElectron(result) {
  return {
    dialog: {
      async showOpenDialog() {
        return result;
      },
    },
  };
}

/**
 * 假 spawn：返回一个带 stdout/stderr 的 EventEmitter。
 * `emit` 是一个回调，用来在 spawn 之后模拟子进程输出。
 */
function fakeSpawn(behaviour) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    // 放到下一个 tick 再模拟，让调用方先把监听挂上
    setImmediate(() => behaviour(child));
    return child;
  };
  return { spawnImpl, calls };
}

/** 等一小会儿，让后台 promise 落地。 */
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('pickerScript：包含 PowerShell 选文件夹需要的几个关键设置', () => {
  const script = pickerScript();
  assert.match(script, /\[Console\]::OutputEncoding/);
  assert.match(script, /System\.Windows\.Forms/);
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /ShowDialog/);
  assert.match(script, /SelectedPath/);
  assert.ok(script.includes('选择整合包文件夹'), '标题要写进脚本');
  // 取消时不能输出任何东西，否则宿主会把空串当成路径
  assert.match(script, /-eq \[System\.Windows\.Forms\.DialogResult\]::OK/);
});

test('pickerScript：标题里的单引号要转义，不能把脚本拼坏', () => {
  const script = pickerScript("我的人's 文件夹");
  assert.ok(script.includes("'我的人''s 文件夹'"), '单引号要变成两个');
});

test('encodeCommand：UTF-16LE base64 能原样还原', () => {
  const script = pickerScript();
  const encoded = encodeCommand(script);
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(decoded, script);
});

test('pickFolder：非 Windows 又没有 Electron 时老实报错', async () => {
  resetPickFolderState();
  await assert.rejects(
    () => pickFolder({ platform: 'linux', loadElectron: () => null }),
    (error) => {
      assert.equal(error.code, 'McPickUnsupported');
      assert.ok(error.hint, '要告诉用户可以直接手填路径');
      return true;
    },
  );
});

test('pickFolder：Electron 返回取消 → null', async () => {
  resetPickFolderState();
  const result = await pickFolder({ loadElectron: () => fakeElectron({ canceled: true, filePaths: [] }) });
  assert.equal(result, null);
});

test('pickFolder：Electron 选中了文件夹 → 绝对路径', async () => {
  resetPickFolderState();
  const result = await pickFolder({
    loadElectron: () => fakeElectron({ canceled: false, filePaths: ['D:\\pcl2\\整合包\\Demo'] }),
  });
  assert.equal(result, 'D:\\pcl2\\整合包\\Demo');
});

test('pickFolder：Electron 返回空数组（异常情况）→ null', async () => {
  resetPickFolderState();
  const result = await pickFolder({ loadElectron: () => fakeElectron({ canceled: false, filePaths: [] }) });
  assert.equal(result, null);
});

test('pickFolder：loadElectron 抛错时退到 PowerShell，不整体崩掉', async () => {
  resetPickFolderState();
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('D:\\x', 'utf8'));
    child.emit('close', 0);
  });
  const result = await pickFolder({
    platform: 'win32',
    loadElectron: () => {
      throw new Error('没有 electron');
    },
    spawnImpl,
  });
  assert.equal(result, 'D:\\x');
});

test('pickFolder：PowerShell 有输出 → 就是选中的路径', async () => {
  resetPickFolderState();
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('D:\\pcl2\\PCL 下载\\整合包\\重度机械症', 'utf8'));
    child.emit('close', 0);
  });
  const result = await pickFolder({ platform: 'win32', loadElectron: () => null, spawnImpl });
  assert.equal(result, 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症');
  // 必须带 -STA，否则 WinForms 的对话框直接抛异常
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.includes('-STA'), '要带 -STA');
  assert.ok(calls[0].args.includes('-EncodedCommand'), '要带 -EncodedCommand');
});

test('pickFolder：PowerShell 没输出、正常退出 → 用户点了取消', async () => {
  resetPickFolderState();
  const { spawnImpl } = fakeSpawn((child) => {
    child.emit('close', 0);
  });
  const result = await pickFolder({ platform: 'win32', loadElectron: () => null, spawnImpl });
  assert.equal(result, null);
});

test('pickFolder：PowerShell 报错退出 → 抛出带 stderr 的错', async () => {
  resetPickFolderState();
  const { spawnImpl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('System.Windows.Forms 不存在\r\n更多细节', 'utf8'));
    child.emit('close', 1);
  });
  await assert.rejects(
    () => pickFolder({ platform: 'win32', loadElectron: () => null, spawnImpl }),
    (error) => {
      assert.equal(error.code, 'McPickFolder');
      assert.match(error.message, /System\.Windows\.Forms 不存在/);
      return true;
    },
  );
});

test('pickFolder：spawn 直接抛错 → 包装成可读的错', async () => {
  resetPickFolderState();
  await assert.rejects(
    () => pickFolder({
      platform: 'win32',
      loadElectron: () => null,
      spawnImpl: () => {
        throw new Error('ENOENT');
      },
    }),
    (error) => {
      assert.equal(error.code, 'McPickFolder');
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});

test('pickFolder：已经有一个在选时再点一次 → 报忙，不弹第二个窗', async () => {
  resetPickFolderState();
  const { spawnImpl } = fakeSpawn(() => {
    /* 故意什么都不做，让它挂着 */
  });
  const options = { platform: 'win32', loadElectron: () => null, spawnImpl, timeoutMs: 60 };
  const first = pickFolder(options);
  await tick(5);
  await assert.rejects(
    () => pickFolder(options),
    (error) => {
      assert.equal(error.code, 'McPickBusy');
      return true;
    },
  );
  // 第一个最终会超时收场，把它等掉，别留悬挂的 promise 拖住测试进程
  await assert.rejects(() => first, (error) => {
    assert.equal(error.code, 'McPickTimeout');
    return true;
  });
});

test('beginPickFolder：立刻返回 started，状态是 picking，选完变 idle 并带路径', async () => {
  resetPickFolderState();
  const started = beginPickFolder({
    loadElectron: () => fakeElectron({ canceled: false, filePaths: ['D:\\a'] }),
  });
  assert.equal(started.started, true);
  assert.equal(pickFolderStatus().status, 'picking');

  await tick(20);
  const state = pickFolderStatus();
  assert.equal(state.status, 'idle');
  assert.equal(state.path, 'D:\\a');
  assert.equal(state.error, '');
});

test('beginPickFolder：取消 → 状态回 idle 但路径为空', async () => {
  resetPickFolderState();
  beginPickFolder({ loadElectron: () => fakeElectron({ canceled: true, filePaths: [] }) });
  await tick(20);
  const state = pickFolderStatus();
  assert.equal(state.status, 'idle');
  assert.equal(state.path, '');
});

test('beginPickFolder：正在选的时候再点一次 → started:false，不会弹第二个', async () => {
  resetPickFolderState();
  const { spawnImpl } = fakeSpawn(() => {
    /* 挂着不动 */
  });
  const options = { platform: 'win32', loadElectron: () => null, spawnImpl, timeoutMs: 60 };
  const first = beginPickFolder(options);
  assert.equal(first.started, true);
  const second = beginPickFolder(options);
  assert.equal(second.started, false);
  // 等它自己超时收场，别留下悬挂的定时器
  await tick(90);
  assert.equal(pickFolderStatus().status, 'failed');
});

test('beginPickFolder：失败时状态变 failed，错误和提示都带上', async () => {
  resetPickFolderState();
  beginPickFolder({ platform: 'linux', loadElectron: () => null });
  await tick(20);
  const state = pickFolderStatus();
  assert.equal(state.status, 'failed');
  assert.equal(state.code, 'McPickUnsupported');
  assert.ok(state.error);
  assert.ok(state.hint, '要给用户一条能走的路');
});
