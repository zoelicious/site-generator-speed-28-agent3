// State-Machine Site Engine — a drop-in for makefun-site 1.0.0.
//
// The same answer as makefun-site 1.0.0's build, for every input, produced by a
// lookup-table driven state machine instead of the reference's regexes and
// token trees:
//
//   * one transition table drives the Markdown inline scan: each input
//     character maps to an action (escape, code span, strong, emphasis, link)
//     with no chain of branches;
//   * one transition table drives the block scan: each line's first characters
//     map to its block kind;
//   * templates compile once, up front, into a flat table of operations with
//     precomputed jumps, and a small interpreter walks that table with an
//     explicit control stack (loops and includes never recurse, never
//     allocate a scope chain per element).
//
// Everything is written from the behaviour the reference's README states and
// its code runs; no part of the reference's code is copied. The module reads
// no clock, no environment, no randomness and no file, and keeps no state
// from one case to the next: every run() call builds its own tables.

// ------------------------------------------------------------------ tables

/** HTML escape entities, indexed by character code (undefined: no escape). */
const ESC_ENT = [];
ESC_ENT[38] = '&amp;';
ESC_ENT[60] = '&lt;';
ESC_ENT[62] = '&gt;';
ESC_ENT[34] = '&quot;';
ESC_ENT[39] = '&#39;';

/** Inline actions, indexed by character code: 0 plain, 1 backslash, 2 backtick, 3 star, 4 bracket. */
const ACT = new Uint8Array(128);
ACT[92] = 1;
ACT[96] = 2;
ACT[42] = 3;
ACT[91] = 4;

/** The characters a backslash escapes, indexed by character code. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

const ESC_TEST = /[&<>"']/;
const SPECIAL_TEST = /[\\`*\[]/;

/** `text` with & < > " and ' escaped, and nothing else. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const e = c < 128 ? ESC_ENT[c] : undefined;
    if (e !== undefined) {
      out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

/** Whether `s` holds any JavaScript whitespace (the /\s/ set). */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

/** Whether character code `c` is JavaScript whitespace (the /\s/ set). */
function isWSCode(c) {
  return (
    c === 32 ||
    c === 9 ||
    c === 10 ||
    c === 11 ||
    c === 12 ||
    c === 13 ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

// ------------------------------------------------------------------ text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The slug of `text`, memoised per build in `slugMemo`. */
let slugMemo = new Map();

function slugify(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyCold(text);
  slugMemo.set(text, out);
  return out;
}

function slugifyCold(text) {
  // One pass over the code units: ASCII text normalises to itself with no
  // combining marks, so a non-ASCII character bails to the Unicode path.
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifyUnicode(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return slugifyCut(out);
}

/** The slug of non-ASCII `text`: NFKD, combining marks dropped. */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return slugifyCut(out);
}

/** A slug cut to 64 characters, a "-" left at the cut dropped, "untitled" when nothing is left. */
function slugifyCut(out) {
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether a tag name holds a character it may not. */
function hasBadTagChar(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return true;
  }
  return false;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 4; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERR };
        y = y * 10 + c;
      }
      for (let i = 5; i < 7; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERR };
        mo = mo * 10 + c;
      }
      for (let i = 8; i < 10; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERR };
        d = d * 10 + c;
      }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let start = 0;
      for (let i = 0; i <= inner.length; i++) {
        if (i === inner.length || inner.charCodeAt(i) === 44) {
          const t = inner.slice(start, i).trim();
          if (t === '' || hasBadTagChar(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          tags.push(t);
          start = i + 1;
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      const n = raw.length;
      if (n === 0 || n > 64) return { error: 'key "slug": not a slug' };
      let i = 0;
      for (;;) {
        if (i >= n) return { error: 'key "slug": not a slug' };
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return { error: 'key "slug": not a slug' };
        while (i < n) {
          const d = raw.charCodeAt(i);
          if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57)) i++;
          else break;
        }
        if (i === n) break;
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  const nl0 = text.indexOf('\n');
  if (nl0 !== 3 && !(nl0 === -1 && text.length === 3)) return { error: 'no front matter' };
  // Find the closing line and the body's start, line by line.
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeEnd = -1;
  let lineNo = 2;
  let closeLineNo = -1;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeEnd = nl === -1 ? text.length : nl + 1;
      closeLineNo = lineNo;
      break;
    }
    pos = lineEnd + 1;
    lineNo++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl0 === -1 ? text.length : nl0 + 1;
  lineNo = 2;
  while (lineNo < closeLineNo) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    pos = lineEnd + 1;
    lineNo++;
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank) continue;
    if (line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${lineNo - 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${lineNo - 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------ markdown

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  if (line.length < 3) return false;
  return !isWSCode(line.charCodeAt(2));
}

/** A list's first line as a marker, or null: { ordered, start, text }. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    let num = 0;
    while (i < 9 && i < line.length) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      num = num * 10 + (c - 48);
      i++;
    }
    if (i > 0 && i < line.length && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: num, text: line.slice(i + 2) };
    }
  }
  return null;
}

// ------------------------------------------------------------------ inline

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length) {
      const c2 = s.charCodeAt(j + 1);
      if (c2 < 128 && ESCAPABLE[c2]) {
        j++;
        continue;
      }
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length) {
      const c2 = s.charCodeAt(j + 1);
      if (c2 < 128 && ESCAPABLE[c2]) {
        j++;
        continue;
      }
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  const n = s.length;
  if (!SPECIAL_TEST.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0;
  let run = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    const act = c < 128 ? ACT[c] : 0;
    if (act === 0) {
      i++;
      continue;
    }
    if (i > run) out.push(escapeHtml(s.slice(run, i)));
    if (act === 1) {
      // Backslash: before an escapable character it writes that character.
      if (i + 1 < n) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 < 128 && ESCAPABLE[c2]) {
          out.push(c2 === 62 ? '&gt;' : s[i + 1]);
          i += 2;
        } else {
          out.push('\\');
          i++;
        }
      } else {
        out.push('\\');
        i++;
      }
      run = i;
      continue;
    }
    if (act === 2) {
      // A backtick opens a code span closed by the next backtick.
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>');
        out.push(escapeHtml(s.slice(i + 1, j)));
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      run = i;
      continue;
    }
    if (act === 3) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          out.push(inline(s.slice(i + 2, j), link));
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>');
          out.push(inline(s.slice(i + 1, j), link));
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      run = i;
      continue;
    }
    // A bracket opens a link: [text](target).
    const k = findUnescaped(s, ']', i + 1);
    let m = -1;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWS(target)) {
      out.push('<a href="');
      out.push(escapeHtml(link(target)));
      out.push('">');
      out.push(inline(s.slice(i + 1, k), link));
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
    run = i;
  }
  if (n > run) out.push(escapeHtml(s.slice(run, n)));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's inline
 * HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let b = `<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`;
      for (const l of body) {
        b += escapeHtml(l);
        b += '\n';
      }
      blocks.push(`${b}</code></pre>\n`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const stripped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') body.push(t);
      }
      if (body.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else blocks.push(`<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const lm = listMarker(line);
    if (lm !== null) {
      const ordered = lm.ordered;
      const items = [];
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === ordered) {
          items.push([trimLine(m2.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && lm.start !== 1 ? `<ol start="${lm.start}">` : `<${tag}>`;
      let b = `${open}\n`;
      for (const it of items) b += `<li>${inline(it.join('\n'), link)}</li>\n`;
      blocks.push(`${b}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Whether character code `c` may start a path name. */
function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether character code `c` may continue a path name. */
function isNameChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

/** Whether `s` holds only spaces and tabs between `a` and `b`. */
function isSpacesOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const bad = () => {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  };
  if (text === '') bad();
  const parts = text.split('.');
  for (const seg of parts) {
    if (seg.length === 0) bad();
    if (!isNameStart(seg.charCodeAt(0))) bad();
    for (let i = 1; i < seg.length; i++) if (!isNameChar(seg.charCodeAt(i))) bad();
  }
  return parts;
}

/**
 * `src` compiled into a flat table of operations. Operation kinds:
 * 0 text {s}, 1 var {p}, 2 raw {p}, 3 for {name, p, end}, 4 if {p, not, els, end},
 * 5 else {end}, 6 end, 7 include {name, ops}. Jumps are indexes into the table.
 * Two phases, as the reference does them: tokenize first (an unclosed
 * delimiter or a bad path anywhere is reported before any structural error),
 * then build the table from the tokens.
 */
function parseTemplateOps(name, src) {
  // Phase 1: tokenize the whole template first, as the reference does: an
  // unclosed delimiter or a bad path anywhere is reported before any
  // structural error, in source order.
  const tokens = [];
  let text = '';
  const pushText = () => {
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
  };
  const notATag = (tag) => new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText();
      tokens.push({ t: raw ? 'raw' : 'var', p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText();
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText();
  // Phase 2: build the operation table from the tokens.
  const ops = [];
  const stack = [{ kind: 'root', op: -1, els: -1 }];
  for (const tok of tokens) {
    if (tok.t === 'text') {
      ops.push({ k: 0, s: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      ops.push({ k: tok.t === 'raw' ? 2 : 1, p: tok.p });
      continue;
    }
    const tag = tok.tag;
    if (tag.startsWith('for ')) {
      const rest = tag.slice(4);
      if (!isNameStart(rest.charCodeAt(0))) throw notATag(tag);
      let j = 0;
      while (j < rest.length && isNameChar(rest.charCodeAt(j))) j++;
      if (rest.slice(j, j + 4) !== ' in ') throw notATag(tag);
      const pathText = rest.slice(j + 4);
      if (pathText === '' || hasWS(pathText)) throw notATag(tag);
      const op = { k: 3, name: rest.slice(0, j), p: pathOf(name, pathText), end: -1 };
      ops.push(op);
      stack.push({ kind: 'for', op: ops.length - 1, els: -1 });
      continue;
    }
    if (tag.startsWith('if ')) {
      const rest = tag.slice(3);
      let not = false;
      let pathText = rest;
      if (rest.startsWith('not ')) {
        not = true;
        pathText = rest.slice(4);
      }
      if (pathText === '' || hasWS(pathText)) throw notATag(tag);
      const op = { k: 4, p: pathOf(name, pathText), not, els: -1, end: -1 };
      ops.push(op);
      stack.push({ kind: 'if', op: ops.length - 1, els: -1 });
      continue;
    }
    if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.els !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
      const op = { k: 5, end: -1 };
      ops.push(op);
      top.els = ops.length - 1;
      ops[top.op].els = ops.length - 1;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      ops.push({ k: 6 });
      ops[top.op].end = ops.length - 1;
      if (top.els !== -1) ops[top.els].end = ops.length - 1;
      stack.pop();
      continue;
    }
    if (tag.startsWith('include "') && tag.endsWith('"') && tag.length >= 11) {
      const nm = tag.slice(9, -1);
      let ok = nm.length > 0;
      for (let i = 0; ok && i < nm.length; i++) {
        const c = nm.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      if (ok) {
        ops.push({ k: 7, name: nm, ops: null });
        continue;
      }
    }
    throw notATag(tag);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return ops;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered with `rootVars` as the outermost scope. An explicit control
 * stack drives loops and includes; no recursion, no scope chain per element.
 */
function renderOps(ops, rootVars) {
  const chunks = [];
  const ctl = [];
  const scopes = [rootVars];
  let cur = ops;
  let pc = 0;
  let depth = 0;
  for (;;) {
    while (pc < cur.length) {
      const op = cur[pc];
      switch (op.k) {
        case 0:
          chunks.push(op.s);
          pc++;
          break;
        case 1:
          chunks.push(escapeHtml(textOf(lookup(scopes, op.p))));
          pc++;
          break;
        case 2:
          chunks.push(textOf(lookup(scopes, op.p)));
          pc++;
          break;
        case 3: {
          const xs = lookup(scopes, op.p);
          if (Array.isArray(xs) && xs.length > 0) {
            const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
            const frame = {};
            frame[op.name] = xs[0];
            frame.loop = loop;
            scopes.push(frame);
            ctl.push({ k: 3, arr: xs, idx: 0, end: op.end, frame, loop, name: op.name, body: pc + 1, ops: cur });
            pc++;
          } else pc = op.end + 1;
          break;
        }
        case 4: {
          const v = truthy(lookup(scopes, op.p));
          if (v !== op.not) pc++;
          else pc = op.els !== -1 ? op.els + 1 : op.end + 1;
          break;
        }
        case 5:
          pc = op.end + 1;
          break;
        case 6: {
          const top = ctl[ctl.length - 1];
          if (top !== undefined && top.k === 3 && top.end === pc && top.ops === cur) {
            if (top.idx + 1 < top.arr.length) {
              top.idx++;
              top.frame[top.name] = top.arr[top.idx];
              top.loop.index = top.idx + 1;
              top.loop.first = top.idx === 0;
              top.loop.last = top.idx === top.arr.length - 1;
              pc = top.body;
            } else {
              scopes.pop();
              ctl.pop();
              pc++;
            }
          } else pc++;
          break;
        }
        case 7: {
          const t = op.ops;
          if (t !== null && t !== undefined && depth < INCLUDE_DEPTH) {
            ctl.push({ k: 7, ops: cur, pc: pc + 1, depth });
            cur = t;
            pc = 0;
            depth++;
          } else pc++;
          break;
        }
        default:
          pc++;
          break;
      }
    }
    const top = ctl[ctl.length - 1];
    if (top !== undefined && top.k === 7) {
      ctl.pop();
      cur = top.ops;
      pc = top.pc;
      depth = top.depth;
      continue;
    }
    break;
  }
  return chunks.join('');
}

// ------------------------------------------------------------------ links

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A link's href, resolved against the built pages and static files. */
function resolveLink(target, dir, bySource, statics, base, broken, srcPath) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const page = bySource.get(path);
    if (page !== undefined) return page.url + frag;
    if (statics.has(path)) return base + '/' + path + frag;
  }
  broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

// ------------------------------------------------------------------ the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `s` with its trailing slashes dropped. */
function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return s.slice(0, e);
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugMemo = new Map();
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplateOps(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  for (const ops of templates.values()) {
    for (const op of ops) if (op.k === 7) op.ops = templates.get(op.name) ?? null;
  }
  const base = stripTrailingSlashes(input.site.base_url);
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  // Permalinks: each page's output directory and url, its slug unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (t) => resolveLink(t, dir, bySource, staticPaths, base, broken, s.path);
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // Collections: the posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // Tags: grouped by their slug, each named as first met in the posts' order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // Cards and pages, as templates read them.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  // Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    return renderOps(ops, { site, tags: allTags, recent, ...vars });
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
