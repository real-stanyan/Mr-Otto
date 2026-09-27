// 从相册挑一张当头像（#1386）：系统相册 → 正中那一块正方形 → 缩到 256 → JPEG 编成 data URL
// （本仓没有对象存储，头像就是 profiles.avatar_url 里的一串，ADR-0028）。超过上限由 profileEdit 的
// validateAvatar 说出口（压到 0.8 的 256² JPEG 一般 20~40KB，离 128KB 远得很）。
// 人在相册里点了「取消」回 null（不是错）；没给相册权限时系统自己会问，拒了走 catch 那一句。
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { AVATAR_PX, centerSquare } from "../../../src/shared/profileEdit.js";

export async function pickAvatar(): Promise<string | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (r.canceled) return null;
  const asset = r.assets[0];
  if (asset === undefined) return null;
  let ctx = ImageManipulator.manipulate(asset.uri);
  // 系统裁过一刀多半已经是方的；不是的话（安卓、或者系统没理 aspect）自己取正中那一块
  const sq = centerSquare(asset.width, asset.height);
  if (sq !== null && asset.width !== asset.height) ctx = ctx.crop(sq);
  const img = await ctx.resize({ width: AVATAR_PX, height: AVATAR_PX }).renderAsync();
  const out = await img.saveAsync({ base64: true, compress: 0.8, format: SaveFormat.JPEG });
  if (out.base64 === undefined || out.base64 === null) throw new Error("这张图读不出来，换一张试试");
  return `data:image/jpeg;base64,${out.base64}`;
}
