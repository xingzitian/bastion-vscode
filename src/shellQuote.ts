/**
 * shell 单引号引用（远端路径里可能有空格/引号/美元符）。
 *
 * 单独一个模块，是为了避免 `terminal.ts` ⇄ `transferPath.ts` 互相 import：
 * 上传的"标准工具"要引用远端路径，而终端又要调用它 —— 放到第三个小模块里最干净。
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
