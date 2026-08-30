import type { ToolDef } from './types';

/** Cron, session-local schedule and background task tools. */
export const SCHEDULING_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'CronCreate',
    description:
      'Schedule a recurring or one-shot task. Uses cron syntax with minute/hour/day-of-month/month/day-of-week. Tasks fire when the app is running. Use for periodic checks, reminders, or automation triggers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for this cron job' },
        prompt: { type: 'string', description: 'The prompt to execute when the cron fires' },
        cron: {
          type: 'string',
          description:
            'Standard 5-field cron expression e.g. "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 minutes',
        },
        recurring: { type: 'boolean', description: 'true = fire on every match, false = fire once then delete' },
      },
      required: ['name', 'prompt', 'cron', 'recurring'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'CronDelete',
    description: 'Cancel a scheduled cron job by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID returned by CronCreate' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'CronList',
    description: 'List all active cron jobs (both recurring and one-shot).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'ScheduleCreate',
    description:
      'Create a session-local scheduled follow-up: run a prompt after a delay (after_seconds), at an absolute time (at, epoch ms), or on a fixed interval (every_seconds, bounded repeats). Delivery is session-local and only fires while the app is running; entries do not survive a restart.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run when the follow-up fires' },
        after_seconds: { type: 'number', description: 'Delay in seconds (1 to 30 days)' },
        at: { type: 'number', description: 'Absolute epoch-ms timestamp (future, within 30 days)' },
        every_seconds: { type: 'number', description: 'Fixed interval in seconds (1 to 30 days, bounded repeats)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ScheduleDelete',
    description: 'Cancel a scheduled follow-up by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Schedule id from ScheduleCreate' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ScheduleList',
    description: 'List scheduled follow-ups (kind, prompt, next fire time, repeat budget).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TaskOutput',
    description:
      'Read accumulated output from a running background task or sub-agent. Use to check progress without blocking.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The toolCallId or agent ID to read output from' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TaskStop',
    description: 'Stop a running tool or sub-agent by its ID. Use to cancel long-running operations.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The toolCallId or agent ID to stop' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
];
