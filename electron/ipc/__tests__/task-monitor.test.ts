import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startBashTask, finishBashTask, stopTask, clearTasks, listTasks, setTaskStopper } from '../task-monitor';

describe('task-monitor — Agent Bash 任务监控', () => {
  beforeEach(() => {
    clearTasks();
    setTaskStopper(null);
  });

  it('records a running task with command / cwd / toolCallId', () => {
    const id = startBashTask({
      command: 'npm test',
      cwd: 'C:/project',
      toolCallId: 'tool-1',
      agentId: 'agent-a',
    });
    const tasks = listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id,
      command: 'npm test',
      cwd: 'C:/project',
      toolCallId: 'tool-1',
      agentId: 'agent-a',
      status: 'running',
    });
  });

  it('finish marks success with exitCode and duration', () => {
    const id = startBashTask({ command: 'echo hi' });
    finishBashTask(id, { exitCode: 0 });
    const [task] = listTasks();
    expect(task.status).toBe('success');
    expect(task.exitCode).toBe(0);
    expect(task.durationMs).toBeGreaterThanOrEqual(0);
    expect(task.finishedAt).toBeDefined();
  });

  it('finish marks failed for non-zero exit or error', () => {
    const fail = startBashTask({ command: 'exit 1' });
    finishBashTask(fail, { exitCode: 1 });
    expect(listTasks()[0].status).toBe('failed');

    const err = startBashTask({ command: 'boom' });
    finishBashTask(err, { exitCode: null, error: 'ENOENT' });
    expect(listTasks()[0].status).toBe('failed');
    expect(listTasks()[0].error).toBe('ENOENT');
  });

  it('marks timeout when the command exceeded its limit', () => {
    const id = startBashTask({ command: 'sleep 999' });
    finishBashTask(id, { exitCode: null, error: '命令超时', timedOut: true });
    expect(listTasks()[0].status).toBe('timeout');
  });

  it('stopTask routes through the registered stopper and marks stopped', () => {
    const stopper = vi.fn(() => true);
    setTaskStopper(stopper);
    const id = startBashTask({ command: 'npm run dev', toolCallId: 'tool-stop' });
    expect(stopTask(id)).toBe(true);
    expect(stopper).toHaveBeenCalledWith('tool-stop');
    expect(listTasks()[0].status).toBe('stopped');

    // A late finish must not overwrite the stopped state.
    finishBashTask(id, { exitCode: 0 });
    expect(listTasks()[0].status).toBe('stopped');
  });

  it('refuses to stop without a toolCallId or when already finished', () => {
    const noTool = startBashTask({ command: 'orphan' });
    expect(stopTask(noTool)).toBe(false);

    const done = startBashTask({ command: 'done', toolCallId: 't' });
    finishBashTask(done, { exitCode: 0 });
    expect(stopTask(done)).toBe(false);
  });

  it('caps history at 100 entries, newest first', () => {
    for (let i = 0; i < 105; i += 1) {
      startBashTask({ command: `cmd ${i}` });
    }
    const tasks = listTasks();
    expect(tasks).toHaveLength(100);
    expect(tasks[0].command).toBe('cmd 104');
  });
});
