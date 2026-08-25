import { createAgent } from '../constants/commands';
import { useAgentStore } from '../stores/useAgentStore';

/** Icon key resolved by UI layers; keeps the skill registry React-free. */
export type AgentSkillIconKey = 'search' | 'bug' | 'refactor' | 'test' | 'architecture' | 'feature';

export type AgentSkillType = 'Explore' | 'Plan' | 'general-purpose';

/** Declarative Agent skill definition — the single source of truth for skills. */
export interface AgentSkill {
  key: string;
  name: string;
  description: string;
  type: AgentSkillType;
  instruction: string;
  icon: AgentSkillIconKey;
}

/** Built-in Agent skills. UI never owns these definitions. */
export const AGENT_SKILLS: AgentSkill[] = [
  {
    key: 'code-review',
    name: '代码审查',
    description: '审查代码质量和潜在问题',
    type: 'Explore',
    icon: 'search',
    instruction:
      '全面审查项目代码：检查逻辑错误、安全漏洞、性能问题、边界条件处理。对每个发现的问题提供文件路径、行号和修复建议。',
  },
  {
    key: 'bug-fix',
    name: 'Bug 修复',
    description: '定位并修复 Bug',
    type: 'general-purpose',
    icon: 'bug',
    instruction: '系统性排查和修复 Bug：先读取相关代码和错误日志，复现问题，定位根因，实施修复，运行测试验证。',
  },
  {
    key: 'refactor',
    name: '代码重构',
    description: '优化代码结构和可读性',
    type: 'general-purpose',
    icon: 'refactor',
    instruction: '优化代码结构和可读性：消除重复代码，提取公共逻辑，改善命名，引入设计模式。确保重构后行为不变。',
  },
  {
    key: 'test-gen',
    name: '测试生成',
    description: '为代码生成单元测试',
    type: 'general-purpose',
    icon: 'test',
    instruction: '为项目生成单元测试：使用 Vitest 框架，覆盖正常路径、边界条件、异常路径。',
  },
  {
    key: 'architecture',
    name: '架构设计',
    description: '设计系统架构和实现方案',
    type: 'Plan',
    icon: 'architecture',
    instruction:
      '设计系统架构方案：分析现有代码结构，提出架构改进方案，绘制模块关系图，列出实施步骤和风险评估。只读分析。',
  },
  {
    key: 'feature-dev',
    name: '功能开发',
    description: '实现新功能需求',
    type: 'general-purpose',
    icon: 'feature',
    instruction: '实现新功能需求：理解需求场景，设计 API 和 UI，编写实现代码，添加测试用例，更新相关文档。',
  },
];

/** Launch a skill through the real Agent pipeline; buttons only trigger this. */
export function startAgentSkill(skill: AgentSkill): void {
  void createAgent({
    name: skill.name,
    type: skill.type,
    instruction: skill.instruction,
    displayText: skill.description,
  }).then((id) => {
    if (id) useAgentStore.getState().setCurrentAgent(id);
  });
}
