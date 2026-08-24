// 选取元素 —— 注入内置浏览器页面的取景器脚本 + 返回值的形状闸门。
//
// 通信通道刻意只用现有的 executeJavaScript seam:脚本装好高亮层后返回一个
// Promise,用户点击时 resolve 出 payload,Esc/取消时 resolve null——
// wc.executeJavaScript 天然会等这个 Promise,结果原路回到主进程,
// 不需要给不可信页面开任何新的 IPC 面(view 是 sandbox + 无 preload,保持原样)。
//
// 页面是不可信的:payload 一律当敌方输入过 parsePickPayload——
// 形状校验 + 全字段截断上限,url 更是根本不收页面的(hub 用 getURL() 权威值)。

/** 页面侧能自证的部分。url 不在这里——出处只认主进程(同 browserHub.read 的理由) */
export interface PickedPagePayload {
  /** CSS 路径,#id 短路,否则 tag:nth-of-type 链 */
  selector: string;
  tag: string;
  /** outerHTML,截断后的 */
  html: string;
  /** 可见文本,折叠空白后的片段 */
  text: string;
  /** React dev build 尽力而为:fiber._debugSource → "文件:行号"。生产页拿不到 */
  source?: string;
  /** React 组件名链(由内向外),同样 dev 尽力而为——没有 source 时 agent 靠它 grep */
  components?: string[];
}

const CAP = { selector: 400, tag: 60, html: 2000, text: 300, source: 300, comp: 80, comps: 5 };

/** executeJavaScript 的返回值 → payload。null = 用户取消。其余一律严格校验:
    脚本跑在页面的 main world,页面能把返回值换成任何东西 */
export function parsePickPayload(raw: unknown): PickedPagePayload | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("选取失败：页面返回了预期外的类型");
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("选取失败：页面返回的不是合法 JSON");
  }
  if (
    typeof p !== "object" || p === null ||
    typeof p.selector !== "string" || typeof p.tag !== "string" ||
    typeof p.html !== "string" || typeof p.text !== "string"
  ) {
    throw new Error("选取失败：payload 形状不对");
  }
  const out: PickedPagePayload = {
    selector: p.selector.slice(0, CAP.selector),
    tag: p.tag.slice(0, CAP.tag),
    html: p.html.slice(0, CAP.html),
    text: p.text.slice(0, CAP.text),
  };
  if (typeof p.source === "string" && p.source) out.source = p.source.slice(0, CAP.source);
  // 混进非字符串就整个丢掉:半真半假的组件链比没有更误导
  if (Array.isArray(p.components) && p.components.length > 0 && p.components.every((c) => typeof c === "string")) {
    out.components = (p.components as string[]).slice(0, CAP.comps).map((c) => c.slice(0, CAP.comp));
  }
  return out;
}

/** 页面里跑的取景器。装好覆盖层后返回 Promise:点击 resolve JSON,Esc/取消 resolve null。
    高亮层跟手不加过渡——这是每秒触发几十次的 hover 级交互,加动画只会显得拖 */
export const PICKER_JS = `(() => {
  if (window.__ottoPickCancel) window.__ottoPickCancel();
  return new Promise((resolve) => {
    const root = document.documentElement;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
      "background:rgba(59,130,246,.15);outline:1px solid rgba(59,130,246,.9);border-radius:2px;";
    const label = document.createElement("div");
    label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
      "background:#1e293b;color:#e2e8f0;font:11px/1.7 ui-monospace,SFMono-Regular,monospace;" +
      "padding:1px 6px;border-radius:4px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const cursor = document.createElement("style");
    cursor.textContent = "*{cursor:crosshair !important}";
    root.appendChild(overlay); root.appendChild(label); root.appendChild(cursor);
    let target = null;

    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\\s+/).filter(Boolean);
      if (cls.length) s += "." + cls.slice(0, 2).join(".");
      return s;
    };

    const cssPath = (el) => {
      const parts = [];
      let node = el;
      while (node instanceof Element && parts.length < 12) {
        if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (Array.prototype.indexOf.call(same, node) + 1) + ")";
        }
        parts.unshift(part);
        if (!parent || parent === document.body) { if (parent) parts.unshift("body"); break; }
        node = parent;
      }
      return parts.join(" > ");
    };

    // React dev build 才有的两样:fiber._debugSource(文件:行号,React 19 起没了)
    // 和组件名链。都是尽力而为,拿不到就不给,绝不抛
    const reactInfo = (el) => {
      try {
        let node = el, key = null;
        while (node && !key) {
          key = Object.keys(node).find((k) => k.indexOf("__reactFiber$") === 0) || null;
          if (!key) node = node.parentElement;
        }
        if (!key || !node) return {};
        let fiber = node[key];
        const comps = []; let source = null; let hops = 0;
        while (fiber && hops++ < 200 && (comps.length < 5 || !source)) {
          const d = fiber._debugSource;
          if (!source && d && typeof d.fileName === "string") source = d.fileName + ":" + d.lineNumber;
          const t = fiber.type;
          const name = typeof t === "function" ? (t.displayName || t.name) : null;
          if (name && comps.length < 5 && comps.indexOf(name) < 0) comps.push(name);
          fiber = fiber._debugOwner || fiber.return;
        }
        const out = {};
        if (source) out.source = source;
        if (comps.length) out.components = comps;
        return out;
      } catch { return {}; }
    };

    const place = () => {
      if (!target || !target.isConnected) { overlay.style.display = label.style.display = "none"; return; }
      const r = target.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = r.left + "px"; overlay.style.top = r.top + "px";
      overlay.style.width = r.width + "px"; overlay.style.height = r.height + "px";
      label.textContent = describe(target);
      label.style.display = "block";
      label.style.left = Math.max(4, r.left) + "px";
      label.style.top = (r.top >= 24 ? r.top - 22 : r.bottom + 4) + "px";
    };

    const onMove = (ev) => {
      const el = ev.target;
      if (!(el instanceof Element) || el === overlay || el === label) return;
      target = el;
      place();
    };

    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", onKey, true);
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "contextmenu"])
        window.removeEventListener(t, t === "click" ? onClick : swallow, true);
      overlay.remove(); label.remove(); cursor.remove();
      delete window.__ottoPickCancel;
    };
    const finish = (v) => { cleanup(); resolve(v); };

    const onClick = (ev) => {
      swallow(ev);
      const el = target || (ev.target instanceof Element ? ev.target : null);
      if (!el) return finish(null);
      const info = reactInfo(el);
      finish(JSON.stringify({
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        html: el.outerHTML.slice(0, 2000),
        text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300),
        ...info,
      }));
    };
    const onKey = (ev) => { if (ev.key === "Escape") { swallow(ev); finish(null); } };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", onKey, true);
    for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "contextmenu"])
      window.addEventListener(t, t === "click" ? onClick : swallow, true);
    window.__ottoPickCancel = () => finish(null);
  });
})()`;

/** 取消 = 请页面里的钩子自行收尾。页面没在选取时是 no-op,返回 null 免得序列化出怪东西 */
export const PICKER_CANCEL_JS =
  `(() => { if (window.__ottoPickCancel) window.__ottoPickCancel(); return null; })()`;
