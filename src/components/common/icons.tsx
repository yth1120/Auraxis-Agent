/**
 * Icon layer: Lucide-based components exposed under the legacy Phosphor names
 * used across the app, so one import rewrite migrates everything.
 * `weight` is translated to Lucide `strokeWidth`; `size`/`className` pass through.
 */
import { createContext, createElement, useContext } from 'react';
import type { SVGProps } from 'react';
import * as L from 'lucide-react';

export const IconContext = createContext<{ size?: number | string; strokeWidth?: number }>({
  size: '1em',
  strokeWidth: 1.5,
});

type IconProps = {
  size?: number | string;
  weight?: 'regular' | 'bold' | 'fill' | 'light' | 'thin' | 'duotone';
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, 'size' | 'className'>;

function makeIcon(C: typeof L.X) {
  return ({ size, weight, className, ...rest }: IconProps) => {
    const ctx = useContext(IconContext);
    const strokeWidth = weight === 'bold' ? 1.75 : weight === 'fill' ? 2 : ctx.strokeWidth;
    return createElement(C as never, {
      size: size ?? ctx.size,
      className,
      strokeWidth,
      ...rest,
    });
  };
}

export const Archive = makeIcon(L.Archive);
export const ArrowClockwise = makeIcon(L.RotateCw);
export const ArrowLeft = makeIcon(L.ArrowLeft);
export const ArrowRight = makeIcon(L.ArrowRight);
export const ArrowSquareOut = makeIcon(L.SquareArrowOutUpRight);
export const ArrowsClockwise = makeIcon(L.RefreshCw);
export const ArrowsOut = makeIcon(L.Maximize2);
export const ArrowUp = makeIcon(L.ArrowUp);
export const ArrowUpRight = makeIcon(L.ArrowUpRight);
export const ArrowUUpLeft = makeIcon(L.Undo2);
export const Bell = makeIcon(L.Bell);
export const Blocks = makeIcon(L.Blocks);
export const BookmarkSimple = makeIcon(L.Bookmark);
export const Brain = makeIcon(L.Brain);
export const Browser = makeIcon(L.Globe2);
export const Bug = makeIcon(L.Bug);
export const CalendarCheck = makeIcon(L.CalendarCheck);
export const CaretDown = makeIcon(L.ChevronDown);
export const CaretRight = makeIcon(L.ChevronRight);
export const CaretUp = makeIcon(L.ChevronUp);
export const ChartBar = makeIcon(L.BarChart3);
export const ChatCircle = makeIcon(L.MessageCircle);
export const ChatTeardropDots = makeIcon(L.MessageSquare);
export const Check = makeIcon(L.Check);
export const CheckCircle = makeIcon(L.CircleCheck);
export const ClipboardCheck = makeIcon(L.ClipboardCheck);
export const Circle = makeIcon(L.Circle);
export const CircleNotch = makeIcon(L.LoaderCircle);
export const ClipboardText = makeIcon(L.ClipboardType);
export const Clock = makeIcon(L.Clock);
export const ClockCounterClockwise = makeIcon(L.History);
export const Code = makeIcon(L.Code);
export const Copy = makeIcon(L.Copy);
export const Cube = makeIcon(L.Box);
export const Desktop = makeIcon(L.Monitor);
export const DeviceMobile = makeIcon(L.Smartphone);
export const DeviceTablet = makeIcon(L.Tablet);
export const DownloadSimple = makeIcon(L.Download);
export const Eraser = makeIcon(L.Eraser);
export const Export = makeIcon(L.FileDown);
export const ExternalLink = makeIcon(L.ExternalLink);
export const Eye = makeIcon(L.Eye);
export const File = makeIcon(L.File);
export const FileCode = makeIcon(L.FileCode);
export const FileImage = makeIcon(L.FileImage);
export const FilePlus = makeIcon(L.FilePlus);
export const FileText = makeIcon(L.FileText);
export const Flask = makeIcon(L.FlaskConical);
export const Folder = makeIcon(L.Folder);
export const FolderOpen = makeIcon(L.FolderOpen);
export const FolderPlus = makeIcon(L.FolderPlus);
export const Gauge = makeIcon(L.Gauge);
export const GearSix = makeIcon(L.Settings);
export const GitBranch = makeIcon(L.GitBranch);
export const GitDiff = makeIcon(L.GitCompare);
export const GitFork = makeIcon(L.GitFork);
export const GitMerge = makeIcon(L.GitMerge);
export const Globe = makeIcon(L.Globe);
export const GlobeHemisphereWest = makeIcon(L.Globe);
export const House = makeIcon(L.Home);
export const Image = makeIcon(L.Image);
export const ThumbsUp = makeIcon(L.ThumbsUp);
export const ThumbsDown = makeIcon(L.ThumbsDown);
export const Info = makeIcon(L.Info);
export const Key = makeIcon(L.Key);
export const Keyboard = makeIcon(L.Keyboard);
export const Layout = makeIcon(L.LayoutDashboard);
export const Lightbulb = makeIcon(L.Lightbulb);
export const Lightning = makeIcon(L.Zap);
export const Link = makeIcon(L.Link);
export const LinkBreak = makeIcon(L.Link2Off);
export const ListChecks = makeIcon(L.ListChecks);
export const MagnifyingGlass = makeIcon(L.Search);
export const MapPin = makeIcon(L.MapPin);
export const Microphone = makeIcon(L.Mic);
export const MenuIcon = makeIcon(L.Menu);
export const Minus = makeIcon(L.Minus);
export const MoreHorizontal = makeIcon(L.Ellipsis);
export const Coins = makeIcon(L.Coins);
export const MinusCircle = makeIcon(L.CircleMinus);
export const PaintBrush = makeIcon(L.Paintbrush);
export const Paperclip = makeIcon(L.Paperclip);
export const PanelBottom = makeIcon(L.PanelBottom);
export const PanelRight = makeIcon(L.PanelRight);
export const Pause = makeIcon(L.Pause);
export const PauseCircle = makeIcon(L.CirclePause);
export const PencilSimple = makeIcon(L.Pencil);
export const Percent = makeIcon(L.Percent);
export const Play = makeIcon(L.Play);
export const PlayCircle = makeIcon(L.CirclePlay);
export const Plugs = makeIcon(L.Plug);
export const PlugsConnected = makeIcon(L.PlugZap);
export const Plus = makeIcon(L.Plus);
export const PlusCircle = makeIcon(L.CirclePlus);
export const PuzzlePiece = makeIcon(L.Puzzle);
export const Question = makeIcon(L.CircleHelp);
export const RotateCcw = makeIcon(L.RotateCcw);
export const ShieldCheck = makeIcon(L.ShieldCheck);
export const SignOut = makeIcon(L.LogOut);
export const SidebarSimple = makeIcon(L.PanelLeft);
export const SlidersHorizontal = makeIcon(L.SlidersHorizontal);
export const Square = makeIcon(L.Square);
export const SquarePlus = makeIcon(L.SquarePlus);
export const SquaresFour = makeIcon(L.LayoutGrid);
export const Stack = makeIcon(L.Layers);
export const Star = makeIcon(L.Star);
export const Stop = makeIcon(L.Square);
export const Target = makeIcon(L.Target);
export const Terminal = makeIcon(L.Terminal);
export const TerminalWindow = makeIcon(L.SquareTerminal);
export const Toolbox = makeIcon(L.Toolbox);
export const Trash = makeIcon(L.Trash2);
export const Tray = makeIcon(L.Inbox);
export const TreeStructure = makeIcon(L.Network);
export const Waypoints = makeIcon(L.Waypoints);
export const Warning = makeIcon(L.TriangleAlert);
export const WarningCircle = makeIcon(L.CircleAlert);
export const Wrench = makeIcon(L.Wrench);
export const X = makeIcon(L.X);
export const XCircle = makeIcon(L.CircleX);
export const MessageCirclePlus = makeIcon(L.MessageCirclePlus);

// Shared action icons — sidebar, collapsed header and tab bar all reference
// these constants so they can never drift apart.
export const NEW_CHAT_ICON = <MessageCirclePlus />;
export const NEW_TASK_ICON = <SquarePlus />;
