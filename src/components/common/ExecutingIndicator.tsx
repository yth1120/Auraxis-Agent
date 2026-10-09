import clsx from 'clsx';

interface ExecutingIndicatorProps {
  size?: number;
  className?: string;
}

/**
 * Auraxis 运行标记（Axis Mark）—— 全应用的「正在执行」指示器。
 *
 * 来自品牌 logo 的三个构成元素，也就是品牌名的字面拆解（Aura 光环 + Axis 轴）：
 *   · **轴**：一条锐利的「A」字形脊线，尖顶越过轨道（logo 里 A 的尖顶同样探出环外）；
 *   · **光环**：一条倾斜的环绕轨道；
 *   · **巡行**：一段沿轨道流动的弧 —— 动的是 `stroke-dashoffset`（描边沿路径前进），
 *     不是位移也不是缩放，符合本仓「零位移动画」规范。
 *
 * 为什么替换掉原先的 `executing.gif`：
 *   1. 它是位图，64px 缩到 12px 会糊，且与 1.5 描边的矢量图标同排；
 *   2. 主题适配只能靠 `dark:invert` 反相，无法跟随 `currentColor`/令牌；
 *   3. **它是全应用唯一关不掉的持续动画** —— reduced-motion 的降级只作用于
 *      CSS animation/transition，动图不受影响。本标记在 reduced-motion 下
 *      会退化成一条静态弧（见 `icons.css`）。
 *
 * `size` 对齐 AGENTS.md 的图标档位（12 / 14 / 16 / 20）。
 */
export default function ExecutingIndicator({ size = 14, className }: ExecutingIndicatorProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={clsx('ax-axis-mark shrink-0 select-none', className)}
    >
      {/* 光环：静态底盘 + 沿轨道流动的弧。`pathLength="100"` 把路径长度归一化，
          所以 dasharray/dashoffset 用整数即可**精确对齐一圈**，循环处不会跳帧。 */}
      <ellipse className="ax-axis-mark__aura" cx="12" cy="12.7" rx="9.2" ry="3.3" transform="rotate(-14 12 12.7)" />
      <ellipse
        className="ax-axis-mark__comet"
        cx="12"
        cy="12.7"
        rx="9.2"
        ry="3.3"
        transform="rotate(-14 12 12.7)"
        pathLength={100}
        strokeDasharray="22 78"
      />
      {/* 轴：尖顶在环之上、两脚在环之下 —— 与 logo 的构图一致 */}
      <path className="ax-axis-mark__axis" d="M8.7 17.8 L12 6.1 L15.3 17.8" />
    </svg>
  );
}
