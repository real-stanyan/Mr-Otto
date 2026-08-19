// 本人资料的跨进程类型(渲染层/主进程共用)。
//
// 和 AccountInfo 的区别值得说清楚:AccountInfo 是 auth.users 的投影(登录给的),
// MyProfile 是 profiles 表的投影(自己改的、**好友看到的**)。同一个人两份数据,
// 冲突时以 profiles 为准 —— 见 docs/adr/0028。

/** profiles 表里属于本人的那一行 */
export interface MyProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  /** 引导走完了没有(点"完成"或"以后再说"都算走完);DB 里是可空的 onboarded_at */
  onboarded: boolean;
}

/** 改资料的补丁。字段全可选 = 只改传了的那些,没传的一律不动 */
export interface ProfilePatch {
  name?: string;
  avatarUrl?: string;
  /** 只接受 true:引导只能"看过",不能被客户端重新标成"没看过"(那会让弹窗永远回来) */
  onboarded?: true;
}

/** 与 FriendsResult 同形:失败是值不是异常,渲染层照着 message 显示就行 */
export type ProfileResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** 名字上限。不是数据库的限制,是版面的限制:侧栏那一行、聊天头部那一行、
    好友列表那一行都只有一行宽度,再长也只会被 truncate 成省略号。
    放在 shared 是因为两边都要用它 —— 渲染层拿它当输入框的 maxLength,
    主进程拿它做落库前的截断,两个数字不能各写各的 */
export const NAME_MAX = 24;

/** 头像串上限(字符数)。头像跟着好友列表和每条邀请一起被查出来,它大一分,
    每一次好友刷新就重一分。256px 的 webp 编成 data URL 约 10~30KB,
    128KB 是留了几倍余量之后的硬顶 */
export const AVATAR_MAX_CHARS = 128 * 1024;
