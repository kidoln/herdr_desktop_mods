// A git source-control panel for the right sidebar, in the shape of VS Code's:
// a commit box (Commit / Commit & Push), Staged Changes / Changes groups, per-file
// stage / unstage / discard, branch + ahead/behind status, and a commit history
// (with the tags on each commit) in a panel below.
//
// Clicking a file (or a file inside a commit) does not draw its diff here: it hands
// the comparison to the `git-diff` pane, which shows it side by side in the main
// area. Opening a commit stays blob-free and fast: its message and changed-file names
// come from the commit's own trees. It follows the focused pane's repository, on this
// machine or a remote space's. Reads write nothing under .git, so the folder watch
// stays quiet.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, shared, setShared, run } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane (the git panel itself, or the git-diff pane) has no folder of its
  // own: keep following the tab's terminal, so showing a diff never changes repo.
  if (pane && !pane.terminal) {
    const term = panes().find((p) => p.tab === pane.tab && p.terminal);
    if (term?.cwd) return { cwd: term.cwd, on };
  }
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const ctxKey = () => JSON.stringify(location());

// The same read flags Files and Changes use: no index refresh, no lock, no
// fsmonitor cookie, so watching the repository does not see our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MONO = () => settings().font_family ?? "JetBrains Mono";
const icon = (name) => svg(`mods/git/${name}.svg`).flex_none();

// `git diff --numstat -z` records: "add\tdel\tpath" NUL-ended (path alone after --no-renames).
function numstat(out) {
  const map = {};
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const parts = entry.split("\t"), path = parts.slice(2).join("\t");
    if (path) map[path] = { add: Number(parts[0]) || 0, del: Number(parts[1]) || 0, binary: parts[0] === "-" };
  }
  return map;
}

// VS Code's letters: untracked reads U, conflicted reads !.
const shownLetter = (f, staged) => f.conflict ? "!" : staged ? f.x : f.untracked ? "?" : f.y;
const letterText = (l) => (l === "?" ? "U" : l === " " ? "M" : l);
const statusColor = (l, t) =>
  l === "U" || l === "?" || l === "A" ? t.ansi2 : l === "D" || l === "!" ? t.ansi1 : l === "R" || l === "C" ? t.ansi4 : t.blocked;

export default class Git extends View {
  init(_props, cx) {
    this.files = []; this.staged = []; this.unstaged = []; this.commits = [];
    this.seq = 0;
    this.collapsed = { staged: false, changes: false };
    this.historyCollapsed = false;
    this.message = ""; this.note = null; this.error = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx, false));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { while (this.context === context) { await watchFolder(root); if (this.context === context) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = ctxKey();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.staged = []; this.unstaged = []; this.commits = [];
      this.commitView = null;
      this.message = ""; this.input.set_value("");
      this.error = null; this.note = null; this.watched = null; this.hasHead = false; this.headSha = null;
      this.branch = null; this.upstream = null; this.ahead = 0; this.behind = 0;
      this.confirm = null; this.confirmAll = false; this.hovered = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (ctxKey() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.files = []; this.staged = []; this.unstaged = []; this.commits = [];
          this.commitView = null; this.error = "Not a git repository"; return;
        }
        const root = top.stdout.trim();
        const g = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await g(["rev-parse", "--verify", "HEAD"]);
        const status = await g(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const stagedStats = numstat((await g(["diff", "--cached", "--numstat", "-z", "--no-renames"])).stdout);
        const workStats = numstat((await g(["diff", "--numstat", "-z", "--no-renames"])).stdout);

        // Branch, upstream and how far it has drifted.
        let branch = null;
        const ref = await g(["rev-parse", "--abbrev-ref", "HEAD"]);
        if (ref.code === 0 && ref.stdout.trim() && ref.stdout.trim() !== "HEAD") branch = ref.stdout.trim();
        else {
          const sym = await g(["symbolic-ref", "--short", "HEAD"]);
          if (sym.code === 0 && sym.stdout.trim()) branch = sym.stdout.trim();
          else { const sha = await g(["rev-parse", "--short", "HEAD"]); if (sha.code === 0) branch = sha.stdout.trim(); }
        }
        let upstream = null, ahead = 0, behind = 0;
        const up = await g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
        if (up.code === 0 && head.code === 0) {
          upstream = up.stdout.trim();
          const cnt = await g(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
          if (cnt.code === 0) { const [a, b] = cnt.stdout.trim().split(/\s+/); ahead = Number(a) || 0; behind = Number(b) || 0; }
        }

        // Commit history: hash, author, relative date, refs (tags), subject. Tree-only.
        const commits = [];
        if (head.code === 0) {
          const log = await g(["log", "-n", "80", "--decorate=short", "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1e"]);
          if (log.code === 0) for (const rec of log.stdout.split("\x1e")) {
            // git separates entries with a newline, so every record but the first starts with one.
            const fields = rec.replace(/^\n/, "").split("\x1f").map((s) => s.trim());
            if (!fields[0]) continue;
            const [hash, short, author, when, refs, subject] = fields;
            const tags = [];
            for (const token of (refs ?? "").split(", ").map((s) => s.trim()).filter(Boolean)) {
              if (token.startsWith("tag: ")) tags.push(token.slice(5));
            }
            commits.push({ hash, short: short ?? hash.slice(0, 7), author, when, subject: subject ?? "", tags });
          }
        }

        const parsed = [], entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 2000)) {
          const x = entry[0], y = entry[1], path = entry.slice(3);
          const untracked = x === "?" && y === "?";
          const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
          parsed.push({ path, x, y, untracked, conflict,
            staged: !untracked && !conflict && x !== " " && x !== "?",
            unstaged: untracked || conflict || (y !== " " && y !== "?") });
        }
        if (ctxKey() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.headSha = head.code === 0 ? head.stdout.trim() : null;
        this.branch = branch; this.upstream = upstream; this.ahead = ahead; this.behind = behind;
        this.commits = commits;
        this.files = parsed; this.limited = entries.length > 2000;
        this.staged = parsed.filter((f) => f.staged).map((f) => ({ ...f, ...(stagedStats[f.path] ?? {}) }));
        this.unstaged = parsed.filter((f) => f.unstaged).map((f) => ({ ...f, ...(workStats[f.path] ?? {}) }));
        this.error = null; this.watch(root, cx);
        // A commit's file list never changes, so it is read once when opened. A
        // background refresh only retries it if that first read has not succeeded yet.
        if (this.commitView && !this.commitView.loaded) {
          try { await this.loadCommit(this.commitView.hash, context); }
          catch (e) { if (ctxKey() === context) this.note = `Cannot read this commit: ${e}`; }
        }
      } catch (e) { if (ctxKey() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // ---- the side-by-side pane ----

  diffPane(tab) {
    return panes().find((p) => p.mod === "git-diff" && p.tab === tab) ?? null;
  }

  // The comparison the git-diff pane is showing, but only while its pane is up in
  // the current tab — a closed pane clears the row highlight.
  shownTarget() {
    const target = shared("git.diff");
    if (!target?.path) return null;
    return this.diffPane(focused()?.tab) ? target : null;
  }

  // Hand the comparison to the git-diff pane: publish it, and open the pane in the
  // focused tab if it is not there yet. A later click updates the same pane. The
  // pane splits off the focused terminal, or the tab's first one when a mod pane
  // (this panel) holds the keyboard.
  openDiff(target, cx) {
    const f = focused(), tab = f?.tab ?? null;
    const anchor = (f?.pane && panes().find((p) => p.pane === f.pane && p.terminal)) ? f.pane
      : panes().find((p) => p.tab === tab && p.terminal)?.pane ?? null;
    const existing = this.diffPane(tab);
    this.seq += 1;
    setShared("git.diff", {
      seq: this.seq,
      mode: target.mode,
      root: this.root,
      on: this.on,
      path: target.path,
      untracked: Boolean(target.untracked),
      binary: Boolean(target.binary),
      commit: target.commit ?? null,
      commitShort: target.commitShort ?? null,
    });
    if (!existing && anchor) run("pane.split", { direction: "right", pane: anchor, mod: "git-diff" });
    cx.notify();
  }

  // Opening a commit reads only its message and the names of the files it changed —
  // no blob content — so it is fast and works even where the commit's blobs are absent.
  async loadCommit(hash, context) {
    hash = String(hash ?? "").trim();
    const root = this.root, on = this.on, g = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const msg = await g(["show", "-s", "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%b", hash]);
    if (msg.code !== 0) throw new Error((msg.stderr || msg.stdout).trim() || "git show failed");
    const parts = msg.stdout.replace(/\n$/, "").split("\x1f");
    const [H, short, author, when, subject] = parts;
    const body = parts.slice(5).join("\x1f").trim();
    const files = [];
    const tree = await g(["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", hash]);
    if (tree.code === 0) {
      const fields = tree.stdout.split("\0").filter(Boolean);
      for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i][0] || "M", path: fields[i + 1] });
    }
    if (ctxKey() !== context || this.commitView?.hash !== hash) return;
    this.commitView = { hash: H ?? hash, short: short ?? hash.slice(0, 7), author, when, subject: subject ?? "", body, files, loaded: true };
  }

  pick(f, staged, cx) {
    this.commitView = null; this.note = null;
    this.openDiff({ mode: staged ? "staged" : "work", path: f.path, untracked: f.untracked, binary: f.binary }, cx);
  }

  pickCommit(c, cx) {
    const same = this.commitView?.hash === c.hash;
    this.note = null;
    if (same) { this.commitView = null; cx.notify(); return; }
    this.commitView = { hash: c.hash, short: c.short, subject: c.subject, body: "", files: [], loaded: false };
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.loadCommit(c.hash, context); }
      catch (e) { if (ctxKey() === context) this.note = `Cannot read this commit: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  pickCommitFile(path, cx) {
    if (!this.commitView) return;
    this.openDiff({ mode: "commit", path, commit: this.commitView.hash, commitShort: this.commitView.short }, cx);
  }

  closeCommit(cx) { this.commitView = null; cx.notify(); }

  // Every write goes through here: one at a time, then a refresh, errors inline.
  mutate(cx, fn) {
    if (this.busy || !this.root) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(root, on); }
      catch (e) { if (ctxKey() === context) this.note = String(e); }
      finally { this.busy = false; if (ctxKey() === context) this.refresh(cx); cx.notify(); }
    });
  }

  git(root, on, args) { return exec("git", [...READ, ...args], { cwd: root, on }); }
  fail(r, fallback) { if (r.code !== 0) throw new Error((r.stderr || r.stdout || fallback || "git failed").trim()); }
  pushArgs() { return this.upstream ? ["push"] : ["push", "-u", "origin", this.branch]; }

  stage(f, cx) { this.mutate(cx, async (root, on) => this.fail(await this.git(root, on, ["add", "-A", "--", f.path]))); }
  unstage(f, cx) {
    this.mutate(cx, async (root, on) => {
      let r = await this.git(root, on, ["restore", "--staged", "--", f.path]);
      if (r.code !== 0) r = await this.git(root, on, ["reset", "-q", "HEAD", "--", f.path]);
      if (r.code !== 0) r = await this.git(root, on, ["rm", "--cached", "-q", "--", f.path]);
      this.fail(r);
    });
  }
  discard(f, cx) {
    this.confirm = null;
    this.mutate(cx, async (root, on) => {
      if (f.untracked) return this.fail(await this.git(root, on, ["clean", "-f", "-q", "--", f.path]));
      const r = await this.git(root, on, ["restore", "--", f.path]);
      if (r.code === 0) return;
      this.fail(await this.git(root, on, ["checkout", "--", f.path]));
    });
  }
  stageAll(cx) { this.mutate(cx, async (root, on) => this.fail(await this.git(root, on, ["add", "-A"]))); }
  unstageAll(cx) {
    this.mutate(cx, async (root, on) => {
      let r = await this.git(root, on, ["restore", "--staged", "."]);
      if (r.code !== 0) r = await this.git(root, on, ["reset", "-q", "HEAD", "."]);
      if (r.code !== 0) r = await this.git(root, on, ["rm", "--cached", "-r", "-q", "."]);
      this.fail(r);
    });
  }
  discardAll(cx) {
    this.confirmAll = false;
    this.mutate(cx, async (root, on) => {
      this.fail(await this.git(root, on, ["restore", "--", "."]));
      await this.git(root, on, ["clean", "-f", "-d", "-q"]);
    });
  }

  commit(cx, push) {
    const message = this.message.trim();
    if (!message || this.busy || !this.root) return;
    const stageFirst = this.staged.length === 0; // VS Code's smart commit: nothing staged commits everything.
    this.mutate(cx, async (root, on) => {
      if (stageFirst) this.fail(await this.git(root, on, ["add", "-A"]));
      this.fail(await this.git(root, on, ["commit", "-m", message]), "Commit failed");
      if (push) this.fail(await this.git(root, on, this.pushArgs()));
      this.message = ""; this.input.set_value("");
    });
  }
  push(cx) { this.mutate(cx, async (root, on) => this.fail(await this.git(root, on, this.pushArgs()))); }
  pull(cx) { this.mutate(cx, async (root, on) => this.fail(await this.git(root, on, ["pull", "--ff-only"]))); }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.confirmAll || this.confirm) { this.confirmAll = false; this.confirm = null; }
      else if (this.typing) { this.typing = false; this.handle.focus(); }
      else if (this.commitView) { this.commitView = null; }
      else return;
      cx.stop_propagation(); cx.notify();
    } else if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
      this.commit(cx, false); cx.stop_propagation();
    }
  }

  // ---- UI ----
  // Clicks use the `cx` their own callback receives. The one passed to render is
  // only valid during that render: using it later makes spawn/notify throw, and the
  // pane then sits unchanged until the next 10-second refresh.

  actionButton(id, name, onClick, t) {
    return div().id(id).w(20).h(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(icon(name).size(14).text_color(t.dim));
  }

  textButton(id, label, bg, fg, onClick, t) {
    return h_flex().id(id).h(26).px(10).items_center().rounded(6).bg(bg).text_color(fg).text_size(11.5).cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  tagChip(t, tag) {
    return h_flex().flex_none().gap(3).px(5).py(1).rounded(4).bg(t.ansi3 + "22").items_center()
      .child(icon("tag").size(10).text_color(t.ansi3))
      .child(div().text_size(10).text_color(t.ansi3).child(tag));
  }

  header(t) {
    const repo = this.root ? this.root.split(/[\\/]/).pop() : null;
    const busy = this.busy || this.loading;
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(icon("git").size(15).text_color(t.accent))
      .child(div().font_semibold().child("Source Control"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(repo ?? ""))
      .child(div().id("git-refresh").w(24).h(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); })
        .child(icon("refresh").size(15).text_color(busy ? t.dim : t.muted)));
  }

  branchRow(t) {
    if (!this.root || !this.branch) return null;
    const counter = (id, name, count, onClick) =>
      h_flex().id(id).h(22).px(6).gap(3).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(icon(name).size(12).text_color(t.accent))
        .when(count > 0, (e) => e.child(div().text_size(11).text_color(t.accent).child(String(count))));
    return h_flex().h(30).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .child(icon("branch").size(13).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.branch))
      .when(!this.upstream, (e) => e.child(
        h_flex().id("git-publish").h(22).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.push(cx); })
          .child(icon("arrow-up").size(12).text_color(t.accent))
          .child(div().text_size(11).text_color(t.accent).child("Publish"))))
      .when(this.upstream && this.behind > 0, (e) => e.child(counter("git-pull", "arrow-down", this.behind, (cx) => this.pull(cx))))
      .when(this.upstream && this.ahead > 0, (e) => e.child(counter("git-push", "arrow-up", this.ahead, (cx) => this.push(cx))));
  }

  commitBox(t) {
    const ready = Boolean(this.message.trim() && this.root && !this.busy);
    const count = this.staged.length;
    const label = count > 0 ? `Commit (${count})` : this.unstaged.length > 0 ? "Commit All" : "Commit";
    const button = (id, name, text, primary, onClick) =>
      h_flex().id(id).flex_1().min_w(0).h(30).items_center().justify_center().gap(6).rounded(8)
        .bg(primary ? (ready ? t.solid : t.raised) : t.raised)
        .text_color(primary ? (ready ? t.solid_foreground : t.dim) : ready ? t.foreground : t.dim)
        .text_size(12).when(ready, (e) => e.cursor_pointer())
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (ready) onClick(cx); })
        .child(icon(name).size(14).text_color(primary ? (ready ? t.solid_foreground : t.dim) : t.muted))
        .child(div().truncate().child(text));
    return v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
      .child(div().id("git-message").w_full().min_h(32).px(10).py(6).flex().items_center().rounded(8).border_1()
        .border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center()
        .child(button("git-commit", "check", label, true, (cx) => this.commit(cx, false)))
        .child(button("git-commit-push", "arrow-up", "Commit & Push", false, (cx) => this.commit(cx, true))));
  }

  sectionRow(t, r) {
    if (r.kind === "empty") {
      return h_flex().h(26).flex_none().pl(28).items_center().text_size(12).text_color(t.dim).child("No changes");
    }
    const actions = [];
    if (r.staged) actions.push(this.actionButton(`git-unall-${r.key}`, "minus", (cx) => this.unstageAll(cx), t));
    else {
      actions.push(this.actionButton(`git-discardall-${r.key}`, "undo", (cx) => { this.confirmAll = true; cx.notify(); }, t));
      actions.push(this.actionButton(`git-stageall-${r.key}`, "plus", (cx) => this.stageAll(cx), t));
    }
    return h_flex().id(`git-sec-${r.key}`).h(28).flex_none().pl(8).pr(6).gap(5).items_center()
      .child(div().id(`git-tog-${r.key}`).w(18).h(18).flex().items_center().justify_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.collapsed[r.staged ? "staged" : "changes"] = !r.collapsed; cx.notify(); })
        .child(icon(r.collapsed ? "chevron-right" : "chevron-down").size(14).text_color(t.muted)))
      .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(r.title))
      .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(String(r.count)))
      .children(actions);
  }

  fileRow(t, f, staged) {
    const rowKey = `${staged ? "s" : "w"}:${f.path}`;
    const hovered = this.hovered === rowKey;
    const target = this.shownTarget();
    const selected = Boolean(target) && target.mode === (staged ? "staged" : "work") && target.path === f.path;
    const confirming = this.confirm === rowKey;
    const letter = letterText(shownLetter(f, staged)), color = statusColor(shownLetter(f, staged), t);
    const parts = f.path.split("/"), name = parts.pop(), dir = parts.length ? parts.join("/") + "/" : "";
    const actions = [];
    if (staged) actions.push(this.actionButton(`git-un-${rowKey}`, "minus", (cx) => this.unstage(f, cx), t));
    else if (confirming) {
      actions.push(this.actionButton(`git-dy-${rowKey}`, "check", (cx) => this.discard(f, cx), t));
      actions.push(this.actionButton(`git-dn-${rowKey}`, "close", (cx) => { this.confirm = null; cx.notify(); }, t));
    } else {
      actions.push(this.actionButton(`git-di-${rowKey}`, "undo", (cx) => { this.confirm = rowKey; cx.notify(); }, t));
      actions.push(this.actionButton(`git-st-${rowKey}`, "plus", (cx) => this.stage(f, cx), t));
    }
    return h_flex().id(`git-row-${rowKey}`).h(26).flex_none().pl(24).pr(6).gap(6).items_center().rounded(6).overflow_hidden()
      .when(selected, (e) => e.bg(t.selected))
      .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
      .on_hover((on, cx) => {
        const next = on ? rowKey : this.hovered === rowKey ? null : this.hovered;
        if (next !== this.hovered) { this.hovered = next; cx.notify(); }
      })
      .on_click((_e, cx) => this.pick(f, staged, cx))
      .child(div().w(14).flex_none().text_center().text_size(11).font_semibold().text_color(color).child(letter))
      .child(h_flex().flex_1().min_w(0)
        .when(Boolean(dir), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(dir)))
        .child(div().truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`\u2212${f.del}`)))
      .children(hovered || confirming ? actions : []);
  }

  commitRow(t, c) {
    const open = this.commitView?.hash === c.hash;
    const isHead = c.hash === this.headSha;
    return h_flex().id(`git-c-${c.hash}`).h(24).flex_none().px(10).gap(7).items_center().rounded(6).overflow_hidden()
      .when(open, (e) => e.bg(t.selected))
      .when(!open, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pickCommit(c, cx))
      .child(div().flex_none().text_size(11).font_family(MONO()).text_color(open ? t.accent : t.dim).child(c.short))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.subject || "(no subject)"))
      .children(c.tags.map((tag) => this.tagChip(t, tag)))
      .when(isHead, (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(this.branch ?? "HEAD")))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.when ?? ""));
  }

  confirmAllBar(t) {
    return h_flex().flex_none().px(10).py(8).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(12).text_color(t.foreground).child("Discard all changes?"))
      .child(this.textButton("git-all-yes", "Discard", t.solid, t.solid_foreground, (cx) => this.discardAll(cx), t))
      .child(this.textButton("git-all-no", "Cancel", t.background, t.foreground, (cx) => { this.confirmAll = false; cx.notify(); }, t));
  }

  emptyState(t) {
    return v_flex().flex_1().items_center().justify_center().gap(8).p(16)
      .child(icon("git").size(26).text_color(t.dim))
      .child(div().text_size(12).text_color(t.dim).text_center().child(this.error || (this.loading ? "Loading\u2026" : "No folder")));
  }

  historySection(t) {
    const count = this.commits.length;
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().h(30).flex_none().pl(8).pr(10).gap(5).items_center()
        .child(div().id("git-log-tog").w(18).h(18).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.historyCollapsed = !this.historyCollapsed; cx.notify(); })
          .child(icon(this.historyCollapsed ? "chevron-right" : "chevron-down").size(14).text_color(t.muted)))
        .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child("Commits"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(String(count)))
        .child(div().id("git-reflog").w(18).h(18).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); })
          .child(icon("refresh").size(13).text_color(t.dim))))
      .when(!this.historyCollapsed, (e) => e.child(
        v_flex().id("git-log").h(190).flex_none().py(4).overflow_y_scrollbar()
          .children(this.commits.map((c) => this.commitRow(t, c)))
          .when(!count, (e) => e.child(div().p(10).text_size(12).text_color(t.dim).child(this.hasHead ? "No commits" : "No commits yet")))));
  }

  // A commit's message and the names of the files it changed. Choosing a file
  // hands its diff to the git-diff pane in the main area, side by side.
  commitList(t) {
    const c = this.commitView;
    const files = c.files.slice(0, 800);
    const target = this.shownTarget();
    const isShown = (path) => Boolean(target) && target.mode === "commit" && target.commit === c.hash && target.path === path;
    return v_flex().flex_1().min_h(0).border_t(1).border_color(t.border)
      .child(h_flex().h(30).flex_none().pl(12).pr(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child("Commit"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).font_family(MONO()).child(`${c.short} ${c.subject}`))
        .child(div().id("git-commit-close").w(20).h(20).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeCommit(cx); })
          .child(icon("close").size(13).text_color(t.dim))))
      .child(v_flex().id("git-commit-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(3)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(c.subject || "(no subject)"))
        .when(Boolean(c.body), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(c.body.slice(0, 4000))))
        .child(div().h(4).flex_none())
        .when(!files.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No file changes")))
        .children(files.map((f) =>
          h_flex().id(`git-cf-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(isShown(f.path), (e) => e.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.pickCommitFile(f.path, cx))
            .child(div().w(14).flex_none().text_center().text_size(11).font_semibold().text_color(statusColor(f.status, t)).child(f.status))
            .child(div().flex_1().min_w(0).truncate().child(f.path))))
        .when(c.files.length > files.length, (e) => e.child(div().p(6).text_size(11).text_color(t.dim).child(`\u2026 and ${c.files.length - files.length} more`))));
  }

  render(cx) {
    if (ctxKey() !== this.context) this.refresh(cx);
    const t = theme();

    const list = [];
    if (this.staged.length) {
      list.push({ key: "staged", kind: "section", staged: true, title: "Staged Changes", count: this.staged.length, collapsed: this.collapsed.staged });
      if (!this.collapsed.staged) for (const f of this.staged) list.push({ key: `s:${f.path}`, kind: "file", f, staged: true });
    }
    list.push({ key: "changes", kind: "section", staged: false, title: "Changes", count: this.unstaged.length, collapsed: this.collapsed.changes });
    if (!this.collapsed.changes) for (const f of this.unstaged) list.push({ key: `w:${f.path}`, kind: "file", f, staged: false });
    if (!this.staged.length && !this.unstaged.length) list.push({ key: "empty", kind: "empty" });

    const rowHeight = list.reduce((n, r) => n + (r.kind === "section" ? 28 : 26), 0);
    const listHeight = Math.min(320, Math.max(60, rowHeight + 12));

    let body = v_flex().id("git-list").w_full().min_h(0).py(4).overflow_y_scrollbar()
      .children(list.map((r) => (r.kind === "file" ? this.fileRow(t, r.f, r.staged) : this.sectionRow(t, r))));
    body = this.commitView ? body.flex_none().h(listHeight) : body.flex_1();

    return v_flex().id("git").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(this.header(t))
      .when(Boolean(this.root) && Boolean(this.branch), (e) => e.child(this.branchRow(t)))
      .when(Boolean(this.root), (e) => e.child(this.commitBox(t)))
      .when(this.confirmAll, (e) => e.child(this.confirmAllBar(t)))
      .when(!this.root, (e) => e.child(this.emptyState(t)))
      .when(Boolean(this.root), (e) => e.child(body))
      .when(Boolean(this.root), (e) => e.child(this.historySection(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(Boolean(this.commitView), (e) => e.child(this.commitList(t)));
  }
}
