/**
 * tool-inertia.ts — AutoTool 工具使用惯性图.
 *
 * 论文核心：工具调用序列具有可预测的低熵"惯性"；用历史轨迹构建有向图
 * （工具节点 + 转移概率），在每次 LLM 决策前可先尝试惯性预测，绕过重复
 * 推理，最多可省 30% 推理开销。
 *
 * 本实现先做观测与预测层：工具批次执行后自动登记转移，暴露
 * suggestNext() 供上层（未来 loop 旁路开关）使用；参数级填充暂不实现。
 */

export interface ToolInertiaSuggestion {
  tool: string;
  probability: number;
  confidence: 'high' | 'medium' | 'low';
  from: string;
}

export interface InertiaEdge {
  from: string;
  to: string;
  count: number;
  probability: number;
}

export interface InertiaStats {
  scopes: number;
  totalTransitions: number;
  edges: InertiaEdge[];
}

class ToolInertiaGraph {
  private edges = new Map<string, Map<string, number>>();
  private lastTool = new Map<string, string>();

  /** 登记一批按原顺序执行完的工具名（同一批次内 + 跨批次衔接）。 */
  observeSequence(scope: string, toolNames: string[]): void {
    if (!scope) return;
    const names = toolNames.filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length === 0) return;

    const prev = this.lastTool.get(scope);
    if (prev && prev !== names[0]) this.bump(scope, prev, names[0]);
    for (let i = 0; i < names.length - 1; i++) {
      if (names[i] !== names[i + 1]) this.bump(scope, names[i], names[i + 1]);
    }
    this.lastTool.set(scope, names[names.length - 1]);
  }

  /**
   * 预测下一个最可能的工具。`history` 为当前回合已调用的工具序列；
   * 缺省时用该 scope 上一次批次结尾。概率低于 minProbability 返回 null。
   */
  suggestNext(scope: string, history?: string[], opts: { minProbability?: number } = {}): ToolInertiaSuggestion | null {
    const minProb = opts.minProbability ?? 0.5;
    const seq = (history || []).filter((n): n is string => typeof n === 'string' && n.length > 0);
    const last = seq.length > 0 ? seq[seq.length - 1] : this.lastTool.get(scope);
    if (!last) return null;

    const next = this.edges.get(this.key(scope, last));
    if (!next || next.size === 0) return null;

    let total = 0;
    let best: { tool: string; count: number } | null = null;
    for (const [tool, count] of next) {
      total += count;
      if (!best || count > best.count) best = { tool, count };
    }
    if (!best || total === 0) return null;
    const probability = best.count / total;
    if (probability < minProb) return null;
    return {
      tool: best.tool,
      probability,
      confidence: probability >= 0.75 ? 'high' : probability >= 0.6 ? 'medium' : 'low',
      from: last,
    };
  }

  stats(scope?: string): InertiaStats {
    const edgeList: InertiaEdge[] = [];
    let totalTransitions = 0;
    for (const [from, map] of this.edges) {
      if (scope && !this.scopeHas(scope, from)) continue;
      const fromTotal = [...map.values()].reduce((a, b) => a + b, 0);
      totalTransitions += fromTotal;
      const sep = from.indexOf('\u0000');
      const displayFrom = sep >= 0 ? from.slice(sep + 1) : from;
      for (const [to, count] of map) {
        edgeList.push({ from: displayFrom, to, count, probability: count / fromTotal });
      }
    }
    edgeList.sort((a, b) => b.count - a.count);
    return { scopes: this.edges.size, totalTransitions, edges: edgeList.slice(0, 200) };
  }

  reset(scope?: string): void {
    if (scope) {
      for (const from of [...this.edges.keys()]) {
        if (from.startsWith(`${scope}\u0000`)) this.edges.delete(from);
      }
      this.lastTool.delete(scope);
    } else {
      this.edges.clear();
      this.lastTool.clear();
    }
  }

  private scopeHas(scope: string, from: string): boolean {
    return from === scope || from.startsWith(`${scope}\u0000`);
  }

  private key(scope: string, tool: string): string {
    return `${scope}\u0000${tool}`;
  }

  private bump(scope: string, fromTool: string, toTool: string): void {
    if (fromTool === toTool) return;
    // 边按 scope 隔离（reset 可精确清理）；未来如需跨项目迁移再合并。
    const mapKey = this.key(scope, fromTool);
    let map = this.edges.get(mapKey);
    if (!map) {
      map = new Map();
      this.edges.set(mapKey, map);
    }
    map.set(toTool, (map.get(toTool) ?? 0) + 1);
  }
}

export const toolInertia = new ToolInertiaGraph();
