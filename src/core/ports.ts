// 内核端口（唯一允许的宿主耦合面）。
//
// 规矩：这里**只放接口与一个组合根**，不放任何 vscode / Electron 的东西。
// core 内部通过 coreLog() / corePaths() / coreEvents() 取用，而不是把 logger 当参数传遍 27 个模块。
//
// 为什么允许这样"隐式"取用：这些是**运行时基础设施**（日志、路径、通知），不是业务依赖；
// 逐个传参会把每个函数签名污染成 (…, deps)，换来的只是形式上的纯度。组合根注入同样可测。

import * as os from 'os'
import * as path from 'path'

export interface Logger {
  info(msg: string): void
  error(msg: string): void
  /** 详细日志（对应 bastion.verboseLog）；不实现则忽略 verbose */
  verbose?(msg: string): void
}

export interface CredentialStore {
  get(key: string): Promise<string | undefined>
  set(key: string, v: string): Promise<void>
  delete(key: string): Promise<void>
}

/** 终端输出端：宿主的 Pseudoterminal / WS 通道 / 测试里的内存 sink */
export interface TerminalSink {
  write(s: string): void
  close(code: number): void
  setTitle?(s: string): void
  dimensions?(): { cols: number; rows: number }
}

export interface HostEvents {
  notify(level: 'info' | 'warn' | 'error', msg: string): void
}

export interface Paths {
  configDir(): string
}

export interface CorePorts {
  logger: Logger
  paths: Paths
  events?: HostEvents
  /** 仅供测试：注入时钟（默认 Date.now） */
  now?: () => number
}

const defaultLogger: Logger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m)
}

const defaultPaths: Paths = {
  // 与扩展侧历史行为一致：~/.bastionshell（可用环境变量覆盖，便于测试/便携部署）
  configDir: () => (process.env.BASTIONSHELL_SHARED_DIR ?? '').trim() || path.join(os.homedir(), '.bastionshell')
}

let ports: CorePorts = { logger: defaultLogger, paths: defaultPaths }

/** 组合根：宿主启动时调一次（扩展、daemon、DSH host、测试都调它） */
export function configureCore(next: Partial<CorePorts>): void {
  ports = { ...ports, ...next }
}

export function coreLog(msg: string): void {
  try {
    ports.logger.info(msg)
  } catch {
    // 日志不能让业务流程崩
  }
}

export function coreLogError(msg: string): void {
  try {
    ports.logger.error(msg)
  } catch {
    // 同上
  }
}

export function coreLogVerbose(msg: string): void {
  try {
    ports.logger.verbose?.(msg)
  } catch {
    // 同上
  }
}

export function coreNotify(level: 'info' | 'warn' | 'error', msg: string): void {
  try {
    ports.events?.notify(level, msg)
  } catch {
    // 通知失败不能影响执行
  }
}

export function corePaths(): Paths {
  return ports.paths
}

export function coreConfigDir(): string {
  return ports.paths.configDir()
}

export function coreNow(): number {
  return (ports.now ?? Date.now)()
}

/** 重置为默认（测试用） */
export function resetCorePorts(): void {
  ports = { logger: defaultLogger, paths: defaultPaths }
}
