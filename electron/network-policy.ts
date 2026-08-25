/** Shared CSP / network origin policy. */
export const ALLOWED_CONNECT_ORIGINS = [
  'https://api.deepseek.com',
  'https://html.duckduckgo.com',
  'https://api.exa.ai',
  'https://api.perplexity.ai',
  'https://slack.com',
  'https://www.googleapis.com',
  'https://api.notion.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
] as const;

/** Local dev-server origins required by Vite HMR. */
export const DEV_CONNECT_ORIGINS = ['http://localhost:*', 'ws://localhost:*'] as const;

/** Internal preview browser deliberately allows http(s) origins in frames. */
export const ALLOWED_FRAME_ORIGINS = ['http://localhost:*', 'http://127.0.0.1:*', 'https:'] as const;

export function buildConnectSrc(includeDevOrigins: boolean): string {
  return [...(includeDevOrigins ? DEV_CONNECT_ORIGINS : []), ...ALLOWED_CONNECT_ORIGINS].join(' ');
}

export function buildFrameSrc(): string {
  return ALLOWED_FRAME_ORIGINS.join(' ');
}
