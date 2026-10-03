// speakerPrefix 的实现搬到了 src/shared/speakerPrefix.ts（#1441：外联转写也要剥这个前缀，shared 不能反向
// import services/）。这里只是再导出，既有 import 路径不变；正则仍然只有那一份。
export { splitSpeakerPrefix, labelFromPrefix } from "../../../src/shared/speakerPrefix.js";
