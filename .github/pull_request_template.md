<!-- 实现哪个 Task：写 Closes #N，合并即关 -->
Closes #

## 为什么

<!-- 动机，不是改动清单（改动看 diff 和 commit message） -->

## 验收证据

<!-- 贴 Task issue 里「验收」那栏的实际结果。`npm test` 是门禁，必须绿。
     e2e / 真机是可选证据：跑了就贴，没跑写「没跑」——不再强制 GUI 改动必贴（ADR-0138） -->

- `npm test`：
- `npm run e2e`（可选；建议只跑相关 spec：`npx playwright test tests/e2e/xxx.e2e.ts`）：
- 真机（可选）：
