import { readFile, writeFile, readdir, stat, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'];
const JSX_EXTS = new Set(['.tsx', '.jsx', '.js', '.mjs', '.cjs']);

const DEFAULT_IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', '.svelte-kit', '.output', 'vendor', '__snapshots__', 'generated',
];

/** Comments kept unless --all is passed (they change behaviour or carry legal text). */
const PRESERVE = [
  /^\/[*/]!/,
  /@(license|preserve|copyright|lic\b)/i,
  /^\/\/\/\s*<(reference|amd-)/,
  /@ts-(ignore|expect-error|nocheck|check)\b/,
  /\beslint(-disable|-enable|\b\s+\w)/,
  /\b(tslint|biome-ignore|prettier-ignore|stylelint-(disable|enable))\b/,
  /\b(istanbul|c8|v8)\s+(ignore|disable)/,
  /\bwebpack(ChunkName|Ignore|Prefetch|Preload|Mode|Exports|Include|Exclude)\b/,
  /@vite-ignore\b/,
  /#__(PURE|NO_SIDE_EFFECTS)__/,
  /@__PURE__/,
  /@jsx(Runtime|ImportSource|Frag|Fragment)?\b/,
  /@(flow|noflow)\b/,
  /\bsource(MappingURL|URL)=/,
  /^\/\/\s*#(region|endregion)\b/i,
];

/* ------------------------------------------------------------------ cli --- */

const die = (m) => { process.stderr.write(`strip-comments: ${m}\n`); process.exit(2); };

function parseArgs(argv) {
  const o = {
    targets: [], exts: null, includeJs: false, ignoreDirs: new Set(DEFAULT_IGNORED_DIRS),
    exclude: [], dryRun: false, check: false, backup: false, verbose: false, quiet: false,
    preserve: true, keepJsdoc: false, squeeze: false, skipDts: false, follow: false,
    hidden: false, engine: 'auto', root: PROJECT_ROOT,
    concurrency: Math.max(4, Math.min(32, (os.cpus?.().length || 4) * 4)),
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) { const k = a.indexOf('='); inline = a.slice(k + 1); a = a.slice(0, k); }
    const take = () => { if (inline !== null) return inline; const v = argv[++i]; if (v === undefined) die(`missing value for ${a}`); return v; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '--check': o.check = true; o.dryRun = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '-q': case '--quiet': o.quiet = true; break;
      case '--backup': o.backup = true; break;
      case '--all': case '--no-preserve': o.preserve = false; break;
      case '--keep-jsdoc': o.keepJsdoc = true; break;
      case '--squeeze': o.squeeze = true; break;
      case '--skip-dts': o.skipDts = true; break;
      case '--include-js': o.includeJs = true; break;
      case '--hidden': o.hidden = true; break;
      case '--follow': o.follow = true; break;
      case '--ext': o.exts = take().split(',').map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()); break;
      case '--ignore': take().split(',').forEach((d) => d && o.ignoreDirs.add(d.trim())); break;
      case '--exclude': o.exclude.push(new RegExp(take())); break;
      case '--engine': o.engine = take(); break;
      case '--root': o.root = path.resolve(take()); break;
      case '--concurrency': o.concurrency = Math.max(1, parseInt(take(), 10) || 1); break;
      default:
        if (a === '--') { o.targets.push(...argv.slice(i + 1)); i = argv.length; }
        else if (a.startsWith('-')) die(`unknown option ${a}`);
        else o.targets.push(a);
    }
  }
  if (!['auto', 'ts', 'fallback'].includes(o.engine)) die('--engine must be auto|ts|fallback');
  if (!o.exts) o.exts = o.includeJs ? [...TS_EXTS, ...JS_EXTS] : [...TS_EXTS];
  return o;
}

const HELP = `Usage: node scripts/strip-comments.mjs [targets...] [options]

Targets default to <project>/src.

  -n, --dry-run     report without writing        --check       exit 1 if comments found
  -v, --verbose     list every file               -q, --quiet   only the summary
      --all         also strip licenses/directives (@ts-ignore, eslint-disable, ...)
      --keep-jsdoc  keep /** ... */ blocks         --squeeze     collapse extra blank lines
      --backup      write .bak next to each file   --skip-dts    skip *.d.ts
      --include-js  also .js/.jsx/.mjs/.cjs        --ext .ts,.tsx
      --ignore a,b  extra dir names to skip        --exclude <regex>  (repeatable)
      --hidden      descend into dot-directories   --follow      follow symlinks
      --engine auto|ts|fallback                    --concurrency <n>   --root <dir>
`;

/* ------------------------------------------------------- typescript mode --- */

async function loadTypeScript(root) {
  for (const base of [root, process.cwd(), HERE]) {
    try {
      const req = createRequire(path.join(base, '__resolve__.cjs'));
      const mod = await import(pathToFileURL(req.resolve('typescript')).href);
      const ts = mod.default ?? mod;
      if (ts && typeof ts.createSourceFile === 'function') return ts;
    } catch { /* keep looking */ }
  }
  return null;
}

const scriptKindFor = (ts, file) => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (TS_EXTS.includes(ext)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
};

function collectWithTypeScript(ts, file, text) {
  const sf = ts.createSourceFile(path.basename(file), text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const comments = [];
  const containers = [];
  const jsxText = [];
  const seen = new Set();

  const add = (list) => {
    if (!list) return;
    for (const r of list) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push({ pos: r.pos, end: r.end });
    }
  };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push([node.pos, node.end]);
    } else {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
      if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression) containers.push([node.getStart(sf), node.end]);
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);

  const protectedRange = (r) => jsxText.some(([p, e]) => r.pos < e && r.end > p);
  return { comments: comments.filter((r) => !protectedRange(r)), containers };
}

function parseErrorCount(ts, file, text) {
  try {
    const sf = ts.createSourceFile(path.basename(file), text, ts.ScriptTarget.Latest, false, scriptKindFor(ts, file));
    return Array.isArray(sf.parseDiagnostics) ? sf.parseDiagnostics.length : -1;
  } catch { return -1; }
}

/* ---------------------------------------------------------- fallback mode --- */

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isWordChar = (c) => !!c && (/[A-Za-z0-9_$]/.test(c));

function scanFallback(text, { jsx }) {
  const CODE = 0, TEMPLATE = 1, TAG = 2, CHILDREN = 3;
  const n = text.length;
  const comments = [];
  const containers = [];
  const stack = [{ mode: CODE, depth: 0 }];
  let prev = null;
  let i = 0;

  if (text[0] === '#' && text[1] === '!') { const nl = text.indexOf('\n'); i = nl === -1 ? n : nl; }

  const regexOk = () => {
    if (!prev) return true;
    if (prev.t === 'w') return REGEX_KEYWORDS.has(prev.v);
    if (prev.t === 'lit') return false;
    return prev.v !== ')' && prev.v !== ']';
  };
  const lineEnd = (p) => { let e = text.indexOf('\n', p); if (e === -1) e = n; if (e > p && text[e - 1] === '\r') e--; return e; };
  const blockEnd = (p) => { const e = text.indexOf('*/', p + 2); return e === -1 ? n : e + 2; };
  const strEnd = (p, q) => {
    for (let j = p + 1; j < n; j++) {
      const ch = text[j];
      if (ch === '\\') { j++; continue; }
      if (ch === q) return j + 1;
      if (ch === '\n') return j;
    }
    return n;
  };
  const regexEnd = (p) => {
    let cls = false;
    for (let j = p + 1; j < n; j++) {
      const ch = text[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '\n') return p + 1;
      if (cls) { if (ch === ']') cls = false; continue; }
      if (ch === '[') { cls = true; continue; }
      if (ch === '/') { j++; while (j < n && /[a-z]/i.test(text[j])) j++; return j; }
    }
    return p + 1;
  };
  const jsxStarts = (p) => {
    const c = text[p + 1];
    if (c === '>') return true;
    if (!c || !/[A-Za-z_$]/.test(c)) return false;
    let j = p + 1;
    while (j < n && /[A-Za-z0-9_$.\-:]/.test(text[j])) j++;
    let k = j;
    while (k < n && /\s/.test(text[k])) k++;
    if (text[k] === ',') return false;                       // <T,>() => ... generic arrow
    if (/^extends\b/.test(text.slice(k, k + 8))) return false; // <T extends X>() => ...
    return true;
  };

  while (i < n) {
    const f = stack[stack.length - 1];
    const c = text[i];

    if (f.mode === CHILDREN) {
      if (c === '{') { stack.push({ mode: CODE, depth: 0, brace: i, fromChildren: true }); prev = null; i++; continue; }
      if (c === '<') {
        if (text[i + 1] === '/') { const gt = text.indexOf('>', i); i = gt === -1 ? n : gt + 1; stack.pop(); prev = { t: 'lit' }; continue; }
        stack.push({ mode: TAG, depth: 0 }); i++; continue;
      }
      i++; continue;
    }

    if (f.mode === TAG) {
      if (c === '{') { stack.push({ mode: CODE, depth: 0 }); prev = null; i++; continue; }
      if (c === '"' || c === "'") { i = strEnd(i, c); continue; }
      if (c === '/' && text[i + 1] === '>') { stack.pop(); i += 2; prev = { t: 'lit' }; continue; }
      if (c === '/' && text[i + 1] === '/') { const e = lineEnd(i); comments.push({ pos: i, end: e }); i = e; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = blockEnd(i); comments.push({ pos: i, end: e }); i = e; continue; }
      if (c === '>') { f.mode = CHILDREN; i++; continue; }
      i++; continue;
    }

    if (f.mode === TEMPLATE) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); prev = { t: 'lit' }; i++; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push({ mode: CODE, depth: 0 }); prev = null; i += 2; continue; }
      i++; continue;
    }

    /* CODE */
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = lineEnd(i); comments.push({ pos: i, end: e }); i = e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = blockEnd(i); comments.push({ pos: i, end: e }); i = e; continue; }
    if (c === '/' && regexOk()) { const e = regexEnd(i); if (e > i + 1) { i = e; prev = { t: 'lit' }; continue; } prev = { t: 'p', v: '/' }; i++; continue; }
    if (c === '"' || c === "'") { i = strEnd(i, c); prev = { t: 'lit' }; continue; }
    if (c === '`') { stack.push({ mode: TEMPLATE }); i++; continue; }
    if (c === '{') { f.depth++; prev = { t: 'p', v: '{' }; i++; continue; }
    if (c === '}') {
      if (f.depth > 0 || stack.length === 1) { if (f.depth > 0) f.depth--; prev = { t: 'p', v: '}' }; i++; continue; }
      const frame = stack.pop(); i++;
      if (frame.fromChildren) containers.push([frame.brace, i]);
      prev = { t: 'p', v: '}' };
      continue;
    }
    if (jsx && c === '<' && regexOk() && jsxStarts(i)) { stack.push({ mode: TAG, depth: 0 }); i++; continue; }
    if (isWordChar(c)) { let j = i; while (j < n && isWordChar(text[j])) j++; prev = { t: 'w', v: text.slice(i, j) }; i = j; continue; }
    prev = { t: 'p', v: c }; i++;
  }
  return { comments, containers };
}

/* ------------------------------------------------------------ rewriting --- */

const shouldPreserve = (src, o) => {
  if (!o.preserve) return false;
  if (o.keepJsdoc && src.startsWith('/**') && src !== '/**/') return true;
  return PRESERVE.some((re) => re.test(src));
};

function assertCommentShaped(text, ranges) {
  for (const r of ranges) {
    const s = text.slice(r.pos, r.end);
    if (!s.startsWith('//') && !s.startsWith('/*')) throw new Error(`refused: non-comment range at offset ${r.pos}`);
  }
}

/** `{/* jsx comment *\/}` containers become empty `` — remove them whole. */
function expandContainers(text, removable, containers) {
  if (!containers.length) return removable;
  const out = removable.slice();
  for (const [cs, ce] of containers) {
    const inner = out.filter((r) => r.pos >= cs && r.end <= ce).sort((a, b) => a.pos - b.pos);
    if (!inner.length) continue;
    let masked = '';
    let last = cs + 1;
    for (const r of inner) { masked += text.slice(last, Math.max(last, r.pos)); last = Math.max(last, r.end); }
    masked += text.slice(Math.min(last, ce - 1), ce - 1);
    if (masked.trim() !== '') continue;
    for (const r of inner) out.splice(out.indexOf(r), 1);
    out.push({ pos: cs, end: ce });
  }
  return out;
}

/** Grow each range so no orphan blank lines / trailing spaces are left behind. */
function expandWhitespace(text, ranges) {
  const out = [];
  for (const r of ranges) {
    let s = r.pos;
    const e = r.end;
    const ls = text.lastIndexOf('\n', s - 1) + 1;
    const nl = text.indexOf('\n', e);
    const hasNl = nl !== -1;
    const le = hasNl ? nl : text.length;
    let contentEnd = le;
    if (contentEnd > e && text[contentEnd - 1] === '\r') contentEnd--;
    const before = text.slice(ls, s);
    const after = text.slice(e, contentEnd);

    if (before.trim() === '' && after.trim() === '') {
      out.push({ pos: ls, end: hasNl ? nl + 1 : text.length });
    } else if (after.trim() === '') {
      while (s > ls && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
      out.push({ pos: s, end: contentEnd });
    } else {
      const spaceBefore = text[s - 1] === ' ' || text[s - 1] === '\t';
      let e2 = e;
      if (spaceBefore) { while (s > ls && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--; }
      else { while (e2 < contentEnd && (text[e2] === ' ' || text[e2] === '\t')) e2++; }
      out.push({ pos: s, end: e2 });
    }
  }
  return out;
}

function cutRanges(text, ranges) {
  const merged = [];
  for (const r of [...ranges].sort((a, b) => a.pos - b.pos || a.end - b.end)) {
    const last = merged[merged.length - 1];
    if (last && r.pos <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ pos: r.pos, end: r.end });
  }
  let out = '';
  let cursor = 0;
  for (const r of merged) { out += text.slice(cursor, r.pos); cursor = r.end; }
  return out + text.slice(cursor);
}

async function processFile(file, o, ts) {
  const raw = await readFile(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const text = bom ? raw.slice(1) : raw;

  const found = ts
    ? collectWithTypeScript(ts, file, text)
    : scanFallback(text, { jsx: JSX_EXTS.has(path.extname(file).toLowerCase()) });

  const removable = found.comments.filter((c) => !shouldPreserve(text.slice(c.pos, c.end), o));
  const kept = found.comments.length - removable.length;
  if (!removable.length) return { file, removed: 0, kept, changed: false };

  assertCommentShaped(text, removable);
  let out = cutRanges(text, expandWhitespace(text, expandContainers(text, removable, found.containers)));
  if (o.squeeze) out = out.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1');
  if (text.endsWith('\n') && !out.endsWith('\n')) out += text.endsWith('\r\n') ? '\r\n' : '\n';
  out = bom + out;

  if (ts) {
    const before = parseErrorCount(ts, file, text);
    const after = parseErrorCount(ts, file, out.slice(bom.length));
    if (before >= 0 && after > before) throw new Error('output would not parse — file left untouched');
  }
  if (out === raw) return { file, removed: 0, kept, changed: false };

  if (!o.dryRun) {
    if (o.backup) await copyFile(file, `${file}.bak`);
    await writeFile(file, out, 'utf8');
  }
  return { file, removed: removable.length, kept, changed: true };
}

/* -------------------------------------------------------------- walking --- */

const accept = (file, o) => {
  const lower = file.toLowerCase();
  if (o.skipDts && lower.endsWith('.d.ts')) return false;
  if (lower.endsWith('.bak')) return false;
  return o.exts.some((e) => lower.endsWith(e));
};

async function collectFiles(roots, o) {
  const files = [];
  const visited = new Set();
  const stack = [...roots];
  const excluded = (p) => o.exclude.some((re) => re.test(p.split(path.sep).join('/')));

  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = await stat(cur); } catch { continue; }
    if (st.isFile()) { if (accept(cur, o)) files.push(cur); continue; }
    if (!st.isDirectory()) continue;

    let real = cur;
    try { real = await realpath(cur); } catch { /* ignore */ }
    if (visited.has(real)) continue;
    visited.add(real);

    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (excluded(full)) continue;
      if (ent.isSymbolicLink()) { if (o.follow) stack.push(full); continue; }
      if (ent.isDirectory()) {
        if (o.ignoreDirs.has(ent.name)) continue;
        if (!o.hidden && ent.name.startsWith('.')) continue;
        stack.push(full);
      } else if (ent.isFile() && accept(full, o)) files.push(full);
    }
  }
  return files.sort();
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (idx < items.length) { const i = idx++; results[i] = await worker(items[i]); }
  }));
  return results;
}

/* ----------------------------------------------------------------- main --- */

const o = parseArgs(process.argv.slice(2));
if (o.help) { process.stdout.write(HELP); process.exit(0); }

const roots = (o.targets.length ? o.targets : [path.join(o.root, 'src')]).map((p) => path.resolve(p));
const ts = o.engine === 'fallback' ? null : await loadTypeScript(o.root);
if (!ts && o.engine === 'ts') die('engine "ts" requested but the `typescript` package could not be resolved');
if (!ts && !o.quiet) process.stderr.write('strip-comments: typescript not found — using built-in scanner (best effort)\n');

const files = await collectFiles(roots, o);
if (!files.length) { if (!o.quiet) process.stdout.write(`strip-comments: no matching files under ${roots.map((r) => path.relative(process.cwd(), r) || '.').join(', ')}\n`); process.exit(0); }

const rel = (f) => path.relative(process.cwd(), f) || f;
let changed = 0, removed = 0, kept = 0;
const errors = [];

const results = await pool(files, o.concurrency, async (file) => {
  try { return await processFile(file, o, ts); }
  catch (err) { errors.push({ file, message: err?.message || String(err) }); return null; }
});

for (const r of results) {
  if (!r) continue;
  kept += r.kept;
  if (!r.changed) { if (o.verbose && !o.quiet) process.stdout.write(`  ·  ${rel(r.file)}\n`); continue; }
  changed++; removed += r.removed;
  if (!o.quiet) process.stdout.write(`  ${o.dryRun ? '~' : '✔'}  ${rel(r.file)}  (${r.removed} comment${r.removed === 1 ? '' : 's'})\n`);
}
for (const e of errors) process.stderr.write(`  ✖  ${rel(e.file)}: ${e.message}\n`);

if (!o.quiet) {
  process.stdout.write(
    `\n${o.dryRun ? '[dry-run] ' : ''}${files.length} file${files.length === 1 ? '' : 's'} scanned · ` +
    `${changed} ${o.dryRun ? 'with comments' : 'rewritten'} · ${removed} comment${removed === 1 ? '' : 's'} removed` +
    `${kept ? ` · ${kept} preserved` : ''}${errors.length ? ` · ${errors.length} error(s)` : ''} · engine: ${ts ? 'typescript' : 'builtin'}\n`,
  );
}

process.exitCode = errors.length ? 2 : (o.check && changed ? 1 : 0);