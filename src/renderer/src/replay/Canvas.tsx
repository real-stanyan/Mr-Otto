// 架构画布 SVG — docs/replay-demo.html 的画布原样移植成 React 组件。
// 纯展示：亮哪些节点/边由 props 决定（steps.ts 算好传进来），自己不含逻辑。
// 改架构图时两边同步：demo HTML 是文档，这里是产品。

interface CanvasProps {
  nodes: string[];
  edges: string[];
  deny: boolean;
}

export function Canvas({ nodes, edges, deny }: CanvasProps) {
  // demo 同款类名策略：deny 时节点同时挂 deny+hot（deny 覆盖颜色，hot 保住文字亮度）
  const nodeCls = (id: string) =>
    "node" + (nodes.includes(id) ? (deny ? " deny hot" : " hot") : "");
  const edgeCls = (id: string) => "edge" + (edges.includes(id) ? (deny ? " deny" : " hot") : "");

  return (
    <svg viewBox="0 0 640 470">
      <defs>
        <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0L7,3.5L0,7z" fill="#3f3f42" />
        </marker>
        <marker id="arrHot" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0L7,3.5L0,7z" fill="#2f9e44" />
        </marker>
        <marker id="arrDeny" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0L7,3.5L0,7z" fill="#e03131" />
        </marker>
      </defs>

      {/* 边 */}
      <g className={edgeCls("e-user-bridge")}>
        <path d="M88,60 H103" />
      </g>
      <g className={edgeCls("e-bridge-loop")}>
        <path d="M217,60 H235" />
      </g>
      <g className={edgeCls("e-loop-store")}>
        <path d="M255,105 L150,190" />
        <text x="130" y="150">append 先落盘</text>
      </g>
      <g className={edgeCls("e-store-derive")}>
        <path d="M185,220 H255" />
        <text x="192" y="212">load</text>
      </g>
      <g className={edgeCls("e-derive-adapter")}>
        <path d="M395,205 L470,112" />
        <text x="428" y="170">messages</text>
      </g>
      <g className={edgeCls("e-adapter-loop")}>
        <path d="M470,75 H385" />
        <text x="398" y="67">reply</text>
      </g>
      <g className={edgeCls("e-loop-gate")}>
        <path d="M255,107 L240,330" />
        <text x="130" y="300">runPipeline(call)</text>
      </g>
      <g className={edgeCls("e-gate-approver")}>
        <path d="M395,360 H475" />
        <text x="400" y="352">decide()</text>
      </g>
      <g className={edgeCls("e-gate-tool")}>
        <path d="M235,365 H165" />
        <text x="180" y="357">放行</text>
      </g>
      <g className={edgeCls("e-tool-world")}>
        <path d="M100,397 V418" />
        <text x="108" y="412">world.*</text>
      </g>

      {/* 节点（.file 行 = 对应源码文件） */}
      <g className={nodeCls("n-user")}>
        <ellipse cx="50" cy="60" rx="38" ry="24" />
        <text x="50" y="64" textAnchor="middle">用户</text>
      </g>
      <g className={nodeCls("n-bridge")}>
        <rect x="103" y="28" width="114" height="66" rx="10" />
        <text x="160" y="50" textAnchor="middle">ShellBridge</text>
        <text className="sub" x="160" y="65" textAnchor="middle">React UI ⇄ IPC ⇄ main</text>
        <text className="file" x="160" y="82" textAnchor="middle">shared/shellBridge.ts</text>
        <text className="file" x="160" y="92" textAnchor="middle">renderer/src/App.tsx</text>
      </g>
      <g className={nodeCls("n-loop")}>
        <rect x="235" y="35" width="150" height="72" rx="10" />
        <text x="310" y="60" textAnchor="middle">LoopEngine</text>
        <text className="sub" x="310" y="76" textAnchor="middle">零状态 · 全靠日志</text>
        <text className="file" x="310" y="94" textAnchor="middle">loop/engine.ts · middleware.ts</text>
      </g>
      <g className={nodeCls("n-adapter")}>
        <rect x="470" y="45" width="150" height="62" rx="10" />
        <text x="545" y="67" textAnchor="middle">ModelAdapter</text>
        <text className="sub" x="545" y="83" textAnchor="middle">OpenAI 方言直连</text>
        <text className="file" x="545" y="99" textAnchor="middle">model/openaiCompatible.ts</text>
      </g>
      <g className={nodeCls("n-store")}>
        <rect x="35" y="190" width="150" height="60" rx="10" />
        <text x="110" y="212" textAnchor="middle">EventStore</text>
        <text className="sub" x="110" y="228" textAnchor="middle">SQLite · append-only</text>
        <text className="file" x="110" y="243" textAnchor="middle">session/store.ts</text>
      </g>
      <g className={nodeCls("n-derive")}>
        <rect x="255" y="190" width="140" height="60" rx="10" />
        <text x="325" y="212" textAnchor="middle">deriveMessages()</text>
        <text className="sub" x="325" y="228" textAnchor="middle">日志 → 模型上下文</text>
        <text className="file" x="325" y="243" textAnchor="middle">session/deriveMessages.ts</text>
      </g>
      <g className={nodeCls("n-gate")}>
        <rect x="235" y="330" width="160" height="66" rx="10" />
        <text x="315" y="352" textAnchor="middle">审批门</text>
        <text className="sub" x="315" y="368" textAnchor="middle">fail-closed · 可短路</text>
        <text className="file" x="315" y="385" textAnchor="middle">loop/approvalGate.ts</text>
      </g>
      <g className={nodeCls("n-approver")}>
        <rect x="475" y="333" width="145" height="63" rx="10" />
        <text x="547" y="353" textAnchor="middle">Approver</text>
        <text className="sub" x="547" y="369" textAnchor="middle">UIApprover · GUI 审批卡</text>
        <text className="file" x="547" y="386" textAnchor="middle">main/uiApprover.ts</text>
      </g>
      <g className={nodeCls("n-tool")}>
        <rect x="35" y="333" width="130" height="64" rx="10" />
        <text x="100" y="353" textAnchor="middle">工具层</text>
        <text className="sub" x="100" y="369" textAnchor="middle">read_file · write_file · bash</text>
        <text className="file" x="100" y="386" textAnchor="middle">tools/*.ts</text>
      </g>
      <g className={nodeCls("n-world")}>
        <rect x="35" y="418" width="230" height="48" rx="10" />
        <text x="150" y="436" textAnchor="middle">ExecutionWorld ← LocalWorld</text>
        <text className="sub" x="150" y="450" textAnchor="middle">fence 围栏 · exec cwd = workspace</text>
        <text className="file" x="150" y="462" textAnchor="middle">world/executionWorld.ts · localWorld.ts</text>
      </g>
    </svg>
  );
}
