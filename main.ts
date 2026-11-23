// mend — one patch tool for every AI edit format.
//
// mend applies an edit an AI model wrote to a tree of text files. Models write
// edits in four formats: unified diffs (often with wrong line numbers),
// SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON.
// This file implements the whole of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three-tier line matcher, all
// four readers, and the all-or-nothing write at the end.
//
// Node 22, standard library only, deterministic. Run it as
// `node main.ts [options] [PATCH]`. When MAKEFUN_ENV_URL is set the file
// hands over to runner.ts instead (kept exactly as the kit ships it).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Errors. Exit2 carries the single stdout line of an exit-2 run. Fail carries
// one edit's failure code and the path the failure concerns.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 * empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path: not empty, no leading slash, no backslash, and no segment
 * that is empty, "." or "..". */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// The file model (SPEC.md section 3). A file's break is CRLF when its first
// line feed follows a carriage return, LF otherwise. `finalBreak` records
// whether the text ends with its break; an empty file has no lines and no
// final break, and a file of no lines is written empty.
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

// ---------------------------------------------------------------------------
// The tree. Edits work against this in-memory view: `now` holds every path an
// edit has touched (null = deleted), everything else is read from disk on
// first use and remembered as the pre-patch state. Nothing reaches the disk
// until every edit has succeeded.
// ---------------------------------------------------------------------------

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs [oldPath, newPath] recorded by move edits, for R lines. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5). Old lines O are looked for at the
// first of three tiers at which they occur at least once: exact, then equal
// after trimming trailing blanks, then after trimming both ends. --strict
// tries tier 0 only.
// ---------------------------------------------------------------------------

function tierView(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/** Every position at which O occurs in `lines`, at the first tier that has
 * one, optionally restricted to positions >= from and (when endOnly) to the
 * single position that ends at the file's last line. Null when O occurs at
 * no tier. */
function findOccurrences(
  lines: string[],
  old: string[],
  strict: boolean,
  from = 0,
  endOnly = false,
): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i++) {
      if (endOnly && i + old.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (tierView(lines[i + j]!, tier) !== tierView(old[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The lines N is written as when it replaces the matched lines at `pos`:
 * context lines (the indices in `contextOf`, mapping an index of N to the
 * index of the same line in O) keep the file's own matched line; at tier 2
 * every other non-blank line of N is re-indented by swapping O's first line's
 * leading blanks for the file's first matched line's. */
function replacementLines(
  fileLines: string[],
  pos: number,
  old: string[],
  replacement: string[],
  tier: number,
  contextOf: Map<number, number>,
): string[] {
  const lead = (s: string): string => /^[ \t]*/.exec(s)![0];
  const fileLead = fileLines.length > 0 ? lead(fileLines[pos] ?? '') : '';
  const oldLead = old.length > 0 ? lead(old[0]!) : '';
  return replacement.map((line, ni) => {
    const oi = contextOf.get(ni);
    if (oi !== undefined) return fileLines[pos + oi]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(oldLead)) {
      return fileLead + line.slice(oldLead.length);
    }
    return line;
  });
}

/** Splice `replacement` over the matched lines at `pos` in the model. */
function spliceMatch(
  m: FileModel,
  pos: number,
  old: string[],
  replacement: string[],
  tier: number,
  contextOf: Map<number, number>,
): void {
  const written = replacementLines(m.lines, pos, old, replacement, tier, contextOf);
  m.lines.splice(pos, old.length, ...written);
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface BodyLine {
  tag: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows this body line ("\ No newline at end of file"). */
  noEol: boolean;
  /** The patch line was completely empty (a context line by the unified
   * rule, but one of the trailing empties a body drops). */
  rawEmpty?: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined; // undefined: no --- line seen
  headNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: text after the four characters, up to
 * the first tab, surrounding spaces removed, a leading a/ or b/ removed;
 * /dev/null comes back as null. */
function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}

function newSection(): Section {
  return {
    diffOld: null,
    diffNew: null,
    headOld: undefined,
    headNew: undefined,
    renameOld: null,
    renameNew: null,
    isCreate: false,
    isDelete: false,
    inHeader: true,
    hunks: [],
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk starting at lines[i] (a line starting with @@). Returns
 * the hunk and the index of the first line after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ tag: ' ', text: '', noEol: false, rawEmpty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ tag: c, text: l.slice(1), noEol: false });
      j++;
      continue;
    }
    if (c === '\\') {
      const prev = body[body.length - 1];
      if (prev !== undefined) prev.noEol = true;
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.rawEmpty === true && !last.noEol) body.pop();
    else break;
  }
  return { hunk: { a: Number(m[1]), body }, next: j };
}

/** Split a hunk's body into its old lines O, its new lines N, and the map
 * from an index of N to the index of the same line in O for context lines. */
function hunkParts(body: BodyLine[]): { old: string[]; neu: string[]; contextOf: Map<number, number> } {
  const old: string[] = [];
  const neu: string[] = [];
  const contextOf = new Map<number, number>();
  for (const b of body) {
    if (b.tag === ' ') {
      contextOf.set(neu.length, old.length);
      old.push(b.text);
      neu.push(b.text);
    } else if (b.tag === '-') {
      old.push(b.text);
    } else {
      neu.push(b.text);
    }
  }
  return { old, neu, contextOf };
}

/** The last body line of a hunk that is a context or + line, if any. */
function lastWrittenLine(body: BodyLine[]): BodyLine | null {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.tag !== '-') return body[k]!;
  }
  return null;
}

/** Apply a change section's hunks, in order, to a file's text. Throws Fail
 * with the failing hunk's code and the section's path. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = parseFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const { old, neu, contextOf } = hunkParts(hunk.body);
    if (old.length === 0) {
      const at = Math.min(hunk.a + d, model.lines.length);
      model.lines.splice(at, 0, ...neu);
      if (at + neu.length === model.lines.length && neu.length > 0) {
        const last = lastWrittenLine(hunk.body);
        if (last !== null) model.finalBreak = !last.noEol;
      }
      d += neu.length;
      continue;
    }
    const found = findOccurrences(model.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const runsToEnd = pos + old.length === model.lines.length;
    spliceMatch(model, pos, old, neu, found.tier, contextOf);
    if (runsToEnd) {
      const last = lastWrittenLine(hunk.body);
      if (last !== null) model.finalBreak = !last.noEol;
    }
    d += neu.length - old.length;
  }
  return renderFile(model);
}

/** Turn one parsed section into an edit. */
function sectionEdit(sec: Section): Edit {
  const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renameOld ?? sec.diffOld;
  const newPath = sec.headNew !== undefined ? sec.headNew : sec.renameNew ?? sec.diffNew;
  const create = sec.isCreate || (sec.headOld !== undefined && sec.headOld === null);
  const del = sec.isDelete || (sec.headNew !== undefined && sec.headNew === null);
  return (tree) => {
    if (create) {
      const p = newPath ?? '';
      if (!isSafePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      let lastPlus: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.tag === '+') {
            added.push(b.text);
            lastPlus = b;
          }
        }
      }
      const finalBreak = lastPlus === null ? false : !lastPlus.noEol;
      tree.set(p, renderFile({ lines: added, br: '\n', finalBreak }));
      return;
    }
    if (del) {
      const p = oldPath ?? '';
      if (!isSafePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const from = oldPath ?? '';
    const to = newPath ?? '';
    if (!isSafePath(from)) throw new Fail('unsafe', from);
    if (to !== from && !isSafePath(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from) {
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const after = applyHunks(before, sec.hunks, STRICT, from);
      tree.set(from, null);
      tree.set(to, after);
      tree.moves.push([from, to]);
      return;
    }
    tree.set(from, applyHunks(before, sec.hunks, STRICT, from));
  };
}

// STRICT is set by run() before the edits run; the readers close over it.
let STRICT = false;

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || !sec.inHeader || sec.headOld !== undefined) {
        sec = newSection();
        sections.push(sec);
      }
      sec.headOld = headerPath(line);
      sec.headNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (sec !== null && sec.inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      sec.inHeader = false;
      i = next;
      continue;
    }
    if (sec !== null && sec.inHeader) {
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.isCreate = true;
      else if (line.startsWith('deleted file mode')) sec.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map(sectionEdit);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let bound = 0; // blocks and their paths live after this line index
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line before the SEARCH line, at or after the
    // bound, that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let k = searchAt - 1; k >= bound; k--) {
      const cand = lines[k]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchAt + 1}`);
    }
    let eq = -1;
    for (let k = searchAt + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    blocks.push({
      path,
      oldLines: lines.slice(searchAt + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    bound = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!isSafePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, renderFile({ lines: b.newLines, br: '\n', finalBreak: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = parseFile(before);
    const found = findOccurrences(model.lines, b.oldLines, STRICT);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    spliceMatch(model, found.positions[0]!, b.oldLines, b.newLines, found.tier, new Map());
    tree.set(b.path, renderFile(model));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  atLine: number;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };

  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const sec: VSection = { kind, path, moveTo: null, addLines: [], chunks: [], atLine: i + 1 };
    i++;
    // Collect the section's raw lines, up to the next section or End Patch.
    const raw: Array<{ text: string; at: number }> = [];
    while (i < last && sectionStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, at: i + 1 });
      i++;
    }
    // Blank lines (empty or only whitespace) at the end of a section are
    // not part of it.
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.at}`);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (r.text !== '') throw new Exit2(`error: parse ${r.at}`);
      }
    } else {
      let chunk: VChunk | null = null;
      let bodySeen = 0;
      for (const r of raw) {
        const l = r.text;
        if (bodySeen === 0 && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          bodySeen++;
          continue;
        }
        bodySeen++;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          sec.chunks.push(chunk);
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          const tag = l === '' ? ' ' : (l[0] as ' ' | '-' | '+');
          chunk.body.push({ tag, text: l === '' ? '' : l.slice(1), noEol: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.at}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new Exit2(`error: parse ${sec.atLine}`);
      }
    }
    sections.push(sec);
  }

  return sections.map((sec) => (tree: Tree) => {
    if (!isSafePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, renderFile({ lines: sec.addLines, br: '\n', finalBreak: true }));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    // Update, with an optional move.
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let anchorAt = -1;
        const tiers = STRICT ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (tierView(model.lines[k]!, tier) === tierView(chunk.anchor, tier)) {
              anchorAt = k;
              break;
            }
          }
          if (anchorAt >= 0) break;
        }
        if (anchorAt < 0) throw new Fail('no-match', sec.path);
        cursor = anchorAt + 1;
      }
      const { old, neu, contextOf } = hunkParts(chunk.body);
      if (old.length === 0) {
        const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...neu);
        cursor = at + neu.length;
        continue;
      }
      const found = findOccurrences(model.lines, old, STRICT, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.positions[0]!;
      spliceMatch(model, pos, old, neu, found.tier, contextOf);
      cursor = pos + neu.length;
    }
    const after = renderFile(model);
    if (sec.moveTo !== null) {
      tree.set(sec.path, null);
      tree.set(sec.moveTo, after);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.set(sec.path, after);
    }
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** Validate one edit object and turn it into an edit; null when the object
 * is not a valid edit (a parse fault in the caller). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
    if (!isSafePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text); // written byte for byte
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const model = parseFile(before);
      const crlf = model.br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(needle);
      const joined = text.slice(0, at) + toLf(newStr) + text.slice(at + needle.length);
      tree.set(p, crlf ? joined.replaceAll('\n', '\r\n') : joined);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const model = parseFile(before);
      if (at < 0 || at > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(at, 0, ...added);
      tree.set(p, renderFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const e = jsonEdit(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(line));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4).
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const hasDiff = lines.some(
    (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
  );
  if (hasDiff) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;

  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text: string;
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const failures: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // Work out the report rows. A recorded move whose old path existed before
  // the patch and is gone now, and whose new path did not exist before and
  // exists now, is one R line (sorted by the new path) instead of a D and
  // an A.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (consumed.has(from) || consumed.has(to)) continue;
    const wasFrom = tree.original(from);
    const wasTo = tree.original(to);
    const nowFrom = tree.now.get(from);
    const nowTo = tree.now.get(to);
    if (wasFrom !== null && wasFrom !== undefined && nowFrom === null && wasTo === null && nowTo !== null && nowTo !== undefined) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      consumed.add(from);
      consumed.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!checkOnly) {
    for (const p of [...tree.now.keys()].sort()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
