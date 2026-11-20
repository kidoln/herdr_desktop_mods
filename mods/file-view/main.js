// The file pane for the Files panel, in the main area: an editor for text files
// and a picture viewer for image files (PNG, JPEG, GIF, WebP, BMP, ICO, SVG).
// Clicking a file in the panel publishes what to open to
// shared("files.view"); this pane reads it, shows it right away, and writes
// text back from the Save button in its header (top right) -- the same
// read/edit/write contract as the git-diff pane's editor, with the editor as
// the pane's whole state. Saving is refused while the file changed on disk
// since it was read (writeTextFile's expected snapshot), and a file too large
// to read whole, or one on another machine, opens read-only instead (a write
// could not round-trip it).
// A picture is never read as text: image() reads from the app's own folder, so
// the bytes are copied into data/file-view/ first, under a fresh name per load
// (a rewritten file must not come back from an old cache entry), and only the
// copy plus its pixel size are kept. A picture bigger than the pane shows
// scaled down; clicking it (or the header's 1:1 / Fit chip) shows it at its own
// size, scrolling whatever does not fit.
// Clicking the file the tab already shows closes it again (the panel's own
// click toggles), and another file opens in the same tab. A picked file never
// throws away unsaved edits: while the editor is modified it waits, and the
// save releases it. The header's find field searches the whole text (unsaved
// edits included); while it holds a query the pane draws the text itself, every
// match a yellow run and the current one stronger, and Enter walks them. The
// editor paints a selection only while it holds the keyboard, which the find
// field does, so the matches are drawn rather than selected. Its Wrap chip
// (Alt+Z) soft-wraps long lines and stays as the person left it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { shared, readTextFile, writeTextFile, theme, settings, appHome, exec, nextCommand } from "herdr";
import * as fs from "fs/promises";
import { join } from "path";
import { Buffer } from "buffer";
import { randomUUID } from "crypto";

// The editor's language: the extension, or the same aliases the Files panel uses.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const language = (path) => { const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt"; return LANG[ext] ?? ext; };
const MAX_EDIT = 1048576; // readTextFile's cap: a longer file cannot round-trip a save
const MAX_VIEW = 400000;  // what a read-only view keeps of a longer file
const MONO = () => settings().font_family ?? "JetBrains Mono";
const icon = (name) => svg(`mods/file-view/${name}.svg`).flex_none();
const SEARCH_DEBOUNCE = 120; // ms after the last keystroke before a search runs
const SEARCH_MAX = 5000;     // matches kept: enough to navigate any real file
const ROW = 18;              // px per row of the find view
const CHAR_W = 7.2;          // a column at 12px in JetBrains Mono: columns per row

// The index of the first entry greater than `v`, in an ascending array.
function upperBound(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

// Picture files, by extension. image() reads from the app's own folder only, so
// the bytes are copied into COPY_DIR first and the pane keeps the copy.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const COPY_DIR = "data/file-view"; // under appHome()
const IMAGE_MAX = 33554432;        // 32 MiB: more than this is not copied in
const REMOTE_MAX = 6291456;        // base64 comes back through exec, whose output stops at 8 MiB
const COPIES = 16;                 // copies kept; older ones are pruned on the next load
const extOf = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
const isImage = (p) => IMAGE_EXT.has(extOf(p));
const bytesLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// The pixel size read off the file's header: PNG, GIF, BMP, WebP, JPEG, ICO
// and SVG say it early enough. null when the format does not (or these are not
// picture bytes at all), and then the picture is shown unscaled.
function imageSize(u8) {
  const be32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const le16 = (o) => u8[o] | (u8[o + 1] << 8);
  const le32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  if (u8.length >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e) return { w: be32(16), h: be32(20) };
  if (u8.length >= 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return { w: le16(6), h: le16(8) };
  if (u8.length >= 26 && u8[0] === 0x42 && u8[1] === 0x4d) return { w: le32(18), h: le32(22) };
  if (u8.length >= 30 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) {
    const kind = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (kind === "VP8X") return { w: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), h: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)) };
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L") { const bits = le32(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8) { // JPEG: hunt for the frame header
    let o = 2;
    while (o + 9 < u8.length) {
      if (u8[o] !== 0xff) { o += 1; continue; }
      const mark = u8[o + 1];
      if (mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc) return { w: (u8[o + 7] << 8) | u8[o + 8], h: (u8[o + 5] << 8) | u8[o + 6] };
      if (mark === 0x01 || (mark >= 0xd0 && mark <= 0xd8)) { o += 2; continue; }
      const len = (u8[o + 2] << 8) | u8[o + 3];
      if (len < 2) break;
      o += 2 + len;
    }
    return null;
  }
  if (u8.length >= 8 && u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0) return { w: u8[6] || 256, h: u8[7] || 256 };
  if (u8[0] === 0x3c) { // "<": XML, so probably an SVG: its viewBox, else its width/height
    const head = Buffer.from(u8.slice(0, 4096)).toString("utf8");
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(head);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return { w: Math.round(Number(vb[1])), h: Math.round(Number(vb[2])) };
    const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(head), h = /\bheight\s*=\s*["']([\d.]+)/i.exec(head);
    if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) };
  }
  return null;
}

// Old copies go: the names start with the load's timestamp in base36, so name
// order is age order. A copy still shown only goes past COPIES newer ones.
async function pruneCopies() {
  try {
    const dir = join(appHome(), COPY_DIR);
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    for (const name of names.slice(0, Math.max(0, names.length - COPIES))) {
      await fs.unlink(join(dir, name)).catch(() => {});
    }
  } catch {}
}

export default class FileView extends View {
  init(_props, cx) {
    this.seq = null;
    this.target = null;     // the file the panel published (it waits while edits are unsaved)
    this.editFile = null;   // { root, path, on }: the file the editor holds
    this.code = null;       // EditorState
    this.image = null;      // { name, w, h, bytes }: the picture copy in the app folder
    this.shownImage = null; // the file that copy came from, so a reselect is not reloaded
    this.oneToOne = false;  // show the picture at its own size, not scaled to the pane
    this.size = null;       // the pane's size, from on_size_change
    this.saved = null;      // the text the editor read / last saved
    this.dirty = false;
    this.readOnly = false;  // view only: on another machine, or too large to round-trip
    this.saving = false;
    this.error = null;      // nothing to edit (binary, gone, unreadable)
    this.saveError = null;  // a refused save, shown above the editor
    this.loading = false;
    this.loadToken = 0;     // guards a stale read after the panel picked another file

    // The editor's own view options, not the file's: soft wrap stays as the
    // person left it (per pane), and the search is over what the editor holds
    // now, unsaved edits included.
    this.wrap = localStorage.getItem("wrap") === "1";
    this.lastWrapToggle = 0; // Alt+Z can arrive as both a command and a key
    this.handle = cx.focus_handle();
    this.query = "";
    this.matches = [];       // match start offsets in the editor's text
    this.matchIndex = -1;
    this.searchTimer = null;
    // The find view: the file's lines cut into rows of `cols` columns, one
    // virtual row per (line, chunk), with the runs of each match beside them.
    this.searchScroll = VirtualListScrollHandle.new();
    this.searchText = "";
    this.searchLines = [];   // { start, end } per file line
    this.rowFirst = [];      // the row each line starts on
    this.searchMarks = new Map(); // line -> [{ from, to, cur }]
    this.lineCount = 0;
    this.cols = 80;
    this.rows = 0;
    this.currentRow = -1;
    this.revealToken = 0;
    this.search = InputState.new({ placeholder: "Search in file\u2026" });
    this.search.on("change", (_e, ccx) => this.onSearch(ccx));
    this.search.on("submit", (e, ccx) => this.stepMatch(e?.shift ? -1 : 1, ccx));
    cx.spawn(async (cx) => {
      for (;;) {
        let cmd;
        try { cmd = await nextCommand(); } catch { return; }
        if (cmd === "toggle_wrap") this.toggleWrap(cx);
        else if (cmd === "clear_search" && this.query) this.clearSearch(cx);
      }
    });
  }

  sameFile(a, b) { return Boolean(a && b) && a.root === b.root && a.path === b.path && (a.on ?? null) === (b.on ?? null); }

  // ---- search and wrap ----

  // A new file starts with a clean find bar: the old file's matches are not
  // this file's.
  resetSearch() {
    if (this.searchTimer) { try { this.searchTimer.cancel(); } catch {} this.searchTimer = null; }
    this.query = "";
    this.matches = [];
    this.matchIndex = -1;
    this.clearRows();
    try { this.search?.set_value(""); } catch {}
  }

  clearRows() {
    this.searchText = "";
    this.searchLines = [];
    this.rowFirst = [];
    this.searchMarks = new Map();
    this.lineCount = 0;
    this.rows = 0;
    this.currentRow = -1;
  }

  // Typing waits for a short pause, then searches the whole editor text. The
  // first match at or after the caret is shown first, wrapping.
  onSearch(cx) {
    this.query = this.search.value();
    if (this.searchTimer) { try { this.searchTimer.cancel(); } catch {} this.searchTimer = null; }
    if (!this.query) {
      this.matches = []; this.matchIndex = -1;
      this.clearRows();
      cx.notify();
      return;
    }
    this.searchTimer = cx.timer.after(SEARCH_DEBOUNCE, (ccx) => {
      this.searchTimer = null;
      this.findMatches();
      if (!this.matches.length) { this.matchIndex = -1; ccx.notify(); return; }
      let caret = 0;
      try { caret = this.code?.selected_range()?.start ?? 0; } catch {}
      const next = this.matches.findIndex((off) => off >= caret);
      this.matchIndex = next >= 0 ? next : 0;
      this.selectMatch();
      this.buildRows();
      this.revealMatch(ccx);
      ccx.notify();
    });
  }

  // Every occurrence, case-insensitively, in a text the editor may have edited
  // but not saved. Non-overlapping, like a find bar counts.
  findMatches() {
    const text = this.code ? this.code.value() : "";
    const q = this.query;
    this.matches = [];
    if (!text || !q) { this.clearRows(); return; }
    const hay = text.toLowerCase(), needle = q.toLowerCase();
    let at = 0;
    while (this.matches.length < SEARCH_MAX) {
      const i = hay.indexOf(needle, at);
      if (i < 0) break;
      this.matches.push(i);
      at = i + Math.max(1, needle.length);
    }
    this.buildRows();
  }

  // The editor's caret goes to the current match: invisible while the find
  // field holds the keyboard, it is where the editor opens once the search is
  // cleared.
  selectMatch() {
    if (!this.code || this.matchIndex < 0 || !this.matches.length) return;
    const start = this.matches[this.matchIndex];
    try { this.code.set_selected_range({ start, end: start + this.query.length }); } catch {}
  }

  stepMatch(dir, cx) {
    if (!this.code || !this.query) return;
    if (!this.matches.length) this.findMatches();
    if (!this.matches.length) { this.matchIndex = -1; cx.notify(); return; }
    this.matchIndex = ((this.matchIndex + dir) % this.matches.length + this.matches.length) % this.matches.length;
    this.selectMatch();
    this.buildRows();
    this.revealMatch(cx);
    cx.notify();
  }

  // Clearing from the header's button hands the keyboard back to the editor,
  // which scrolls to the match the search had reached.
  clearSearch(cx) {
    const had = Boolean(this.query);
    this.resetSearch();
    if (had) cx.timer.after(30, (ccx) => { try { this.code?.focus(); } catch {} ccx.notify(); });
    cx.notify();
  }

  // ---- the find view ----
  // The file's lines, cut into rows of the pane's columns (a tab counts four),
  // so a long line wraps at a fixed place and every match can be seen. Only the
  // rows on screen are built: the list asks for a range each frame.

  gutterWidth() {
    return String(Math.max(1, this.lineCount || 1)).length * CHAR_W + 12;
  }

  // Columns one row holds: what the pane leaves right of the line numbers.
  searchCols() {
    const z = Number(settings()?.zoom) || 1;
    const avail = Math.max(120, Math.round((this.size?.width ?? 640) / z) - this.gutterWidth() - 18);
    return Math.max(20, Math.floor(avail / CHAR_W));
  }

  // Columns from the start of a line to `off`, tabs counted as four.
  cellsBefore(raw, off) {
    let n = 0;
    for (let i = 0; i < off && i < raw.length; i++) n += raw.charCodeAt(i) === 9 ? 4 : 1;
    return n;
  }

  cellCount(raw) {
    let n = 0;
    for (let i = 0; i < raw.length; i++) n += raw.charCodeAt(i) === 9 ? 4 : 1;
    return n;
  }

  // The rows of the current query: every line's first row, the row each match
  // starts on (so navigation can go there), and the marks by line.
  buildRows() {
    this.clearRows();
    const text = this.code ? this.code.value() : "";
    if (!text || !this.query) return;
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    this.searchText = text;
    this.lineCount = starts.length;
    this.cols = this.searchCols();
    const marks = new Map();
    for (let k = 0; k < this.matches.length; k++) {
      const s = this.matches[k];
      const line = upperBound(starts, s) - 1;
      const run = { from: s - starts[line], to: s - starts[line] + this.query.length, cur: k === this.matchIndex };
      const list = marks.get(line);
      if (list) list.push(run); else marks.set(line, [run]);
    }
    this.searchMarks = marks;
    let start = 0, row = 0, line = 0;
    for (;;) {
      let end = text.indexOf("\n", start);
      const last = end < 0;
      if (last) end = text.length;
      this.searchLines.push({ start, end });
      this.rowFirst.push(row);
      for (const run of marks.get(line) ?? []) {
        if (!run.cur) continue;
        this.currentRow = row + Math.floor(this.cellsBefore(text.slice(start, end), run.from) / this.cols);
      }
      row += Math.max(1, Math.ceil(this.cellCount(text.slice(start, end)) / this.cols));
      line += 1;
      if (last) break;
      start = end + 1;
    }
    this.rows = row;
  }

  // Puts the current match's row in the middle of the pane. The list is
  // mounted a frame after the first search, so the jump is repeated once.
  revealMatch(cx) {
    if (!this.query || this.currentRow < 0) return;
    const token = ++this.revealToken;
    const row = this.currentRow;
    const jump = () => { try { this.searchScroll.scroll_to_item(row, "center"); } catch {} };
    jump();
    try {
      cx.timer.after(40, (ccx) => {
        if (this.revealToken !== token) return;
        jump();
        ccx.notify();
      });
    } catch {}
  }

  // One row: its line number (only on the line's first row) and its text in
  // runs -- plain, a match, or the current match.
  searchRow(index, t) {
    const li = upperBound(this.rowFirst, index) - 1;
    const line = this.searchLines[li];
    let raw = this.searchText.slice(line.start, line.end);
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    const first = index - this.rowFirst[li];
    const startCol = first * this.cols, endCol = startCol + this.cols;
    const runs = this.searchMarks.get(li);
    const segs = [];
    let buf = "", kind = 0, col = 0, mi = 0;
    const flush = () => { if (buf) { segs.push([buf, kind]); buf = ""; } };
    for (let i = 0; i < raw.length && col < endCol; ) {
      const code = raw.charCodeAt(i);
      const w = code === 9 ? 4 : 1;
      let k = 0;
      if (runs) {
        while (mi < runs.length && runs[mi].to <= i) mi++;
        const r = runs[mi];
        if (r && i >= r.from && i < r.to) k = r.cur ? 2 : 1;
      }
      if (col >= startCol) {
        if (k !== kind) { flush(); kind = k; }
        buf += code === 9 ? "    " : raw[i];
      }
      col += w; i += 1;
    }
    flush();
    return h_flex().h(ROW).flex_none().w_full().items_center().overflow_hidden()
      .child(div().w(this.gutterWidth()).flex_none().pr(10).text_size(10.5).text_color(t.dim).text_right()
        .child(first ? "" : String(li + 1)))
      .children(segs.map(([s, k]) => div().flex_none().text_size(12).font_family(MONO())
        .when(k === 1, e => e.bg(t.ansi3 + "5c"))
        .when(k === 2, e => e.bg(t.ansi3).text_color(t.background))
        .child(s)));
  }

  searchBody(t) {
    const rows = this.rows;
    return v_flex().flex_1().min_h(0).relative()
      .child(v_virtual_list("file-view-search", rows, ROW, (i) => String(i), (range) => {
        const out = [];
        for (let i = range.start; i < range.end && i < rows; i++) out.push(this.searchRow(i, t));
        return out;
      }).flex_1().min_h(0).track_scroll(this.searchScroll))
      .child(Scrollbar.vertical("file-view-search").absolute().inset_0());
  }

  // Soft wrap: rebuilding the editor is what applies the new mode (the state
  // has no setter). Value, selection and the modified flag survive; undo
  // history does not.
  toggleWrap(cx) {
    // The same press can reach both the key section (a command) and the
    // element's key handler; one toggle per press either way.
    const now = Date.now();
    if (now - this.lastWrapToggle < 80) return;
    this.lastWrapToggle = now;
    this.wrap = !this.wrap;
    try { localStorage.setItem("wrap", this.wrap ? "1" : "0"); } catch {}
    if (this.code) {
      const value = this.code.value();
      let range = null;
      try { range = this.code.selected_range(); } catch {}
      const path = this.editFile?.path ?? this.target?.path ?? "txt";
      this.code.release();
      this.code = this.createEditor(path, value, this.readOnly);
      if (!this.readOnly) this.watchChanges();
      try { if (range) this.code.set_selected_range(range); } catch {}
      this.findMatches();
      this.matchIndex = this.matches.length ? Math.max(0, Math.min(this.matchIndex, this.matches.length - 1)) : -1;
      if (this.query) { this.buildRows(); this.revealMatch(cx); }
    }
    try { cx.notify(); } catch { cx.timer.after(0, (ccx) => ccx.notify()); }
  }

  createEditor(path, value, readOnly) {
    const t = theme();
    return EditorState.new({ language: language(path), readonly: readOnly, value,
      font_family: settings().font_family, font_size: 12, soft_wrap: Boolean(this.wrap),
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  // The editor's change hook: keeps the modified flag honest and, while a
  // search is up, re-runs it over the edited text.
  watchChanges() {
    if (!this.code) return;
    this.code.on("change", (_e, ccx) => {
      if (!this.code) return;
      this.dirty = this.code.value() !== this.saved;
      this.saveError = null;
      if (this.query) {
        this.findMatches();
        this.matchIndex = this.matches.length ? Math.max(0, Math.min(this.matchIndex, this.matches.length - 1)) : -1;
        this.buildRows();
      }
      ccx.notify();
    });
  }

  // The room the picture has, in the same px the mod draws with: the pane
  // minus the header, the padding and a little air. on_size_change reports the
  // pane before zoom is applied, so the zoom divides it back out. Null until
  // the first layout has come back.
  available() {
    if (!this.size?.width) return null;
    const z = Number(settings()?.zoom) || 1;
    return { w: Math.max(48, Math.round(this.size.width / z) - 24), h: Math.max(48, Math.round(this.size.height / z) - 30 - 24) };
  }

  // Whether the picture at its own size is bigger than the pane, i.e. whether
  // there is anything to toggle between fitting and 1:1.
  shrunk() {
    const i = this.image, box = this.available();
    return Boolean(i?.w && i?.h && box && (i.w > box.w || i.h > box.h));
  }

  // Re-derives the shown file whenever the panel publishes a new target, guarded
  // by the sequence number. Nothing here ever drops a modified editor: the file
  // it edits wins until it is saved.
  sync(cx) {
    const target = shared("files.view");
    const seq = target?.seq ?? 0;
    if (seq === this.seq) return;
    this.seq = seq;
    this.target = target?.path && target.root ? target : null;
    // sync runs at the top of render (a shared-state change is what redraws this
    // pane), so the mutations here are already in this pass's tree; cx.notify()
    // is not allowed during render.
    if (!this.target) {
      if (!this.dirty) { this.leave(); this.loading = false; }
      return;
    }
    // The pane already holds this file: nothing to load, and any read still in
    // flight for another file is stale now.
    if (this.editFile && this.sameFile(this.target, this.editFile)) {
      this.loadToken += 1; this.loading = false;
      return;
    }
    if (this.image && this.sameFile(this.target, this.shownImage)) {
      this.loadToken += 1; this.loading = false;
      return;
    }
    if (this.dirty) return;   // wait: the edits stay until saved
    this.load(this.target, cx);
  }

  // Reads the target into the editor, or copies a picture in for the viewer. The
  // token makes a late read land nowhere; a read that arrives after the file
  // grew modified does not replace it either.
  load(target, cx) {
    const token = ++this.loadToken;
    this.loading = true;
    this.error = null; this.saveError = null;
    if (isImage(target.path)) return this.loadImage(target, token, cx);
    cx.spawn(async (cx) => {
      let text = null, error = null;
      try { text = await readTextFile(`${target.root}/${target.path}`, { on: target.on }); }
      catch (e) { error = String(e); }
      if (this.loadToken !== token) return;                       // a newer read owns the pane now
      if (this.dirty) { this.loading = false; cx.notify(); return; }  // edits won: keep them
      this.code?.release();
      this.code = null; this.editFile = null; this.saved = null;
      this.image = null; this.shownImage = null; this.oneToOne = false;
      this.dirty = false; this.readOnly = false;
      this.resetSearch();
      if (text === null) error = error ?? "This file is no longer available";
      else if (text.includes("\0")) error = "Binary file \u00b7 no text editor";
      else {
        // Another machine's file cannot be written from here, and a file past
        // readTextFile's cap may be truncated: both open as views, not editors.
        this.readOnly = Boolean(target.on) || text.length >= MAX_EDIT;
        this.code = this.createEditor(target.path,
          this.readOnly && text.length > MAX_VIEW ? text.slice(0, MAX_VIEW) + "\n\u2026 (file truncated)" : text,
          this.readOnly);
        this.editFile = { root: target.root, path: target.path, on: target.on ?? null };
        if (!this.readOnly) {
          this.saved = text;
          this.watchChanges();
        }
      }
      this.error = error; this.loading = false;
      cx.notify();
    });
  }

  // Copies the picture where image() can read it and notes its pixel size. Local
  // files are read through fs (the sandbox reads the home folder); a file on
  // another machine comes back as base64 through exec. Nothing is ever read as
  // text, so the pane never mistakes bytes for characters.
  loadImage(target, token, cx) {
    const ext = (extOf(target.path) || "img").replace(/[^a-z0-9]/g, "") || "img";
    const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    const dir = join(appHome(), COPY_DIR);
    cx.spawn(async (cx) => {
      let bytes = null, error = null;
      try {
        const abs = `${target.root}/${target.path}`;
        if (target.on) {
          const probe = await exec("sh", ["-c", 'wc -c < "$1"', "file-view", abs], { on: target.on });
          const size = Number(probe.stdout.trim());
          if (probe.code !== 0 || !(size > 0)) throw new Error("Cannot read the file there");
          if (size > REMOTE_MAX) throw new Error(`Too large to preview (${bytesLabel(size)})`);
          const r = await exec("sh", ["-c", 'base64 < "$1"', "file-view", abs], { on: target.on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read the file there");
          bytes = Buffer.from(r.stdout, "base64");
        } else {
          // exec reaches files the fs sandbox may not (say, outside the home
          // folder); its size keeps a huge file from being read into memory.
          let size = null;
          try { const r = await exec("sh", ["-c", 'wc -c < "$1"', "file-view", abs]); if (r.code === 0) size = Number(r.stdout.trim()); } catch {}
          if (size !== null && size > IMAGE_MAX) throw new Error(`Too large to preview (${bytesLabel(size)})`);
          bytes = await fs.readFile(abs);
        }
        if (!bytes.length) throw new Error("The file is empty");
        if (bytes.length > IMAGE_MAX) throw new Error(`Too large to preview (${bytesLabel(bytes.length)})`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, name), bytes);
      } catch (e) { error = String(e?.message ?? e); bytes = null; }
      if (this.loadToken !== token) return;                        // a newer read owns the pane now
      if (this.dirty) { this.loading = false; cx.notify(); return; }
      this.code?.release();
      this.code = null; this.editFile = null; this.saved = null;
      this.dirty = false; this.readOnly = true; this.oneToOne = false;
      this.resetSearch();
      this.image = bytes ? { name, ...(imageSize(bytes) ?? { w: null, h: null }), bytes: bytes.length } : null;
      this.shownImage = bytes ? { root: target.root, path: target.path, on: target.on ?? null } : null;
      this.error = bytes ? null : error ?? "This file is no longer available";
      this.loading = false;
      if (bytes) pruneCopies().catch(() => {});
      cx.notify();
    });
  }

  leave() {
    this.code?.release();
    this.code = null; this.editFile = null; this.saved = null;
    this.image = null; this.shownImage = null; this.oneToOne = false;
    this.dirty = false; this.readOnly = false; this.saving = false; this.saveError = null;
    this.resetSearch();
  }

  // A refused save (the file changed outside Herdr) leaves a dead end unless the
  // draft can be given up: reload reads the file again, discarding the draft.
  reload(cx) {
    const file = this.target && this.target.path ? this.target : this.editFile;
    if (!file) return;
    this.dirty = false; this.saveError = null;
    this.load(file, cx);
  }

  // Save: writes the editor's text only while the file still matches what was
  // read. A save also releases the file the panel picked while this one was
  // modified -- it opens the moment the edits are safe.
  save(cx) {
    if (!this.code || !this.editFile || this.readOnly || this.saving || !this.dirty) return;
    const file = this.editFile, text = this.code.value(), expected = this.saved;
    this.saving = true; this.saveError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${file.root}/${file.path}`, text, expected);
        if (!this.sameFile(this.editFile, file)) return;
        this.saved = text; this.dirty = false;
        if (this.target && !this.sameFile(this.target, file)) this.load(this.target, cx);
      } catch (e) {
        if (this.sameFile(this.editFile, file)) this.saveError = `Cannot save \u00b7 ${e}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  // The header's right button: solid while there is something to save, dimmed
  // when not (a dimmed press does nothing), reading "Saving\u2026" while the
  // write is out.
  saveButton(t) {
    const ready = this.dirty && !this.saving && Boolean(this.code);
    return h_flex().id("file-view-save").flex_none().h(20).px(8).gap(5).items_center().rounded(6).text_size(11)
      .when(ready, e => e.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover(s => s.opacity(0.88)))
      .when(!ready, e => e.bg(t.raised).border_1().border_color(t.border).text_color(t.dim))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.save(cx); })
      .child(icon("disk").size(12).text_color(ready ? t.solid_foreground : t.dim))
      .child(div().child(this.saving ? "Saving\u2026" : "Save"));
  }

  // Soft wrap, the editor's own switch. Alt+Z runs the same command through the
  // mod's key section; the chip keeps it visible and clickable.
  wrapButton(t) {
    const on = this.wrap;
    return h_flex().id("file-view-wrap").flex_none().h(20).px(7).gap(5).items_center().rounded(6).text_size(10.5)
      .tooltip(on ? "Soft wrap is on (Alt+Z)" : "Soft wrap long lines (Alt+Z)")
      .when(on, e => e.bg(t.selected).text_color(t.foreground).cursor_pointer().hover(s => s.opacity(0.85)))
      .when(!on, e => e.bg(t.raised).border_1().border_color(t.border).text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleWrap(cx); })
      .child(icon("wrap").size(12))
      .child(div().child("Wrap"));
  }

  // The search field in the header, immediately left of Wrap: the input, the
  // match count, previous/next, and a way to clear it.
  searchField(t) {
    const n = this.matches.length;
    const pos = n ? this.matchIndex + 1 : 0;
    const count = this.query ? (n ? `${pos}/${n}` : "0") : "";
    const nav = (name, dir) => h_flex().id(`file-view-search-${name}`).flex_none().w(18).h(18).items_center().justify_center()
      .rounded(5).cursor_pointer().hover(s => s.bg(t.hover)).tooltip(dir < 0 ? "Previous match (Shift+Enter)" : "Next match (Enter)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.stepMatch(dir, cx); })
      .child(icon(name).size(11).text_color(t.muted));
    return h_flex().id("file-view-search").flex_none().gap(4).items_center()
      .child(h_flex().flex_none().h(22).px(6).gap(5).items_center().rounded(5)
        .bg(t.background).border_1().border_color(t.input)
        .child(icon("search").size(11).text_color(t.dim))
        .child(Input.new(this.search).w(170).h(20).text_color(t.foreground).text_size(11)))
      .when(Boolean(count), e => e.child(div().flex_none().px(1).text_size(10.5).text_color(n ? t.muted : t.dim).child(count)))
      .when(n > 0, e => e.child(nav("chevron-up", -1)).child(nav("chevron-down", 1)))
      .when(Boolean(this.query), e => e.child(h_flex().id("file-view-search-clear").flex_none().w(18).h(18).items_center().justify_center()
        .rounded(5).cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Clear search")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.clearSearch(cx); })
        .child(icon("x").size(11).text_color(t.dim))));
  }

  // Fit / 1:1, the picture's own toggle: fitting scales it down to the pane,
  // 1:1 shows it at its pixel size and scrolls the rest.
  fitButton(t) {
    return h_flex().id("file-view-fit").flex_none().h(18).px(7).items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
      .text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.oneToOne = !this.oneToOne; cx.notify(); })
      .child(div().child(this.oneToOne ? "Fit" : "1:1"));
  }

  header(t) {
    const label = this.editFile?.path ?? this.target?.path ?? "File";
    const chip = this.dirty ? "Modified" : this.readOnly && this.code ? "Read-only" : null;
    const i = this.image;
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.editFile || this.target ? t.foreground : t.dim).child(label))
      .when(Boolean(i), e => e.child(div().flex_none().text_size(10.5).text_color(t.dim)
        .child(`${i.w && i.h ? `${i.w}\u00d7${i.h} \u00b7 ` : ""}${bytesLabel(i.bytes)}`)))
      .when(Boolean(i) && this.shrunk(), e => e.child(this.fitButton(t)))
      .when(Boolean(chip), e => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10)
        .text_color(this.dirty ? t.ansi1 : t.dim).child(chip)))
      .when(Boolean(this.code), e => e.child(this.searchField(t)))
      .when(Boolean(this.code), e => e.child(this.wrapButton(t)))
      .when(Boolean(this.editFile) && !this.readOnly, e => e.child(this.saveButton(t)));
  }

  // The picture itself. Scaled to fit unless 1:1 was asked for; clicking it
  // switches between the two whenever there is a difference to see. Without a
  // header size to scale by (an odd SVG, or a picture that lies about its
  // format) it is shown at its own size and scrolled, which crops nothing.
  imageBody(t) {
    const i = this.image;
    if (!i) return div().p(12).text_color(t.dim).child(this.error || (this.loading ? "Loading\u2026" : "Select a file in Files to open it here"));
    const src = image(`${COPY_DIR}/${i.name}`).flex_none();
    const box = this.available();
    if (!i.w || !i.h || !box) {
      return v_flex().flex_1().min_h(0).overflow_scrollbar().p(12).child(src);
    }
    const s = this.oneToOne ? 1 : Math.min(1, box.w / i.w, box.h / i.h);
    const w = Math.max(1, Math.round(i.w * s)), h = Math.max(1, Math.round(i.h * s));
    const toggle = (cx) => { cx.stop_propagation(); this.oneToOne = !this.oneToOne; cx.notify(); };
    if (w > box.w || h > box.h) {
      // At its own size and bigger than the pane: whatever does not fit scrolls.
      return v_flex().flex_1().min_h(0).overflow_scrollbar().p(12)
        .when(w <= box.w, e => e.items_center())
        .when(h <= box.h, e => e.justify_center())
        .child(src.w(w).h(h).cursor_pointer().on_click((_e, cx) => toggle(cx)));
    }
    const clickable = this.shrunk();
    return v_flex().flex_1().min_h(0).items_center().justify_center().p(12).overflow_hidden()
      .child(src.w(w).h(h).when(clickable, e => e.cursor_pointer().on_click((_e, cx) => toggle(cx))));
  }

  body(t) {
    if (this.image || isImage(this.target?.path ?? "")) return this.imageBody(t);
    if (!this.code) return div().p(12).text_color(t.dim)
      .child(this.error || (this.loading ? "Loading\u2026" : "Select a file in Files to open it here"));
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.saveError), e => e.child(h_flex().flex_none().px(10).py(4).gap(8).items_center().bg(t.ansi1 + "22")
        .child(div().flex_1().min_w(0).text_color(t.ansi1).text_size(11).child(this.saveError))
        .child(h_flex().id("file-view-reload").flex_none().h(18).px(7).gap(4).items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
          .text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.reload(cx); })
          .child(div().child("Reload")))))
      .when(this.query && this.rows > 0, e => e.child(this.searchBody(t)))
      .when(!(this.query && this.rows > 0), e => e.child(Editor.new(this.code).flex_1().min_h(0)));
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    return v_flex().id("file-view").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(11).font_family(MONO())
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        // Escape closes a search from anywhere in the pane.
        if (e.key === "escape" && this.query) {
          cx.stop_propagation();
          this.clearSearch(cx);
          return;
        }
        // The editor has no wrap key of its own; catch Alt+Z on the way up.
        if (e.modifiers.alt && !e.modifiers.platform && !e.modifiers.control && e.key?.toLowerCase() === "z") {
          cx.stop_propagation();
          this.toggleWrap(cx);
        }
      })
      .on_size_change((size, cx) => {
        this.size = size;
        // A wider or narrower pane holds other columns per row.
        if (this.query && this.code) {
          const cols = this.searchCols();
          if (cols !== this.cols) { this.buildRows(); this.revealMatch(cx); }
        }
        cx.notify();
      })
      .child(this.header(t))
      .child(this.body(t));
  }

  async close() {
    try { this.code?.release(); } catch {}
  }
}
