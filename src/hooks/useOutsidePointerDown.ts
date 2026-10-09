import { useEffect, type RefObject } from 'react';

/**
 * 点击面板外部时回调 —— 自绘弹层（非 antd 托管）统一用它收起。
 *
 * 命中检测只认 `ref` 容器：触发按钮要和面板一起豁免时，把两者放进同一个容器；
 * 只想豁免面板本身（点触发按钮另有 toggle 逻辑）时，把 ref 放在面板上。
 * 用捕获阶段监听，避免被面板内部 stopPropagation 的交互吞掉。
 */
export function useOutsidePointerDown(ref: RefObject<HTMLElement | null>, onOutside: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      onOutside();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [enabled, onOutside, ref]);
}
