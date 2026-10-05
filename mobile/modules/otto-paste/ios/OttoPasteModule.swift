import ExpoModulesCore
import ObjectiveC
import UIKit
import UniformTypeIdentifiers

// 输入框收图片粘贴（#1645）：长按「粘贴」一张图、iOS 27 键盘建议栏的「Paste from Screenshots」，在 Otto 里原来都没反应——
// RN 的输入框（RCTUITextView，新旧架构都用它）只认文字：canPerformAction 只在剪贴板有字时给「粘贴」，
// pasteConfiguration 不收图片，paste: / pasteItemProviders: 拿到图也不知道往哪放。
//
// 这里不换输入框组件，而是在 RCTUITextView 上挂住四个入口（只加在这个类上，别的 UITextView 不受影响）：
// · pasteConfiguration 多收一种 public.image——键盘那条建议、UIPasteControl 按它判「这个输入框收不收图」
// · canPerformAction(paste:) 剪贴板里有图也给「粘贴」
// · paste: 剪贴板里只有图（没有字）时把图拿走；有字照旧粘字（网页上复制的一段图文，人要的多半是字）
// · canPasteItemProviders: / pasteItemProviders: 带图的那几份拿走（键盘建议与拖放走这一条）
// 拿走的图存成临时 PNG，经 onPaste 交给 JS（聊天页弹「发送这张图片？」，走现成的发图那条路）。
// **JS 没挂监听时一律放回原样**：sink 为 nil = 不改任何行为，别的输入框（登录页的邮箱框）照旧。

public class OttoPasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OttoPaste")

    Events("onPaste")

    OnCreate {
      PasteHook.install()
    }

    // sink 只在主线程读写（挂钩都在主线程上被 UIKit 调）
    OnStartObserving {
      DispatchQueue.main.async {
        PasteHook.sink = { [weak self] payload in
          self?.sendEvent("onPaste", payload)
        }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async { PasteHook.sink = nil }
    }
  }
}

enum PasteHook {
  /// JS 那边有人在听才不为 nil（OnStartObserving / OnStopObserving 管它）。只在主线程读写
  static var sink: (([String: Any]) -> Void)?
  private static var installed = false

  static func install() {
    DispatchQueue.main.async {
      guard !installed, let cls = NSClassFromString("RCTUITextView") else { return }
      installed = true
      hookPasteConfiguration(cls)
      hookCanPerform(cls)
      hookPaste(cls)
      hookItemProviders(cls)
    }
  }

  // ── 挂钩：只加 / 换在 cls 自己身上；原实现（可能是父类 UITextView 的）先取出来留着调 ─────────────

  private static func replace(_ cls: AnyClass, _ sel: Selector, types: String, _ block: Any) {
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(cls, sel, imp, types), let m = class_getInstanceMethod(cls, sel) {
      method_setImplementation(m, imp)
    }
  }

  private static func original(_ cls: AnyClass, _ sel: Selector) -> IMP? {
    class_getInstanceMethod(cls, sel).map { method_getImplementation($0) }
  }

  private static func hookPasteConfiguration(_ cls: AnyClass) {
    let sel = #selector(getter: UIResponder.pasteConfiguration)
    typealias Fn = @convention(c) (AnyObject, Selector) -> UIPasteConfiguration?
    let orig = original(cls, sel).map { unsafeBitCast($0, to: Fn.self) }
    let block: @convention(block) (AnyObject) -> UIPasteConfiguration? = { obj in
      let base = orig?(obj, sel)
      guard sink != nil else { return base }
      let c = base ?? UIPasteConfiguration(forAccepting: NSString.self)
      if !c.acceptableTypeIdentifiers.contains(UTType.image.identifier) {
        c.addAcceptableTypeIdentifiers([UTType.image.identifier, UTType.png.identifier, UTType.jpeg.identifier])
      }
      return c
    }
    replace(cls, sel, types: "@@:", block)
  }

  private static func hookCanPerform(_ cls: AnyClass) {
    let sel = #selector(UIResponder.canPerformAction(_:withSender:))
    typealias Fn = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
    guard let orig = original(cls, sel).map({ unsafeBitCast($0, to: Fn.self) }) else { return }
    let paste = #selector(UIResponderStandardEditActions.paste(_:))
    let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { obj, action, sender in
      // hasImages 只是探一下有没有，不读内容，不会弹「允许粘贴」
      if action == paste, sink != nil, (obj as? UITextView)?.isEditable == true, UIPasteboard.general.hasImages { return true }
      return orig(obj, sel, action, sender)
    }
    replace(cls, sel, types: "B@::@", block)
  }

  private static func hookPaste(_ cls: AnyClass) {
    let sel = #selector(UIResponderStandardEditActions.paste(_:))
    typealias Fn = @convention(c) (AnyObject, Selector, Any?) -> Void
    let orig = original(cls, sel).map { unsafeBitCast($0, to: Fn.self) }
    let block: @convention(block) (AnyObject, Any?) -> Void = { obj, sender in
      let pb = UIPasteboard.general
      if sink != nil, pb.hasImages, !pb.hasStrings, let images = pb.images, !images.isEmpty {
        emit(images)
        return
      }
      orig?(obj, sel, sender)
    }
    replace(cls, sel, types: "v@:@", block)
  }

  private static func imageProviders(_ providers: [NSItemProvider]) -> [NSItemProvider] {
    providers.filter { $0.canLoadObject(ofClass: UIImage.self) && !$0.canLoadObject(ofClass: NSString.self) }
  }

  private static func hookItemProviders(_ cls: AnyClass) {
    let canSel = NSSelectorFromString("canPasteItemProviders:")
    typealias CanFn = @convention(c) (AnyObject, Selector, [NSItemProvider]) -> Bool
    let canOrig = original(cls, canSel).map { unsafeBitCast($0, to: CanFn.self) }
    let canBlock: @convention(block) (AnyObject, [NSItemProvider]) -> Bool = { obj, providers in
      if sink != nil, !imageProviders(providers).isEmpty { return true }
      return canOrig?(obj, canSel, providers) ?? true
    }
    replace(cls, canSel, types: "B@:@", canBlock)

    let sel = NSSelectorFromString("pasteItemProviders:")
    typealias Fn = @convention(c) (AnyObject, Selector, [NSItemProvider]) -> Void
    let orig = original(cls, sel).map { unsafeBitCast($0, to: Fn.self) }
    let block: @convention(block) (AnyObject, [NSItemProvider]) -> Void = { obj, providers in
      let imgs = imageProviders(providers)
      if sink != nil, !imgs.isEmpty {
        load(imgs)
        return
      }
      orig?(obj, sel, providers)
    }
    replace(cls, sel, types: "v@:@", block)
  }

  // ── 拿到图之后：存成临时 PNG，一次粘贴一条事件 ─────────────────────────

  private static func load(_ providers: [NSItemProvider]) {
    let group = DispatchGroup()
    var images = [Int: UIImage]()
    let lock = NSLock()
    for (i, p) in providers.enumerated() {
      group.enter()
      p.loadObject(ofClass: UIImage.self) { obj, _ in
        if let img = obj as? UIImage {
          lock.lock()
          images[i] = img
          lock.unlock()
        }
        group.leave()
      }
    }
    group.notify(queue: .main) {
      let ordered = images.keys.sorted().compactMap { images[$0] }
      if !ordered.isEmpty { emit(ordered) }
    }
  }

  private static func emit(_ images: [UIImage]) {
    let dir = FileManager.default.temporaryDirectory
    var out = [[String: Any]]()
    for img in images {
      guard let data = img.pngData() else { continue }
      let url = dir.appendingPathComponent("otto-paste-\(UUID().uuidString).png")
      do {
        try data.write(to: url)
      } catch {
        continue
      }
      out.append([
        "uri": url.absoluteString,
        "width": Int((img.size.width * img.scale).rounded()),
        "height": Int((img.size.height * img.scale).rounded()),
        "bytes": data.count,
      ])
    }
    guard !out.isEmpty else { return }
    let payload: [String: Any] = ["images": out]
    if Thread.isMainThread {
      sink?(payload)
    } else {
      DispatchQueue.main.async { sink?(payload) }
    }
  }
}
