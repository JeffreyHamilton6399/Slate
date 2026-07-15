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
import { AudioEditorPanel } from './AudioEditorPanel';
import { AudioAssetsPanel } from './AudioAssetsPanel';

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
  // Members panel retired — the People widget covers roster + voice + host controls.
  // Audio settings — left dock panel for audio-mode boards (track/clip properties).
  registerPanel({
    id: 'audio-settings',
    title: 'Audio Settings',
    defaultSide: 'left',
    render: AudioAssetsPanel,
    order: 0,
    mode: 'audio',
  });
  // Audio assets — right dock panel for audio-mode boards.
  registerPanel({
    id: 'audio-assets',
    title: 'Audio Assets',
    defaultSide: 'right',
    render: AudioAssetsPanel,
    order: 0,
    mode: 'audio',
  });
}
