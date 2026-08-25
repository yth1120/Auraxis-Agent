import { ipcMain, app } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import os from 'os';
import { execFile } from 'child_process';

let lastCpuInfo = os.cpus();

function getCpuUsage(): number {
  const currentInfo = os.cpus();

  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < lastCpuInfo.length; i++) {
    const prev = lastCpuInfo[i].times;
    const curr = currentInfo[i]?.times;
    if (!curr) continue;

    const prevIdle = prev.idle;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const currIdle = curr.idle;
    const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;

    totalIdle += currIdle - prevIdle;
    totalTick += currTotal - prevTotal;
  }

  lastCpuInfo = currentInfo;

  if (totalTick === 0) return 0;
  return Math.round((1 - totalIdle / totalTick) * 100);
}

function getMemUsage(): { usedGB: string; totalGB: string; percent: number } {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    usedGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
    totalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
    percent: Math.round((usedMem / totalMem) * 100),
  };
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function getGitBranches(projectRoot: string): Promise<{ current: string; branches: string[] }> {
  try {
    const current = await execGit(['branch', '--show-current'], projectRoot);
    const branchListRaw = await execGit(['branch'], projectRoot);
    const branches = branchListRaw
      .split('\n')
      .map((b) => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);

    return { current, branches };
  } catch {
    return { current: '', branches: [] };
  }
}

export function registerSystemHandlers() {
  secureHandle('system:getStats', async () => {
    try {
      const cpu = getCpuUsage();
      const mem = getMemUsage();

      return {
        ok: true,
        data: {
          cpu,
          mem,
          hostname: os.hostname(),
          platform: process.platform,
          arch: os.arch(),
        },
      };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('system:getGitBranches', async (_event, projectRoot: string) => {
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      const gitInfo = await getGitBranches(root);
      return { ok: true, data: gitInfo };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('system:getVersion', async () => {
    return { ok: true, data: app.getVersion() };
  });

  // ── DeepSeek account balance ─────────────────────────
  secureHandle('system:getAccountInfo', async (_event, apiKey: string) => {
    try {
      const resp = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
      }
      const data = await resp.json();
      const info = data?.balance_infos?.[0];
      return {
        ok: true,
        data: {
          balance: info?.total_balance ?? '—',
          toppedUp: info?.topped_up_balance ?? '—',
          currency: info?.currency || 'CNY',
        },
      };
    } catch (err: any) {
      return { ok: false, error: err.message || '请求失败' };
    }
  });
}
