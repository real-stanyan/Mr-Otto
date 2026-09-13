// 团队栏的根。M3 接上团队云会话之前，这里是一句实话的空态——不画假数据。
import { Card, Headline, Hint, Page } from "../ui.js";

export function TeamsRoot() {
  return (
    <Page>
      <Card>
        <Headline>团队栏下一步接上</Headline>
        <Hint>团队的群聊、@ 和通话都会在这里。</Hint>
      </Card>
    </Page>
  );
}
