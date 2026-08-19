// userProfile — 本人资料的读写编排(首登引导 + 账号页改名/换头像,issue #95)。
//
// 分层照抄 friends.ts 的做法:本文件只有纯逻辑 + 一个注入式 api,
// 真 supabase 查询在 supabaseUserProfileApi.ts。理由同样是可测性 ——
// 校验规则(名字怎么收敛、什么样的头像串可以进库)是这里唯一有分量的东西,
// 它不该躲在网络调用后面。

import { AVATAR_MAX_CHARS, NAME_MAX } from "../shared/profile.js";
import type { MyProfile, ProfilePatch, ProfileResult } from "../shared/profile.js";

/** profiles 表里本人那一行的原始形状(snake_case 保持与 DB 一致) */
export interface MyProfileRow {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  onboarded_at: string | null;
}

export interface UserProfileApi {
  getUserId(): Promise<string | null>;
  loadProfile(uid: string): Promise<MyProfileRow | null>;
  /** patch 是 snake_case 的列补丁,只写传了的列 */
  saveProfile(uid: string, patch: Record<string, string>): Promise<MyProfileRow>;
}

/** 允许进库的头像来源。https 是 provider 给的图,data:image 是用户自己传的
    (本仓库没有对象存储,见 ADR-0028)。别的一律拒绝 —— 尤其 javascript: 这类
    会在渲染层被当成 <img src> 塞进 DOM 的东西 */
const AVATAR_PATTERN = /^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/;

/** 控制字符(含换行/制表)。名字只会被显示在单行里,留着它们只会变成
    看不见的宽度,或者把一行撑成两行的假象 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 用户输入的名字 → 能进库的名字。连续空白压成单个空格,首尾裁掉,按码点截断 */
export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  // 用扩展运算符按码点切,不用 slice:emoji 是代理对,按 UTF-16 单元切会切出半个字符
  return [...cleaned].slice(0, NAME_MAX).join("");
}

/** 头像串校验。空串是合法的:那是"清掉自定义头像,回到首字母" */
export function validateAvatar(raw: string): ProfileResult<string> {
  const value = raw.trim();
  if (value === "") return { ok: true, value: "" };
  if (value.length > AVATAR_MAX_CHARS) {
    return { ok: false, message: `头像太大了(${Math.round(value.length / 1024)}KB),换张小点的` };
  }
  if (!AVATAR_PATTERN.test(value)) {
    return { ok: false, message: "头像只能是 https 链接或图片文件" };
  }
  return { ok: true, value };
}

/** DB 行 → 渲染层形状。null 列一律收敛成空串/false,渲染层不再判 null */
export function toMyProfile(row: MyProfileRow): MyProfile {
  return {
    id: row.id,
    email: row.email ?? "",
    name: row.name ?? "",
    avatarUrl: row.avatar_url ?? "",
    onboarded: row.onboarded_at !== null,
  };
}

/**
 * 补丁 → 列补丁。这里是唯一把用户输入变成 SQL 值的地方。
 * 返回 ok:false 表示这次改动不该发生(校验没过),不是数据库出错。
 */
export function buildColumnPatch(patch: ProfilePatch, nowIso: string): ProfileResult<Record<string, string>> {
  const columns: Record<string, string> = {};
  if (patch.name !== undefined) {
    const name = sanitizeName(patch.name);
    if (name === "") return { ok: false, message: "名字不能是空的" };
    columns["name"] = name;
  }
  if (patch.avatarUrl !== undefined) {
    const avatar = validateAvatar(patch.avatarUrl);
    if (!avatar.ok) return avatar;
    columns["avatar_url"] = avatar.value;
  }
  // 只认 true。ProfilePatch 的类型已经把 false 挡在门外,这里是运行时的第二道
  if (patch.onboarded === true) columns["onboarded_at"] = nowIso;
  if (Object.keys(columns).length === 0) return { ok: false, message: "没有要改的内容" };
  columns["updated_at"] = nowIso;
  return { ok: true, value: columns };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 本人资料管理器。所有方法都回 ProfileResult —— 失败是值不是异常:
 * 这条链上最常见的"失败"是没登录和网络不通,两者都不该炸穿 IPC。
 */
export class UserProfileManager {
  private readonly api: UserProfileApi;
  private readonly now: () => Date;

  constructor(deps: { api: UserProfileApi; now?: () => Date }) {
    this.api = deps.api;
    this.now = deps.now ?? (() => new Date());
  }

  /** 未登录回 value:null(不是错误)——冷启动和登出时这是正常状态 */
  async load(): Promise<ProfileResult<MyProfile | null>> {
    try {
      const uid = await this.api.getUserId();
      if (!uid) return { ok: true, value: null };
      const row = await this.api.loadProfile(uid);
      return { ok: true, value: row ? toMyProfile(row) : null };
    } catch (err) {
      return { ok: false, message: message(err) };
    }
  }

  async save(patch: ProfilePatch): Promise<ProfileResult<MyProfile>> {
    const uid = await this.api.getUserId().catch(() => null);
    if (!uid) return { ok: false, message: "没登录" };
    const columns = buildColumnPatch(patch, this.now().toISOString());
    if (!columns.ok) return columns;
    try {
      return { ok: true, value: toMyProfile(await this.api.saveProfile(uid, columns.value)) };
    } catch (err) {
      return { ok: false, message: message(err) };
    }
  }
}
