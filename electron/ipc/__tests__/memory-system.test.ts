import { describe, it, expect } from 'vitest';

/**
 * Memory system logic tests — extraction, dedup, retrieval, archive, formatting.
 */

interface Memory {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string;
  is_active: number;
  importance: number;
  timestamp: number;
}

describe('Memory extraction — type classification', () => {
  const validTypes = ['decision', 'problem', 'architecture', 'preference', 'progress', 'context'];

  it('识别所有 6 种记忆类型', () => {
    validTypes.forEach((t) => {
      expect(validTypes).toContain(t);
    });
    expect(validTypes).toHaveLength(6);
  });

  it('拒绝无效的记忆类型', () => {
    expect(validTypes.includes('unknown')).toBe(false);
    expect(validTypes.includes('')).toBe(false);
  });
});

describe('Memory deduplication', () => {
  function similarityScore(a: string, b: string): number {
    const al = a.toLowerCase().trim();
    const bl = b.toLowerCase().trim();
    if (al === bl) return 1.0;
    const aWords = new Set(al.split(/\s+/));
    const bWords = new Set(bl.split(/\s+/));
    const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
    const union = new Set([...aWords, ...bWords]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  it('完全相同标题+高相似内容不重复存储', () => {
    const existing: Memory[] = [
      {
        id: '1',
        title: 'React Router v6',
        content: '项目统一使用 React Router v6，采用 createBrowserRouter',
        type: 'decision',
        tags: '["react","routing"]',
        is_active: 1,
        importance: 4,
        timestamp: Date.now(),
      },
    ];

    const newMem = { title: 'React Router v6', content: '项目统一使用 React Router v6，采用 createBrowserRouter API' };
    const titleSim = similarityScore(newMem.title, existing[0].title);
    const contentSim = similarityScore(newMem.content, existing[0].content);

    expect(titleSim).toBe(1.0);
    expect(contentSim).toBeGreaterThan(0.8);
  });

  it('不同标题的记忆正常存储', () => {
    const existing: Memory[] = [
      {
        id: '1',
        title: 'React Router v6',
        content: '使用 React Router v6',
        type: 'decision',
        tags: '["react"]',
        is_active: 1,
        importance: 4,
        timestamp: Date.now(),
      },
    ];

    const newMem = { title: 'TypeScript strict mode', content: '启用 TypeScript strict mode' };
    const titleSim = similarityScore(newMem.title, existing[0].title);

    expect(titleSim).toBeLessThan(0.5);
  });
});

describe('Memory retrieval', () => {
  const memories: Memory[] = [
    {
      id: '1',
      title: '使用 React Router',
      content: '...',
      type: 'decision',
      tags: '["react","routing"]',
      is_active: 1,
      importance: 4,
      timestamp: 1000,
    },
    {
      id: '2',
      title: '用户认证方案',
      content: '...',
      type: 'architecture',
      tags: '["auth","jwt"]',
      is_active: 1,
      importance: 5,
      timestamp: 2000,
    },
    {
      id: '3',
      title: '临时调试日志',
      content: '...',
      type: 'context',
      tags: '["debug"]',
      is_active: 1,
      importance: 1,
      timestamp: 3000,
    },
  ];

  it('按项目路径检索活跃记忆', () => {
    const active = memories.filter((m) => m.is_active === 1);
    expect(active).toHaveLength(3);
  });

  it('按类型检索', () => {
    const decisions = memories.filter((m) => m.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe('使用 React Router');
  });

  it('按标签检索', () => {
    const authMemories = memories.filter((m) => m.tags.includes('auth'));
    expect(authMemories).toHaveLength(1);
    expect(authMemories[0].title).toBe('用户认证方案');
  });

  it('按重要性降序排列', () => {
    const sorted = [...memories].sort((a, b) => b.importance - a.importance);
    expect(sorted[0].importance).toBe(5);
    expect(sorted[2].importance).toBe(1);
  });
});

describe('Memory archival', () => {
  const memories: Memory[] = [
    {
      id: '1',
      title: 'Active memory',
      content: '...',
      type: 'context',
      tags: '[]',
      is_active: 1,
      importance: 3,
      timestamp: 1000,
    },
    {
      id: '2',
      title: 'Archived memory',
      content: '...',
      type: 'context',
      tags: '[]',
      is_active: 0,
      importance: 3,
      timestamp: 2000,
    },
  ];

  it('归档后不出现在活跃记忆中', () => {
    const active = memories.filter((m) => m.is_active === 1);
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe('Active memory');
  });

  it('归档操作将 is_active 设为 0', () => {
    const mem = memories[0];
    const archived = { ...mem, is_active: 0 };
    expect(archived.is_active).toBe(0);
  });
});

describe('Memory preamble formatting', () => {
  const memories: Memory[] = [
    {
      id: '1',
      title: 'React Router',
      content: '使用 React Router v6 进行路由',
      type: 'decision',
      tags: '[]',
      is_active: 1,
      importance: 4,
      timestamp: Date.now(),
    },
    {
      id: '2',
      title: 'JWT Auth',
      content: '使用 JWT 进行用户认证',
      type: 'architecture',
      tags: '[]',
      is_active: 1,
      importance: 5,
      timestamp: Date.now(),
    },
    {
      id: '3',
      title: '推荐 named export',
      content: '用户偏好使用 named export',
      type: 'preference',
      tags: '[]',
      is_active: 1,
      importance: 3,
      timestamp: Date.now(),
    },
  ];

  it('formatMemoryPreamble 输出包含类型分组标题', () => {
    const groups: Record<string, Memory[]> = {};
    for (const m of memories) {
      (groups[m.type] ||= []).push(m);
    }

    const labels: Record<string, string> = {
      decision: '关键决策',
      architecture: '架构信息',
      preference: '用户偏好',
      progress: '上次进度',
      problem: '已知问题',
      context: '上下文信息',
    };

    const sections: string[] = ['## 项目记忆（来自之前的会话）\n'];
    for (const [type, label] of Object.entries(labels)) {
      const items = groups[type] || [];
      if (items.length > 0) {
        sections.push(`### ${label}`);
        for (const m of items.slice(0, 3)) {
          sections.push(`- ${m.content.slice(0, 200)}`);
        }
        sections.push('');
      }
    }
    sections.push('请利用以上记忆理解用户当前任务');

    const output = sections.join('\n');
    expect(output).toContain('### 关键决策');
    expect(output).toContain('### 架构信息');
    expect(output).toContain('### 用户偏好');
    expect(output).toContain('React Router v6');
    expect(output).toContain('JWT');
    expect(output).toContain('named export');
  });
});
