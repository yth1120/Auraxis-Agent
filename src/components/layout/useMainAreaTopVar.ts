import { useEffect } from 'react';

/** 顶栏（菜单栏）之下、主界面内容的起始偏移。 */
export const MAIN_AREA_TOP_VAR = '--ax-main-top';

/**
 * 把「主界面内容区起点」写进 CSS 变量，供右侧栏全屏使用。
 *
 * 全屏面板不能用 `inset: 0`——那是相对整个窗口，会把顶部栏（菜单栏与窗口按钮）
 * 一起盖住。这里实测 body 行距窗口顶部的距离（= 顶部栏总高），全屏 CSS 用它作为
 * top，从而只铺满顶栏以下的主界面。
 */
export function useMainAreaTopVar(enabled: boolean, element: HTMLElement | null): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const apply = () => {
      // 量不到就先不写：CSS 里 40px 的兜底值（菜单栏高度）好过写 0 把顶栏盖住。
      if (!element) {
        root.style.removeProperty(MAIN_AREA_TOP_VAR);
        return;
      }
      root.style.setProperty(MAIN_AREA_TOP_VAR, `${Math.round(element.getBoundingClientRect().top)}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      root.style.removeProperty(MAIN_AREA_TOP_VAR);
    };
  }, [enabled, element]);
}
