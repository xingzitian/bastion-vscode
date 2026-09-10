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
