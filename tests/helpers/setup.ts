// vitest setupFiles —— 每个测试文件跑一遍。
// 目前只干一件事：把 tempDir() 建过的一次性目录在文件跑完之后删掉（见 tempDir.ts）。

import { afterAll } from "vitest";
import { cleanupTempDirs } from "./tempDir.js";

afterAll(cleanupTempDirs);
