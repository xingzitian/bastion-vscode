# 0.3.16 自检报告（2026-11-18）

## 1. 全量测试（清空 out 后从头跑）

```
✓ 内核边界   36 个 core 文件，0 处 vscode / 0 处反向引用
✓ 装载       73 个 out 模块在假 vscode 下全部可加载
✓ require    425 处相对 require 全部可解析
✓ 资源       3 处引用全部存在
✓ 循环       142 个模块，0 个新增环（已知遗留 5 个）
ℹ 测试       745 用例 / 720 通过 / 0 失败 / 25 跳过
```

## 2. 传输锁的三层验证

| 层 | 文件 | 条数 | 覆盖什么 |
|---|---|---|---|
纯判定 | `src/test/transferLock.test.ts` | 8 | 丢键计数、只读恢复、嵌套、菜单放行、shell 逃生、硬超时、no-op、reset |
行为 | `src/test/transferLockTerminal.test.ts` | 5 | **真实 BastionTerminal**：锁住时 handleInput 一个字节都不写进 stream；解锁恢复；只读不被改；菜单放行；嵌套；强制解锁 |
接线 | `src/test/transferLockWiring.test.ts` | 6 | handleInput 顺序（锁在只读之前）、upload/download 的 finally、广播过滤、所有 push/pull 入口、关闭清理、zmodem 的 screenTail |

## 3. 变异测试（证明守卫真会红，不是摆设）

| 变异 | 结果 |
|---|---|
`broadcastReceivers` 去掉 `!t.isTransferLocked` | 接线守卫 ✖（fail 1） |
`close()` 去掉 `forceUnlockTransfer('会话关闭')` | 接线守卫 ✖（fail 1） |
`handleInput` 里 `if (this.tlock.active)` → `if (false && …)`（模拟接线被改坏） | 行为测试 ✖ 2 条 |
全部还原后 | 全绿（6 + 5 通过） |

## 4. 包自检

```
条目 303；包内 version=0.3.16；main=./out/extension.js；engines.vscode=^1.99.0
out/core/transferLock.js  在
out/terminal.js           在
测试/源码/调试/RELEASE 泄漏  0
node_modules 127 条；ssh2 / zmodem.js / jsonc-parser 都在包内
```

## 5. 已验证 / 未验证（诚实边界）

**已验证**：类型编译、全量单测、六道静态检查、装载（假 vscode 下 73 模块）、包内容与依赖完整性、
锁的行为（真实 BastionTerminal 实例 + 假 stream）、守卫的变异敏感性。

**未验证**（只能真机）：
- 真实 rz/sz 传输期间按键是否真的不再打断传输（需要一台装 lrzsz 的机器）
- 堡垒机登录菜单阶段放行是否与实际菜单文本匹配（本机无堡垒机环境）
- 硬超时 10 分钟路径（不想真等 10 分钟；逻辑已用假时钟单测）