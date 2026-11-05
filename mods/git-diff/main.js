// The side-by-side diff pane for the git panel. The panel writes what to compare
// to shared("git.diff"); this pane reads it, fetches a byte-capped patch, and lays
// the removed and added lines out in two aligned columns (old on the left, new on
// the right) — a removed line and the added line that replaces it share a row, so
// the columns always line up. Hunk headers and file metadata span the full width.
//
// It never writes to the repository, follows the panel (another click updates the
// same pane), and follows the panel's machine for a remote space.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { shared, exec, readTextFile, theme, settings } from "herdr";

// The same read flags the git panel uses: no index refresh, no lock, no fsmonitor
// cookie, so watching the repository does not see our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CAP = 600000;      // bytes of a single patch we keep; the rest is dropped mid-stream.
const MAX_LINES = 4000;  // diff lines we turn into rows; the rest is dropped.
const ROW = 19;          // one row's height, shared by both columns.
const GUT = 46;          // the line-number gutter inside each column.
const MONO = () => settings().font_family ?? "JetBrains Mono";
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

// Real red / green row tints: saturated bases at a readable alpha. The theme's ANSI
// red and green are pastel (built for text on a terminal), so at a low alpha they
// wash out to gray; these keep their hue over any theme background, dark or light.
const RED = () => (settings().dark ? "#f85149" : "#cf222e");
const GREEN = () => (settings().dark ? "#3fb950" : "#1a7f37");
const TINT_ALPHA = () => (settings().dark ? "3d" : "24");
const tint = (sign) => (sign === "-" ? RED() + TINT_ALPHA() : sign === "+" ? GREEN() + TINT_ALPHA() : null);

// A unified-diff line list into paired rows. Runs of "-" are paired with the "+"
// run that follows, index by index; context lines fill both sides. Hunk headers
// and file metadata become full-width rows.
function buildRows(lines) {
  const rows = [];
  let old = 0, next = 0, minus = null, plus = null;
  const flush = () => {
    if (!minus && !plus) return;
    const a = minus ?? [], b = plus ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) rows.push({ left: a[i] ?? null, right: b[i] ?? null });
    minus = plus = null;
  };
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { flush(); old = +hunk[1]; next = +hunk[2]; rows.push({ full: "hunk", text: line }); continue; }
    if (/^(diff --git|index |new file|deleted file|old mode|new mode|similarity|dissimilarity|rename |copy |\+\+\+ |--- |\\ No newline|Binary files )/.test(line)) {
      flush(); rows.push({ full: "meta", text: line }); continue;
    }
    const kind = line[0];
    if (kind === "-") { if (plus) flush(); minus = minus ?? []; minus.push({ n: old++, text: line.slice(1) || " ", sign: "-" }); continue; }
    if (kind === "+") { plus = plus ?? []; plus.push({ n: next++, text: line.slice(1) || " ", sign: "+" }); continue; }
    if (kind === " ") { flush(); const text = line.slice(1) || " "; rows.push({ left: { n: old++, text, sign: " " }, right: { n: next++, text, sign: " " } }); continue; }
    flush(); rows.push({ full: "meta", text: line });
  }
  flush();
  return rows;
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
    return buildRows([`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, MAX_LINES).map((l) => `+${l}`)]);
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
  return buildRows((start >= 0 ? all.slice(start) : all.slice(hunk)).slice(0, MAX_LINES));
}

export default class GitDiff extends View {
  init() {
    this.seq = null;
    this.target = null;
    this.rows = [];
    this.loading = false; this.error = null;
  }

  // Re-derives the rows whenever the panel publishes a new target. Guarded by the
  // sequence number, so a stale fetch never overwrites a newer one.
  sync(cx) {
    const target = shared("git.diff");
    const seq = target?.seq ?? 0;
    if (seq === this.seq) return;
    this.seq = seq;
    this.target = target ?? null;
    this.rows = []; this.error = null;
    if (!target || !target.root || !target.path) { this.loading = false; return; }
    this.loading = true;
    const context = seq;
    cx.spawn(async (cx) => {
      let rows = null, error = null;
      try { rows = await loadRows(target); }
      catch (e) { error = String(e); }
      if (this.seq !== context) return;
      this.rows = rows ?? [];
      this.error = error; this.loading = false;
      cx.notify();
    });
  }

  mode(t) { return t.mode === "commit" ? `Commit ${t.commitShort ?? ""}`.trim() : t.mode === "staged" ? "Staged" : "Working Tree"; }

  header(t) {
    const target = this.target;
    return h_flex().h(26).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(target?.path), (e) => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(this.mode(target))))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(target?.path ? t.foreground : t.dim).child(target?.path ?? "Diff"));
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
    return h_flex().w_full().h(ROW).flex_none().items_center()
      .child(this.cell(row.left, t))
      .child(div().w(1).h(ROW).flex_none().bg(t.border))
      .child(this.cell(row.right, t));
  }

  body(t) {
    return div().flex_1().min_h(0).relative().overflow_hidden()
      .child(v_virtual_list("git-diff-rows", this.rows.length, ROW, (i) => String(i),
        (range) => this.rows.slice(range.start, range.end).map((row) => this.row(row, t))).size_full())
      .child(Scrollbar.vertical("git-diff-rows").viewport_from_layout().absolute().inset_0())
      .when(!this.rows.length, (e) => e.child(div().absolute().top(8).px(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading\u2026" : this.target?.path ? "No text diff" : "Select a file in Source Control to compare it here"))));
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    return v_flex().id("git-diff").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(11).font_family(MONO())
      .child(this.header(t))
      .child(this.body(t));
  }
}
