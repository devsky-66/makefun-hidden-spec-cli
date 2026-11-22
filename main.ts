// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (the command line, the output and exit
// codes, safe paths, format detection, JSON edits and the all-or-nothing
// write) follow the kit starter's design; sections 5 to 8 (three-tier line
// matching, unified diffs, SEARCH/REPLACE blocks and V4A patches) are written
// here from SPEC.md.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- files as lines (SPEC.md section 3) ----

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---- three-tier matching (SPEC.md section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  return normLine(a, tier) === normLine(b, tier);
}

/** All positions >= `from` where `pat` occurs in `lines` at `tier`. */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..maxTier) at which `pat` occurs, with its positions. */
function firstTier(lines: string[], pat: string[], maxTier: number, from = 0): { tier: number; pos: number[] } | null {
  if (pat.length === 0) return null;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(lines, pat, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `oIdx` >= 0 means it is a context line, the file's own
 *  matched line at that index of O; -1 means a fresh line of N. */
interface NItem {
  text: string;
  oIdx: number;
}

function plainN(lines: string[]): NItem[] {
  return lines.map((text) => ({ text, oIdx: -1 }));
}

/** Replace O at `pos` by N, honouring section 5: context lines are written
 *  as the file's own matched lines, and at tier 2 the other lines of N are
 *  re-indented from O's first line's leading whitespace to the file's. */
function applyReplace(lines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!);
  }
  for (const it of n) {
    if (it.oIdx >= 0) {
      out.push(lines[pos + it.oIdx]!);
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface UHunk {
  a: number;
  o: string[];
  n: NItem[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noEolPlus: boolean;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hasHdr: boolean;
  hunks: UHunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first
 *  tab, surrounding spaces removed, one leading `a/` or `b/` removed. */
function cleanUnifiedPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const perr = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const newSection = (): USection => {
    const s: USection = {
      gitOld: null, gitNew: null, hdrOld: null, hdrNew: null,
      renOld: null, renNew: null, newFile: false, delFile: false,
      hasHdr: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) perr(i + 1);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasHdr) {
        cur.hdrOld = cleanUnifiedPath(line.slice(4));
        cur.hdrNew = cleanUnifiedPath(lines[i + 1]!.slice(4));
        cur.hasHdr = true;
        i += 2;
        continue;
      }
      const s = newSection();
      s.hdrOld = cleanUnifiedPath(line.slice(4));
      s.hdrNew = cleanUnifiedPath(lines[i + 1]!.slice(4));
      s.hasHdr = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) perr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null || (m[5] !== '' && !m[5]!.startsWith(' '))) perr(i + 1);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const n: NItem[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith(' ')) {
          const t = b.slice(1);
          o.push(t);
          n.push({ text: t, oIdx: o.length - 1 });
          lastCtxPlus = k;
        } else if (b === '') {
          // A bare empty line is a context line whose text is empty.
          o.push('');
          n.push({ text: '', oIdx: o.length - 1 });
          lastCtxPlus = k;
        } else if (b.startsWith('-')) {
          o.push(b.slice(1));
        } else if (b.startsWith('+')) {
          n.push({ text: b.slice(1), oIdx: -1 });
          lastCtxPlus = k;
          lastPlus = k;
        }
      }
      const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
      const noEolPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
      cur.hunks.push({ a, o, n, noEol, noEolPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) perr(i + 2);
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply one section's hunks to a file's lines, tracking the running offset
 *  d and the final line break the way section 6 says. */
function applyUnifiedHunks(
  f: FileParts,
  hunks: UHunk[],
  strict: boolean,
  path: string,
): FileParts {
  let lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const touched = at === lines.length;
      lines = [...lines.slice(0, at), ...h.n.map((it) => it.text), ...lines.slice(at)];
      if (touched) final = !h.noEol;
      d += h.n.length;
    } else {
      const found = firstTier(lines, h.o, strict ? 0 : 2);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touched = best + h.o.length === lines.length;
      lines = applyReplace(lines, best, h.o, h.n, found.tier);
      if (touched) final = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  return { lines, br: f.br, final };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = sec.hdrOld ?? sec.renOld ?? sec.gitOld;
    const newRaw = sec.hdrNew ?? sec.renNew ?? sec.gitNew;
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === '/dev/null' ? null : newRaw;
    if (oldPath === null && newPath === null) return;
    const isCreate = sec.newFile || oldPath === null;
    const isDelete = sec.delFile || newPath === null;
    for (const p of [oldPath, newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate && newPath !== null) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.n) if (it.oIdx < 0) plus.push(it.text);
      }
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.n.some((it) => it.oIdx < 0)) {
          noEol = h.noEolPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete && oldPath !== null) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    // A move, or a change of the one path.
    const from = oldPath!;
    const to = newPath ?? oldPath!;
    const isMove = newPath !== null && oldPath !== null && newPath !== oldPath;
    const cur = tree.get(from);
    if (cur === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const out = applyUnifiedHunks(splitFile(cur), sec.hunks, strict, from);
    const text = joinFile(out);
    if (isMove) {
      tree.moves.push({ old: from, nw: to });
      tree.now.set(from, null);
      tree.now.set(to, text);
    } else {
      tree.now.set(from, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let j = i + 1;
      while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
      if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let k = j + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
      if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
      const old = lines.slice(i + 1, j);
      const nw = lines.slice(j + 1, k);
      let path: string | null = null;
      for (let p = searchIdx - 1; p >= prevEnd; p--) {
        const t = lines[p]!;
        if (blank(t)) continue;
        const tr = t.trim();
        if (tr.startsWith('```')) continue;
        path = tr;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      prevPath = path;
      blocks.push({ path, old, nw });
      prevEnd = k + 1;
      i = k + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = firstTier(f.lines, b.old, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const out = applyReplace(f.lines, found.pos[0]!, b.old, plainN(b.nw), found.tier);
    tree.now.set(p, joinFile({ lines: out, br: f.br, final: f.final }));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VLine {
  text: string;
  no: number;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

interface VSection {
  kind: string;
  path: string;
  body: VLine[];
  headerLine: number;
  /** Validated at parse time (a parse error is reported before any file
   *  is looked at, section 10): the Add file's lines, or the Update
   *  section's move target and chunks. */
  added?: string[];
  update?: { moveTo: string | null; chunks: VChunk[] };
}

function parseUpdateSection(body: VLine[], headerLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
    moveTo = body[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  while (idx < body.length) {
    const l = body[idx]!;
    const t = l.text;
    if (t.trimEnd() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, o: [], n: [] };
        chunks.push(cur);
      } else {
        cur.eof = true;
      }
      closed = true;
      cur = null;
      idx++;
      continue;
    }
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      chunks.push(cur);
      closed = false;
      idx++;
      continue;
    }
    if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
      if (cur === null) {
        if (chunks.length > 0 || closed) throw new Exit2(`error: parse ${l.no}`);
        cur = { anchor: null, eof: false, o: [], n: [] };
        chunks.push(cur);
      }
      if (t.startsWith(' ')) {
        const tx = t.slice(1);
        cur.o.push(tx);
        cur.n.push({ text: tx, oIdx: cur.o.length - 1 });
      } else if (t.startsWith('-')) {
        cur.o.push(t.slice(1));
      } else if (t.startsWith('+')) {
        cur.n.push({ text: t.slice(1), oIdx: -1 });
      } else {
        cur.o.push('');
        cur.n.push({ text: '', oIdx: cur.o.length - 1 });
      }
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${l.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File):(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const start = i + 1;
    let j = start;
    while (j < last) {
      if (/^\*\*\* (Add File|Delete File|Update File):/.test(lines[j]!)) break;
      j++;
    }
    const body: VLine[] = [];
    for (let k = start; k < j; k++) body.push({ text: lines[k]!, no: k + 1 });
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    sections.push({ kind, path, body, headerLine: i + 1 });
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  // Validate every section body now: a parse error is reported before any
  // file is looked at (section 10), never from inside an edit.
  for (const sec of sections) {
    if (sec.kind === 'Add File') {
      const added: string[] = [];
      for (const l of sec.body) {
        if (l.text.startsWith('+')) added.push(l.text.slice(1));
        else if (l.text === '') added.push('');
        else throw new Exit2(`error: parse ${l.no}`);
      }
      sec.added = added;
    } else if (sec.kind === 'Delete File') {
      for (const l of sec.body) throw new Exit2(`error: parse ${l.no}`);
    } else {
      sec.update = parseUpdateSection(sec.body, sec.headerLine);
    }
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'Add File') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added = sec.added ?? [];
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'Delete File') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update File
    const { moveTo, chunks } = sec.update ?? { moveTo: null, chunks: [] };
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const isMove = moveTo !== null && moveTo !== p;
    if (isMove && tree.get(moveTo!) !== null) throw new Fail('exists', moveTo!);
    const maxTier = strict ? 0 : 2;
    const f = splitFile(cur);
    let fileLines = f.lines.slice();
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let at: number | null = null;
        for (let t = 0; t <= maxTier; t++) {
          for (let q = cursor; q < fileLines.length; q++) {
            if (lineEq(fileLines[q]!, chunk.anchor, t)) {
              at = q;
              break;
            }
          }
          if (at !== null) break;
        }
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? fileLines.length : cursor;
        fileLines = [...fileLines.slice(0, at), ...chunk.n.map((it) => it.text), ...fileLines.slice(at)];
        cursor = at + chunk.n.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (let t = 0; t <= maxTier; t++) {
          const occ = occurrences(fileLines, chunk.o, t, cursor).filter(
            (pos) => !chunk.eof || pos + chunk.o.length === fileLines.length,
          );
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        fileLines = applyReplace(fileLines, found.pos, chunk.o, chunk.n, found.tier);
        cursor = found.pos + chunk.n.length;
      }
    }
    const text = joinFile({ lines: fileLines, br: f.br, final: f.final });
    if (isMove) {
      tree.moves.push({ old: p, nw: moveTo! });
      tree.now.set(p, null);
      tree.now.set(moveTo!, text);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- running the edits (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const nextOf = new Map<string, string>();
  for (const m of tree.moves) nextOf.set(m.old, m.nw);
  for (const m of tree.moves) {
    if (usedOld.has(m.old)) continue;
    if (tree.original(m.old) === null) continue;
    if (tree.get(m.old) !== null) continue;
    let end = m.nw;
    const seen = new Set<string>([m.old]);
    while (nextOf.has(end) && !seen.has(end) && tree.get(end) === null) {
      seen.add(end);
      end = nextOf.get(end)!;
    }
    if (tree.original(end) !== null) continue;
    if (tree.get(end) === null) continue;
    rows.push({ key: end, text: `R ${m.old} -> ${end}` });
    usedOld.add(m.old);
    usedNew.add(end);
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
