// 任务栏的根。M2（#1254）接上任务会话之前，这里是一句实话的空态——不画假数据。
import { Card, Headline, Hint, Page } from "../ui.js";

export function TasksRoot() {
  return (
    <Page>
      <Card>
        <Headline>任务栏下一步接上</Headline>
        <Hint>电脑上聊过的任务会话、手机上新开的，都会出现在这里。</Hint>
      </Card>
    </Page>
  );
}
