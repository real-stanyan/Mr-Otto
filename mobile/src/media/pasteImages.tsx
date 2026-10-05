// 输入框里粘贴图片（#1645）：长按「粘贴」一张图、iOS 27 键盘建议栏的「Paste from Screenshots」。
// 原生 otto-paste 把图交来，这里先问一句「发送这张图片？」（照微信：粘贴不等于发送，手一抖不该就发出去了），
// 点「发送」交回聊天页现成的 sendPicked——与相册挑的同一条路（压缩、上传、本地气泡）。
import { useEffect, useRef } from "react";
import { Image, View, useWindowDimensions } from "react-native";
import { OttoPaste } from "../../modules/otto-paste/index.js";
import { pastedImagesOf, type PastedImage } from "../../../src/shared/pastedImages.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import type { PickedAsset } from "./prepareMedia.js";

/** 订阅粘贴来的图。只在 `enabled`（这一页在最上面、能发图）时订阅：原生那边没人订阅就不碰输入框 */
export function usePastedImages(enabled: boolean, onImages: (images: PastedImage[]) => void): void {
  const latest = useRef(onImages);
  latest.current = onImages;
  useEffect(() => {
    if (!enabled || OttoPaste === null) return;
    const sub = OttoPaste.addListener("onPaste", (raw) => {
      const images = pastedImagesOf(raw);
      if (images.length > 0) latest.current(images);
    });
    return () => sub.remove();
  }, [enabled]);
}

/** 交给 prepareAsset 的那一份：形状同相册挑出来的（PNG，大的由 prepareImage 缩成 JPEG） */
export function pastedAssets(images: readonly PastedImage[]): PickedAsset[] {
  return images.map((p, i) => ({
    uri: p.uri, width: p.width, height: p.height, type: "image", mimeType: "image/png", fileName: `paste-${i + 1}.png`, fileSize: p.bytes,
  }));
}

export function PasteDialog({ visible, images, to, onCancel, onSend, onExited }: {
  visible: boolean;
  images: readonly PastedImage[];
  /** 发给谁（标题底下一行） */
  to: string;
  onCancel: () => void;
  onSend: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  const { height } = useWindowDimensions();
  const first = images[0];
  const box = Math.min(240, Math.round(height * 0.3));
  return (
    <Dialog visible={visible} onExited={onExited}>
      <DialogTitle>{images.length > 1 ? `发送 ${images.length} 张图片？` : "发送这张图片？"}</DialogTitle>
      {to !== "" ? <DialogLead>{`发给${to}`}</DialogLead> : null}
      {first !== undefined ? (
        <DialogBody>
          <View style={{ height: box, borderRadius: 12, overflow: "hidden", backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
            <Image source={{ uri: first.uri }} resizeMode="contain" style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors />
          </View>
        </DialogBody>
      ) : null}
      <DialogFooter left={{ label: "取消", onPress: onCancel }} right={{ label: "发送", onPress: onSend }} />
    </Dialog>
  );
}
