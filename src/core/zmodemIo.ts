import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import type { ZmodemIo, ZmodemFileInfo } from './zmodem';

/**
 * 上传时该告诉远端什么权限位。
 *
 * 三条都来自实测/平台事实：
 *  1. **Windows 上的 `st.mode` 是合成的**（可写文件一律 `0o666`、只读 `0o444`），
 *     照搬过去会让远端文件变成 **world-writable**；所以 Windows 上给正常的 `0o644`。
 *  2. 类 Unix 上按本地真实权限位传（脚本的 `+x` 能保住）。`& 0o7777` 去掉文件类型位
 *     —— zmodem.js 会自己 OR 上 `32768`（S_IFREG）。
 *  3. 兜底：算出来是 0 就给 `0o644`。**绝不能是 0** —— 远端会建出 `----------` 的文件，
 *     谁都读不了（2026-09-14 真机：`readable=no`，连 md5sum 都读不了，
 *     部署上去的配置文件服务也读不了）。
 */
export function uploadModeOf(st: { mode: number }): number {
  if (process.platform === 'win32') return 0o644
  const m = st.mode & 0o7777
  return m === 0 ? 0o644 : m
}

/** 真实文件系统 + 下载目录解析的 ZMODEM I/O */
export class NodeFsZmodemIo implements ZmodemIo {
  /**
   * @param takePresetDownloadDir 取一次「已经定好的下载目录」（没有就返回 null）。
   *   程序化下载（`bastion_pull`）走这里：AI 已经把目录定好了，不该再问。
   *   取一次就消费掉（只对这一次传输生效）。
   * @param fallbackDownloadDir   人工下载（用户在终端里自己敲 `sz`）时用哪个目录。
   *   由调用方决定优先级：`bastion.downloadDir` 设置 > 上次用过的目录 > 工作区默认目录。
   */
  constructor(
    private readonly takePresetDownloadDir: () => string | null = () => null,
    private readonly fallbackDownloadDir: () => string = () => ''
  ) {}

  async statFiles(paths: string[]): Promise<ZmodemFileInfo[]> {
    const out: ZmodemFileInfo[] = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) {
          out.push({
            path: p,
            name: path.basename(p),
            size: st.size,
            mtime: Math.floor(st.mtimeMs / 1000),
            // 权限位：**必须传给 ZMODEM**（ZFILE 头里有 mode，远端 rz 会照它 chmod）。
            // 不给的话远端建出来是 0000 —— 谁都读不了（2026-09-14 真机发现）。
            mode: uploadModeOf(st)
          });
        }
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /**
   * 同步解析下载目录 —— **绝不弹窗**。
   *
   * 弹窗会把握手拖死（对端等不到 ZRINIT 就重发 ZRQINIT，然后我们报
   * `Unhandled header: ZRQINIT`，2026-09-15 真机故障）。
   * 「选目录」这件事放在传输之外：`bastion.downloadDir` 设置 + `bastion.setDownloadDir` 命令。
   */
  resolveDownloadDir(): string {
    const preset = this.takePresetDownloadDir();
    if (preset) return preset;
    return this.fallbackDownloadDir();
  }

  openWrite(dir: string, name: string): { fd: number; path: string } {
    // ⚠️ 目录可能还不存在：下载目录现在是「默认就定好的」（工作区 `.bastion-downloads/`），
    // 第一次下载时它根本还没被创建 —— 旧代码靠"用户选目录"保证存在，
    // 改成默认目录之后就必须自己建（2026-09-15 真机：ENOENT open ...\.bastion-downloads\xxx）。
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    const fd = fs.openSync(p, 'w');
    return { fd, path: p };
  }

  write(fd: number, data: Uint8Array): void {
    fs.writeSync(fd, data);
  }

  close(fd: number): void {
    fs.closeSync(fd);
  }

  openRead(p: string): number {
    return fs.openSync(p, 'r');
  }

  read(fd: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, null);
    return buf.subarray(0, n);
  }

  closeRead(fd: number): void {
    fs.closeSync(fd);
  }

  async hashFile(p: string, algo: 'sha256' | 'md5'): Promise<string> {
    const data = fs.readFileSync(p);
    return crypto.createHash(algo).update(data).digest('hex');
  }
}
