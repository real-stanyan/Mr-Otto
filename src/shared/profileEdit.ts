// profileEdit —— 改本人资料的纯逻辑：名字怎么收敛、什么样的头像串能进库、列补丁、库行转换，
// 外加改密码那两句判据（#1386）。
//
// 原来住在 src/main/userProfile.ts（issue #95）；手机端的「个人信息」也要改名字、换头像，
// 这些判断只能有一份——两份的话，同一个名字在桌面上存得进去、在手机上被截掉一截，
// 而谁都不会报错。所以挪进 shared，桌面那边改成 import（行为一字不变）。
//
// 纯文件：不许 import node builtin / electron（手机端 import 同一份源码）。

import { AVATAR_MAX_CHARS, NAME_MAX } from "./profile.js";
import type { MyProfile, ProfilePatch, ProfileResult } from "./profile.js";

/** profiles 表里本人那一行的原始形状(snake_case 保持与 DB 一致) */
export interface MyProfileRow {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  onboarded_at: string | null;
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

// ── 改密码（#1386，demo 的 passwordDialog） ──

/** 新密码的下限。Supabase 项目的 minimum password length 是 8（与注册那张卡同一个数） */
export const PASSWORD_MIN = 8;

/**
 * 改密码那张弹窗此刻要说的那一句（空串 = 没什么要说的）。**一边输一边判**，所以还没输到
 * 那一格时不喊：新密码一个字都没打就说「至少 8 位」，等于在人动手之前先骂他一句。
 * 顺序就是人填的顺序：新的够不够长 → 两次一不一样 → 和现在的是不是同一个。
 */
export function passwordProblem(current: string, next: string, again: string): string {
  if (next !== "" && next.length < PASSWORD_MIN) return `新密码至少 ${PASSWORD_MIN} 位`;
  if (again !== "" && next !== again) return "两次输的新密码不一样";
  if (next !== "" && current !== "" && next === current) return "新密码和现在的一样";
  return "";
}

/** 「保存」按不按得动：三格都填了、而且一句毛病都没有 */
export function passwordReady(current: string, next: string, again: string): boolean {
  return current !== "" && next.length >= PASSWORD_MIN && next === again && next !== current;
}
