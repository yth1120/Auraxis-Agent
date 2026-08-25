import clsx from 'clsx';

export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error';

/** Outer 3x3 matrix cells (2px pixels on a 10px grid), clockwise from top-left. */
const MATRIX_CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  [4, 0],
  [8, 0],
  [8, 4],
  [8, 8],
  [4, 8],
  [0, 8],
  [0, 4],
];

/**
 * 状态圆点: done/warning/error draw a same-color 10% halo around
 * a 6/10 solid core; ongoing is a pixel-art chase — the 8 outer cells of a
 * 3x3 matrix light up clockwise with a stepped trail.
 */
export default function StateDot({
  state,
  size = 10,
  className,
}: {
  state: StateDotState;
  size?: number;
  className?: string;
}) {
  if (state === 'ongoing') {
    return (
      <svg
        className={clsx('ax-state-dot-matrix', className)}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {MATRIX_CELLS.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            className="ax-state-dot-cell"
            x={x}
            y={y}
            width="2"
            height="2"
            /* Negative delay phases the chase so every cell animates from mount. */
            style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}
          />
        ))}
      </svg>
    );
  }
  return (
    <span
      className={clsx('ax-state-dot', className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
