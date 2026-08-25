import { memo } from 'react';
import clsx from 'clsx';
import { Gauge } from '@/components/common/icons';
import {
  THINKING_LEVELS,
  THINKING_MAX_LEVEL,
  useThinkingDepthSelector,
  type ThinkingLevel,
} from './useThinkingDepthSelector';

export { THINKING_LEVELS, THINKING_LEVEL_INDEX, type ThinkingLevel } from './useThinkingDepthSelector';

interface ThinkingDepthSelectorProps {
  value: ThinkingLevel;
  labels: Record<ThinkingLevel, string>;
  ariaLabel: string;
  title: string;
  description?: string;
  /** Lock the rail (e.g. thinking mode is off in Chat). */
  disabled?: boolean;
  onChange?: (level: ThinkingLevel) => void;
}

/**
 * Claude Desktop-style effort selector:
 * - continuous draggable rail with magnetic snapping and spring-back on release
 * - pixel/ember cell field + star sparks that ignite from the low end toward the thumb
 * - leading-edge glow + thumb core light while interacting, then a calm idle state
 * - blur/translate label swap when the snapped level changes
 */
export const ThinkingDepthSelector = memo(function ThinkingDepthSelector({
  value,
  labels,
  ariaLabel,
  title,
  description,
  disabled,
  onChange,
}: ThinkingDepthSelectorProps) {
  const {
    trackRef,
    thumbRef,
    fillRef,
    canvasRef,
    dotRefs,
    descId,
    levelIndex,
    dragging,
    curLabel,
    outLabel,
    labelKey,
    stageStyle,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
    handleTrackClick,
    selectLevel,
  } = useThinkingDepthSelector({ value, labels, disabled, onChange });

  return (
    <div className="ax-effort">
      <div className="ax-effort-head">
        <span className="ax-effort-title">
          <span className="ax-effort-title-icon">
            <Gauge size={14} />
          </span>
          {title}
        </span>
        <span className="ax-effort-stage" style={stageStyle} aria-live="polite" aria-atomic="true">
          {outLabel !== null && outLabel !== curLabel && (
            <span key={`out-${labelKey}`} className="ax-effort-label-out" aria-hidden="true">
              {outLabel}
            </span>
          )}
          <span key={`cur-${labelKey}`} className="ax-effort-label-cur">
            {curLabel}
          </span>
        </span>
      </div>

      <div
        ref={trackRef}
        className={clsx('ax-effort-track', dragging && 'is-dragging', disabled && 'is-disabled')}
        role="slider"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={THINKING_MAX_LEVEL}
        aria-valuenow={levelIndex}
        aria-valuetext={curLabel}
        aria-disabled={disabled || undefined}
        aria-describedby={description ? descId : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onKeyDown={handleKeyDown}
        onClick={handleTrackClick}
      >
        <div ref={fillRef} className="ax-effort-fill" aria-hidden="true" />
        <canvas ref={canvasRef} className="ax-effort-canvas" aria-hidden="true" />
        <div className="ax-effort-ticks" aria-hidden="true">
          {THINKING_LEVELS.map((level, index) => (
            <button
              key={level}
              type="button"
              tabIndex={-1}
              ref={(element) => {
                dotRefs.current[index] = element;
              }}
              data-level={level}
              className={clsx('ax-effort-dot', index === levelIndex && 'is-active')}
              onClick={(event) => {
                event.stopPropagation();
                selectLevel(index);
              }}
            />
          ))}
        </div>
        <div ref={thumbRef} className="ax-effort-thumb" aria-hidden="true" />
      </div>

      {description ? (
        <div className="ax-effort-desc" id={descId}>
          {description}
        </div>
      ) : null}
    </div>
  );
});
