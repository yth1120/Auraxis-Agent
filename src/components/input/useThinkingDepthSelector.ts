import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

export type ThinkingLevel = 'low' | 'medium' | 'high';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];
export const THINKING_LEVEL_INDEX: Record<ThinkingLevel, number> = { low: 0, medium: 1, high: 2 };
export const THINKING_MAX_LEVEL = THINKING_LEVELS.length - 1;

const THUMB_WIDTH = 20;
const DOT_WIDTH = 22;
const SPRING_STIFFNESS = 920;
const SPRING_DAMPING = 42;

const clamp = (value: number, min = 0, max = THINKING_MAX_LEVEL): number => Math.min(max, Math.max(min, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

interface Particle {
  u: number;
  phase: number;
  speed: number;
  size: number;
  jitter: number;
  wob: number;
  flick: number;
  bright: number;
  tone: number;
}

function makeParticle(): Particle {
  return {
    u: Math.random(),
    phase: Math.random() * Math.PI * 2,
    speed: 0.08 + Math.random() * 0.22,
    size: 1.4 + Math.random() * 1.6,
    jitter: Math.random(),
    wob: 1.2 + Math.random() * 2.4,
    flick: 2.5 + Math.random() * 5,
    bright: 0.35 + Math.random() * 0.65,
    tone: Math.random(),
  };
}

function parseHexColor(raw: string): [number, number, number] | null {
  const hex = raw.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function useThinkingDepthSelector({
  value,
  labels,
  disabled,
  onChange,
}: {
  value: ThinkingLevel;
  labels: Record<ThinkingLevel, string>;
  disabled?: boolean;
  onChange?: (level: ThinkingLevel) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const descId = useId();

  const [levelIndex, setLevelIndex] = useState(() => THINKING_LEVEL_INDEX[value]);
  const [dragging, setDragging] = useState(false);
  const [curLabel, setCurLabel] = useState(() => labels[value]);
  const [outLabel, setOutLabel] = useState<string | null>(null);
  const [labelKey, setLabelKey] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);

  const levelIndexRef = useRef(THINKING_LEVEL_INDEX[value]);
  const posRef = useRef(THINKING_LEVEL_INDEX[value]);
  const targetRef = useRef<number | null>(null);
  const velocityRef = useRef(0);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const pointerSamplesRef = useRef<{ t: number; v: number }[]>([]);
  const igniteRef = useRef(0);
  const lastInteractRef = useRef(performance.now());
  const lastTimeRef = useRef(0);
  const rafRef = useRef(0);
  const labelTimerRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const dprRef = useRef(1);
  const thumbXRawRef = useRef(0);
  const trackRectRef = useRef<{ left: number; width: number } | null>(null);
  const paletteRef = useRef<{ violet: [number, number, number]; light: [number, number, number] }>({
    violet: [106, 104, 132],
    light: [255, 255, 255],
  });
  const particlesRef = useRef<Particle[] | null>(null);

  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const refreshPalette = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const computed = getComputedStyle(track);
    paletteRef.current = {
      violet: parseHexColor(computed.getPropertyValue('--color-violet')) ?? [106, 104, 132],
      light: parseHexColor(computed.getPropertyValue('--color-bg-elevated')) ?? [255, 255, 255],
    };
  }, []);

  const measureTrack = useCallback(() => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const width = track.clientWidth || rect.width;
    if (width < 1) return null;
    const borderLeft = track.clientLeft || Math.max((rect.width - width) / 2, 0);
    return { left: rect.left + borderLeft, width };
  }, []);

  const updateThumb = useCallback(
    (nextValue: number) => {
      const track = trackRef.current;
      if (!track) return;
      const metrics = trackRectRef.current ?? measureTrack();
      if (!metrics) return;
      const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
      const safe = clamp(nextValue);
      const center = (safe / THINKING_MAX_LEVEL) * usable + THUMB_WIDTH / 2;
      thumbXRawRef.current = center;
      if (thumbRef.current) thumbRef.current.style.left = `${center - THUMB_WIDTH / 2}px`;
      if (fillRef.current) {
        fillRef.current.style.width = `${center}px`;
        const depthScale = 0.55 + 0.45 * (safe / THINKING_MAX_LEVEL);
        fillRef.current.style.opacity = `${0.75 * igniteRef.current * depthScale}`;
      }
    },
    [measureTrack],
  );

  const layoutDots = useCallback(() => {
    const metrics = trackRectRef.current ?? measureTrack();
    if (!metrics) return;
    const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
    THINKING_LEVELS.forEach((_, index) => {
      const dot = dotRefs.current[index];
      if (!dot) return;
      const center = THUMB_WIDTH / 2 + (index / 2) * usable;
      dot.style.left = `${center - DOT_WIDTH / 2}px`;
    });
  }, [measureTrack]);

  const changeLevel = useCallback((index: number) => {
    const next = clamp(Math.round(index));
    const prev = levelIndexRef.current;
    if (next === prev) return;
    levelIndexRef.current = next;
    const nextLevel = THINKING_LEVELS[next];
    const prevLevel = THINKING_LEVELS[prev];
    setLevelIndex(next);
    setDir(next > prev ? 1 : -1);
    setOutLabel(labelsRef.current[prevLevel]);
    setCurLabel(labelsRef.current[nextLevel]);
    setLabelKey((key) => key + 1);
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = window.setTimeout(() => setOutLabel(null), 240);
    onChangeRef.current?.(nextLevel);
  }, []);

  const drawCanvas = useCallback((time: number, dt: number) => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx || reducedMotionRef.current) return;
    const width = canvas.width / dprRef.current;
    const height = canvas.height / dprRef.current;
    if (width < 1 || height < 1) return;
    ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const energy = igniteRef.current;
    if (energy < 0.004) return;
    const thumbX = thumbXRawRef.current;
    if (thumbX <= 0) return;
    const [vr, vg, vb] = paletteRef.current.violet;
    const [lr, lg, lb] = paletteRef.current.light;
    const now = time / 1000;
    const centerY = height / 2;
    const lit = thumbX * energy;
    const thumbNorm = clamp(thumbX / width);
    const depth = clamp(posRef.current / THINKING_MAX_LEVEL);
    const depthScale = 0.55 + 0.45 * depth;
    const glow = ctx.createLinearGradient(0, 0, width, 0);
    glow.addColorStop(0, 'rgba(0,0,0,0)');
    glow.addColorStop(Math.max(0, (thumbX - 110) / width), 'rgba(0,0,0,0)');
    glow.addColorStop(thumbNorm, `rgba(${vr},${vg},${vb},${(0.42 * energy * depthScale).toFixed(3)})`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    const cell = 6;
    const gap = 1.4;
    const columns = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = column * cell;
        const nx = (x + cell * 0.5) / width;
        const ignite = smoothstep(0.04, Math.max(thumbNorm * energy, 0.0405), nx);
        if (ignite <= 0.002) continue;
        const hash = Math.abs(Math.sin(column * 12.9898 + row * 78.233) * 43758.5453) % 1;
        const flick =
          0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(now * (1.2 + hash * 2.2) + column * 1.1 + row * 2.3 + nx * 5), 2);
        const edge = Math.exp(-Math.pow((nx - thumbNorm) * 14, 2));
        const bright = clamp(0.55 + edge * 0.9 + hash * 0.25, 0, 1.6);
        const alpha = ignite * flick * energy * (0.16 + edge * 0.3) * bright * depthScale;
        if (alpha <= 0.012) continue;
        const mixT = clamp(0.25 + edge * 0.75, 0, 1);
        const r = Math.round(vr + (lr - vr) * mixT);
        const g = Math.round(vg + (lg - vg) * mixT);
        const b = Math.round(vb + (lb - vb) * mixT);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.fillRect(x + gap * 0.5, row * cell + gap * 0.5, cell - gap, cell - gap);
      }
    }
    const coreRadius = 16 + 10 * depth;
    const core = ctx.createRadialGradient(thumbX, centerY, 0, thumbX, centerY, coreRadius);
    core.addColorStop(0, `rgba(${lr},${lg},${lb},${(0.42 * energy * depthScale).toFixed(3)})`);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = core;
    ctx.fillRect(thumbX - coreRadius, centerY - coreRadius, coreRadius * 2, coreRadius * 2);
    const particles = particlesRef.current;
    if (particles) {
      const activeCount = Math.ceil(particles.length * (0.6 + 0.4 * depth));
      for (let i = 0; i < activeCount; i += 1) {
        const p = particles[i];
        p.u += p.speed * dt * (0.5 + energy * 0.9) * (0.8 + 0.5 * depth);
        if (p.u > 1) {
          p.u -= 1;
          p.phase = Math.random() * Math.PI * 2;
          p.bright = 0.35 + Math.random() * 0.65;
        }
        const x = p.u * lit;
        const y = centerY + Math.sin(now * p.wob + p.phase) * height * 0.2 + (p.jitter - 0.5) * height * 0.18;
        const back = 1 - Math.max(0, thumbX - x) / Math.max(1, thumbX);
        const flick = Math.pow(0.5 + 0.5 * Math.sin(now * p.flick + p.phase * 7), 2.5);
        const alpha = energy * back * (0.24 + 0.68 * flick * p.bright) * depthScale;
        if (alpha <= 0.012) continue;
        const mixT = Math.min(0.55, p.tone * (0.35 + 0.65 * back));
        const r = Math.round(vr + (lr - vr) * mixT);
        const g = Math.round(vg + (lg - vg) * mixT);
        const b = Math.round(vb + (lb - vb) * mixT);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        const size = p.size * (0.55 + 0.65 * back);
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
      for (let i = 0; i < 8; i += 1) {
        const p = particles[(i * 17 + 3) % particles.length];
        const travel = (p.u + i * 0.13) % 1;
        const sx = lit * travel + Math.sin(now * 3 + i * 1.7) * 2;
        const sy = centerY + Math.sin(now * (2 + i * 0.7) + p.phase) * height * 0.18;
        const twinkle = 0.5 + 0.5 * Math.sin(now * (5 + i) + p.phase * 3);
        const alpha = energy * twinkle * (0.5 + 0.55 * p.bright) * depthScale;
        if (alpha <= 0.02) continue;
        ctx.fillStyle = `rgba(${lr},${lg},${lb},${alpha.toFixed(3)})`;
        const size = 2 + p.size * 1.3;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
    }
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const ensureLoop = useCallback(() => {
    if (reducedMotionRef.current || rafRef.current) return;
    lastTimeRef.current = performance.now();
    const frame = (time: number) => {
      rafRef.current = requestAnimationFrame(frame);
      const dt = clamp((time - lastTimeRef.current) / 1000, 0, 0.032);
      lastTimeRef.current = time;
      let busy = false;
      if (draggingRef.current) {
        busy = true;
      } else if (targetRef.current !== null) {
        const target = targetRef.current;
        const acceleration = -SPRING_STIFFNESS * (posRef.current - target) - SPRING_DAMPING * velocityRef.current;
        velocityRef.current += acceleration * dt;
        posRef.current = clamp(posRef.current + velocityRef.current * dt);
        changeLevel(Math.round(posRef.current));
        if (Math.abs(posRef.current - target) < 0.0015 && Math.abs(velocityRef.current) < 0.02) {
          posRef.current = target;
          velocityRef.current = 0;
          targetRef.current = null;
          changeLevel(Math.round(target));
          igniteRef.current = 1;
          lastInteractRef.current = performance.now();
        } else {
          busy = true;
        }
      }
      if (igniteRef.current < 1) {
        igniteRef.current = Math.min(1, igniteRef.current + dt * 4.2);
        busy = true;
      }
      if (!draggingRef.current && targetRef.current === null && igniteRef.current > 0.001) {
        const idle = performance.now() - lastInteractRef.current;
        if (idle > 1200) {
          igniteRef.current = Math.max(0, igniteRef.current - dt * 1.4);
          busy = igniteRef.current > 0.001;
        } else {
          busy = true;
        }
      }
      updateThumb(posRef.current);
      drawCanvas(time, dt);
      if (!busy) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [changeLevel, drawCanvas, updateThumb]);

  const springTo = useCallback(
    (target: number, initialVelocity = 0) => {
      const safeTarget = clamp(target);
      if (reducedMotionRef.current) {
        posRef.current = safeTarget;
        targetRef.current = null;
        velocityRef.current = 0;
        igniteRef.current = 0;
        updateThumb(safeTarget);
        changeLevel(safeTarget);
        lastInteractRef.current = performance.now();
        return;
      }
      targetRef.current = safeTarget;
      velocityRef.current = initialVelocity;
      igniteRef.current = Math.max(igniteRef.current, 0.25);
      lastInteractRef.current = performance.now();
      ensureLoop();
    },
    [changeLevel, ensureLoop, updateThumb],
  );

  const valueFromClientX = useCallback(
    (clientX: number) => {
      const metrics = measureTrack();
      if (!metrics) return posRef.current;
      const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
      return clamp(((clientX - metrics.left - THUMB_WIDTH / 2) / usable) * THINKING_MAX_LEVEL);
    },
    [measureTrack],
  );

  const applyMagnet = useCallback((nextValue: number) => {
    const nearest = Math.round(nextValue);
    const delta = nextValue - nearest;
    const distance = Math.abs(delta);
    if (distance < 0.001 || distance > 0.5) return nextValue;
    const t = 1 - distance / 0.5;
    const strength = 0.32 + 0.24 * t;
    return nextValue - delta * strength * t * t;
  }, []);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return;
    const metrics = measureTrack();
    if (!metrics) return;
    trackRectRef.current = metrics;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;
    const height = track.clientHeight || track.getBoundingClientRect().height;
    if (height < 1) return;
    canvas.width = Math.max(1, Math.round(metrics.width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctxRef.current = canvas.getContext('2d');
    refreshPalette();
    if (!particlesRef.current) particlesRef.current = Array.from({ length: 140 }, makeParticle);
    layoutDots();
    updateThumb(posRef.current);
  }, [layoutDots, measureTrack, refreshPalette, updateThumb]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    setupCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => setupCanvas());
      resizeObserver.observe(track);
      return () => resizeObserver.disconnect();
    }
    return undefined;
  }, [setupCanvas]);

  useEffect(() => {
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => refreshPalette()) : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    const mediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reducedMotionRef.current = mediaQuery?.matches ?? false;
    const updateReducedMotion = () => {
      reducedMotionRef.current = mediaQuery?.matches ?? false;
      if (reducedMotionRef.current) stopLoop();
    };
    mediaQuery?.addEventListener('change', updateReducedMotion);
    return () => {
      observer?.disconnect();
      mediaQuery?.removeEventListener('change', updateReducedMotion);
      stopLoop();
      clearTimeout(labelTimerRef.current);
    };
  }, [refreshPalette, stopLoop]);

  useEffect(() => {
    const next = THINKING_LEVEL_INDEX[value];
    const prev = levelIndexRef.current;
    if (next === prev) return;
    levelIndexRef.current = next;
    posRef.current = next;
    targetRef.current = null;
    velocityRef.current = 0;
    setLevelIndex(next);
    setDir(next > prev ? 1 : -1);
    setOutLabel(labelsRef.current[THINKING_LEVELS[prev]]);
    setCurLabel(labelsRef.current[value]);
    setLabelKey((key) => key + 1);
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = window.setTimeout(() => setOutLabel(null), 240);
    updateThumb(next);
    igniteRef.current = 1;
    lastInteractRef.current = performance.now();
    ensureLoop();
  }, [ensureLoop, updateThumb, value]);

  useEffect(() => {
    if (reducedMotionRef.current) return;
    igniteRef.current = 1;
    lastInteractRef.current = performance.now();
    ensureLoop();
  }, [ensureLoop]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const track = trackRef.current;
      if (!track) return;
      const metrics = measureTrack();
      if (!metrics) return;
      draggingRef.current = true;
      movedRef.current = false;
      targetRef.current = null;
      velocityRef.current = 0;
      trackRectRef.current = metrics;
      posRef.current = valueFromClientX(event.clientX);
      updateThumb(posRef.current);
      layoutDots();
      pointerSamplesRef.current = [{ t: performance.now(), v: posRef.current }];
      igniteRef.current = 1;
      lastInteractRef.current = performance.now();
      setDragging(true);
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture unsupported (jsdom) */
      }
      ensureLoop();
    },
    [ensureLoop, layoutDots, measureTrack, updateThumb, valueFromClientX, disabled],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      movedRef.current = true;
      const nextValue = applyMagnet(valueFromClientX(event.clientX));
      posRef.current = nextValue;
      updateThumb(nextValue);
      const now = performance.now();
      const samples = pointerSamplesRef.current;
      samples.push({ t: now, v: nextValue });
      pointerSamplesRef.current = samples.filter((sample) => now - sample.t < 90).slice(-5);
      changeLevel(Math.round(nextValue));
    },
    [applyMagnet, changeLevel, updateThumb, valueFromClientX],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      try {
        trackRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer capture unsupported (jsdom) */
      }
      const target = Math.round(posRef.current);
      if (Math.abs(target - posRef.current) < 0.001) {
        posRef.current = target;
        if (reducedMotionRef.current) {
          igniteRef.current = 0;
          updateThumb(target);
        }
        changeLevel(target);
        if (reducedMotionRef.current) return;
        igniteRef.current = 1;
        lastInteractRef.current = performance.now();
        ensureLoop();
        return;
      }
      if (reducedMotionRef.current) {
        igniteRef.current = 0;
        updateThumb(target);
        changeLevel(target);
        return;
      }
      let velocity = 0;
      const samples = pointerSamplesRef.current;
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = Math.max((last.t - first.t) / 1000, 0.016);
        velocity = Math.min(8, Math.max(-8, (last.v - first.v) / elapsed));
      }
      springTo(target, velocity);
    },
    [changeLevel, ensureLoop, springTo, updateThumb],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = levelIndexRef.current + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = levelIndexRef.current - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = THINKING_MAX_LEVEL;
      else if (event.key === 'PageUp') next = levelIndexRef.current + 1;
      else if (event.key === 'PageDown') next = levelIndexRef.current - 1;
      if (next === null) return;
      event.preventDefault();
      springTo(next);
    },
    [disabled, springTo],
  );

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (movedRef.current) return;
      springTo(Math.round(valueFromClientX(event.clientX)));
    },
    [disabled, springTo, valueFromClientX],
  );

  const selectLevel = useCallback(
    (index: number) => {
      if (disabled) return;
      if (movedRef.current) return;
      springTo(index);
    },
    [disabled, springTo],
  );

  const stageStyle = {
    '--effort-enter-y': dir === 1 ? '4px' : '-4px',
    '--effort-exit-y': dir === 1 ? '-4px' : '4px',
  } as CSSProperties;

  return {
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
    maxLevel: THINKING_MAX_LEVEL,
  };
}
