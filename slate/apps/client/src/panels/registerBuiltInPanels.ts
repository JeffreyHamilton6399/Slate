/**
 * Registers all built-in panels at module import time. Add new panels here.
 *
 * Heavy panels (3D Properties / Hierarchy) are still lightweight to import
 * because they only attach a React component reference; the component itself
 * is lazy-rendered only when its tab is opened.
 */

import { registerPanel } from '../workspace/panelRegistry';
import { ChatPanel } from './ChatPanel';
import { NotesPanel } from './NotesPanel';
import { BoardsPanel } from './BoardsPanel';
import { LayersPanel } from './LayersPanel';
import { HierarchyPanel } from './HierarchyPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { AssetsPanel } from './AssetsPanel';
import { ToolsPanel } from './ToolsPanel';
import { AudioAssetsPanel } from './AudioAssetsPanel';
import { AudioSettingsPanel } from './AudioSettingsPanel';
import { InstrumentPanel } from './InstrumentPanel';
import { FriendsPanel } from './FriendsPanel';
import { DocOutlinePanel } from './DocOutlinePanel';
import { DocToolsPanel } from './DocToolsPanel';
import { CodeFilesPanel } from './CodeFilesPanel';
import { CodePreviewPanel } from './CodePreviewPanel';
import { CodeTerminalPanel } from './CodeTerminalPanel';
import { AiChatPanel } from './AiChatPanel';

let registered = false;

export function registerBuiltInPanels(): void {
  if (registered) return;
  registered = true;

  // Boards is reference material — it lives bottom-right with Chat/Notes,
  // leaving the left dock for scene structure (Hierarchy/Layers + Assets).
  registerPanel({
    id: 'boards',
    title: 'Boards',
    defaultSide: 'right-bottom',
    render: BoardsPanel,
    order: 0,
    mode: 'both',
  });
  registerPanel({
    id: 'hierarchy',
    title: 'Hierarchy',
    defaultSide: 'left',
    render: HierarchyPanel,
    order: 10,
    mode: '3d',
  });
  registerPanel({
    id: 'layers',
    title: 'Layers',
    defaultSide: 'left-bottom',
    render: LayersPanel,
    order: 0,
    mode: '2d',
  });
  registerPanel({
    id: 'props',
    title: 'Properties',
    defaultSide: 'right',
    render: PropertiesPanel,
    order: 1,
    mode: '3d',
  });
  // Full tool list with names + shortcuts — top-right, 2D boards only.
  registerPanel({
    id: 'tools2d',
    title: 'Tools',
    defaultSide: 'right',
    render: ToolsPanel,
    order: 1,
    mode: '2d',
  });
  // Curated asset library for 3D boards — bottom-left under the hierarchy.
  registerPanel({
    id: 'assets',
    title: 'Assets',
    defaultSide: 'left-bottom',
    render: AssetsPanel,
    order: 9,
    mode: '3d',
  });
  // Chat and Notes are useful but secondary — they live in the bottom zone
  // so Properties/Layers stay visible while they're open.
  registerPanel({
    id: 'chat',
    title: 'Chat',
    defaultSide: 'right-bottom',
    render: ChatPanel,
    order: 10,
    mode: 'both',
  });
  registerPanel({
    id: 'notes',
    title: 'Notes',
    defaultSide: 'right-bottom',
    render: NotesPanel,
    order: 11,
    mode: 'both',
  });
  // Friends — bottom-right tab: roster + online status + invite to this board.
  registerPanel({
    id: 'friends',
    title: 'Friends',
    defaultSide: 'right-bottom',
    render: FriendsPanel,
    order: 12,
    mode: 'both',
  });
  // Members panel retired — the People widget covers roster + voice + host controls.
  // Audio settings — left dock panel (clip/track properties + import).
  registerPanel({
    id: 'audio-settings',
    title: 'Audio Settings',
    defaultSide: 'left',
    render: AudioSettingsPanel,
    order: 0,
    mode: 'audio',
  });
  // Audio assets — right dock panel.
  registerPanel({
    id: 'audio-assets',
    title: 'Audio Assets',
    defaultSide: 'right',
    render: AudioAssetsPanel,
    order: 0,
    mode: 'audio',
  });
  // Instrument — playable/customizable synth keyboard (piano etc.) that
  // records takes into audio clips. Docks in the left zone as a tab next to
  // Audio Settings (registered just after it so it lands to its right).
  registerPanel({
    id: 'instrument',
    title: 'Instrument',
    defaultSide: 'left',
    render: InstrumentPanel,
    order: 1,
    mode: 'audio',
  });
  // Doc Tools — the 2D-style left "bar" for writing: quick structure/insert
  // actions. Top-left default so it's the first thing on the left.
  registerPanel({
    id: 'doc-tools',
    title: 'Tools',
    defaultSide: 'left',
    render: DocToolsPanel,
    order: 0,
    mode: 'doc',
  });
  // Doc Outline — table of contents from the doc's headings. Bottom-left, under
  // the Tools bar (mirrors 2D's tools-over-layers left column).
  registerPanel({
    id: 'doc-outline',
    title: 'Outline',
    defaultSide: 'left-bottom',
    render: DocOutlinePanel,
    order: 0,
    mode: 'doc',
  });
  // Code Files (single browser — the editor's own rail was removed) on the
  // RIGHT, Preview under it; the AI assistant takes the LEFT (chat-left /
  // editor-center / files+preview-right, bolt/Z.ai style).
  registerPanel({ id: 'code-files', title: 'Files', defaultSide: 'right', render: CodeFilesPanel, order: 0, mode: 'code' });
  registerPanel({ id: 'code-preview', title: 'Preview', defaultSide: 'right-bottom', render: CodePreviewPanel, order: 1, mode: 'code' });
  // Code Terminal — streams the live preview's console output. Right-bottom
  // with Preview so runtime logs sit beside what produced them.
  registerPanel({ id: 'code-terminal', title: 'Terminal', defaultSide: 'right-bottom', render: CodeTerminalPanel, order: 2, mode: 'code' });

  // AI Assistant is registered PER MODE: a panel's dock spot is global to its
  // id, so one shared 'both' panel can't be left in code AND right elsewhere.
  registerPanel({ id: 'ai-code', title: 'AI Assistant', defaultSide: 'left', render: AiChatPanel, order: 2, mode: 'code' });
  registerPanel({ id: 'ai-2d', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: '2d' });
  registerPanel({ id: 'ai-3d', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: '3d' });
  registerPanel({ id: 'ai-doc', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: 'doc' });
  // Audio: Audio Assets stays the top-right default; the AI goes bottom-right.
  registerPanel({ id: 'ai-audio', title: 'AI Assistant', defaultSide: 'right-bottom', render: AiChatPanel, order: 3, mode: 'audio' });
}
