/**
 * terminalCommands — the command engine behind CodeTerminalPanel.
 *
 * Slate has no server-side shell; the "terminal" is a UI affordance that runs
 * file operations directly against the shared Yjs doc (the same `code:files`
 * map the editor and AI assistant use). Every mutation goes through the
 * shared helpers in codeFiles.ts so a `touch` here is identical to a
 * right-click → "New file" in the Files panel — peers see the same change,
 * and Yjs undo rolls it back.
 *
 * The engine is pure: it takes the doc + raw input string and returns a
 * TerminalResult (output text + optional side-effect flags). The React
 * component owns the input/prompt/history UI and interprets the flags
 * (`clear` empties the log; `refreshPreview` dispatches a window event the
 * CodeEditor's split-view preview and the dockable CodePreviewPanel both
 * listen for).
 */

import type { SlateDoc } from '../sync/doc';
import { listCodeFiles } from './exportCode';
import {
  listCodeFolders,
  normalizePath,
  upsertCodeFile,
  createCodeFolder,
  deleteCodePath,
  renameCodePath,
  readCodeFileText,
  findFileId,
} from './codeFiles';

export interface TerminalResult {
  output: string;
  /** Empty the terminal log (the `clear` command). */
  clear?: boolean;
  /** Ask the host to rebuild the preview iframe (the `run` command). */
  refreshPreview?: boolean;
}

/** Entry point: parse the raw input line and dispatch to a command handler. */
export function runTerminalCommand(slate: SlateDoc, rawInput: string): TerminalResult {
  const input = rawInput.trim();
  if (!input) return { output: '' };

  const parts = input.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  switch (cmd) {
    case 'ls':
      return cmdList(slate, args);
    case 'cat':
      return cmdCat(slate, args);
    case 'touch':
      return cmdTouch(slate, args);
    case 'mkdir':
      return cmdMkdir(slate, args);
    case 'rm':
      return cmdRm(slate, args);
    case 'mv':
      return cmdMv(slate, args);
    case 'write':
      return cmdWrite(slate, args, rawInput);
    case 'echo':
      return cmdEcho(args, rawInput);
    case 'run':
      return { output: 'Refreshing preview…', refreshPreview: true };
    case 'clear':
      return { output: '', clear: true };
    case 'pwd':
      return { output: '/' };
    case 'help':
      return cmdHelp();
    default:
      return {
        output: `Command not found: ${cmd}. Type 'help' for available commands.`,
      };
  }
}

/* ----------------------------- commands ------------------------------ */

/** `ls [path]` — list the direct children of a directory.
 *  No arg → top level. A path arg → that folder's immediate children.
 *  Files show their size in chars; folders are suffixed with `/`. */
function cmdList(slate: SlateDoc, args: string[]): TerminalResult {
  const target = args[0] ? normalizePath(args[0]) : '';
  const prefix = target ? `${target}/` : '';

  // Direct child paths: strip the prefix, keep only one path segment deeper.
  const files = listCodeFiles(slate);
  const folders = listCodeFolders(slate);

  type Entry = { name: string; isDir: boolean; size?: number };
  const seen = new Set<string>();
  const entries: Entry[] = [];

  const pushChild = (name: string, isDir: boolean, size?: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, isDir, size });
  };

  for (const f of files) {
    if (prefix) {
      if (!f.name.startsWith(prefix)) continue;
      const rest = f.name.slice(prefix.length);
      if (!rest) continue;
      if (rest.includes('/')) {
        // nested under a sub-folder — show the sub-folder, not the leaf
        pushChild(rest.split('/')[0]!, true);
      } else {
        pushChild(rest, false, f.id ? slate.codeText(f.id).toString().length : 0);
      }
    } else {
      if (f.name.includes('/')) {
        pushChild(f.name.split('/')[0]!, true);
      } else {
        pushChild(f.name, false, slate.codeText(f.id).toString().length);
      }
    }
  }

  for (const folder of folders) {
    if (prefix) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      if (!rest) continue;
      pushChild(rest.includes('/') ? rest.split('/')[0]! : rest, true);
    } else {
      pushChild(folder.includes('/') ? folder.split('/')[0]! : folder, true);
    }
  }

  if (entries.length === 0) {
    return { output: target ? `ls: ${target}: empty` : '(no files — try `touch index.html`)' };
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const lines = entries.map((e) => {
    if (e.isDir) return `${e.name}/`;
    return `${e.name}\t${e.size ?? 0}b`;
  });
  return { output: lines.join('\n') };
}

/** `cat <path>` — print a file's contents. Errors on missing files or
 *  attempts to cat a folder. */
function cmdCat(slate: SlateDoc, args: string[]): TerminalResult {
  if (!args[0]) return { output: 'usage: cat <path>' };
  const path = normalizePath(args[0]);
  const text = readCodeFileText(slate, path);
  if (text === null) {
    // Could be a folder or a missing path.
    if (listCodeFolders(slate).includes(path)) {
      return { output: `cat: ${path}: Is a directory` };
    }
    return { output: `cat: ${path}: No such file` };
  }
  if (text.length === 0) return { output: '' };
  return { output: text };
}

/** `touch <path>` — create an empty file if it doesn't exist. No-op (and
 *  reports as such) if the file already exists, matching the shell. */
function cmdTouch(slate: SlateDoc, args: string[]): TerminalResult {
  if (!args[0]) return { output: 'usage: touch <path>' };
  const path = normalizePath(args[0]);
  if (findFileId(slate, path)) {
    return { output: '' }; // touch on an existing file is a no-op
  }
  if (listCodeFolders(slate).includes(path)) {
    return { output: `touch: ${path}: Is a directory` };
  }
  upsertCodeFile(slate, path, '');
  return { output: `created ${path}` };
}

/** `mkdir <path>` — create an explicit (possibly empty) folder. */
function cmdMkdir(slate: SlateDoc, args: string[]): TerminalResult {
  if (!args[0]) return { output: 'usage: mkdir <path>' };
  const path = normalizePath(args[0]);
  if (findFileId(slate, path)) {
    return { output: `mkdir: ${path}: File exists` };
  }
  if (listCodeFolders(slate).includes(path)) {
    return { output: '' }; // already exists, no-op like the shell
  }
  createCodeFolder(slate, path);
  return { output: `created directory ${path}/` };
}

/** `rm <path>` — delete a file or folder (and its whole subtree). No -rf
 *  flag needed: this is a creative tool, so rm is always recursive. */
function cmdRm(slate: SlateDoc, args: string[]): TerminalResult {
  if (!args[0]) return { output: 'usage: rm <path>' };
  const path = normalizePath(args[0]);
  const existed =
    findFileId(slate, path) !== null ||
    listCodeFolders(slate).includes(path) ||
    listCodeFiles(slate).some((f) => f.name.startsWith(`${path}/`));
  if (!existed) {
    return { output: `rm: ${path}: No such file or directory` };
  }
  deleteCodePath(slate, path);
  return { output: `removed ${path}` };
}

/** `mv <old> <new>` — rename or move a file/folder (and its subtree). */
function cmdMv(slate: SlateDoc, args: string[]): TerminalResult {
  if (args.length < 2) return { output: 'usage: mv <old> <new>' };
  const oldPath = normalizePath(args[0]!);
  const newPath = normalizePath(args[1]!);
  const existed =
    findFileId(slate, oldPath) !== null ||
    listCodeFolders(slate).includes(oldPath) ||
    listCodeFiles(slate).some((f) => f.name.startsWith(`${oldPath}/`));
  if (!existed) {
    return { output: `mv: ${oldPath}: No such file or directory` };
  }
  // Refuse to overwrite an existing leaf file silently — shell `mv` would
  // clobber, but in a collaborative editor a silent overwrite is a foot-gun.
  if (findFileId(slate, newPath)) {
    return { output: `mv: ${newPath}: File exists (will not overwrite)` };
  }
  renameCodePath(slate, oldPath, newPath);
  return { output: `moved ${oldPath} → ${newPath}` };
}

/** `write <path> <content...>` — write text to a file (creates or
 *  overwrites). The content is everything after the path token in the raw
 *  input, so spaces and quotes are preserved as-typed. */
function cmdWrite(slate: SlateDoc, args: string[], rawInput: string): TerminalResult {
  if (!args[0]) return { output: 'usage: write <path> <content...>' };
  const path = normalizePath(args[0]!);
  if (listCodeFolders(slate).includes(path)) {
    return { output: `write: ${path}: Is a directory` };
  }
  // Re-derive the content from the raw input so quoted/multi-word text is
  // preserved verbatim. Tokens: "write", "<path>", "<content…>".
  const afterCmd = rawInput.replace(/^\s*write\s+/i, '');
  // afterCmd now starts at the path token; drop the path token + one space.
  const pathToken = args[0]!;
  const pathIdx = afterCmd.indexOf(pathToken);
  const content =
    pathIdx >= 0 ? afterCmd.slice(pathIdx + pathToken.length).replace(/^\s/, '') : args.slice(1).join(' ');

  const existed = findFileId(slate, path) !== null;
  upsertCodeFile(slate, path, content);
  return { output: `${existed ? 'overwrote' : 'created'} ${path} (${content.length} bytes)` };
}

/** `echo <text...>` — print the text. Quotes are NOT stripped (kept simple);
 *  the raw text after `echo ` is echoed verbatim. */
function cmdEcho(args: string[], rawInput: string): TerminalResult {
  if (args.length === 0) return { output: '' };
  const afterCmd = rawInput.replace(/^\s*echo\s+/i, '');
  return { output: afterCmd };
}

/** `help` — list every command with a one-line description. */
function cmdHelp(): TerminalResult {
  const lines = [
    'available commands:',
    '  ls [path]         list files in a directory (default: /)',
    '  cat <path>        print a file’s contents',
    '  touch <path>      create an empty file',
    '  mkdir <path>      create a folder',
    '  rm <path>         delete a file or folder (recursive)',
    '  mv <old> <new>    rename or move a file/folder',
    '  write <p> <text>  write text to a file (creates or overwrites)',
    '  echo <text>       print text',
    '  run               refresh the live preview',
    '  clear             clear the terminal',
    '  pwd               print working directory (always /)',
    '  help              show this help',
    '',
    'tip: ↑/↓ cycles command history; Enter runs the line.',
  ];
  return { output: lines.join('\n') };
}
