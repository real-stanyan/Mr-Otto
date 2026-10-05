# Apple 健康：隐私政策段落与审核备注（#1656，ADR-0373）

隐私政策正文不在本仓；这份是要贴过去的那一段，以及 App Store / TestFlight 外部测试送审时填的备注。
改了 read_health 的行为（读哪些类、存在哪、谁能读）就回来改这份，再同步到线上的隐私政策。

## 隐私政策段落（中文）

**Apple 健康数据**

如果你在 Otto 的「设置 → Apple 健康」中开启了读取（默认关闭），当你本人向你的智能体提出与健康相关的问题时，Otto 会从你这台 iPhone 的 Apple 健康中读取以下类别的**按天汇总**数据，用于回答这个问题：步数、步行距离、活动能量、爬楼层数、锻炼时长、站立小时、睡眠（含分期）、心率、静息心率、心率变异性、血氧、体重、体脂率、体能训练记录。

- **只读**：Otto 不会向 Apple 健康写入任何数据。
- **只在你本人提问时读取**：其他人（包括群聊成员、好友及其智能体）、定时任务都无法读取你的健康数据；只有在 Otto 打开并处于前台时才能读取。
- **用途**：读到的数据只用于回答你当次的提问。它会作为这段对话的一部分保存在你的会话记录里，并发送给为该智能体提供服务的模型供应商来生成回答。
- **不用于广告或营销**，不出售，不用于数据挖掘，不存入 iCloud。
- **删除**：删除对应的会话即删除其中的健康数据；关闭开关后 Otto 不再读取。你也可以随时在 iOS「健康」App → 共享 → App → Otto 中撤销各类别的授权。

## Privacy policy section (English)

**Apple Health data**

If you turn on reading in Otto's Settings → Apple Health (off by default), then when you yourself ask your agent a health-related question, Otto reads **daily summaries** of the following categories from Apple Health on your iPhone to answer that question: steps, walking distance, active energy, flights climbed, exercise minutes, stand hours, sleep (including stages), heart rate, resting heart rate, heart rate variability, blood oxygen, body mass, body fat percentage, and workouts.

- **Read-only**: Otto never writes data to Apple Health.
- **Only when you ask**: other people (including group members, friends and their agents) and scheduled tasks cannot read your health data, and it can only be read while Otto is open in the foreground.
- **Purpose**: the data is used only to answer your question. It is stored as part of that conversation's history and sent to the model provider that powers the agent to generate the answer.
- **Not used for advertising or marketing**, not sold, not used for data mining, and not stored in iCloud.
- **Deletion**: deleting the conversation deletes the health data in it; turning the switch off stops Otto from reading. You can revoke individual categories at any time in the iOS Health app → Sharing → Apps → Otto.

## App Review 备注（Notes for Review，英文）

Otto uses HealthKit read-only. Users opt in under Settings → Apple Health (off by default), which shows the iOS HealthKit permission sheet. When the user asks their own AI agent a health question in chat (e.g. "How did I sleep last night?"), the app reads daily aggregates (steps, distance, active energy, flights, exercise minutes, stand hours, sleep stages, heart rate, resting heart rate, HRV, blood oxygen, body mass, body fat, workouts) and sends them to the agent to answer that question. Data is never written to HealthKit, never used for advertising or marketing, not sold, and not stored in iCloud. Other users and scheduled tasks cannot read a user's health data. The chat shows a line each time health data is read.
