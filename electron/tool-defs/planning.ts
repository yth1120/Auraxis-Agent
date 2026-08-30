import type { ToolDef } from './types';

/** Task planning and sub-agent tools. */
export const PLANNING_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'TodoWrite',
    description:
      'Create and manage a structured task list for tracking progress. Use this to plan complex multi-step tasks, track what is in progress, and mark items as completed. Always update the list as you make progress — mark items complete IMMEDIATELY after finishing.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The complete todo list. Each item must have: content (what to do), status (pending/in_progress/completed), activeForm (present continuous form shown during execution, e.g. "Adding login"). Exactly ONE item in_progress at a time.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What needs to be done' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status' },
              activeForm: { type: 'string', description: 'Present continuous form, e.g. "Fixing auth bug"' },
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle complex, multi-step tasks autonomously. Use for research (Explore), planning (Plan), or general coding tasks (general-purpose). The sub-agent runs independently and returns a single result message. Default backend "internal" runs the built-in sub-agent; "fork" spawns a one-shot child-process fork with its own session.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-5 word) description of the task' },
        prompt: {
          type: 'string',
          description:
            'Complete task description for the sub-agent. Include context, what to do, what tools to use, and expected output format.',
        },
        subagent_type: {
          type: 'string',
          enum: ['Explore', 'Plan', 'general-purpose'],
          description:
            'Agent type: Explore (search/read code), Plan (design implementation), general-purpose (full tools)',
        },
        backend: {
          type: 'string',
          enum: ['internal', 'fork'],
          description: 'Sub-agent backend: internal (built-in, default), fork (one-shot headless fork)',
        },
        background: {
          type: 'boolean',
          description:
            'Start in the background and return immediately with an agentId. Use ListAgents to track it, SendMessage to steer it, and TaskOutput to read the final result.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Replan',
    description:
      'When the current execution plan cannot proceed (tasks are blocked or the original approach is invalid), call this tool to generate a new sub-plan for the remaining work. Provide the status of completed and blocked tasks so the planner understands the current situation.',
    input_schema: {
      type: 'object',
      properties: {
        currentPlanStatus: {
          type: 'string',
          description: 'Summary of the current plan status — which tasks are completed, blocked, and still pending.',
        },
        blockedTasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of blocked task IDs that need a new approach',
        },
        reason: { type: 'string', description: 'Why the original plan cannot continue and what needs to change' },
      },
      required: ['currentPlanStatus', 'blockedTasks', 'reason'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
];
