import * as vscode from 'vscode';
import { readJsonFile, writeJsonFile, migrateJsonExtension } from './config';
import { log } from './log';

export interface ConnectionProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  /** 认证方式：password / key */
  authMethod: 'password' | 'key';
  /** 私钥文件路径（authMethod='key'） */
  privateKeyPath?: string;

  /**
   * 别名：这台机器在别处的叫法。
   * 一台机器两个叫法时（堡垒机里一个、资产表/部署文档里另一个），写在这里；
   * 部署任务 / AI 调用 / 转发规则里用哪个叫法都指到同一个档案。
   */
  aliases?: string[];
  /** 连接模式：direct = 直接 SSH（普通服务器）；bastion = 堡垒机（过菜单选机） */
  mode?: 'direct' | 'bastion';
}

const KEY = 'bastion.profiles';
export const PROFILES_FILE = 'profiles.jsonc';
const SECRET_PREFIX = 'bastion.pass.';

export const PROFILES_HEADER = [
  '// ============================================================',
  '// BastionShell 连接档案配置',
  '// 直接编辑本文件并保存即可生效（刷新侧边栏后读取）。',
  '// 密码不写在这里：连接时会提示输入，可选「加密保存」到系统钥匙串。',
  '// ------------------------------------------------------------',
  '// 每个档案字段说明：',
  '//   name           档案名（唯一，AI 调用时用它）',
  '//   host           主机地址（堡垒机或普通服务器的 IP/域名）',
  '//   port           端口，默认 22',
  '//   username       登录用户名',
  '//   authMethod     认证方式：password=密码 / key=私钥',
  '//   privateKeyPath 私钥文件路径（仅 authMethod=key 时需要，可省略）',
  '//   aliases        别名数组（可选）：这台机器的其它叫法，部署任务/AI 里写哪个都认得',
  '//   mode           连接模式：direct=直接 SSH（普通服务器，直接进 shell）；bastion=堡垒机（登录后过菜单选机）',
  '// ------------------------------------------------------------',
  '// 示例（复制进下面的数组并删掉注释即可）：',
  '// { "name": "生产堡垒机", "host": "10.0.0.10", "port": 22,',
  '//   "username": "deploy", "authMethod": "password", "mode": "bastion" }',
  '// ============================================================'
].join('\n');

function isValidProfile(p: unknown): p is ConnectionProfile {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.host === 'string' &&
    typeof o.username === 'string' &&
    (o.authMethod === 'password' || o.authMethod === 'key')
  );
}

function isValidProfiles(v: unknown): v is ConnectionProfile[] {
  return Array.isArray(v) && v.every(isValidProfile);
}

function normalizeProfile(p: ConnectionProfile): ConnectionProfile {
  return {
    ...p,
    port: typeof p.port === 'number' && p.port > 0 ? p.port : 22,
    authMethod: p.authMethod === 'key' ? 'key' : 'password',
    // 别名只留非空字符串（手写文件时很容易留空串/写错类型）
    aliases: Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).trim()).filter(Boolean) : undefined,
    mode: p.mode === 'direct' ? 'direct' : 'bastion'
  };
}

export function getProfiles(ctx: vscode.ExtensionContext): ConnectionProfile[] {
  migrateJsonExtension(PROFILES_FILE, 'profiles.json', PROFILES_HEADER);
  let profiles = readJsonFile<ConnectionProfile[]>(PROFILES_FILE, [], isValidProfiles);

  // 迁移旧版 globalState 数据（配置文件不存在/为空，且 globalState 有旧数据时）
  const legacy = ctx.globalState.get<ConnectionProfile[]>(KEY);
  if (profiles.length === 0 && Array.isArray(legacy) && legacy.length > 0) {
    profiles = legacy.filter(isValidProfile).map(normalizeProfile);
    try {
      writeJsonFile(PROFILES_FILE, profiles, PROFILES_HEADER);
      void ctx.globalState.update(KEY, undefined);
      log(`已迁移 ${profiles.length} 个连接档案到配置文件`);
    } catch (e) {
      log(`档案迁移写入失败: ${(e as Error).message}`);
    }
  }
  return profiles.map(normalizeProfile);
}

export function saveProfiles(ctx: vscode.ExtensionContext, profiles: ConnectionProfile[]): void {
  writeJsonFile(PROFILES_FILE, profiles.map(normalizeProfile), PROFILES_HEADER);
}

/** 密码改为 SecretStorage：由 VS Code 底层用系统钥匙串/DPAPI 加密，不再明文落盘 */
export async function getPassword(ctx: vscode.ExtensionContext, name: string): Promise<string> {
  return (await ctx.secrets.get(SECRET_PREFIX + name)) ?? '';
}

export async function savePassword(ctx: vscode.ExtensionContext, name: string, password: string): Promise<void> {
  await ctx.secrets.store(SECRET_PREFIX + name, password);
}

export async function deletePassword(ctx: vscode.ExtensionContext, name: string): Promise<void> {
  await ctx.secrets.delete(SECRET_PREFIX + name);
}


// ───────────────── 密码被改过之后的出路（2026-09-16 维护者报的逻辑错误）─────────────────
//
// 问题：钥匙串里存着旧密码时，认证失败只会"用同一个旧密码自动重试 3 次然后报连接失败" ——
// 密码在服务器上改过之后就彻底连不上，而且**没有任何入口**去改（连清除命令都没有）。
// 解法：认证失败且用的是存下来的密码 → 问一句，让用户重输或清除。

let profilesCtx: vscode.ExtensionContext | undefined;

/** 由 extension.ts 在激活时注入（下面两个函数要读写钥匙串） */
export function initProfiles(ctx: vscode.ExtensionContext): void {
  profilesCtx = ctx;
}

/** 这个档案在钥匙串里有密码吗？（决定认证失败时要不要给"重新输入"的出路） */
export async function hasSavedPassword(profile: ConnectionProfile): Promise<boolean> {
  if (!profilesCtx) return false;
  return (await getPassword(profilesCtx, profile.name)) !== '';
}

export type PasswordResetResult =
  | { action: 'retry'; password: string }
  | { action: 'cleared' }
  | { action: 'cancel' };

export async function offerPasswordReset(profile: ConnectionProfile): Promise<PasswordResetResult> {
  const pick = await vscode.window.showWarningMessage(
    `${profile.name}：已保存的密码无效（可能已在服务器上改过）。`,
    '重新输入密码',
    '清除已保存的密码',
    '取消'
  );
  if (pick === '清除已保存的密码') {
    if (profilesCtx) await deletePassword(profilesCtx, profile.name);
    log(`已清除保存的密码（${profile.name}）`);
    return { action: 'cleared' };
  }
  if (pick !== '重新输入密码') return { action: 'cancel' };
  const p = await vscode.window.showInputBox({
    prompt: `新密码（${profile.username}@${profile.host}）`,
    password: true,
    ignoreFocusOut: true
  });
  if (p === undefined || p === '') return { action: 'cancel' };
  if (profilesCtx) await savePassword(profilesCtx, profile.name, p);
  log(`已更新保存的密码（${profile.name}）`);
  return { action: 'retry', password: p };
}


/**
 * 按名字**或别名**找档案 —— 所有"按名字找档案"的地方都必须走这里。
 *
 * 为什么要有它：一台机器常常有两个叫法（堡垒机菜单里一个、资产表/部署文档里另一个）。
 * 以前各处都是 `profiles.find(p => p.name === x)`，用户在部署任务里写另一个叫法就直接找不到档案。
 * 现在档案里写一次 `aliases`，用哪个叫法都指到同一个档案。
 *
 * 匹配规则：去空格 + 忽略大小写；先精确匹配 name，再匹配 aliases。
 */
export function resolveProfile(profiles: ConnectionProfile[], want: string | undefined): ConnectionProfile | undefined {
  const key = (want ?? '').trim().toLowerCase()
  if (!key) return undefined
  const byName = profiles.find((p) => p.name.trim().toLowerCase() === key)
  if (byName) return byName
  return profiles.find((p) => (p.aliases ?? []).some((a) => String(a).trim().toLowerCase() === key))
}


// ───────────────── 私钥口令也要记住（2026-09-16）─────────────────
//
// 以前 authMethod=key 的档案**每次都弹口令输入框**，而且根本不提供"保存" ——
// 用户天天被问，AI 走档案连接时更会被这个弹窗直接卡住。
// 和密码一样存进系统钥匙串。注意区分两种情况：
//   undefined = 从没存过（要问一次）
//   ''        = 存过，而且这把私钥**本来就不需要口令**（不能再问）

const SECRET_PASSPHRASE_PREFIX = 'bastion.passphrase.';

/** 取已保存的私钥口令：undefined = 没存过；'' = 存过且不需要口令 */
export async function getPassphrase(ctx: vscode.ExtensionContext, name: string): Promise<string | undefined> {
  return await ctx.secrets.get(SECRET_PASSPHRASE_PREFIX + name);
}

export async function savePassphrase(ctx: vscode.ExtensionContext, name: string, passphrase: string): Promise<void> {
  await ctx.secrets.store(SECRET_PASSPHRASE_PREFIX + name, passphrase);
}

export async function deletePassphrase(ctx: vscode.ExtensionContext, name: string): Promise<void> {
  await ctx.secrets.delete(SECRET_PASSPHRASE_PREFIX + name);
}

/** 这个档案存过私钥口令吗？ */
export async function hasSavedPassphrase(profile: ConnectionProfile): Promise<boolean> {
  if (!profilesCtx) return false;
  return (await getPassphrase(profilesCtx, profile.name)) !== undefined;
}

/** 口令不对时的出路：重输 / 清除 / 取消（与 offerPasswordReset 同一套路） */
export async function offerPassphraseReset(profile: ConnectionProfile): Promise<PasswordResetResult> {
  const pick = await vscode.window.showWarningMessage(
    `${profile.name}：已保存的私钥口令无效（可能私钥换了或口令改过）。`,
    '重新输入口令',
    '清除已保存的口令',
    '取消'
  );
  if (pick === '清除已保存的口令') {
    if (profilesCtx) await deletePassphrase(profilesCtx, profile.name);
    log(`已清除保存的私钥口令（${profile.name}）`);
    return { action: 'cleared' };
  }
  if (pick !== '重新输入口令') return { action: 'cancel' };
  const p = await vscode.window.showInputBox({
    prompt: `私钥口令（无则直接回车）（${profile.privateKeyPath ?? ''}）`,
    password: true,
    ignoreFocusOut: true
  });
  if (p === undefined) return { action: 'cancel' };
  if (profilesCtx) await savePassphrase(profilesCtx, profile.name, p);
  log(`已更新保存的私钥口令（${profile.name}）`);
  return { action: 'retry', password: p };
}
