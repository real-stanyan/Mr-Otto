// xterm 实例的存放处。
//
// 为什么不让 React 组件持有:终端面板会被卸载(关面板、切去看 Git Graph),
// 而 pty 还活着。实例跟着组件走的话,切回来时滚动历史、光标位置、
// 正在编辑的那半行命令全没了——用户会以为进程也死了。
//
// 所以生命周期由 id 决定,不由组件决定:只有"关标签"和"会话删除"才 dispose。
// 工厂注入 = 这个模块不依赖 DOM,能在 vitest 里用假实例测。

export interface Disposable {
  dispose(): void;
}

export function createXtermRegistry<T extends Disposable>(factory: (id: string) => T) {
  const instances = new Map<string, T>();
  return {
    get(id: string): T {
      let inst = instances.get(id);
      if (!inst) {
        inst = factory(id);
        instances.set(id, inst);
      }
      return inst;
    },
    dispose(id: string) {
      instances.get(id)?.dispose();
      instances.delete(id);
    },
    disposeAll() {
      for (const inst of instances.values()) inst.dispose();
      instances.clear();
    },
  };
}
