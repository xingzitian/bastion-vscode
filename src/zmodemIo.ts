import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ZmodemIo, ZmodemFileInfo } from './zmodem';

/** 真实文件系统 + VS Code 目录选择对话框的 ZMODEM I/O */
export class NodeFsZmodemIo implements ZmodemIo {
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
          });
        }
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async pickDownloadDir(): Promise<string | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: '选择下载保存目录',
    });
    return uris && uris.length > 0 ? uris[0].fsPath : null;
  }

  openWrite(dir: string, name: string): { fd: number; path: string } {
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
