/**
 * cli-args.ts — headless CLI command surface （插件管理）.
 *
 * Commands (all headless, no window):
 *   auraxis --help
 *   auraxis --run "<task>"
 *   auraxis --plugin list
 *   auraxis --sdk | --acp
 */

export type CliApprovalMode = 'ask' | 'plan' | 'auto';
export type CliSandboxMode = 'read' | 'workspace-write' | 'full';
export type CliReasoningEffort = 'low' | 'high' | 'max';
import type { DeepSeekToolChoice } from './contracts/advanced';

export interface CliArgs {
  help: boolean;
  sdk: boolean;
  acp: boolean;
  run?: string;
  pluginList: boolean;
  /** `--plugin scan [dir]` — discover installable plugin manifests. */
  pluginScanDir?: string;
  /** `--plugin enable <id>` / `--plugin disable <id>`. */
  pluginEnable?: string;
  pluginDisable?: string;
  /** Project root for the task. Falls back to settings → cwd. */
  project?: string;
  model?: string;
  apiKey?: string;
  /** Override the resolved API base (also settable via DEEPSEEK_BASE_URL). */
  apiBase?: string;
  mode?: CliApprovalMode;
  sandbox?: CliSandboxMode;
  /** 能力面：chat（无工具）/ work（仅文档）/ code（全工具，默认）。 */
  surface?: 'chat' | 'work' | 'code';
  deepThink?: boolean;
  reasoningEffort?: CliReasoningEffort;
  toolChoice?: DeepSeekToolChoice;
  maxIterations?: number;
  /** Stream machine-readable NDJSON events instead of plain text. */
  json?: boolean;
  /** Print tool calls / thinking / lifecycle events to stderr. */
  verbose?: boolean;
  /** Auto-approve every tool call (default true for one-shot runs). */
  autoApprove?: boolean;
  /** Auto-approve generated plans in plan mode. */
  approvePlan?: boolean;
  /** `--trace-out <path>` — 运行结束导出结构化轨迹 JSON（评测 / 回放用）。 */
  traceOut?: string;
  /** `--tools=Read,Grep,…` — 只注入这些工具（缺省按任务动态预选）。 */
  tools?: string[];
}

function valueOf(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1] !== undefined) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function has(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** `--tools=Read,Grep,…` → 工具名数组（空串 = 未指定）。 */
function parseToolList(argv: string[]): string[] {
  return (valueOf(argv, '--tools') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    help: false,
    sdk: false,
    acp: false,
    pluginList: false,
  };
  if (has(argv, '--help') || has(argv, '-h') || argv.includes('help')) out.help = true;
  if (has(argv, '--sdk')) out.sdk = true;
  if (has(argv, '--acp')) out.acp = true;

  out.run = valueOf(argv, '--run');
  out.project = valueOf(argv, '--project');
  out.model = valueOf(argv, '--model');
  out.apiKey = valueOf(argv, '--api-key');
  out.apiBase = valueOf(argv, '--api-base');
  out.maxIterations = (() => {
    const raw = valueOf(argv, '--max-iterations');
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  })();
  const mode = valueOf(argv, '--mode');
  if (mode === 'ask' || mode === 'plan' || mode === 'auto') {
    out.mode = mode;
  } else if (mode === 'afe') {
    // Legacy CLI spelling — normalize to the current value.
    out.mode = 'auto';
  }
  const sandbox = valueOf(argv, '--sandbox');
  if (sandbox === 'read' || sandbox === 'workspace-write' || sandbox === 'full') out.sandbox = sandbox;
  const effort = valueOf(argv, '--reasoning-effort');
  if (effort === 'low' || effort === 'high' || effort === 'max') out.reasoningEffort = effort;
  const toolChoice = valueOf(argv, '--tool-choice');
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    out.toolChoice = toolChoice;
  } else if (toolChoice) {
    out.toolChoice = { type: 'function', function: { name: toolChoice } };
  }
  out.deepThink = has(argv, '--deep-think') || has(argv, '--deepthink');
  out.json = has(argv, '--json');
  out.verbose = has(argv, '--verbose');
  out.autoApprove = has(argv, '--auto-approve');
  out.traceOut = valueOf(argv, '--trace-out');
  out.tools = parseToolList(argv);
  out.approvePlan = has(argv, '--approve-plan');
  const surface = valueOf(argv, '--surface');
  if (surface === 'chat' || surface === 'work' || surface === 'code') out.surface = surface;

  const pluginIdx = argv.indexOf('--plugin');
  if (pluginIdx >= 0) {
    const action = argv[pluginIdx + 1];
    if (action === 'list') out.pluginList = true;
    else if (action === 'scan') out.pluginScanDir = argv[pluginIdx + 2] || '';
    else if (action === 'enable') out.pluginEnable = argv[pluginIdx + 2];
    else if (action === 'disable') out.pluginDisable = argv[pluginIdx + 2];
  }

  return out;
}

export function cliUsage(): string {
  return [
    'Auraxis headless CLI',
    '',
    '  auraxis --help                                  显示本帮助',
    '  auraxis --run "<任务>" [选项]                   无头执行任务',
    '',
    '任务选项:',
    '  --project <路径>            项目根目录（默认: 设置 → 当前目录）',
    '  --model <id>                模型 ID（默认: 设置 → deepseek-v4-pro）',
    '  --api-key <key>             API Key（优先级高于设置；也支持 DEEPSEEK_API_KEY）',
    '  --api-base=<url>            API 端点（默认: DEEPSEEK_BASE_URL → 官方端点；请用 = 形式）',
    '  --mode <ask|plan|auto>      审批策略（默认: auto；旧写法 afe 仍兼容）',
    '  --sandbox <read|workspace-write|full>  沙箱模式（默认: workspace-write）',
    '  --deep-think                启用深度思考',
    '  --reasoning-effort <high|max>  思考强度（默认 high）',
    '  --max-iterations <n>        最大执行轮数',
    '  --auto-approve              自动批准全部工具调用（单次 CLI 默认启用）',
    '  --surface <chat|work|code>  能力面：work = 仅文档可写（默认 code）',
    '  --approve-plan              计划模式自动批准生成计划',
    '  --json                      输出 NDJSON 事件 + 最终结果',
    '  --verbose                   把工具调用/思考输出打印到 stderr',
    '',
    '其它命令:',
    '  auraxis --plugin list                           列出已安装插件（来自最近同步）',
    '  auraxis --plugin scan [目录]                     扫描目录下的 .auraxis-plugin/plugin.json',
    '  auraxis --plugin enable <id>                    持久化启用插件（写入 plugin-state.json）',
    '  auraxis --plugin disable <id>                   持久化禁用插件',
    '  auraxis --sdk                                   SDK JSON-RPC 服务（回环 TCP）',
    '  auraxis --acp                                   ACP 服务（stdio）',
  ].join('\n');
}
