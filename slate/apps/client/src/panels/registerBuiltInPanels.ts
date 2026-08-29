/**
 * Registers all built-in panels at module import time. Add new panels here.
 *
 * MODE-SPECIFIC panels are registered as React.lazy components. This file runs
 * at app start, so a plain `import` of a panel pulls its ENTIRE module graph
 * into the main bundle — the Instrument panel alone dragged in the synth
 * engine and the GM sample tables, which someone opening a document has no use
 * for. Registering a lazy component still attaches only a component reference
 * (what the old comment here claimed a static import did), and RenderPanel's
 * Suspense boundary shows a one-line fallback while the chunk arrives.
 *
 * The four 'both' panels (Boards / Chat / Notes / Friends) stay static: they
 * are docked in every mode, so deferring them would only add a flash.
 */

import { lazy, type ComponentType } from 'react';
import { registerPanel } from '../workspace/panelRegistry';
import { ChatPanel } from './ChatPanel';
import { NotesPanel } from './NotesPanel';
import { BoardsPanel } from './BoardsPanel';
import { FriendsPanel } from './FriendsPanel';

/** Register a named export from a module as a lazily-loaded panel component. */
function lazyPanel<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): ComponentType {
  // Annotate `default` explicitly: without it React infers the lazy component's
  // props from the generic and the result stops matching PanelDef.render.
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

const LayersPanel = lazyPanel(() => import('./LayersPanel'), 'LayersPanel');
const HierarchyPanel = lazyPanel(() => import('./HierarchyPanel'), 'HierarchyPanel');
const PropertiesPanel = lazyPanel(() => import('./PropertiesPanel'), 'PropertiesPanel');
const AssetsPanel = lazyPanel(() => import('./AssetsPanel'), 'AssetsPanel');
const ToolsPanel = lazyPanel(() => import('./ToolsPanel'), 'ToolsPanel');
const AudioAssetsPanel = lazyPanel(() => import('./AudioAssetsPanel'), 'AudioAssetsPanel');
const AudioSettingsPanel = lazyPanel(() => import('./AudioSettingsPanel'), 'AudioSettingsPanel');
const InstrumentPanel = lazyPanel(() => import('./InstrumentPanel'), 'InstrumentPanel');
const DocOutlinePanel = lazyPanel(() => import('./DocOutlinePanel'), 'DocOutlinePanel');
const DocToolsPanel = lazyPanel(() => import('./DocToolsPanel'), 'DocToolsPanel');
const CodeFilesPanel = lazyPanel(() => import('./CodeFilesPanel'), 'CodeFilesPanel');
const CodePreviewPanel = lazyPanel(() => import('./CodePreviewPanel'), 'CodePreviewPanel');
const DiagramToolsPanel = lazyPanel(() => import('./DiagramToolsPanel'), 'DiagramToolsPanel');
const SlideLayoutPanel = lazyPanel(() => import('./SlideLayoutPanel'), 'SlideLayoutPanel');
const AiChatPanel = lazyPanel(() => import('./AiChatPanel'), 'AiChatPanel');

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
  // Audio assets — left dock tab, FIRST in the left zone so the MobileDrawer
  // opens directly to it on phones (sample/loop browser is the most-tapped
  // audio entry point). Desktop docks it at the top of the left rail, above
  // Audio Settings + Instrument.
  registerPanel({
    id: 'audio-assets',
    title: 'Audio Assets',
    defaultSide: 'left',
    render: AudioAssetsPanel,
    order: 0,
    mode: 'audio',
  });
  // Audio settings — left dock tab. Registered AFTER Audio Assets so the
  // initial tab order on the left zone (which drives the MobileDrawer tab
  // order) lands Audio Assets first; clip/track properties + import live here.
  registerPanel({
    id: 'audio-settings',
    title: 'Audio Settings',
    defaultSide: 'left',
    render: AudioSettingsPanel,
    order: 1,
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
    order: 2,
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
  // Diagram — the tools + node-style palette lands top-left (mirrors 2D Tools).
  registerPanel({ id: 'diagram-tools', title: 'Tools', defaultSide: 'left', render: DiagramToolsPanel, order: 0, mode: 'diagram' });
  // Terminal is NOT a dockable panel — it lives as a bottom strip inside the
  // CodeEditor (toggle in the editor toolbar), VS Code / bolt style.

  // Presentation: the tools palette (slide ops, text formatting, design,
  // actions) lives top-left in the left dock — mirrors the doc/diagram layout.
  // The AI assistant keeps its right-dock spot from the registration below.
  registerPanel({
    id: 'presentation-tools',
    title: 'Tools',
    defaultSide: 'left',
    render: SlideLayoutPanel,
    order: 0,
    mode: 'presentation',
  });
  // AI Assistant is registered PER MODE: a panel's dock spot is global to its
  // id, so one shared 'both' panel can't be left in code AND right elsewhere.
  registerPanel({ id: 'ai-code', title: 'AI Assistant', defaultSide: 'left', render: AiChatPanel, order: 2, mode: 'code' });
  registerPanel({ id: 'ai-2d', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: '2d' });
  registerPanel({ id: 'ai-3d', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: '3d' });
  registerPanel({ id: 'ai-doc', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: 'doc' });
  registerPanel({ id: 'ai-diagram', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: 'diagram' });
  // Presentation AI assistant — right dock, same as the other writing modes.
  registerPanel({ id: 'ai-presentation', title: 'AI Assistant', defaultSide: 'right', render: AiChatPanel, order: 3, mode: 'presentation' });
  // Audio: Audio Assets lives top-left (above Audio Settings + Instrument);
  // the AI assistant goes bottom-right so it never crowds the dock tabs.
  registerPanel({ id: 'ai-audio', title: 'AI Assistant', defaultSide: 'right-bottom', render: AiChatPanel, order: 3, mode: 'audio' });
}
