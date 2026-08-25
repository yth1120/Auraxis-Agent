import { describe, it, expect, beforeEach } from 'vitest';
import { useAdvancedStore } from '../useAdvancedStore';
import type {
  PermissionRequest,
  PermissionRule,
  MCPServerConfig,
  MCPStatus,
  AgentInfo,
  AgentLogEntry,
} from '../../types/advanced';

function mkPermissionReq(requestId: string): PermissionRequest {
  return {
    requestId,
    toolName: 'Write',
    input: { file_path: '/test.ts' },
    message: '写入 /test.ts',
    timestamp: Date.now(),
    mode: 'ask',
  };
}

function mkPermissionRule(id: string): PermissionRule {
  return {
    id,
    toolName: 'Write',
    scope: 'once' as const,
    action: 'allow',
    createdAt: Date.now(),
  };
}

function mkAgent(id: string): AgentInfo {
  return {
    id,
    name: `Agent ${id}`,
    description: '',
    status: 'running' as const,
    startTime: Date.now(),
    toolCallCount: 0,
    iterations: 0,
    log: [],
  };
}

describe('useAdvancedStore — permission queue', () => {
  beforeEach(() => {
    useAdvancedStore.setState({
      permissionQueue: [],
      permissionRules: [],
      permissionStatus: 'idle',
    });
  });

  it('enqueuePermission 入队请求', () => {
    const req = mkPermissionReq('req-1');
    useAdvancedStore.getState().enqueuePermission(req);
    expect(useAdvancedStore.getState().permissionQueue).toHaveLength(1);
    expect(useAdvancedStore.getState().permissionQueue[0].requestId).toBe('req-1');
  });

  it('enqueuePermission 将 permissionStatus 设为 waiting', () => {
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-1'));
    expect(useAdvancedStore.getState().permissionStatus).toBe('waiting');
  });

  it('多次入队队列累增', () => {
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-1'));
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-2'));
    expect(useAdvancedStore.getState().permissionQueue).toHaveLength(2);
  });

  it('dequeuePermission 移出指定请求', () => {
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-1'));
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-2'));
    useAdvancedStore.getState().dequeuePermission('req-1');
    expect(useAdvancedStore.getState().permissionQueue).toHaveLength(1);
    expect(useAdvancedStore.getState().permissionQueue[0].requestId).toBe('req-2');
  });

  it('dequeuePermission 队列清空后状态回 idle', () => {
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-1'));
    useAdvancedStore.getState().dequeuePermission('req-1');
    expect(useAdvancedStore.getState().permissionStatus).toBe('idle');
  });

  it('dequeuePermission 不存在 requestId 不改变状态', () => {
    useAdvancedStore.getState().enqueuePermission(mkPermissionReq('req-1'));
    useAdvancedStore.getState().dequeuePermission('nonexistent');
    expect(useAdvancedStore.getState().permissionQueue).toHaveLength(1);
    expect(useAdvancedStore.getState().permissionStatus).toBe('waiting');
  });

  it('setPermissionStatus 手动设置状态', () => {
    useAdvancedStore.getState().setPermissionStatus('waiting');
    expect(useAdvancedStore.getState().permissionStatus).toBe('waiting');
  });
});

describe('useAdvancedStore — permission rules', () => {
  beforeEach(() => {
    useAdvancedStore.setState({ permissionRules: [] });
  });

  it('addPermissionRule 添加规则', () => {
    const rule = mkPermissionRule('rule-1');
    useAdvancedStore.getState().addPermissionRule(rule);
    expect(useAdvancedStore.getState().permissionRules).toHaveLength(1);
    expect(useAdvancedStore.getState().permissionRules[0].id).toBe('rule-1');
  });

  it('addPermissionRule 超 200 条裁剪保留最新', () => {
    // 添加 210 条规则
    for (let i = 0; i < 210; i++) {
      useAdvancedStore.getState().addPermissionRule(mkPermissionRule(`rule-${i}`));
    }
    const rules = useAdvancedStore.getState().permissionRules;
    expect(rules.length).toBe(200);
    // 保留最新的 200 条（即裁剪掉最旧的 10 条，id 从 rule-10 开始）
    expect(rules[0].id).toBe('rule-10');
    expect(rules[199].id).toBe('rule-209');
  });

  it('removePermissionRule 按 id 删除', () => {
    useAdvancedStore.getState().addPermissionRule(mkPermissionRule('rule-1'));
    useAdvancedStore.getState().addPermissionRule(mkPermissionRule('rule-2'));
    useAdvancedStore.getState().removePermissionRule('rule-1');
    expect(useAdvancedStore.getState().permissionRules).toHaveLength(1);
    expect(useAdvancedStore.getState().permissionRules[0].id).toBe('rule-2');
  });

  it('removePermissionRule 不存在的 id 无影响', () => {
    useAdvancedStore.getState().addPermissionRule(mkPermissionRule('rule-1'));
    useAdvancedStore.getState().removePermissionRule('nonexistent');
    expect(useAdvancedStore.getState().permissionRules).toHaveLength(1);
  });

  it('clearPermissionRules 清空所有规则', () => {
    useAdvancedStore.getState().addPermissionRule(mkPermissionRule('rule-1'));
    useAdvancedStore.getState().addPermissionRule(mkPermissionRule('rule-2'));
    useAdvancedStore.getState().clearPermissionRules();
    expect(useAdvancedStore.getState().permissionRules).toEqual([]);
  });
});

describe('useAdvancedStore — MCP statuses', () => {
  beforeEach(() => {
    useAdvancedStore.setState({ mcpStatuses: [] });
  });

  it('updateMcpStatus 新增状态', () => {
    const status: MCPStatus = { serverId: 'srv-1', connected: true, toolCount: 5 };
    useAdvancedStore.getState().updateMcpStatus(status);
    expect(useAdvancedStore.getState().mcpStatuses).toHaveLength(1);
    expect(useAdvancedStore.getState().mcpStatuses[0].serverId).toBe('srv-1');
  });

  it('updateMcpStatus 同 serverId 覆盖旧状态', () => {
    useAdvancedStore.getState().updateMcpStatus({ serverId: 'srv-1', connected: true, toolCount: 5 });
    useAdvancedStore.getState().updateMcpStatus({ serverId: 'srv-1', connected: false, toolCount: 0 });
    expect(useAdvancedStore.getState().mcpStatuses).toHaveLength(1);
    expect(useAdvancedStore.getState().mcpStatuses[0].connected).toBe(false);
    expect(useAdvancedStore.getState().mcpStatuses[0].toolCount).toBe(0);
  });

  it('setMcpServers 设置服务器列表', () => {
    const servers: MCPServerConfig[] = [
      { id: 's1', name: 'Server 1', command: 'node', args: ['s1.js'], enabled: true },
      { id: 's2', name: 'Server 2', command: 'python', args: ['s2.py'], enabled: true },
    ];
    useAdvancedStore.getState().setMcpServers(servers);
    expect(useAdvancedStore.getState().mcpServers).toEqual(servers);
  });
});

describe('useAdvancedStore — agent management', () => {
  beforeEach(() => {
    useAdvancedStore.setState({ runningAgents: [] });
  });

  it('addAgent 添加 agent', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    expect(useAdvancedStore.getState().runningAgents).toHaveLength(1);
    expect(useAdvancedStore.getState().runningAgents[0].id).toBe('agent-1');
  });

  it('updateAgent 更新 agent 属性', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().updateAgent('agent-1', { status: 'completed' as const });
    expect(useAdvancedStore.getState().runningAgents[0].status).toBe('completed');
  });

  it('updateAgent 不存在 id 不影响', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().updateAgent('nonexistent', { status: 'error' as const });
    expect(useAdvancedStore.getState().runningAgents[0].status).toBe('running');
  });

  it('removeAgent 移除 agent', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().addAgent(mkAgent('agent-2'));
    useAdvancedStore.getState().removeAgent('agent-1');
    expect(useAdvancedStore.getState().runningAgents).toHaveLength(1);
    expect(useAdvancedStore.getState().runningAgents[0].id).toBe('agent-2');
  });
});

describe('useAdvancedStore — agent log appending', () => {
  beforeEach(() => {
    useAdvancedStore.setState({ runningAgents: [] });
  });

  it('appendAgentLog 追加 text log', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    const entry: AgentLogEntry = { type: 'text', text: 'Hello', timestamp: Date.now() };
    useAdvancedStore.getState().appendAgentLog('agent-1', [entry]);
    const agent = useAdvancedStore.getState().runningAgents[0];
    expect(agent.log).toBeDefined();
    expect(agent.log![0].text).toBe('Hello');
  });

  it('appendAgentLog 连续 text 类型合并', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'text', text: 'Part1', timestamp: 1000 }]);
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'text', text: 'Part2', timestamp: 2000 }]);
    const agent = useAdvancedStore.getState().runningAgents[0];
    // 连续 text 合并为一条
    expect(agent.log!.length).toBe(1);
    expect(agent.log![0].text).toBe('Part1Part2');
  });

  it('appendAgentLog 非 text 类型单独追加（不合并）', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'tool_start', toolName: 'Read', timestamp: 1000 }]);
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'tool_start', toolName: 'Write', timestamp: 2000 }]);
    const agent = useAdvancedStore.getState().runningAgents[0];
    // 非 text 类型各自独立
    expect(agent.log!.length).toBe(2);
  });

  it('appendAgentLog 混合 text 和非 text 追加', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'text', text: 'Hello', timestamp: 1000 }]);
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'tool_start', toolName: 'Read', timestamp: 2000 }]);
    useAdvancedStore.getState().appendAgentLog('agent-1', [{ type: 'text', text: 'World', timestamp: 3000 }]);
    const agent = useAdvancedStore.getState().runningAgents[0];
    // [text:Hello, tool_call:Read, text:World] — 3 entries (text 被 tool_call 隔开)
    expect(agent.log!.length).toBe(3);
  });

  it('appendAgentLog 上限 500 条裁剪', () => {
    useAdvancedStore.getState().addAgent(mkAgent('agent-1'));
    // 添加 501 条非 text log（不会被合并）
    const entries: AgentLogEntry[] = [];
    for (let i = 0; i < 501; i++) {
      entries.push({ type: 'tool_start', toolName: `Tool${i}`, timestamp: i * 1000 });
    }
    useAdvancedStore.getState().appendAgentLog('agent-1', entries);
    const agent = useAdvancedStore.getState().runningAgents[0];
    expect(agent.log!.length).toBe(500);
    // 最新 500 条，第一条是 Tool1
    expect(agent.log![0].toolName).toBe('Tool1');
  });
});
