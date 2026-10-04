# 智能体打电话认不准人时弹好友选择卡（#1520）

- 日期：2026-10-04
- Issue：#1520
- 相关：ADR-0337（派智能体给好友打电话）、ADR-0350（好友三档权限）
- Demo：A 版定稿（会话里的 `design.html`：三种场景 × 六种状态 + 每步落的事件）

## 1. 要什么

维护者原话：「用户要求智能体给朋友打电话的时候，智能体如果不确定是谁，可以弹出一个卡片。这个卡片包含它认为有可能的好友的头像和名字，然后让用户自己点击选择。」

触发它的那一次：主人说「再给他打个电话」，「他」是之前打过的 Mingxuan Zhang，但对方已经把名字改成了「爸爸」。`call_friend` 按显示名精确匹配
（`resolveFriend`，`src/shared/outreach.ts`）落空，回模型一段文字列出全部好友名，模型再问主人，主人回「对就是爸爸」，多绕了一轮。

## 2. 维护者拍板的三条（2026-10-04）

1. **点了就直接拨**：卡里存着模型原本要用的交代（brief）和开场白（opening），点谁就打给谁，不再过一轮模型。
2. **候选人 = 模型点名 + runtime 兜底**：`call_friend` 加可选参数 `candidates`，模型拿不准时自己列；模型只给了一个名字但对不上 / 重名时，runtime 自己排。
3. **样式 A**：卡长在智能体的气泡里，一行一人：头像 + 名字 + 为什么猜他。

## 3. 什么时候出卡、列谁

纯函数 `pickFriend`（`src/shared/friendPick.ts`，零 IO，runtime 与测试共用），输入：好友名单（uid、名字、档位）、模型给的 `friend` 与可选 `candidates`、
这条聊天里最近打过的好友 uid（新的在前）。输出三种之一：

- `{ kind: "dial", uid, name }`：直接拨（现在的行为）。
- `{ kind: "card", question, candidates: [{ uid, name, why }] }`：出卡。
- `{ kind: "text", message }`：回模型一段文字（现在的行为，含档位拒绝那句）。

判定顺序：

1. **模型给了 `candidates`**（2–4 个名字）：每个名字按精确匹配换成好友（同名的全收），去重，只留**能打的**，最多 4 位。至少 1 位就出卡，
   `question` = 「你要打给哪位？点一下我就拨。」，`why` 留空（模型点名不附理由）。0 位就当没给，走第 2 步。
2. **`friend` 精确命中一人**：照现在走——档位不够回拒绝那句，够就直接拨。
3. **对不上或重名**：runtime 排候选，三个来源合在一起去重，**按这个顺序**排：
   - 最近打过（这条聊天的 `outreach` 事件按 uid 折出来，新的在前）：最新那位 `why` = 「上次打的就是他」，其余 = 「最近打过」；
   - 同名（`friend` 精确命中多人时）：`why` = 「同名」，和「最近打过」重叠时写「同名 · 最近打过」；
   - 名字相近：`why` = 「名字相近」。判据：两边都做 NFKC、小写、去空白与标点后，一边包含另一边（短的一边至少 2 个字），
     或者按空白切出的词有一个相同（至少 2 个字），或者编辑距离 ≤ ⌊较长一边长度 / 3⌋（较长一边至少 3 个字）。
   只留能打的，最多 4 位。`question`：对不上 = 「好友里没有叫「X」的。你要打给哪位？点一下我就拨。」；重名 = 「好友里有 N 位叫「X」。你要打给哪位？点一下我就拨。」
   一位都没有 → `text`，也就是现在那两句。

**「能打的」** = 档位没被 `outreachTierProblem` 拦下（ADR-0350：两边都开「全部开放」；档位缺席照现状不拦）。不能打的人不上卡——点了也打不出去。

「最近打过」要从**同一个 uid** 认人，而不是名字，所以改名不影响；截图那一例靠它排出「爸爸」。

**只出现在能调 `call_friend` 的地方**：`mayCall()` 先判，过不了就回拒绝那句，卡也不出（补跑轮、客人轮、汇报轮都出不了卡）。

## 4. 工具

`call_friend` 的参数表加一格：

```
candidates: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4,
  description: "拿不准用户指的是哪位好友时（比如「他」「她」指代不清）填 2–4 个可能的名字，会弹卡让用户点选；拿得准就别填" }
```

`friend` 仍是必填（用户原话里的称呼）。出卡时工具回模型：

> 没认准是哪位，已经弹了张卡让他点选（候选：A、B）。卡片自己会问，你这一轮不用再说话；他点了电话会直接拨出去，不用你再调 call_friend。

## 5. 事件（日志）

新事件 `friend_pick`，落在发起的那条聊天（原聊天）里，`ignorable: true`、模型不可见（同 `outreach`：结果靠 tool_result 与之后的汇报开场白告诉它）。
**叫 `fromAgentId` 不叫 `agentId`**，理由同 `outreach` / `call_ring`。

```ts
interface FriendPickEvent extends SessionEventBase {
  type: "friend_pick";
  pickId: string;
  phase: "offered" | "picked" | "dismissed" | "failed";
  fromAgentId: string;
  /** offered 才有 */
  question?: string;
  candidates?: { uid: string; name: string; why: string }[];
  brief?: string;
  opening?: string;
  /** picked 才有 */
  uid?: string;
  /** failed 才有：卡上那行红字 */
  message?: string;
  ignorable: true;
}
```

折叠 `friendPickFoldOf(events)`（`src/shared/friendPick.ts`）：按 pickId 取最后一条的 phase；**派生**两个状态不落事件：

- **过期**：`offered` 已超过 10 分钟（`FRIEND_PICK_TTL_MS`），读的那一刻用 `now` 算。
- **作废**：同一条聊天里之后又有一张 `offered`，旧卡作废（显示同「过期」）。

旧日志没有这个事件，新增不影响重放（Hard rule 第 4 条）；旧客户端碰到它按 `ignorable` 跳过。

## 6. 协议

协议版本 24 → 25。

- 手机 → runtime：`{ t: "pick_friend", pickId: string, uid: string | null }`（`null` = 「都不是」）。
- runtime → 手机：`{ t: "pick_friend_result", pickId: string, ok: boolean, message?: string }`（同 `approve_result`：带 pickId，一张卡一条回执，成功也回）。

runtime 处理（`frameHandler` 新 case → `CloudSession.pickFriend` → `outreachHub.dialPicked`）：

1. 在籍复查（同 `approve`）；发帧的人必须是主人本人（主场 owner），否则 `ok:false`「只有他本人能选」。
2. 从这条聊天的日志折出这张卡：不存在 / 已经 picked、dismissed、failed / 过期 / 作废 → `ok:false`「这张卡已经用过或过期了」。
3. `uid === null` → 落 `dismissed`，`ok:true`。
4. `uid` 不在候选里 → `ok:false`。
5. 落 `picked`，然后走和 `dispatch` **同一条**拨号路径（把现在 `dispatch` 里「解析好友」之后的部分抽成 `dialResolved(uid)`，两边共用）：
   重新查一次好友名单与档位（出卡后可能删了好友 / 降了档）、这只是否正在打别的、对方有没有能接的设备、主人额度——
   任何一条不过 → 落 `failed`（`message` 用那句现成的人话），`ok:true`（回执说的是「帧收到了」，失败画在卡上）。
   通过 → 照现在落 `outreach started`，之后的通话、结束、汇报一字不改。

**资格**：ADR-0337 第 4 条是「只有主人本人亲口派的那一轮才能打」。点卡是主人本人在自己的聊天里的直接动作，且卡只在 `mayCall()` 通过的轮里才出得来，
所以等价于亲口派。这不是确认卡：认得准时照旧直接拨，不出卡。

`agentName` 在点的那一刻现取（同现在 `specNames`）；那只已经不在这条聊天的名单里 → `failed`「它已经不在这条聊天里了」。

## 7. 手机

- `mobileChat` 新行 `kind: "friend_pick"`（从 §5 的折叠来），带 `status: "open" | "busy" | "picked" | "failed" | "dismissed" | "expired"`。
  `busy` 是客户端本地态（发了帧、还没收到回执，或者已落 `picked`、还没看到 `outreach started`）。
- `Bubbles.tsx` 新组件 `FriendPickCard`：智能体头像 + 气泡（`bubbleAgent` 底），上面是 `question`，下面一行一人：
  36px 头像 + 名字 + `why`（空就不画第二行）+ 右侧电话图标；最底下「都不是」。
  - 头像：按 uid 从 `useFriends()` 拿 `avatarUrl`，拿不到用名字首字（`wx/Avatar` 现成的人像画法）。runtime 不传头像。
  - 已选：选中那行青色底 + 头像描边，其余变灰；`picked` 后时间线里随后出现现在那条「打给 X」外联气泡。
  - 失败：红字 `message`。都不是：灰字「都不是。要打给谁，直接告诉我名字。」过期 / 作废：灰字「这张卡过期了，要打再跟我说。」
  - 无障碍：每行是 button，label =「打给 名字，why」。
- 桌面：`Timeline.tsx` 对 `friend_pick` 返回 `null`（桌面本来就不画外联）。
- 群聊：`call_friend` 只挂在个人主场，群里出不了卡，不处理。

## 8. 不做

- 两位同名、都没打过、都没头像时，卡上两行看起来一样。v1 不补区分信息（比如加好友时间），真遇到再加。
- 卡片顶上的问话不让模型写（固定三句）。
- 不做「点了先确认再拨」。

## 9. 测试

- `tests/shared/friendPick.test.ts`：`pickFriend` 三条路径 × 边界——候选全不能打、模型候选里有同名、最近打过排最前、同名与最近打过重叠、
  名字相近三种判据、上限 4 位、截图那一例（旧名 + 最近打过 uid 改了名）；折叠：过期、作废、最后一条胜出。
- `tests/services/runtime/outreachHub.test.ts`：出卡路径落 `offered` 并回那句 tool_result；`dialPicked` 成功 / 已用过 / 过期 / 不在候选 /
  出卡后被删好友 / 降档 / 正在打别的 → 各自的事件与回执。
- `tests/services/runtime/frameHandler`：`pick_friend` 非主人拒、回执带 pickId。
- 协议：`cloudSession` 解析 `pick_friend` 帧的正反例；版本号断言 25。
- `tests/shared/mobileChat`：`friend_pick` 行的六种状态。
- 真机：模拟器冒烟三种场景各点一次（`mobile-sim-smoke-expo-go` 那套）。

## 10. 改动面

- `src/shared/friendPick.ts`（新）、`src/shared/outreach.ts`（`resolveFriend` 保留给 `pickFriend` 用）
- `src/session/events.ts`（`FriendPickEvent`）
- `src/shared/remote/cloudSession.ts`（两种帧 + 版本 25）
- `services/runtime/src/callFriendTool.ts`（`candidates`）、`outreachHub.ts`（出卡、`dialResolved`、`dialPicked`）、
  `sessionService.ts`（最近打过的 uid、`logFriendPick`、`pickFriend`）、`frameHandler.ts`（新 case）
- `src/shared/mobileChat.ts`、`mobile/src/chat/Bubbles.tsx`、`mobile/src/chat/ChatScreen.tsx`、手机端 cloud client 发帧
- `src/renderer/src/components/Timeline.tsx`（`null`）
- 新 ADR：认不准时出选人卡、点即拨、ADR-0337 第 4 条的补充说明；`docs/where-to-find-things.md` 加一行
