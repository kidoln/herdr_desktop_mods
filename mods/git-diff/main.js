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
// pane turns into an editor for the file on disk, with Save writing it back only
// while it still matches what was read, then refreshing the diff. A commit's diff is
// no exception: the editor holds the working-tree copy (the only one a save can
// write), while the diff behind keeps showing the commit's version. Leaving with
// unsaved changes asks once.
//
// It never writes to the repository, follows the panel (another click updates the
// same tab), and follows the panel's machine for a remote space.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, Editor, EditorState } from "gpui-base";
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
function buildRows(lines) {
  const side = [], uni = [];
  let old = 0, next = 0, minus = null, plus = null;
  const flush = () => {
    if (!minus && !plus) return;
    const a = minus ?? [], b = plus ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) side.push({ left: a[i] ?? null, right: b[i] ?? null });
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
    if (kind === "-") { if (plus) flush(); minus = minus ?? []; minus.push({ n: old++, text: line.slice(1) || " ", sign: "-" }); continue; }
    if (kind === "+") { plus = plus ?? []; plus.push({ n: next++, text: line.slice(1) || " ", sign: "+" }); continue; }
    if (kind === " ") {
      flush();
      const text = line.slice(1) || " ";
      const cell = { n: next++, text, sign: " " };
      side.push({ left: { n: old++, text, sign: " " }, right: cell });
      uni.push(cell);
      continue;
    }
    flush(); full("meta", line);
  }
  flush();
  return { side, uni };
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
    this.code?.release();
    this.code = null; this.editFile = null; this.saved = null;
    this.dirty = false; this.discard = false; this.editError = null;
  }

  startEdit(cx) {
    const target = this.target;
    if (!this.editable(target) || this.code) return;
    const file = { root: target.root, path: target.path };
    this.editFile = file; this.editError = null; this.discard = false;
    const token = ++this.loadToken;
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(`${file.root}/${file.path}`); } catch {}
      if (this.editFile !== file || this.loadToken !== token) return;
      if (text === null) { this.editError = "This file is not on disk (deleted, or unreadable)"; cx.notify(); return; }
      if (text.includes("\0")) { this.editError = "Binary file \u00b7 cannot edit"; cx.notify(); return; }
      if (text.length >= MAX_EDIT) { this.editError = "File is too large to edit here"; cx.notify(); return; }
      const t = theme();
      this.code = EditorState.new({ language: language(file.path), value: text, font_family: settings().font_family, font_size: 11,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      this.saved = text;
      this.dirty = false;
      // Its own cx: this fires long after the click that made the editor.
      this.code.on("change", (_e, ccx) => { this.dirty = this.code.value() !== this.saved; this.discard = false; ccx.notify(); });
      cx.notify();
    });
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
    cx.notify();
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
    if (row.left !== undefined) {
      return h_flex().w_full().h(ROW).flex_none().items_center()
        .child(this.cell(row.left, t))
        .child(div().w(1).h(ROW).flex_none().bg(t.border))
        .child(this.cell(row.right, t));
    }
    return h_flex().w_full().h(ROW).flex_none().items_center().child(this.cell(row, t));
  }

  body(list, t) {
    return div().flex_1().min_h(0).relative().overflow_hidden()
      .child(v_virtual_list("git-diff-rows", list.length, ROW, (i) => String(i),
        (range) => list.slice(range.start, range.end).map((row) => this.row(row, t))).size_full())
      .child(Scrollbar.vertical("git-diff-rows").viewport_from_layout().absolute().inset_0())
      .when(!list.length, (e) => e.child(div().absolute().top(8).px(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading\u2026" : this.target?.path ? "No text diff" : "Select a file in Git to compare it here"))));
  }

  editorBody(t) {
    if (!this.code) return v_flex().flex_1().min_h(0).p(12).text_color(t.dim).child(this.editError ?? "Loading\u2026");
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.editError), (e) => e.child(div().flex_none().px(10).py(4).bg(t.ansi1 + "22").text_color(t.ansi1).text_size(11).child(this.editError)))
      .child(Editor.new(this.code).flex_1().min_h(0));
  }

  render(cx) {
    this.sync(cx);
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
    try { this.code?.release(); } catch {}
  }
}
