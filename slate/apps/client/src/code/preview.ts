/**
 * Build a self-contained preview document from a code board's files, for
 * rendering in a sandboxed <iframe srcdoc>. No bundler: we take an entry HTML
 * file and inline any LOCAL `<link rel=stylesheet>` / `<script src>` by
 * resolving their paths against the other files on the board. External URLs
 * (http/https/protocol-relative/data:) are left untouched.
 *
 * With no HTML but a single script, we wrap it in a minimal page that runs the
 * script and mirrors console output onto the page — enough for "hello world"
 * style snippets. Anything with bare module imports won't resolve (there's no
 * bundler), which is an accepted limitation of a zero-build preview.
 */

export interface PreviewFile {
  name: string;
  content: string;
}

export interface PreviewResult {
  html: string | null;
  /** Why there's no preview (shown to the user) when html is null. */
  reason?: string;
  /** The entry file used, for the panel's status line. */
  entry?: string;
}

const isExternal = (url: string): boolean =>
  /^([a-z][a-z0-9+.-]*:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('#');

/** Resolve a relative href/src against the entry file's directory. */
function resolvePath(entryPath: string, rel: string): string {
  const clean = rel.split(/[?#]/)[0] ?? '';
  const baseDir = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
  const stack = clean.startsWith('/') ? [] : baseDir ? baseDir.split('/') : [];
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

export function buildPreview(files: PreviewFile[]): PreviewResult {
  if (files.length === 0) return { html: null, reason: 'No files yet — add an index.html to see a live preview.' };

  const byPath = new Map(files.map((f) => [f.name.replace(/\\/g, '/'), f.content]));

  // Pick an entry HTML: prefer index.html, then the shallowest .html file.
  const htmlFiles = files
    .filter((f) => /\.html?$/i.test(f.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
  const entry =
    htmlFiles.find((f) => /(^|\/)index\.html?$/i.test(f.name)) ?? htmlFiles[0];

  if (entry) {
    let html = entry.content;

    // Inline local stylesheets: <link ... rel=stylesheet ... href="X" ...>
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href || isExternal(href)) return tag;
      const css = byPath.get(resolvePath(entry.name, href));
      return css === undefined ? tag : `<style>\n${css}\n</style>`;
    });

    // Inline local scripts: <script ... src="X" ...></script> (keep type=module).
    html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, src, post) => {
      if (isExternal(src)) return tag;
      const js = byPath.get(resolvePath(entry.name, src));
      if (js === undefined) return tag;
      const isModule = /type\s*=\s*["']module["']/i.test(`${pre} ${post}`);
      return `<script${isModule ? ' type="module"' : ''}>\n${js}\n</script>`;
    });

    return { html: withConsoleBridge(html), entry: entry.name };
  }

  // No HTML — run a lone script with console mirrored onto the page.
  const script = files.find((f) => /\.(js|mjs|jsx|ts|tsx)$/i.test(f.name));
  if (script) {
    const body = `<!doctype html><html><head><meta charset="utf-8">
<style>body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:10px;background:#0c0c0e;color:#e6e6e6}
.log{white-space:pre-wrap;word-break:break-word}.err{color:#ff6b6b}.warn{color:#ffd166}</style></head>
<body><div id="__out"></div>
<script>${scriptType(script.name)}>
${script.content}
</script></body></html>`;
    return { html: withConsoleBridge(body), entry: script.name };
  }

  return { html: null, reason: 'Add an index.html (or a .js file) to see a live preview.' };
}

const scriptType = (name: string): string =>
  /\.(mjs|jsx|tsx)$/i.test(name) || /\.ts$/i.test(name) ? '<script type="module"' : '<script';

/**
 * Inject a tiny console/error bridge so runtime logs and uncaught errors are
 * visible inside the preview instead of vanishing into the sandboxed frame.
 * Appended right after <body> when present, else prepended.
 */
function withConsoleBridge(html: string): string {
  const bridge = `<script>(function(){
  var out=document.getElementById('__out');
  if(!out){out=document.createElement('div');out.id='__out';
    out.style.cssText='position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;font:11px/1.4 ui-monospace,monospace;background:rgba(0,0,0,.75);color:#eee;padding:4px 8px;z-index:2147483647';
    document.addEventListener('DOMContentLoaded',function(){document.body&&document.body.appendChild(out)});}
  function fmt(args){return Array.prototype.map.call(args,function(a){try{return typeof a==='object'?JSON.stringify(a):String(a)}catch(e){return String(a)}}).join(' ');}
  function add(cls,args){var text=fmt(args);var line=document.createElement('div');line.className='log '+cls;line.textContent=text;
    (out.parentNode?out:document.body||document.documentElement).appendChild(line);
    try{parent.postMessage({source:'slate-preview',level:cls||'log',text:text},'*')}catch(e){}}
  ['log','info'].forEach(function(k){var o=console[k];console[k]=function(){add('',arguments);o&&o.apply(console,arguments)}});
  var w=console.warn;console.warn=function(){add('warn',arguments);w&&w.apply(console,arguments)};
  var e=console.error;console.error=function(){add('err',arguments);e&&e.apply(console,arguments)};
  window.addEventListener('error',function(ev){add('err',[ev.message+' ('+(ev.filename||'')+':'+ev.lineno+')'])});
  window.addEventListener('unhandledrejection',function(ev){add('err',['Unhandled promise rejection: '+ev.reason])});
})();</script>`;
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => m + bridge);
  return bridge + html;
}
