/**
 * permission.ts — unified permission presets (single source of truth).
 *
 * One composer control answers "how much should I let the agent do?".
 * Each preset expands to the three backend axes that already exist:
 *
 *   · sandboxMode  — hard boundary enforced by sandbox-policy.ts
 *   · mode         — approval policy ('ask' = prompt, 'auto' = auto-approve)
 *   · autoApprove  — bypasses file-hygiene checks (safe-extension,
 *                    read-before-write, blocked-URL). Kept false for the
 *                    auto tier so the workspace still enforces hygiene.
 *
 * The active named permission profile (standard / readonly / sandbox /
 * custom) is a separate hard-scope layer: presets align it with the built-in
 * profile that matches their boundary, while custom profiles can still be
 * layered on top from the settings panel.
 */
import type { ApprovalPolicy } from './core';

export type PermissionPreset = 'ask' | 'auto' | 'full' | 'readonly';
export type PermissionPresetSandbox = 'read' | 'workspace-write' | 'full';
export type PresetApprovalPolicy = Exclude<ApprovalPolicy, 'plan'>;

export interface PermissionPresetSpec {
  sandboxMode: PermissionPresetSandbox;
  mode: PresetApprovalPolicy;
  autoApprove: boolean;
  /** Built-in profile id the preset aligns with (hard scopes). */
  profileId: 'standard' | 'readonly';
}

export const PERMISSION_PRESET_IDS: readonly PermissionPreset[] = ['ask', 'auto', 'full', 'readonly'];

export const PERMISSION_PRESETS: Record<PermissionPreset, PermissionPresetSpec> = {
  ask: {
    sandboxMode: 'workspace-write',
    mode: 'ask',
    autoApprove: false,
    profileId: 'standard',
  },
  auto: {
    sandboxMode: 'workspace-write',
    mode: 'auto',
    // 'auto' already skips every approval prompt; autoApprove stays false so
    // safe-extension / read-before-write / blocked-URL hygiene still apply
    // inside the workspace. The review gate pauses on failed ReviewArtifact.
    autoApprove: false,
    profileId: 'standard',
  },
  full: {
    sandboxMode: 'full',
    mode: 'auto',
    autoApprove: true,
    profileId: 'standard',
  },
  readonly: {
    sandboxMode: 'read',
    mode: 'ask',
    autoApprove: false,
    profileId: 'readonly',
  },
};

export const DEFAULT_PERMISSION_PRESET: PermissionPreset = 'ask';

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESET_IDS as readonly string[]).includes(value);
}

/** Legacy migration: infer a preset from a persisted sandboxMode alone. */
export function permissionPresetFromSandbox(sandboxMode: string | undefined | null): PermissionPreset {
  if (sandboxMode === 'read') return 'readonly';
  if (sandboxMode === 'full') return 'full';
  return 'ask'; // workspace-write (or unknown) keeps the safe default
}
