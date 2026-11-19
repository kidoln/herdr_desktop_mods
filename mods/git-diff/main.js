// The diff pane for the git panel. The panel writes what to compare to
// shared("git.diff"); this pane reads it and fetches a byte-capped patch. A wide
// pane shows it side by side — removed and added lines in two aligned columns (old
// left, new right), a removed line and the added line that replaces it sharing a
// row. A narrow pane folds the same rows into one unified column (removals, then
// additions), so lines are never squeezed. A file with nothing to pair against — a
// new file (no old side) or a deleted one (no new side) — always gets that one
// column, full width, every code row green for the addition or red for the removal.
// Hunk headers and file metadata span the full width in both.
//
// For a file on this machine (not a binary), the header carries an Edit button: the
// pane turns into an editor for the file on disk, opening where the diff was looking —
// the row that was clicked (the diff's cursor) or else the first row on screen — with
// that line in the middle of the pane and the caret on it, and scrolling back to its
// row on the way out. The caret's line is marked with a band behind the text, followed
// as the caret moves. Save writes it back only while it still matches what was read,
// then refreshes the diff. A commit's diff is no exception: the editor holds the
// working-tree copy (the only one a save can write), while the diff behind keeps
// showing the commit's version. Leaving with unsaved changes asks once.
//
// It never writes to the repository, follows the panel (another click updates the
// same tab), and follows the panel's machine for a remote space.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, Editor, EditorState, VirtualListScrollHandle } from "gpui-base";
import { shared, exec, readTextFile, writeTextFile, theme, settings } from "herdr";

// The same read flags the git panel uses: no index refresh, no lock, no fsmonitor
// cookie, so watching the repository does not see our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CAP = 600000;      // bytes of a single patch we keep; the rest is dropped mid-stream.
const MAX_LINES = 4000;  // diff lines we turn into rows; the rest is dropped.
const ROW = 19;          // one row's height.
const GUT = 46;          // the line-number gutter in a column.
const NARROW = 420;      // below this width (design px), one column reads better than two.
const COMPACT = 300;     // below this, the header drops the mode chip and shortens its labels.
const TINY = 160;        // below this, the header's buttons are icons only, so they are never pushed out.
const MONO = () => settings().font_family ?? "JetBrains Mono";
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

// The editor's language: the extension, or the same aliases the Files panel uses.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const language = (path) => { const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt"; return LANG[ext] ?? ext; };
const MAX_EDIT = 1048576; // readTextFile's cap: a longer file cannot round-trip a save
const EDIT_FONT = 11;     // the editor's font size (design px)
const EDIT_LINE = 17.5;   // one editor line's height at EDIT_FONT (design px); the caret band's height too
const icon = (name) => svg(`mods/git-diff/${name}.svg`).flex_none();

// Real red / green row tints: saturated bases at a readable alpha. The theme's ANSI
// red and green are pastel (built for text on a terminal), so at a low alpha they
// wash out to gray; these keep their hue over any theme background, dark or light.
const RED = () => (settings().dark ? "#f85149" : "#cf222e");
const GREEN = () => (settings().dark ? "#3fb950" : "#1a7f37");
const TINT_ALPHA = () => (settings().dark ? "3d" : "24");
const tint = (sign) => (sign === "-" ? RED() + TINT_ALPHA() : sign === "+" ? GREEN() + TINT_ALPHA() : null);

// A unified-diff line list, turned into rows two ways at once: `side` pairs each
// run of "-" lines with the "+" run that follows, index by index (for the two-column
// view); `uni` re-expands every run in unified order, removals then additions (for
// the one-column view a narrow pane falls back to). Context lines fill both sides /
// appear once. Hunk headers and file metadata become full-width rows in both.
//
// Every code row also carries `line`: the row's place in the working-tree file,
// which is the copy the editor opens — the new side's number for a context or
// added line, and for a removal, which the new file no longer has, the line the
// new file puts where it was. A jump from the diff to the editor aims there.
function buildRows(lines) {
  const side = [], uni = [];
  let old = 0, next = 0, minus = null, plus = null;
  const flush = () => {
    if (!minus && !plus) return;
    const a = minus ?? [], b = plus ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const left = a[i] ?? null, right = b[i] ?? null;
      side.push({ left, right, line: (right ?? left)?.line ?? null });
    }
    for (const cell of a) uni.push(cell);
    for (const cell of b) uni.push(cell);
    minus = plus = null;
  };
  const full = (kind, text) => { const row = { full: kind, text }; side.push(row); uni.push(row); };
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { flush(); old = +hunk[1]; next = +hunk[2]; full("hunk", line); continue; }
    if (/^(diff --git|index |new file|deleted file|old mode|new mode|similarity|dissimilarity|rename |copy |\+\+\+ |--- |\\ No newline|Binary files )/.test(line)) {
      flush(); full("meta", line); continue;
    }
    const kind = line[0];
    if (kind === "-") { if (plus) flush(); minus = minus ?? []; minus.push({ n: old++, text: line.slice(1) || " ", sign: "-", line: next }); continue; }
    if (kind === "+") { plus = plus ?? []; const n = next++; plus.push({ n, text: line.slice(1) || " ", sign: "+", line: n }); continue; }
    if (kind === " ") {
      flush();
      const text = line.slice(1) || " ";
      const n = next++;
      const cell = { n, text, sign: " ", line: n };
      side.push({ left: { n: old++, text, sign: " ", line: n }, right: cell, line: n });
      uni.push(cell);
      continue;
    }
    flush(); full("meta", line);
  }
  flush();
  return { side, uni };
}

// The working-tree line a row stands for. Hunk headers and file metadata have
// none, so a row scrolled to the top resolves to the nearest code row: the next
// one down, else the last one up.
function lineOf(list, index) {
  const start = Math.max(0, Math.min(index, list.length - 1));
  for (let i = start; i < list.length; i++) if (list[i].line) return list[i].line;
  for (let i = start - 1; i >= 0; i--) if (list[i].line) return list[i].line;
  return null;
}

// A byte-capped patch: `git ... | head -c CAP` so a huge diff stops early instead
// of stalling or blowing the output limit. Falls back to a plain (also capped)
// call if there is no `sh`, and throws with git's own message when it truly fails.
async function patch(root, on, args) {
  try {
    const script = `git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false "$@" | head -c ${CAP}`;
    const r = await exec("sh", ["-c", script, "git", ...args], { cwd: root, on });
    if (r.code === 0 && r.stdout) return r.stdout;
  } catch {}
  const r = await exec("git", [...READ, ...args], { cwd: root, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git failed");
  return r.stdout.slice(0, CAP);
}

async function loadRows(target) {
  const { root, on, mode, path } = target;
  if (mode === "work" && target.untracked && !target.binary) {
    const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
    if (text === null) return buildRows(["Cannot preview this file (binary, too large, or unreadable)"]);
    if (text.includes("\0")) return buildRows(["Binary file \u00b7 no text diff"]);
    const n = countLines(text);
    // Untracked: the worktree copy is the whole story, so every line is an addition.
    return { ...buildRows([`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, MAX_LINES).map((l) => `+${l}`)]), kind: "added" };
  }
  const args = mode === "commit"
    ? ["show", "--no-color", "--no-ext-diff", "--no-textconv", target.commit, "--", path]
    : ["diff", ...(mode === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
  const out = await patch(root, on, args);
  const all = out.replace(/\n$/, "").split("\n");
  const start = all.findIndex((l) => l.startsWith("diff --git"));
  const hunk = all.findIndex((l) => l.startsWith("@@"));
  if (!out.trim() || hunk < 0) return buildRows([target.binary ? "Binary file changed" : "No text diff"]);
  // Keep the file's banner (diff --git / index / --- / +++), drop any commit header.
  const lines = (start >= 0 ? all.slice(start) : all.slice(hunk)).slice(0, MAX_LINES);
  // git says so itself when there is no old version (a new file) or no new one (a
  // deleted file). Such a diff has no second side to align, so the pane shows it in
  // one column whatever its width — every code row green (addition) or red (removal).
  const kind = lines.some((l) => l.startsWith("new file mode ")) ? "added"
    : lines.some((l) => l.startsWith("deleted file mode ")) ? "deleted" : "mixed";
  return { ...buildRows(lines), kind };
}

export default class GitDiff extends View {
  init(_props, cx) {
    this.seq = null;
    this.target = null;
    this.rows = [];   // paired rows, for the two-column view
    this.uni = [];    // the same lines in unified order, for the one-column view
    this.kind = "mixed"; // "added" / "deleted": always one column (nothing to pair)
    this.paneW = 0;   // the pane's width in design px (zoom-independent)
    this.loading = false; this.error = null;
    this.loadToken = 0;                 // guards a stale fetch after a save reloads it
    this.code = null;                   // the EditorState while editing
    this.editFile = null;               // {root, path} the editor holds
    this.saved = null;                  // the text the editor read / last saved
    this.dirty = false;
    this.saving = false;
    this.discard = false;               // leaving with unsaved changes asks once
    this.editError = null;              // read/save problem, shown above the editor
    this.edH = 0;                       // the editor's height, in design px, once laid out
    this.editTopPx = 0;                 // the editor's scroll from the file's top, in design px
    this.editCaret = null;              // the editor caret's line
    this.editLine = 1;                  // the line it opens on: the diff's cursor or top row
    this.editText = null;               // the text its caret offsets count in
    this.editLines = null;              // that text, split
    this.editCount = 0;                 // how many lines it has
    this.caretTask = null;              // follows the caret while editing
    this.scroll = VirtualListScrollHandle.new(); // the diff's position, so it can be gone back to
    this.viewTop = null;                // the first row on screen's line in the working-tree file
    this.cursorLine = null;             // the diff row clicked last: a line, not a row, so it survives the one-column fold
    // The target is watched from here, not from render(): starting a fetch there
    // interrupts the frame it was asked for.
    this.sync(cx);
    cx.timer.every(300, (cx) => this.sync(cx));
  }

  // Re-derives the rows whenever the panel publishes a new target. Guarded by the
  // sequence number, so a stale fetch never overwrites a newer one.
  sync(cx) {
    const target = shared("git.diff");
    const seq = target?.seq ?? 0;
    if (seq === this.seq) return;
    this.seq = seq;
    this.target = target ?? null;
    this.rows = []; this.uni = []; this.kind = "mixed"; this.error = null;
    this.cursorLine = null; this.viewTop = null;
    // Another file was picked: leave the editor when nothing would be lost, and
    // keep it (and its unsaved text) when there is.
    if (this.editFile && !this.dirty && (target?.root !== this.editFile.root || target?.path !== this.editFile.path)) this.leave();
    if (!target || !target.root || !target.path) { this.loading = false; return; }
    this.fetch(target, cx);
  }

  // Reads the patch this target names into both row shapes. Every fetch carries a
  // token, so a save reloading the diff never races a target the panel published.
  fetch(target, cx) {
    const token = ++this.loadToken;
    this.loading = true;
    cx.spawn(async (cx) => {
      let rows = null, error = null;
      try { rows = await loadRows(target); }
      catch (e) { error = String(e); }
      if (this.loadToken !== token) return;
      this.rows = rows?.side ?? [];
      this.uni = rows?.uni ?? [];
      this.kind = rows?.kind ?? "mixed";
      this.error = error; this.loading = false;
      cx.notify();
    });
  }

  // ---- editing the live file ----

  // Editable: this machine (writes are local) and text. A commit's diff is no
  // exception: the editor holds the working-tree file, the copy a save writes.
  editable(target) { return Boolean(target?.path) && !target.on && !target.binary; }

  leave() {
    this.caretTask?.cancel(); this.caretTask = null;
    this.code?.release();
    this.code = null; this.editFile = null; this.saved = null;
    this.dirty = false; this.discard = false; this.editError = null;
    this.editCaret = null;
    this.editText = null; this.editLines = null; this.editCount = 0;
    this.edH = 0; this.editTopPx = 0;
  }

  startEdit(cx) {
    const target = this.target;
    if (!this.editable(target) || this.code) return;
    const file = { root: target.root, path: target.path };
    // Where it opens: the row clicked in the diff, else the first one on screen —
    // read now, before the click could change either or a render could pass.
    const openLine = Math.round(this.cursorLine ?? this.viewTop ?? 1) || 1;
    this.editFile = file; this.editError = null; this.discard = false;
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(`${file.root}/${file.path}`); } catch {}
      if (this.editFile !== file) return;
      if (text === null) { this.editError = "This file is not on disk (deleted, or unreadable)"; cx.notify(); return; }
      if (text.includes("\0")) { this.editError = "Binary file \u00b7 cannot edit"; cx.notify(); return; }
      if (text.length >= MAX_EDIT) { this.editError = "File is too large to edit here"; cx.notify(); return; }
        this.edH = 0; this.editTopPx = 0; this.editCaret = null;
      this.editText = text;
      this.editLines = text.split("\n");
      this.editCount = Math.max(1, this.editLines.length - Number(text.endsWith("\n")));
      this.editLine = Math.max(1, Math.min(this.editCount, openLine));
      const t = theme();
      this.code = EditorState.new({ language: language(file.path), value: text, font_family: settings().font_family, font_size: EDIT_FONT,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      this.saved = text;
      this.dirty = false;
      // Its own cx: this fires long after the click that made the editor.
      this.code.on("change", (_e, ccx) => {
        const value = this.code.value();
        this.dirty = value !== this.saved;
        this.discard = false;
        this.editText = value;
        ccx.notify();
      });
      cx.notify();
    });
  }

  // The selection's caret in the text, 1-based.
  lineAt(offset) {
    const text = this.editText ?? "";
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  }

  put(line) {
    const code = this.code, lines = this.editLines;
    if (!code || !lines) return;
    const n = Math.max(1, Math.min(this.editCount, Math.round(line) || 1));
    let offset = 0;
    for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
    code.set_selected_range({ start: offset, end: offset });
  }

  // Opens on the diff's line, in the middle of the pane, and keeps the band there
  // as the caret moves. The editor only scrolls a caret that is out of sight, and
  // only as far as it must: a line below the view lands on the bottom edge, one
  // above on the top. So the line whose row ends at the bottom edge of the wanted
  // scroll goes first; the wanted line is in view by then, so the caret lands on
  // it without moving the view again.
  placeEdit(cx) {
    const code = this.code;
    if (!code || !this.editText || !(this.edH > 0)) return; // no size yet: the layout reports again
    this.caretTask?.cancel();
    const L = EDIT_LINE, H = this.edH, count = this.editCount;
    const maxTop = Math.max(0, count * L - H);
    const want = Math.max(0, Math.min(maxTop, (this.editLine - 1) * L - (H - L) / 2));
    const bottom = Math.max(1, Math.min(count, Math.round((want + H) / L)));
    // The scroll this lands on, kept here: the band's offset follows it.
    let top = Math.max(0, Math.min(maxTop, bottom * L - H));
    let caret = this.editLine;
    this.editTopPx = top;
    this.editCaret = caret;
    this.put(bottom);
    cx.timer.after(80, (cx) => { if (this.code !== code) return; this.put(this.editLine); code.focus(); cx.notify(); });
    // The band is drawn beside the editor, not by it: the caret's line is read from
    // its selection and its scroll is mirrored here, the same rule the editor uses.
    this.caretTask = cx.timer.every(160, (cx) => {
      const ed = this.code;
      if (ed !== code || !this.editText) return;
      let line;
      try { line = this.lineAt(ed.selected_range().start); } catch { this.caretTask?.cancel(); this.caretTask = null; return; }
      let t = top;
      if ((line - 1) * L < t) t = (line - 1) * L;
      else if (line * L > t + H) t = line * L - H;
      t = Math.max(0, Math.min(maxTop, t));
      if (t !== top || line !== caret) {
        top = t; caret = line;
        this.editTopPx = t;
        this.editCaret = line;
        cx.notify();
      }
    });
    cx.notify();
  }

  // The diff's own cursor: the row clicked last, remembered as a line so it holds
  // when the pane folds to one column (the row indexes differ there).
  pick(list, index, cx) {
    const line = lineOf(list, index);
    if (line == null || line === this.cursorLine) return;
    this.cursorLine = line;
    cx.notify();
  }

  save(cx) {
    if (!this.code || !this.editFile || this.saving) return;
    const file = this.editFile, text = this.code.value(), expected = this.saved;
    if (text === expected) { this.dirty = false; cx.notify(); return; }
    this.saving = true; this.editError = null;
    cx.spawn(async (cx) => {
      try {
        // Refused when the file changed underneath: the snapshot in `saved` is the
        // one this text was edited from, and overwriting a newer version loses it.
        await writeTextFile(`${file.root}/${file.path}`, text, expected);
        if (this.editFile !== file) return;
        this.saved = text; this.dirty = false;
        if (this.target) this.fetch(this.target, cx); // the diff behind is now stale
      } catch (e) {
        if (this.editFile === file) this.editError = `Cannot save \u00b7 ${e}`;
      } finally {
        if (this.editFile === file) { this.saving = false; cx.notify(); }
      }
    });
  }

  back(cx) {
    if (!this.code) return;
    // Leaving with unsaved changes takes a second press, so a stray click
    // cannot drop them.
    if (this.dirty && !this.discard) { this.discard = true; cx.notify(); return; }
    this.leave();
    this.restore(cx);
    cx.notify();
  }

  // Back to the diff in the row it was left at: the list is a fresh element now
  // (the editor stood in its place), so the position is asked for again. The
  // stored value is a line, which the row is found by in either column shape.
  restore(cx) {
    const line = this.viewTop;
    if (!(line > 0)) return;
    cx.timer.after(60, (cx) => {
      const list = this.kind !== "mixed" || (this.paneW > 0 && this.paneW < NARROW) ? this.uni : this.rows;
      const index = list.findIndex((row) => row.line && row.line >= line);
      if (index <= 0) return;
      this.scroll.scroll_to_item(index, "top");
      cx.notify();   // the request is taken up by the frame after it is made
    });
  }

  // An empty label makes the button icon-only: in a very narrow pane a word
  // would not fit, and an invisible button is worse than a wordless one.
  button(id, label, name, onClick, t, solid) {
    const el = h_flex().id(id).flex_none().h(18).px(7).gap(5).items_center().rounded(5).cursor_pointer().text_size(10.5)
      .on_click(onClick)
      .child(icon(name).size(12))
      .when(Boolean(label), (e) => e.child(div().child(label)));
    return (solid ? el.bg(t.solid).text_color(t.solid_foreground) : el.bg(t.raised).border_1().border_color(t.border).text_color(t.muted))
      .hover((s) => s.bg(solid ? t.solid : t.hover));
  }

  mode(t) { return t.mode === "commit" ? `Commit ${t.commitShort ?? ""}`.trim() : t.mode === "staged" ? "Staged" : "Working Tree"; }

  header(t) {
    // A narrow pane must still show its controls, so the header gives room up in
    // two steps: the mode chip goes first, then the buttons keep only their icon.
    // Nothing is ever laid out past the pane's edge (where it would be invisible).
    const narrow = this.paneW > 0 && this.paneW < COMPACT;
    const tiny = this.paneW > 0 && this.paneW < TINY;
    if (this.editFile) {
      const discard = this.dirty && this.discard;
      const back = this.button("git-diff-back", tiny ? "" : discard ? (narrow ? "Discard?" : "Discard changes?") : "Diff", "chevron-left",
        (_e, cx) => { cx.stop_propagation(); this.back(cx); }, t, false);
      const save = this.button("git-diff-save", tiny ? "" : this.saving ? "Saving\u2026" : "Save", "disk",
        (_e, cx) => { cx.stop_propagation(); this.save(cx); }, t, this.dirty);
      return h_flex().h(26).flex_none().px(6).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(back)
        .when(!narrow, (e) => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(discard ? t.ansi1 : t.dim)
          .child(this.dirty ? "Editing \u00b7 modified" : "Editing")))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(this.editFile.path))
        .child(save);
    }
    const target = this.target;
    return h_flex().h(26).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(target?.path) && !narrow, (e) => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(this.mode(target))))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(target?.path ? t.foreground : t.dim).child(target?.path ?? "Diff"))
      .when(this.editable(target), (e) => e.child(this.button("git-diff-edit", tiny ? "" : "Edit", "pencil",
        (_e, cx) => { cx.stop_propagation(); this.startEdit(cx); }, t, false)));
  }

  cell(side, t) {
    const color = tint(side?.sign);
    const gutter = side?.sign === "-" ? RED() : side?.sign === "+" ? GREEN() : t.dim;
    return h_flex().flex_1().min_w(0).h(ROW).items_center().overflow_hidden()
      .when(Boolean(color), (e) => e.bg(color))
      .child(div().w(GUT).flex_none().pr(8).text_right().text_color(gutter).child(side ? String(side.n) : ""))
      .child(div().flex_1().min_w(0).truncate().child(side ? side.text : ""));
  }

  row(row, t) {
    if (row.full) {
      return div().w_full().h(ROW).flex_none().px(8).truncate()
        .when(row.full === "hunk", (e) => e.bg(t.raised))
        .text_color(t.dim).child(row.text);
    }
    // The clicked row, under its red or green wash: a faint accent so the line
    // the editor will land on is the one that reads as chosen.
    const cursor = Boolean(row.line) && row.line === this.cursorLine;
    if (row.left !== undefined) {
      return h_flex().w_full().h(ROW).flex_none().items_center()
        .when(cursor, (e) => e.bg(t.accent + "1a"))
        .child(this.cell(row.left, t))
        .child(div().w(1).h(ROW).flex_none().bg(t.border))
        .child(this.cell(row.right, t));
    }
    return h_flex().w_full().h(ROW).flex_none().items_center()
      .when(cursor, (e) => e.bg(t.accent + "1a"))
      .child(this.cell(row, t));
  }

  body(list, t) {
    return div().flex_1().min_h(0).relative().overflow_hidden()
      .child(v_virtual_list("git-diff-rows", list.length, ROW, (i) => String(i), (range) => {
        // What the top of the pane shows: where the editor opens, and where the
        // diff is put back on the way out (a line, so it survives a fold).
        this.viewTop = lineOf(list, range.start);
        return list.slice(range.start, range.end).map((row) => this.row(row, t));
      }).track_scroll(this.scroll).on_item_click((key, cx) => this.pick(list, Number(key), cx)).size_full())
      .child(Scrollbar.vertical("git-diff-rows").viewport_from_layout().absolute().inset_0())
      .when(!list.length, (e) => e.child(div().absolute().top(8).px(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading\u2026" : this.target?.path ? "No text diff" : "Select a file in Git to compare it here"))));
  }

  editorBody(t) {
    if (!this.code) return v_flex().flex_1().min_h(0).p(12).text_color(t.dim).child(this.editError ?? "Loading\u2026");
    const mark = this.editCaret != null && this.edH > 0;
    const y = mark ? (this.editCaret - 1) * EDIT_LINE - this.editTopPx : 0;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.editError), (e) => e.child(div().flex_none().px(10).py(4).bg(t.ansi1 + "22").text_color(t.ansi1).text_size(11).child(this.editError)))
      .child(v_flex().id("git-diff-editor").flex_1().min_h(0).relative().overflow_hidden().bg(t.background)
        // Its height is what places the editor: the layout reports it once the
        // pane has a size.
        .on_size_change((size, cx) => {
          const h = size.height / settings().zoom;
          if (!(h > 0) || Math.abs(h - this.edH) < 0.5) return;
          this.edH = h;
          if (this.editCaret != null) this.editLine = this.editCaret;   // a resize keeps the line it is on
          if (this.editText) this.placeEdit(cx);
        })
        // The caret's line, behind the text: the editor paints no background of
        // its own here, so the band shows through and the text stays crisp.
        .when(mark, (e) => e.child(div().absolute().left(0).right(0).top(y).h(EDIT_LINE).bg(t.accent + "2e")))
        .child(Editor.new(this.code).flex_1().min_h(0).bg("#00000000")));
  }

  render(cx) {

    const t = theme();
    // A new or deleted file has no other side to align against, so it stays one
    // column whatever the width. For everything else two columns need room for a
    // gutter and readable text in each; below that the same lines fold into one
    // unified column instead of squeezing both.
    const list = this.kind !== "mixed" || (this.paneW > 0 && this.paneW < NARROW) ? this.uni : this.rows;
    return v_flex().id("git-diff").size_full().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const w = size.width / settings().zoom;
        if (Math.abs(w - this.paneW) > 0.5) { this.paneW = w; cx.notify(); }
      })
      .bg(t.background).text_color(t.foreground).text_size(11).font_family(MONO())
      .child(this.header(t))
      .child(this.editFile ? this.editorBody(t) : this.body(list, t));
  }

  async close() {
    this.caretTask?.cancel();
    try { this.code?.release(); } catch {}
  }
}
