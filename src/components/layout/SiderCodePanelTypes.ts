export type SiderDragState = { kind: 'workspace'; id: string } | { kind: 'session'; id: string; root: string } | null;
