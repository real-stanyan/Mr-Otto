// 导航引用（#1411）：来电是从通知里来的，不在任何一页里——接听要从外面把人送进那条聊天
import { createNavigationContainerRef } from "@react-navigation/native";
import type { RootStackParams } from "./types.js";

export const navRef = createNavigationContainerRef<RootStackParams>();
