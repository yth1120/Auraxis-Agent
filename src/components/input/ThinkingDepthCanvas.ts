export type ThinkingLevel = 'low' | 'medium' | 'high';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];
export const THINKING_LEVEL_INDEX: Record<ThinkingLevel, number> = { low: 0, medium: 1, high: 2 };
export const THINKING_MAX_LEVEL = THINKING_LEVELS.length - 1;

export const THUMB_WIDTH = 20;
export const DOT_WIDTH = 22;
export const SPRING_STIFFNESS = 920;
export const SPRING_DAMPING = 42;

export function clamp(value: number, min = 0, max = THINKING_MAX_LEVEL): number {
  return Math.min(max, Math.max(min, value));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface Particle {
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

export function makeParticle(): Particle {
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

export function parseHexColor(raw: string): [number, number, number] | null {
  const hex = raw.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export interface ThinkingCanvasState {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  reducedMotion: boolean;
  dpr: number;
  thumbX: number;
  pos: number;
  ignite: number;
  palette: { violet: [number, number, number]; light: [number, number, number] };
  particles: Particle[] | null;
}

export function drawThinkingCanvas(
  { canvas, ctx, reducedMotion, dpr, thumbX, pos, ignite, palette, particles }: ThinkingCanvasState,
  time: number,
  dt: number,
) {
  if (!canvas || !ctx || reducedMotion) return;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  if (width < 1 || height < 1) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const energy = ignite;
  if (energy < 0.004) return;
  if (thumbX <= 0) return;
  const [vr, vg, vb] = palette.violet;
  const [lr, lg, lb] = palette.light;
  const now = time / 1000;
  const centerY = height / 2;
  const lit = thumbX * energy;
  const thumbNorm = clamp(thumbX / width);
  const depth = clamp(pos / THINKING_MAX_LEVEL);
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
      const igniteCell = smoothstep(0.04, Math.max(thumbNorm * energy, 0.0405), nx);
      if (igniteCell <= 0.002) continue;
      const hash = Math.abs(Math.sin(column * 12.9898 + row * 78.233) * 43758.5453) % 1;
      const flick =
        0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(now * (1.2 + hash * 2.2) + column * 1.1 + row * 2.3 + nx * 5), 2);
      const edge = Math.exp(-Math.pow((nx - thumbNorm) * 14, 2));
      const bright = clamp(0.55 + edge * 0.9 + hash * 0.25, 0, 1.6);
      const alpha = igniteCell * flick * energy * (0.16 + edge * 0.3) * bright * depthScale;
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
}
