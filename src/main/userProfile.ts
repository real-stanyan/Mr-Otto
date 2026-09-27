// userProfile — 本人资料的读写编排(首登引导 + 账号页改名/换头像,issue #95)。
//
// 分层照抄 friends.ts 的做法:本文件只有编排 + 一个注入式 api,
// 真 supabase 查询在 supabaseUserProfileApi.ts,校验规则在 src/shared/profileEdit.ts。
// 理由同样是可测性 —— 校验规则(名字怎么收敛、什么样的头像串可以进库)是这条链上
// 唯一有分量的东西,它不该躲在网络调用后面。

import type { MyProfile, ProfilePatch, ProfileResult } from "../shared/profile.js";
import { buildColumnPatch, toMyProfile, type MyProfileRow } from "../shared/profileEdit.js";

// 纯逻辑（名字收敛、头像准入、列补丁、行转换）挪进了 src/shared/profileEdit.ts（#1386）：手机端的
// 「个人信息」改的是同一行，判据只能有一份。这里原样再导出，既有 import 点一个不用改
export { buildColumnPatch, sanitizeName, toMyProfile, validateAvatar, type MyProfileRow } from "../shared/profileEdit.js";

export interface UserProfileApi {
  getUserId(): Promise<string | null>;
  loadProfile(uid: string): Promise<MyProfileRow | null>;
  /** patch 是 snake_case 的列补丁,只写传了的列 */
  saveProfile(uid: string, patch: Record<string, string>): Promise<MyProfileRow>;
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
