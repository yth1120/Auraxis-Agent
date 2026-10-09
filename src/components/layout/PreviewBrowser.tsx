import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Input, Button, Space, Badge, Tooltip, message } from 'antd';
import {
  ArrowClockwise as ReloadOutlined,
  House as HomeOutlined,
  ArrowLeft as ArrowLeftOutlined,
  ArrowRight as ArrowRightOutlined,
  Bug as BugOutlined,
  Desktop as DesktopOutlined,
  DeviceMobile as MobileOutlined,
  DeviceTablet as TabletOutlined,
  Clock as ClockOutlined,
  CursorClick as CursorClickOutlined,
  X as CloseOutlined,
  Tray,
} from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { annotationLabel } from '../../core/activity/annotation';

interface PreviewBrowserProps {
  tabId: string;
}

type Viewport = 'desktop' | 'tablet' | 'mobile';
const VIEWPORT_SIZES: Record<Viewport, { w: number; h: number } | null> = {
  desktop: null, // null = stretch to fill
  tablet: { w: 768, h: 1024 },
  mobile: { w: 375, h: 667 },
};

const HOME_URL = 'http://localhost:3000';
interface HistoryEntry {
  url: string;
  title: string;
  ts: number;
}
const HISTORY_KEY = 'auraxis-browser-history';
function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}
function saveHistory(list: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 100)));
  } catch {
    /* ignore */
  }
}
function recordHistory(list: HistoryEntry[], url: string, title: string): HistoryEntry[] {
  const next = [{ url, title: title || url, ts: Date.now() }, ...list.filter((h) => h.url !== url)].slice(0, 100);
  saveHistory(next);
  return next;
}
const isElectronEnv = typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;

// In browser-only mode the app is itself served from a dev server, so
// loading the same origin would recursively nest the whole app inside the
// preview iframe.  Detect that and refuse to load it.
function wouldNestSelf(target: string): boolean {
  if (isElectronEnv) return false;
  if (typeof window === 'undefined') return false;
  try {
    const t = new URL(target);
    return t.origin === window.location.origin;
  } catch {
    return false;
  }
}

export default function PreviewBrowser({ tabId }: PreviewBrowserProps) {
  const t = useT();
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Start blank — user types a URL and hits Enter.
  const [url, setUrl] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [title, setTitle] = useState('');
  const [consoleErrors, setConsoleErrors] = useState(0);
  // 标注模式：开启后点击页面元素即可给它写评论（评论随下一条消息进入 Agent 上下文）。
  const [annotating, setAnnotating] = useState(false);
  const pendingAnnotations = useChatStore((s) => s.pendingAnnotations);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const urlRef = useRef('');

  const refreshNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanBack(wv.canGoBack());
      setCanForward(wv.canGoForward());
    } catch {
      /* webview not yet attached */
    }
  }, []);

  // Wire up webview events (Electron only).
  useEffect(() => {
    if (!isElectronEnv) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const onStart = () => {
      setLoading(true);
      setConsoleErrors(0);
    };
    const onStop = () => {
      setLoading(false);
      refreshNavState();
    };
    const onNav = (e: Electron.DidNavigateEvent) => {
      urlRef.current = e.url;
      setUrl(e.url);
      setInput(e.url);
      refreshNavState();
      setHistory((h) => recordHistory(h, e.url, title));
    };
    const onNavSub = (e: Electron.DidNavigateInPageEvent) => {
      if (e.isMainFrame) {
        urlRef.current = e.url;
        setUrl(e.url);
        setInput(e.url);
        setHistory((h) => recordHistory(h, e.url, title));
      }
    };
    const onTitle = (e: Electron.PageTitleUpdatedEvent) => {
      setTitle(e.title);
      if (urlRef.current) setHistory((h) => recordHistory(h, urlRef.current, e.title));
    };
    const onFail = (e: Electron.DidFailLoadEvent) => {
      if (e.errorCode === -3) return; // user-initiated abort
      console.warn('[PreviewBrowser] load failed:', e.errorCode, e.errorDescription);
      setLoading(false);
    };
    const onConsole = (e: Electron.ConsoleMessageEvent) => {
      // 0=verbose, 1=info, 2=warning, 3=error
      if (e.level >= 2) setConsoleErrors((n) => n + 1);
    };

    // 把这块 webview 登记为**可被 Agent 驱动**的浏览器目标（见 electron/browser-target.ts）。
    // 只有登记过的 webContents 才可寻址 —— 这是"Agent 只能驱动用户打开的预览"的落点。
    const registerTarget = () => {
      try {
        const id = wv.getWebContentsId();
        if (id > 0) void window.electronAPI?.browser?.register(id);
      } catch {
        /* webview 尚未就绪 */
      }
    };
    const unregisterTarget = () => {
      try {
        const id = wv.getWebContentsId();
        if (id > 0) void window.electronAPI?.browser?.unregister(id);
      } catch {
        /* 已经销毁 */
      }
    };
    wv.addEventListener('did-stop-loading', registerTarget);
    // 挂载即登记；面板关闭（卸载）时注销，避免留下失效句柄。
    registerTarget();

    // Agent 打开网页时，主进程已经导航过了；这里只负责把它切到前台。
    const offOpenRequest = window.electronAPI?.browser?.onOpenRequest?.(({ url: target }) => {
      useAppStore.getState().setRightPanelView('preview');
      if (target) wv.loadURL(target)?.catch(() => setLoading(false));
    });

    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNavSub);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('console-message', onConsole);

    return () => {
      unregisterTarget();
      offOpenRequest?.();
      wv.removeEventListener('did-stop-loading', registerTarget);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNavSub);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('console-message', onConsole);
    };
  }, [refreshNavState, title]);

  // 标注模式：用户点页面元素 → 生成一个尽量稳定的选择器，并把元素文本带回来。
  //
  // 单独一个 effect（只依赖 annotating）：它嵌在主 effect 里时，主 effect 每次因
  // title/refreshNavState 变化重跑都会重新武装一次页面侧的点击监听，而卸载中的那次
  // 无法回收 —— 页面里会留下多个监听器。页面脚本因此改成**自我替换**：新的一次会先
  // 摘掉上一次的监听器，重复武装也不会叠加。
  //
  // 整段逻辑必须跑在**页面上下文**里（渲染层的闭包传不进 webview），所以用
  // executeJavaScript 返回一个 Promise：页面侧只负责"等一次点击并回报元素"，
  // 评论由渲染层用 prompt 收集。注入的是只读脚本，不改页面。
  useEffect(() => {
    if (!isElectronEnv || !annotating) return;
    const wv = webviewRef.current;
    if (!wv) return;
    let cancelled = false;
    void wv
      .executeJavaScript(
        `new Promise((resolve) => {
           const build = (node) => {
             if (node.id) return '#' + node.id;
             const parts = [];
             let cur = node;
             while (cur && cur.tagName && parts.length < 4) {
               let part = cur.tagName.toLowerCase();
               const parent = cur.parentElement;
               if (parent) {
                 const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
                 if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
               }
               parts.unshift(part);
               cur = parent;
             }
             return parts.join(' > ');
           };
           const onClick = (e) => {
             e.preventDefault();
             e.stopPropagation();
             document.removeEventListener('click', window.__axAnnotateClick, true);
             window.__axAnnotateClick = null;
             const el = e.target;
             if (!el || !el.tagName) { resolve(null); return; }
             resolve({ selector: build(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').slice(0, 200) });
           };
           if (window.__axAnnotateClick) document.removeEventListener('click', window.__axAnnotateClick, true);
           window.__axAnnotateClick = onClick;
           document.addEventListener('click', onClick, true);
         })`,
        true,
      )
      .then((picked: { selector?: string; tag?: string; text?: string } | null) => {
        if (cancelled) return;
        setAnnotating(false);
        if (!picked?.selector) return;
        const shown = (picked.text || '').trim().slice(0, 40) || picked.tag || '';
        const comment = window.prompt(t('pb.annotatePrompt', { target: shown }));
        if (!comment?.trim()) return;
        useChatStore.getState().addPendingAnnotation({
          id: `annot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          url: urlRef.current || wv.getURL(),
          ...(title ? { title } : {}),
          selector: picked.selector,
          ...(picked.text ? { elementText: picked.text } : {}),
          ...(picked.tag ? { tag: picked.tag } : {}),
          comment: comment.trim(),
          ts: Date.now(),
        });
        useAppStore.getState().setRightPanelView('preview');
      })
      .catch(() => {
        if (!cancelled) setAnnotating(false);
      });
    return () => {
      cancelled = true;
    };
    // isElectronEnv 是模块级常量，不进依赖数组。
  }, [annotating, title, t]);

  // Iframe load events (browser fallback only).
  useEffect(() => {
    if (isElectronEnv) return;
    const f = iframeRef.current;
    if (!f) return;
    const onLoad = () => setLoading(false);
    const onError = () => setLoading(false);
    f.addEventListener('load', onLoad);
    f.addEventListener('error', onError);
    return () => {
      f.removeEventListener('load', onLoad);
      f.removeEventListener('error', onError);
    };
  }, [url]);

  const [warning, setWarning] = useState<string | null>(null);

  const navigate = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const next = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    if (wouldNestSelf(next)) {
      setWarning(t('pb.sameOrigin'));
      return;
    }
    setWarning(null);
    setLoading(true);
    setUrl(next);
    setInput(next);
    if (isElectronEnv) {
      webviewRef.current?.loadURL(next)?.catch(() => setLoading(false));
    } else if (iframeRef.current) {
      iframeRef.current.src = next;
    }
  };

  const hasContent = useMemo(() => !!url, [url]);

  const reload = () => {
    setLoading(true);
    if (isElectronEnv) webviewRef.current?.reload();
    else iframeRef.current?.contentWindow?.location.reload();
  };
  const goHome = () => navigate(HOME_URL);
  const back = () => webviewRef.current?.goBack();
  const forward = () => webviewRef.current?.goForward();
  const toggleDevTools = () => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (wv.isDevToolsOpened()) wv.closeDevTools();
    else wv.openDevTools();
  };

  const vp = VIEWPORT_SIZES[viewport];
  const frameStyle: React.CSSProperties = vp
    ? { width: vp.w, height: vp.h, margin: '12px auto', border: '1px solid var(--color-border-dim)', borderRadius: 6 }
    : { width: '100%', height: '100%', border: 0 };

  const suggestions = useMemo(() => {
    if (!historyOpen && !input.trim()) return [];
    const q = input.trim().toLowerCase();
    const list = q
      ? history.filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
      : history;
    return list.slice(0, 8);
  }, [input, history, historyOpen]);

  return (
    <div className="flex flex-col h-full w-full bg-[var(--color-bg-primary)] overflow-hidden">
      <div className="flex items-center px-3 py-2 gap-2 bg-bg-secondary border-b border-[var(--color-border-dim)] shrink-0">
        <Space size={2}>
          <Tooltip title={t('pb.back')}>
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              disabled={!isElectronEnv || !canBack}
              onClick={back}
            />
          </Tooltip>
          <Tooltip title={t('pb.forward')}>
            <Button
              type="text"
              size="small"
              icon={<ArrowRightOutlined />}
              disabled={!isElectronEnv || !canForward}
              onClick={forward}
            />
          </Tooltip>
          <Tooltip title={t('pb.reload')}>
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined className={loading ? 'ax-spin' : undefined} />}
              onClick={reload}
            />
          </Tooltip>
          <Tooltip title={t('pb.home')}>
            <Button type="text" size="small" icon={<HomeOutlined />} onClick={goHome} />
          </Tooltip>
        </Space>

        <div className="relative flex-1 ml-2">
          <Input
            size="small"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => navigate(input)}
            onFocus={() => setHistoryOpen(true)}
            onBlur={() => setTimeout(() => setHistoryOpen(false), 150)}
            placeholder={t('pb.urlPlaceholder')}
            style={{ width: '100%' }}
          />
          {suggestions.length > 0 && (
            <div className="absolute top-[calc(100%+4px)] left-0 right-0 z-20 bg-bg-elevated rounded-lg border border-border-dim shadow-md overflow-hidden">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--color-border-dim)]">
                <span className="text-2xs text-text-muted">{t('pb.history')}</span>
                <button
                  type="button"
                  className="text-2xs text-text-muted hover:text-text-secondary cursor-pointer"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setHistory([]);
                    saveHistory([]);
                    message.info(t('pb.historyCleared'));
                  }}
                >
                  {t('pb.clear')}
                </button>
              </div>
              {suggestions.map((h) => (
                <button
                  key={h.url}
                  type="button"
                  className="flex items-center gap-2 w-full px-2 py-2 text-left text-xs hover:bg-[var(--color-hover)] cursor-pointer"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(h.url);
                    setHistoryOpen(false);
                    navigate(h.url);
                  }}
                >
                  <ClockOutlined size={12} className="text-text-muted shrink-0" />
                  <span className="truncate text-text-secondary flex-1">{h.title || h.url}</span>
                  <span className="text-2xs text-text-muted truncate max-w-[180px]">{h.url}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Space size={2} style={{ marginLeft: 8 }}>
          <Tooltip title={t('pb.desktop')}>
            <Button
              type={viewport === 'desktop' ? 'primary' : 'text'}
              size="small"
              icon={<DesktopOutlined />}
              onClick={() => setViewport('desktop')}
            />
          </Tooltip>
          <Tooltip title={t('pb.tablet')}>
            <Button
              type={viewport === 'tablet' ? 'primary' : 'text'}
              size="small"
              icon={<TabletOutlined />}
              onClick={() => setViewport('tablet')}
            />
          </Tooltip>
          <Tooltip title={t('pb.phone')}>
            <Button
              type={viewport === 'mobile' ? 'primary' : 'text'}
              size="small"
              icon={<MobileOutlined />}
              onClick={() => setViewport('mobile')}
            />
          </Tooltip>
          {isElectronEnv && hasContent && (
            <Tooltip title={annotating ? t('pb.annotateOn') : t('pb.annotate')}>
              <Button
                type={annotating ? 'primary' : 'text'}
                size="small"
                icon={<CursorClickOutlined />}
                onClick={() => setAnnotating((v) => !v)}
              />
            </Tooltip>
          )}
          {isElectronEnv && (
            <Tooltip title={t('pb.consoleErrors', { n: consoleErrors })}>
              <Badge count={consoleErrors} size="small" offset={[-2, 4]}>
                <Button type="text" size="small" icon={<BugOutlined />} onClick={toggleDevTools} />
              </Badge>
            </Tooltip>
          )}
        </Space>
      </div>

      {pendingAnnotations.length > 0 && (
        <div className="flex flex-col gap-0.5 px-2 py-1.5 border-b border-border-dim" data-pending-annotations>
          <span className="text-2xs text-text-muted">
            {t('pb.pendingAnnotations', { n: pendingAnnotations.length })}
          </span>
          {pendingAnnotations.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 text-2xs text-text-secondary min-w-0">
              <span className="truncate">
                {annotationLabel(a)} · {a.comment}
              </span>
              <button
                type="button"
                className="ax-tool-row-link shrink-0"
                aria-label={t('pb.removeAnnotation')}
                onClick={() => useChatStore.getState().removePendingAnnotation(a.id)}
              >
                <CloseOutlined size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 relative overflow-auto bg-bg-secondary flex items-stretch justify-center">
        {!hasContent ? (
          <div className="w-full flex items-center justify-center p-8">
            <div className="flex flex-col items-center justify-center gap-1.5 text-center">
              <span className="text-text-faint [&_svg]:w-5 [&_svg]:h-5">
                <Tray size={20} />
              </span>
              <div className="text-xs text-text-muted">{warning ?? t('pb.startHint')}</div>
              {!warning && <div className="text-xs text-text-faint">{t('pb.examples')}</div>}
            </div>
          </div>
        ) : isElectronEnv ? (
          <webview
            ref={webviewRef as unknown as React.RefObject<HTMLElement>}
            src={url}
            partition="persist:auraxis-preview"
            allowpopups
            useragent="Auraxis/2.0 (Electron Preview)"
            style={frameStyle}
          />
        ) : (
          <iframe
            ref={iframeRef}
            title={`Preview Browser - ${tabId}`}
            src={url}
            style={frameStyle}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
          />
        )}
      </div>

      {title && (
        <div className="flex items-center px-3 py-1 text-xs text-text-faint bg-bg-secondary border-t border-[var(--color-border-dim)] whitespace-nowrap overflow-hidden text-ellipsis shrink-0">
          {title} · {url}
        </div>
      )}
    </div>
  );
}
