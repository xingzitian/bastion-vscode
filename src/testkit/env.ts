/**
 * 测试环境工具：临时 HOME + 假时钟。
 *
 * 所有配置文件都存在 ~/.bastionshell/，而扩展是通过 os.homedir() 找它的。
 * 所以测试里把 USERPROFILE/HOME 指到临时目录 —— 绝不能碰你真实的
 * ~/.bastionshell（那里面有你的档案和习惯）。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** 建一个临时 HOME 并把它设成当前用户目录，返回路径 */
export function useTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-test-'))
  process.env.USERPROFILE = dir
  process.env.HOME = dir
  return dir
}

export function cleanupTempHome(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 测试清理失败不影响结论 */
  }
}

/** 临时 HOME 下的配置文件路径 */
export function cfgPath(home: string, file: string): string {
  return path.join(home, '.bastionshell', file)
}

export interface FakeClock {
  advance(ms: number): void
  restore(): void
}

/** 假时钟：传输速率/剩余时间依赖时间推进，不然测不了 */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  const real = Date.now
  let now = start
  Date.now = () => now
  return {
    advance(ms: number): void {
      now += ms
    },
    restore(): void {
      Date.now = real
    }
  }
}
