// A git source-control panel for the right sidebar, in the shape of VS Code's:
// a commit box (Commit / Commit & Push), Staged Changes / Changes groups, per-file
// stage / unstage / discard, branch + ahead/behind status (with the upstream it
// tracks), and a commit history (with the tags on each commit) in a panel below.
//
// The history is not just HEAD: every local and remote branch's commits appear
// together, newest first, and the color dot before each subject is that commit's
// branch lamp (a remote branch borrows its local branch's color). The dots sit
// in a graph: a vertical line runs dot to dot down the list, and where a branch
// forks off or merges back the line bends into the trunk with a curve, so the
// fork reads as a parent with two children above it. Clicking the branch name
// drops the list of every branch: pick one or more and the history narrows to
// the commits their histories reach (nothing picked: all). Right-clicking a
// commit opens a small menu at the pointer: Copy Hash puts the full SHA on the
// clipboard (the row itself shows no hash), and Create Branch asks for a name
// and makes that branch at the commit, switching to it. A row's own business is
// its subject: the message keeps its share of the width and the tag and branch
// chips are cut to what is left of the row, the rest reading as one "+N" pill,
// so a long tag name can never squeeze the message out. Resting the pointer on
// a commit opens the whole row above it -- the subject on the first line with
// the date, every tag and branch under that, nothing shortened. The Commits
// pane's top edge drags to size it, and the size is remembered.
//
// A folder that is not a repository yet reads so in the middle of the panel, with
// a button that runs `git init` there and reads it again; nothing else in the panel
// draws while there is no repository to draw from.
//
// Clicking a file (or a file inside a commit) does not draw its diff here: it hands
// the comparison to the `git-diff` pane in the main area — side by side, or a single
// green (new file) / red (deleted file) column when there is no other side to pair.
// Clicking the file that pane is already showing closes the pane again, so the same
// click toggles the comparison off.
// Clicking a commit does not push a detail panel under the list either: its message
// and changed-file list open as an anchored surface right under that row, floating
// over the commits below it. The same click toggles it off; so do Escape and a press
// elsewhere in the panel. The surface's header carries the short hash -- the message
// stays the body's, shown once -- with a button that copies the full SHA. Right-clicking
// a commit takes the surface down before its context menu opens, so the two never stand
// over the list together.
// Opening a commit stays blob-free and fast: its message and changed-file names
// come from the commit's own trees. It follows the focused pane's repository, on this
// machine or a remote space's. Reads write nothing under .git, so the folder watch
// stays quiet.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup, HoverCard } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, shared, setShared, run, props, openOverlay, closeOverlay, notify } from "herdr";

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

// One lamp color per branch, stable across reloads and repos: the same name always
// hashes to the same palette entry, and two branches shown at once never share one
// (refresh() probes a colliding name onward). A remote branch borrows its local
// branch's color, so origin/main reads as main.
const LAMPS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function lampIndex(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % LAMPS.length;
}

// The clipboard on this machine: pbcopy (macOS), else wl-copy / xclip (Linux).
// Windows has neither, and the caller reports the failure.
async function copyText(text) {
  for (const script of ["printf %s \"$1\" | pbcopy", "printf %s \"$1\" | wl-copy", "printf %s \"$1\" | xclip -selection clipboard"]) {
    try { const r = await exec("sh", ["-c", script, "sh", text]); if (r.code === 0) return true; } catch {}
  }
  return false;
}

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

// ---- the commit graph ----
// The dot column before the subjects is drawn, not built from divs. The list is
// a graph, not a column of dots: a commit's dot takes the line waiting for it,
// leftmost; with none waiting (a branch tip) it opens its own. Its first parent
// runs on in that line; every other parent opens a new line to the right with a
// curve, so a merge leaves its dot as a line that bends out and down; a line
// another line got to first (a side branch rejoining the trunk) bends into that
// dot with the same curve, the fork the picture reads as a parent with two
// children above it. Lines carry the lamp of the branch they belong to -- the
// tip nearest the line's commits, walked down the parents -- and a line hands
// its lamp over at a branch's tip: dev's commits running into main's tip stay
// dev's above it, and main's lamp takes the tip and the shared history below.
// Only a branch's newest tip in the window hands over, so a stale remote
// pointing into old shared history does not repaint it. The geometry is plain
// commands, so it can be exercised without a window; the row view turns each
// into a stroke path. Design pixels: a row is 24 tall (see commitRow), lanes
// are 14 apart, and the curves have radius 7.
const GRAPH = { x0: 5.5, pitch: 14, r: 7, line: 1.25 };
const KAPPA = 0.5523;

// `tipName(c)` names the branch tip on a commit (the branch that colors it; a
// remote borrows its local name), `lampOf(name)` its lamp.
function graphRows(commits, tipName, lampOf) {
  const pos = new Map(commits.map((c, i) => [c.hash, i]));
  // Each line's lamp: the branch tip nearest its commits. Walk down from every
  // tip (a short hop apart), so a merged branch's line keeps its own color.
  const near = new Array(commits.length).fill(null);
  const q = [];
  for (let i = 0; i < commits.length; i++) { const n = tipName(commits[i]); if (n) { near[i] = n; q.push(i); } }
  for (let h = 0; h < q.length; h++) for (const ph of commits[q[h]].parents) {
    const j = pos.get(ph);
    if (j !== undefined && near[j] === null) { near[j] = near[q[h]]; q.push(j); }
  }
  // Where a line hands its lamp over: a commit that is a branch's tip. The
  // line running into it keeps its own lamp above the dot, the dot and the
  // history below take the tip's branch's lamp. Only a branch's newest tip in
  // the window hands over: a stale remote pointing into old shared history
  // (gientech/feature_dev behind feature_dev's own tip) does not repaint it.
  const claim = new Map();
  {
    const newest = new Map();   // lamp -> the topmost row carrying it
    for (let i = 0; i < commits.length; i++) {
      const t = tipName(commits[i]);
      if (!t) continue;
      const lamp = lampOf(t);
      if (!newest.has(lamp) || i < newest.get(lamp)) newest.set(lamp, i);
    }
    for (const [lamp, i] of newest) claim.set(i, lamp);
  }
  const X = (l) => GRAPH.x0 + l * GRAPH.pitch;
  const rows = commits.map(() => []);
  const lanes = commits.map(() => 0);
  const colors = commits.map(() => "dim");
  const vert = (r, l, y0, y1, color) => rows[r].push({ c: color, p: [["M", X(l), y0], ["L", X(l), y1]] });
  const active = [];   // lane -> { hash, color }: the line waiting there, or null
  let maxLane = 0;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i], rd = GRAPH.r, k = rd * KAPPA;
    // The lines waiting for this commit, leftmost first: the first takes the dot.
    const waiting = [];
    for (let l = 0; l < active.length; l++) if (active[l] && active[l].hash === c.hash) waiting.push(l);
    let lc = waiting[0];
    if (lc === undefined) {
      lc = active.findIndex((a) => !a);
      if (lc === -1) { lc = active.length; active.push(null); }
    }
    lanes[i] = lc; if (lc > maxLane) maxLane = lc;
    const own = near[i] ? lampOf(near[i]) : (c.owner ? lampOf(c.owner) : "dim");
    const incoming = waiting.length ? active[lc].color : own;
    const color = claim.get(i) ?? incoming;
    colors[i] = color;
    // What is already on the way: a line whose commit is this one bends into
    // the dot (the dot's own line just runs into it); the rest run through.
    for (let l = 0; l < active.length; l++) {
      const a = active[l];
      if (!a || l === lc) continue;
      if (a.hash === c.hash) {
        const xb = X(l), xa = X(lc);
        vert(i, l, 0, 12 - rd, a.color);
        rows[i].push({ c: a.color, p: [["M", xb, 12 - rd], ["C", xb - rd, 12, xb, 12 - rd + k, xb - rd + k, 12], ["L", xa + 3, 12]] });
        active[l] = null;
      } else {
        vert(i, l, 0, 24, a.color);
      }
    }
    if (waiting.length) vert(i, lc, 0, 12, incoming);
    // The first parent runs on in this line; with no parent under the window
    // the line trails off. Other parents open new lines to the right, each in
    // the lamp of the branch it belongs to.
    const p0 = c.parents[0], j0 = p0 === undefined ? undefined : pos.get(p0);
    if (c.parents.length) {
      if (j0 !== undefined && j0 > i) active[lc] = { hash: p0, color };
      else active[lc] = null;
      vert(i, lc, 12, 24, color);
    } else active[lc] = null;
    for (let kk = 1; kk < c.parents.length; kk++) {
      const j = pos.get(c.parents[kk]);
      if (j === undefined || j <= i) continue;
      let r = -1;
      for (let l = lc + 1; l < active.length; l++) if (!active[l]) { r = l; break; }
      if (r === -1) { r = active.length; active.push(null); }
      if (r > maxLane) maxLane = r;
      const side = near[j] ? lampOf(near[j]) : color;
      const xa = X(lc), xb = X(r);
      rows[i].push({ c: side, p: [["M", xa + 3, 12], ["L", xb - rd, 12], ["C", xb, 12 + rd, xb - rd + k, 12, xb, 12 + rd - k]] });
      vert(i, r, 12 + rd, 24, side);
      active[r] = { hash: c.parents[kk], color: side };
    }
  }
  return { rows, lanes, colors, maxLane };
}

// One row's line pieces as a single stroke path. The pieces are in design
// pixels (the row is 24 tall, the layer `width` wide); painted coordinates are
// percentages of the layer, which the window scales with the app's zoom, so
// the lines land on the dots at any zoom like the layout around them. Stroke
// widths are not scaled, so they carry the zoom themselves.
function strokePath(pieces, width) {
  const x = (v) => `${((v / width) * 100).toFixed(4)}%`;
  const y = (v) => `${((v / 24) * 100).toFixed(4)}%`;
  const b = PathBuilder.stroke(GRAPH.line * (Number(settings()?.zoom) || 1));
  for (const piece of pieces) for (const cmd of piece.p) {
    if (cmd[0] === "M") b.move_to(x(cmd[1]), y(cmd[2]));
    else if (cmd[0] === "L") b.line_to(x(cmd[1]), y(cmd[2]));
    else b.cubic_bezier_to(x(cmd[1]), y(cmd[2]), x(cmd[3]), y(cmd[4]), x(cmd[5]), y(cmd[6]));
  }
  return b.build();
}

// VS Code's letters: untracked reads U, conflicted reads !.
const shownLetter = (f, staged) => f.conflict ? "!" : staged ? f.x : f.untracked ? "?" : f.y;
const letterText = (l) => (l === "?" ? "U" : l === " " ? "M" : l);
const statusColor = (l, t) =>
  l === "U" || l === "?" || l === "A" ? t.ansi2 : l === "D" || l === "!" ? t.ansi1 : l === "R" || l === "C" ? t.ansi4 : t.blocked;

export default class Git extends View {
  init(_props, cx) {
    // An overlay copy renders the commit context menu (see commitMenu): no panel,
    // no polling — just a focus handle for its keys. (props() is read, not the
    // argument: an overlay copy is not given one at init time.)
    if (props()?.commitMenu) {
      this.menuHandle = cx.focus_handle();
      this.menuHandle.focus();
      return;
    }
    // A create-branch dialog copy: no panel either, just the form's input and
    // keys. The commit and the repository to work in arrive as props.
    if (props()?.createBranch) {
      this.branchName = "";
      this.branchError = "";
      this.branchBusy = false;
      this.branchFocused = true;
      this.branchHandle = cx.focus_handle();
      this.branchInput = InputState.new({ placeholder: "Branch name" });
      this.branchInput.on("change", (_e, cx) => { this.branchName = this.branchInput.value(); this.branchError = ""; cx.notify(); });
      this.branchInput.on("submit", (_e, cx) => this.createBranch(cx));
      this.branchInput.on("focus", (_e, cx) => { this.branchFocused = true; cx.notify(); });
      this.branchInput.on("blur", (_e, cx) => { this.branchFocused = false; cx.notify(); });
      this.branchInput.focus();
      cx.timer.after(600, () => this.branchInput.focus());
      return;
    }
    this.files = []; this.staged = []; this.unstaged = []; this.commits = [];
    this.seq = 0;
    this.collapsed = { staged: false, changes: false };
    this.historyCollapsed = false;
    // The branch list dropped from the branch row, and the refs picked in it
    // (nothing picked: every branch). The Commits pane's height drags on its
    // top edge and is remembered; `unit` is window units per design pixel,
    // measured on the drag strip (1 until it first lays out).
    this.branchPick = false; this.picked = new Set();
    this.localRefs = []; this.remoteRefs = [];
    // The graph geometry for the shown commit list, rebuilt when the commits
    // or the picker change.
    this._graph = null;
    const saved = Number(localStorage.getItem("logHeight"));
    this.logHeight = Number.isFinite(saved) && saved >= 72 ? Math.min(saved, 900) : 190;
    this.resize = null; this.size = null; this.unit = 1;
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

  // An empty panel: no folder, or no repository there yet.
  clear() {
    this.root = null; this.on = null; this.hasHead = false; this.headSha = null;
    this.files = []; this.staged = []; this.unstaged = []; this.commits = []; this._graph = null;
    this.branch = null; this.upstream = null; this.ahead = 0; this.behind = 0;
    this.remotes = null; this.lamps = null; this.localRefs = []; this.remoteRefs = [];
    this.commitView = null; this.branchPick = false; this.picked = new Set();
    this.resize = null; this.confirm = null; this.confirmAll = false; this.hovered = null;
    this.error = null; this.notRepo = false; this.note = null; this.limited = false;
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = ctxKey();
    if (context !== this.context) {
      // The folder the panel follows changed. The read below replaces what is on
      // screen in one step; clearing first would flash the empty state for the
      // length of the read (and a `cd` inside one repository, which changes
      // nothing the panel shows, would flash too).
      this.context = context;
      this.watched = null;   // the old folder's watch loop ends by itself
      this.resize = null;    // a drag belongs to the panel that was on screen
    }
    if (!cwd) { this.clear(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (ctxKey() !== context) return;
        if (top.code !== 0) { this.clear(); this.error = "Not a git repository"; this.notRepo = true; return; }
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

        // Commit history across the branches, not just HEAD: hash, parents, author,
        // relative date, refs (tags and branch tips), subject. Tree-only. `%D` names
        // the refs at the tips they point to; the walk below colors every commit by
        // the first branch that reaches it.
        const commits = [];
        let remotes = new Set(), lamps = new Map(), localRefs = [], remoteRefs = [];
        if (head.code === 0) {
          const locals = await g(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
          const remoteRefsRes = await g(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
          const localSet = new Set(locals.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
          remotes = new Set(remoteRefsRes.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !/\/HEAD$/.test(s)));
          localRefs = [...localSet].sort();
          remoteRefs = [...remotes].sort();
          const log = await g(["log", "HEAD", "--branches", "--remotes", "-n", "120", "--decorate=short",
            "--pretty=format:%H%x1f%P%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1e"]);
          if (log.code === 0) for (const rec of log.stdout.split("\x1e")) {
            // git separates entries with a newline, so every record but the first starts with one.
            const fields = rec.replace(/^\n/, "").split("\x1f").map((s) => s.trim());
            if (!fields[0]) continue;
            const [hash, parents, short, author, when, refs, subject] = fields;
            const tags = [], tips = [];
            for (const token of (refs ?? "").split(", ").map((s) => s.trim()).filter(Boolean)) {
              if (token.startsWith("tag: ")) { tags.push(token.slice(5)); continue; }
              // "HEAD -> main" and "origin/HEAD -> origin/main" name the ref they point at.
              const name = token.replace(/^.* -> /, "");
              if (!name || name === "HEAD" || /\/HEAD$/.test(name)) continue;
              tips.push(name);
            }
            commits.push({ hash, short: short ?? hash.slice(0, 7), author, when, subject: subject ?? "",
              tags, tips, parents: (parents ?? "").split(" ").filter(Boolean), owner: null, reach: new Set() });
          }
          // Each commit takes the lamp of the first branch whose history reaches it:
          // the checked-out branch first, then local branches, then remotes. Shared
          // ancestry reads as the branch it belongs to, a side branch's own commits
          // stand out, and a branch whose tip is outside the window colors nothing.
          const byHash = new Map(commits.map((c, i) => [c.hash, i]));
          const tipAt = new Map();
          for (const c of commits) for (const name of c.tips) if (!tipAt.has(name)) tipAt.set(name, c.hash);
          const order = [];
          if (branch && localSet.has(branch) && tipAt.has(branch)) order.push(branch);
          for (const name of localSet) if (name !== branch && tipAt.has(name)) order.push(name);
          for (const name of remotes) if (tipAt.has(name)) order.push(name);
          // Every branch walks its whole reachable history, the part an earlier
          // branch claimed included: `reach` names the branches a commit belongs
          // to (the branch picker filters by it), `owner` only the first one, for
          // the lamp. Shared ancestry still reads as the branch it belongs to.
          for (const name of order) {
            const seen = new Set();
            const stack = [byHash.get(tipAt.get(name))];
            while (stack.length) {
              const i = stack.pop();
              if (i === undefined || seen.has(i)) continue;
              seen.add(i);
              commits[i].reach.add(name);
              if (!commits[i].owner) commits[i].owner = name;
              for (const p of commits[i].parents) { const k = byHash.get(p); if (k !== undefined) stack.push(k); }
            }
          }
          // Lamps for the branches shown: each keeps the color its name hashes to;
          // a name whose lamp is taken probes onward, in this order, so two branches
          // in one window never share a light.
          const keyOf = (name) => (remotes.has(name) ? name.replace(/^[^/]+\//, "") : name);
          const keys = [];
          for (const name of order) { const k = keyOf(name); if (!keys.includes(k)) keys.push(k); }
          const taken = new Set(), deferred = [];
          for (const k of keys) {
            const i = lampIndex(k);
            if (taken.has(i)) deferred.push(k); else { taken.add(i); lamps.set(k, LAMPS[i]); }
          }
          for (const k of deferred) {
            let i = lampIndex(k);
            // More branches than lamps: the extras share a color rather than
            // probing forever (every lamp can already be taken).
            if (taken.size >= LAMPS.length) { lamps.set(k, LAMPS[i]); continue; }
            while (taken.has(i)) i = (i + 1) % LAMPS.length;
            taken.add(i); lamps.set(k, LAMPS[i]);
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
        // A different repository: what belonged to the old one (a typed message, an
        // open commit, the branch picker, picked refs, a discard confirmation) goes
        // with it, in the same step as the new data, so the two are never mixed.
        // A `cd` inside one repository changes none of it and keeps all of it.
        if (this.root !== root) {
          this.commitView = null; this.branchPick = false; this.picked = new Set();
          this.message = ""; this.input.set_value("");
          this.confirm = null; this.confirmAll = false; this.hovered = null; this.note = null;
        }
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.headSha = head.code === 0 ? head.stdout.trim() : null;
        this.branch = branch; this.upstream = upstream; this.ahead = ahead; this.behind = behind;
        this.remotes = remotes; this.lamps = lamps;
        this.localRefs = localRefs; this.remoteRefs = remoteRefs;
        this.commits = commits; this._graph = null;
        // A picked branch that is gone would leave the filter showing nothing;
        // drop it instead.
        for (const name of [...this.picked]) if (!remotes.has(name) && !localRefs.includes(name)) this.picked.delete(name);
        this.syncCommitView();
        this.files = parsed; this.limited = entries.length > 2000;
        this.staged = parsed.filter((f) => f.staged).map((f) => ({ ...f, ...(stagedStats[f.path] ?? {}) }));
        this.unstaged = parsed.filter((f) => f.unstaged).map((f) => ({ ...f, ...(workStats[f.path] ?? {}) }));
        this.error = null; this.notRepo = false; this.watch(root, cx);
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

  // Clicking the file the pane is already showing takes the comparison down again:
  // the lit row reads as "on", so the same click toggles it off by closing the pane.
  // Every other file opens or updates it as before.
  toggleDiff(target, cx) {
    const shown = this.shownTarget();
    const same = Boolean(shown) && shown.mode === target.mode && shown.path === target.path
      && (target.mode !== "commit" || shown.commit === target.commit);
    if (!same) return false;
    const pane = this.diffPane(focused()?.tab);
    if (pane) run("pane.close", { pane: pane.pane });
    cx.notify();
    return true;
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
    this.branchPick = false;
    this.note = null;
    const target = { mode: staged ? "staged" : "work", path: f.path, untracked: f.untracked, binary: f.binary };
    if (this.toggleDiff(target, cx)) return;
    this.commitView = null;
    this.openDiff(target, cx);
  }

  pickCommit(c, cx) {
    this.branchPick = false;
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
    const target = { mode: "commit", path, commit: this.commitView.hash, commitShort: this.commitView.short };
    if (this.toggleDiff(target, cx)) return;
    this.openDiff(target, cx);
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

  // The empty state's button: make the shown folder a repository and read it
  // again. `mutate` is about a repository, so the write runs here with the same
  // one-at-a-time busy flag; the folder is read at the press, like refresh does,
  // so a changed focus inits where the panel is looking now.
  initRepo(cx) {
    if (this.busy || this.loading) return;
    const { cwd, on } = location(), context = ctxKey();
    if (!cwd) return;
    this.busy = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try { this.fail(await exec("git", ["init"], { cwd, on }), "git init failed"); }
      catch (e) { if (ctxKey() === context) this.note = String(e); }
      finally { this.busy = false; if (ctxKey() === context) this.refresh(cx); cx.notify(); }
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
      else if (this.branchPick) { this.branchPick = false; }
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

  // A tag chip. `maxText` caps the label, in design pixels, where the chip has
  // to share the row; null leaves the whole name (the hover card's copy).
  tagChip(t, tag, maxText) {
    return h_flex().flex_none().gap(3).px(5).py(1).rounded(4).bg(t.ansi3 + "22").items_center()
      .child(icon("tag").size(10).text_color(t.ansi3))
      .child(div().when(maxText !== null, (e) => e.max_w(maxText).truncate()).text_size(10).text_color(t.ansi3).child(tag));
  }

  // The branch names whose last commit this row is, in the order their chips
  // read: the current branch, then locals, then remotes. A remote borrows its
  // local branch's spot (origin/main reads "main"); a remote with no local
  // branch on that commit keeps its remote prefix, so it is not mistaken for a
  // local branch. A row that is HEAD still shows HEAD, detached or not.
  refNames(c, isHead) {
    const chosen = new Map();   // the branch -> the ref to show for it
    for (const name of c.tips ?? []) {
      const key = this.colorOf(name);
      const cur = chosen.get(key);
      if (!cur || this.betterRef(name, cur)) chosen.set(key, name);
    }
    const current = this.branch && this.branch !== "HEAD" ? this.branch : null;
    const names = [...chosen.values()];
    names.sort((a, b) => this.refRank(a) - this.refRank(b) || (a < b ? -1 : a > b ? 1 : 0));
    if (isHead && current && !names.includes(current)) names.unshift(current);
    else if (isHead && !current) names.unshift("HEAD");
    return names;
  }

  // Everything a commit's chips would read if the row had room, in the order
  // they show: the tags on the commit, then the branches whose tip it is. One
  // list feeds both the row (rowChips cuts it to fit) and the hover card (the
  // whole of it, commitTip).
  chipSpecs(c, isHead) {
    const current = this.branch && this.branch !== "HEAD" ? this.branch : null;
    const isCurrent = (name) => name === current || (name === "HEAD" && !current);
    return [
      ...(c.tags ?? []).map((text) => ({ kind: "tag", text })),
      ...this.refNames(c, isHead).map((text) => ({ kind: "ref", text, current: isCurrent(text) })),
    ];
  }

  // One chip of a spec: the tag chip, or the branch chip with its lamp.
  chipOf(t, spec, maxText) {
    return spec.kind === "tag" ? this.tagChip(t, spec.text, maxText) : this.refChip(t, spec.text, spec.current, maxText);
  }

  // The order the chips read in: the current branch, then locals, then remotes.
  refRank(name) { return name === this.branch ? 0 : this.remotes?.has(name) ? 2 : 1; }

  // Between two refs on the same branch: the local one wins, else origin's.
  betterRef(a, b) {
    const remote = (n) => Boolean(this.remotes?.has(n));
    if (remote(a) !== remote(b)) return !remote(a);
    if (remote(a) && a.startsWith("origin/") !== b.startsWith("origin/")) return a.startsWith("origin/");
    return false;
  }

  refChip(t, name, current, maxText) {
    return h_flex().flex_none().gap(4).px(5).py(1).rounded(4).bg(t.raised).items_center()
      .child(div().size(6).flex_none().rounded(3).bg(t[this.lampOf(name)]))
      .child(div().when(maxText !== null, (e) => e.max_w(maxText).truncate()).text_size(10).text_color(current ? t.foreground : t.muted).child(name));
  }

  // Roughly how wide a string draws at `size` design pixels: wide glyphs (CJK,
  // emoji) take about a full em, the rest about half. Only ever a way to pick
  // what to show before the layout measures -- being a little off costs a chip.
  textWidth(text, size) {
    let w = 0;
    for (const ch of String(text ?? "")) w += (ch.codePointAt(0) > 0x2e7f ? 1.06 : 0.58) * size;
    return w;
  }

  // Roughly how wide a chip draws: what its box adds to the label (padding, the
  // icon or dot, the gap), plus the label at its 10 px size, capped at `maxText`
  // with room for the ellipsis a truncating label draws.
  chipWidth(spec, maxText) {
    const raw = this.textWidth(spec.text, 10);
    return (spec.kind === "tag" ? 23 : 20) + Math.min(raw, maxText) + (raw > maxText ? 8 : 0);
  }

  // The design-pixel share of one row the chips may take: the row's width less
  // its own chrome (panel border and padding, the graph lane, the date, the
  // gaps) and less the subject's share of what remains -- a long message
  // shortens its chips, never the other way around. The floor keeps one chip
  // visible on a narrow panel; the ceiling keeps the chips chips on a wide one.
  chipBudget(g) {
    const width = (this.size?.width ?? 720) / (this.unit || 1);
    const free = width - 34 - g.width - 68 - 28;
    const keep = Math.max(110, free * 0.4);
    return Math.max(50, Math.min(340, Math.round(free - keep)));
  }

  // The row's tag and branch chips, cut where the row runs out of room: what
  // fits the budget shows and the rest reads as one "+N" pill. A chip that
  // cannot fit whole still shows what the budget can hold rather than nothing,
  // so a row with tags never hides them all; the hover card has the whole set.
  rowChips(t, c, isHead, g) {
    const specs = this.chipSpecs(c, isHead);
    if (!specs.length) return [];
    const budget = this.chipBudget(g), cap = 150, pill = 30;
    const widths = specs.map((spec) => this.chipWidth(spec, cap) + 7);   // 7: the gap between chips
    let shown = 0, used = 0;
    while (shown < specs.length && used + widths[shown] <= budget) { used += widths[shown]; shown += 1; }
    // The "+N" pill needs room as well: one chip fewer beats a count of chips
    // with no chip to count from.
    if (shown < specs.length && shown > 0 && used + pill > budget) shown -= 1;
    const chips = specs.slice(0, shown).map((spec) => this.chipOf(t, spec, cap));
    if (shown < specs.length) {
      if (!shown) {
        // Nothing fits whole: the first chip reads as much of its label as the
        // budget has room for (the card has the rest of it).
        const room = specs.length > 1 ? pill : 0;   // a "+N" pill only when one follows
        const chrome = specs[0].kind === "tag" ? 23 : 20;
        chips.push(this.chipOf(t, specs[0], Math.max(16, budget - room - chrome - 6)));
        shown = 1;
      }
      // The pill counts what the row is not showing; with the single chip above
      // having taken the first spec, there may be nothing left to count.
      if (shown < specs.length) chips.push(
        h_flex().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim)
          .child(`+${specs.length - shown}`));
    }
    // The box is capped at the budget and clips: were the estimates above
    // generous, the row would still keep the subject its share.
    return [h_flex().flex_none().min_w(0).max_w(budget).overflow_hidden().gap(7).children(chips)];
  }

  header(t) {
    const repo = this.root ? this.root.split(/[\\/]/).pop() : null;
    const busy = this.busy || this.loading;
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(icon("git").size(15).text_color(t.accent))
      .child(div().font_semibold().child("Git"))
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
    const picked = this.picked.size, total = this.localRefs.length + this.remoteRefs.length;
    // The branch itself is the button of the branch list: one press drops the
    // list under it. `Popup` paints the content in a layer anchored to this
    // trigger, above the rest of the panel, so nothing below it moves; this
    // script owns the press and the dismissal (Esc, a press elsewhere).
    const trigger = h_flex().id("git-branch-pick").flex_1().min_w(0).h(22).px(5).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.branchPick, (e) => e.bg(t.hover))
      .when(!this.branchPick, (e) => e.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      // Opening the branch list takes the commit popup down: only one anchored
      // surface at a time (a commit click closes the branch list the same way).
      .on_click((_e, cx) => { cx.stop_propagation(); this.branchPick = !this.branchPick; if (this.branchPick) this.commitView = null; cx.notify(); })
      .child(icon("branch").size(13).text_color(t[this.lampOf(this.branch)]))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.branch))
      .when(picked > 0, (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(t.selected).text_size(10).text_color(t.accent)
        .child(`${picked}/${total}`)))
      .when(Boolean(this.upstream), (e) => e.child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim)
        .child(`\u2192 ${this.upstream}`)))
      .child(icon("chevron-down").size(12).text_color(t.dim));
    return h_flex().h(30).flex_none().pl(6).pr(6).gap(4).items_center().border_b(1).border_color(t.border)
      .child(Popup.new("git-branch-pop", trigger).anchor("top_left")
        .when(this.branchPick, (e) => e.content(this.branchPickView(t))))
      .when(!this.upstream, (e) => e.child(
        h_flex().id("git-publish").h(22).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.push(cx); })
          .child(icon("arrow-up").size(12).text_color(t.accent))
          .child(div().text_size(11).text_color(t.accent).child("Publish"))))
      .when(this.upstream && this.behind > 0, (e) => e.child(counter("git-pull", "arrow-down", this.behind, (cx) => this.pull(cx))))
      .when(this.upstream && this.ahead > 0, (e) => e.child(counter("git-push", "arrow-up", this.ahead, (cx) => this.push(cx))));
  }

  // The branch list itself: the Popup's content under the branch row. Every
  // local and remote branch with its lamp, a click toggles it. Nothing picked
  // means all branches, as always; picking narrows the history to the commits
  // the picked branches' histories reach. The surface closes on a press
  // outside, a press on the trigger, or Escape.
  branchPickView(t) {
    const picked = this.picked;
    const row = (name) => {
      const on = picked.has(name);
      return h_flex().id(`git-bp-${name}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(on, (e) => e.bg(t.selected))
        .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { if (picked.has(name)) picked.delete(name); else picked.add(name); this._graph = null; this.syncCommitView(); cx.notify(); })
        .child(div().size(9).flex_none().rounded(5).bg(t[this.lampOf(name)]))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.muted).child(name))
        .when(name === this.branch, (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child("current")))
        .when(on, (e) => e.child(icon("check").size(12).text_color(t.accent)));
    };
    const label = (text) => div().flex_none().px(8).pt(7).pb(2).text_size(10).font_semibold().text_color(t.dim).child(text);
    const maxH = Math.max(150, Math.min(380, Math.round((this.size?.height ?? 560) / this.unit) - 110));
    const width = Math.max(240, Math.round((this.size?.width ?? 720) / this.unit) - 12);
    return v_flex().id("git-branch-pop-list").w(width).max_h(maxH).flex_none()
      .rounded(8).bg(t.popover).border_1().border_color(t.input).overflow_y_scrollbar().py(4).text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().id("git-bp-all").h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(picked.size === 0, (e) => e.bg(t.selected))
        .when(picked.size > 0, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { picked.clear(); this._graph = null; this.syncCommitView(); cx.notify(); })
        .child(icon("git").size(11).text_color(t.muted))
        .child(div().flex_1().text_size(12).text_color(picked.size ? t.muted : t.foreground).child("All branches"))
        .when(picked.size === 0, (e) => e.child(icon("check").size(12).text_color(t.accent))))
      .when(this.localRefs.length > 0, (e) => e.child(label("Local")).children(this.localRefs.map(row)))
      .when(this.remoteRefs.length > 0, (e) => e.child(label("Remote")).children(this.remoteRefs.map(row)));
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
      .child(h_flex().flex_1().min_w(0).gap(6)
        .child(div().truncate().flex_shrink_0().child(name))
        .when(Boolean(dir), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).flex_shrink(8).child(dir))))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`\u2212${f.del}`)))
      .children(hovered || confirming ? actions : []);
  }

  // The lamp key for a ref: a remote branch borrows its local branch's color.
  colorOf(name) { return name && this.remotes?.has(name) ? name.replace(/^[^/]+\//, "") : name; }

  // The palette entry ("ansi4", ...) for a ref: this refresh's assignment when the
  // branch is shown, else its own hash.
  lampOf(name) {
    const key = this.colorOf(name);
    return this.lamps?.get(key) ?? LAMPS[lampIndex(key)];
  }

  // Right-clicking a commit opens a small menu (an overlay copy of this mod, which
  // renders the menu only) at the pointer: the branch lamp, the commit, Copy Hash,
  // Create Branch. The repository travels in the props, since the dialog copy the
  // Create Branch item opens has no panel of its own to read one from.
  commitMenu(t, c) {
    openOverlay({ mod: "git", kind: "popup", width: 250,
      props: { commitMenu: { hash: c.hash, short: c.short, subject: c.subject, lamp: c.owner ? this.lampOf(c.owner) : null, cwd: this.root, on: this.on } } });
  }

  // The full SHA on the clipboard, with a toast either way. The context menu's
  // Copy Hash and the detail surface's header button share it.
  async copyHash(c) {
    const ok = await copyText(c.hash);
    notify(ok
      ? { title: "Hash copied", body: c.short, timeout: 1400 }
      : { title: "Cannot copy", body: "No clipboard tool found (pbcopy, wl-copy, xclip)", level: "warning", timeout: 2200 });
  }

  // The overlay copy's whole render. Copy runs before the popup closes, so its
  // task is not cancelled with the copy.
  commitMenuView(t, m) {
    const close = () => closeOverlay(props().overlay);
    const copy = (cx) => cx.spawn(async () => { await this.copyHash(m); close(); });
    return v_flex().id("git-commit-menu").w_full().p(4).bg(t.popover).text_size(11.5)
      .track_focus(this.menuHandle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); close(); }
        else if (e.key === "enter") { cx.stop_propagation(); copy(cx); }
      })
      .child(h_flex().h(21).px(7).gap(7).items_center()
        .when(Boolean(m.lamp), (e) => e.child(div().size(8).flex_none().rounded(4).bg(t[m.lamp])))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`${m.short} ${m.subject || ""}`)))
      .child(div().mx(6).my(2).h(1).bg(t.border))
      .child(h_flex().id("git-menu-copy").h(26).px(7).gap(7).rounded(6).items_center().text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => copy(cx))
        .child(icon("copy").size(12).text_color(t.muted))
        .child(div().flex_1().child("Copy Hash"))
        .child(div().text_size(10).text_color(t.dim).child("Enter")))
      .child(h_flex().id("git-menu-branch").h(26).px(7).gap(7).rounded(6).items_center().text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          close();
          openOverlay({ mod: "git", kind: "dialog", width: 420, height: 216,
            props: { createBranch: { hash: m.hash, short: m.short, subject: m.subject, cwd: m.cwd, on: m.on } } });
        })
        .child(icon("branch").size(12).text_color(t.muted))
        .child(div().flex_1().child("Create Branch\u2026")));
  }

  // The create-branch form (another overlay copy). Enter creates and switches:
  // `git switch -c <name> <commit>` makes the branch at the commit and moves
  // the checkout to it in one step. Failures read in the form; the toast
  // confirms the switch.
  branchDialogView(t, b) {
    const close = () => closeOverlay(props().overlay);
    const busy = this.branchBusy, ready = Boolean(this.branchName.trim()) && !busy;
    return v_flex().id("git-branch-dialog").size_full().track_focus(this.branchHandle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); close(); }
        else if (e.key === "enter" && !this.branchFocused) { cx.stop_propagation(); this.createBranch(cx); }
      })
      .p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child("New branch"))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).font_family(MONO()).text_size(10).text_color(t.dim).child(b.short))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(b.subject || "")))
      .child(Input.new(this.branchInput).h(32).px(10).items_center().rounded(6).border(1)
        .border_color(this.branchFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .when(Boolean(this.branchError), (e) => e.child(div().flex_none().truncate().text_size(11.5).text_color(t.ansi1).child(this.branchError)))
      .child(div().flex_1())
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(busy ? "creating\u2026" : "\u21b5 create \u00b7 esc cancel"))
        .child(this.textButton("git-branch-cancel", "Cancel", t.background, t.foreground, () => close(), t))
        .child(this.textButton("git-branch-create", "Create", ready ? t.solid : t.raised, ready ? t.solid_foreground : t.dim, (cx) => this.createBranch(cx), t)));
  }

  async createBranch(cx) {
    if (this.branchBusy) return;
    const b = props().createBranch;
    const name = this.branchName.trim();
    if (!name) { this.branchError = "Type a branch name."; cx.notify(); return; }
    this.branchBusy = true; this.branchError = ""; cx.notify();
    try {
      const r = await exec("git", ["switch", "-c", name, b.hash], { cwd: b.cwd, on: b.on });
      if (r.code !== 0) { this.branchError = (r.stderr || r.stdout || "git switch failed").trim(); this.branchBusy = false; cx.notify(); return; }
      notify({ title: "Branch created", body: `${name} at ${b.short}`, timeout: 1600 });
      closeOverlay(props().overlay);
    } catch (e) {
      this.branchError = String(e); this.branchBusy = false; cx.notify();
    }
  }

  // The graph for the shown list, cached until the commits or the picker
  // changes. Each row keeps the dot's lane x, its lamp, and the line pieces.
  graph(commits) {
    const picked = [...this.picked].sort().join("\n");
    const hit = this._graph;
    if (hit && hit.src === this.commits && hit.picked === picked) return hit;
    // A commit's line is colored by the branch tip on it: the current branch
    // first, then any branch the picker has on (nothing picked: all of them).
    const tipName = (c) => {
      const names = (c.tips ?? []).filter((n) => !this.picked.size || this.picked.has(n));
      return names.find((n) => n === this.branch) ?? names[0] ?? null;
    };
    const { rows, lanes, colors, maxLane } = graphRows(commits, tipName, (n) => this.lampOf(n));
    const width = GRAPH.x0 * 2 + maxLane * GRAPH.pitch;
    this._graph = { src: this.commits, picked,
      rows: rows.map((items, i) => ({ x: GRAPH.x0 + lanes[i] * GRAPH.pitch, width, items, color: colors[i] })) };
    return this._graph;
  }

  // One row's dot column: the lines under the dot, grouped into one painted
  // layer per lamp, and the dot itself on top.
  gutter(t, g) {
    const byLamp = new Map();
    for (const piece of g.items) {
      if (!byLamp.has(piece.c)) byLamp.set(piece.c, []);
      byLamp.get(piece.c).push(piece);
    }
    return div().w(g.width).h_full().flex_none()
      .children([...byLamp].map(([name, pieces]) =>
        window.paint_path(strokePath(pieces, g.width), t[name]).absolute().top(0).left(0).size_full()))
      .child(div().absolute().top(7.5).left(g.x - 4.5).size(9).rounded(5).bg(t[g.color]));
  }

  commitRow(t, c, g) {
    const open = this.commitView?.hash === c.hash;
    const isHead = c.hash === this.headSha;
    const row = h_flex().id(`git-c-${c.hash}`).h(24).flex_none().px(10).gap(7).items_center().rounded(6).overflow_hidden()
      .when(open, (e) => e.bg(t.selected))
      .when(!open, (e) => e.hover((s) => s.bg(t.hover)))
      // The press belongs to the row: a press anywhere else in the panel takes the
      // commit popup down, and the open row must read its own click as the toggle.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.pickCommit(c, cx))
      // Right-clicking a commit opens its menu at the pointer. The detail a click
      // opened goes down first: the menu replaces it, so the two surfaces never
      // stand over the list together.
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        if (this.commitView) { this.commitView = null; cx.notify(); }
        this.commitMenu(t, c);
      })
      .child(this.gutter(t, g))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.subject || "(no subject)"))
      .children(this.rowChips(t, c, isHead, g))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.when ?? ""));
    // Resting the pointer on the row opens the whole commit above it -- above,
    // where the click-opened detail below never covers it. The card owns its
    // delay and dismissal, so nothing here tracks the pointer or re-renders.
    const card = HoverCard.new(`git-tip-${c.hash}`)
      .open_delay(350).close_delay(160).anchor("bottom_left")
      .trigger(row)
      .content(this.commitTip(t, c, isHead));
    // A picked commit's details float under its own row instead of a panel below
    // the list: the row stays where it is, and the surface opens over what follows.
    return Popup.new(`git-commit-pop-${c.hash}`, card).anchor("top_left")
      .when(open, (e) => e.content(this.commitPopup(t)));
  }

  // The card a resting pointer opens: the whole row with nothing given up for
  // room. The subject on the first line, the date at its right, and every tag
  // and branch under it -- the ones the row itself had to shorten included.
  // Sized like the commit popup: never wider than the panel, never taller than
  // what the panel can show.
  commitTip(t, c, isHead) {
    const width = Math.max(240, Math.round((this.size?.width ?? 720) / this.unit) - 20);
    const maxH = Math.max(150, Math.min(420, Math.round((this.size?.height ?? 560) / this.unit) - 120));
    const specs = this.chipSpecs(c, isHead);
    return v_flex().w(width).max_h(maxH).flex_none().gap(7).p(10).rounded(8).bg(t.popover)
      .border_1().border_color(t.input).overflow_hidden()
      .child(h_flex().gap(10).items_start()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(c.subject || "(no subject)"))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.when ?? "")))
      .when(specs.length > 0, (e) => e.child(
        h_flex().flex_wrap().gap(7).children(specs.map((spec) => this.chipOf(t, spec, null)))));
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
      .child(div().text_size(12).text_color(t.dim).text_center().child(this.error || (this.loading ? "Loading\u2026" : "No folder")))
      // A folder with no repository offers to make one. While `git init` runs the
      // button names the work and does nothing; the panel refreshes when it lands.
      .when(this.notRepo, (e) => e.child(
        this.textButton("git-init", this.busy ? "Initializing\u2026" : "Initialize Repository",
          this.busy ? t.raised : t.solid, this.busy ? t.dim : t.solid_foreground, (cx) => this.initRepo(cx), t)
          .mt(4)));
  }

  // The Commits pane's top edge, dragged: the log grows as the pointer rises.
  // `unit` maps the window's pixels to design pixels, measured on the strip.
  resizeMove(e, cx) {
    if (!this.resize) return;
    const maxH = Math.max(80, Math.round((this.size?.height ?? 560) / this.unit) - 250);
    const next = Math.round(Math.min(maxH, Math.max(72, this.resize.h - (e.position.y - this.resize.startY) / this.unit)));
    if (next !== this.logHeight) { this.logHeight = next; cx.notify(); }
  }

  resizeEnd(cx) {
    if (!this.resize) return;
    this.resize = null;
    localStorage.setItem("logHeight", String(this.logHeight));
    cx.notify();
  }

  // The commits of the picked branches; while nothing is picked, all of them.
  shownCommits() {
    if (!this.picked.size) return this.commits;
    return this.commits.filter((c) => { for (const name of this.picked) if (c.reach.has(name)) return true; return false; });
  }

  // The commit popup belongs to its row: a branch filter or a refresh that takes
  // the row out of the shown list takes the popup down with it.
  syncCommitView() {
    const c = this.commitView;
    if (c && !this.shownCommits().some((x) => x.hash === c.hash)) this.commitView = null;
  }

  // The Commits pane. Its top edge is the drag strip: pull it up or down to size
  // the log (remembered; the strip also measures the window's pixel unit while
  // it lays out). The count reads "<shown>/<all>" while a branch filter is on.
  historySection(t) {
    const commits = this.shownCommits();
    const graph = this.graph(commits);
    const filtered = this.picked.size > 0;
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .when(!this.historyCollapsed, (e) => e.child(
        div().id("git-log-resize").h(6).flex_none().w_full().cursor_row_resize()
          .when(this.resize, (s) => s.bg(t.accent))
          .when(!this.resize, (s) => s.hover((c) => c.bg(t.hover)))
          .on_size_change((size, cx) => {
            // `unit` maps window pixels to design pixels (the strip is 6 design
            // pixels tall); the chip budget needs it as soon as it is known.
            if (size.height > 0 && Math.abs(this.unit - size.height / 6) > 0.001) { this.unit = size.height / 6; cx.notify(); }
          })
          .on_mouse_down("left", (ev, cx) => {
            cx.stop_propagation();
            this.resize = { startY: ev.position.y, h: this.logHeight };
          })
          .on_mouse_move((ev, cx) => this.resizeMove(ev, cx))
          .on_mouse_up("left", (_ev, cx) => this.resizeEnd(cx))))
      .child(h_flex().h(30).flex_none().pl(8).pr(10).gap(5).items_center()
        .child(div().id("git-log-tog").w(18).h(18).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.historyCollapsed = !this.historyCollapsed; cx.notify(); })
          .child(icon(this.historyCollapsed ? "chevron-right" : "chevron-down").size(14).text_color(t.muted)))
        .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child("Commits"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim)
          .child(filtered ? `${commits.length}/${this.commits.length}` : String(commits.length)))
        .child(div().id("git-reflog").w(18).h(18).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); })
          .child(icon("refresh").size(13).text_color(t.dim))))
      .when(!this.historyCollapsed, (e) => e.child(
        v_flex().id("git-log").h(this.logHeight).flex_none().py(4).overflow_y_scrollbar()
          .children(commits.map((c, i) => this.commitRow(t, c, graph.rows[i])))
          .when(!commits.length, (e) => e.child(div().p(10).text_size(12).text_color(t.dim)
            .child(filtered ? "No commits in the picked branches" : this.hasHead ? "No commits" : "No commits yet")))));
  }

  // The surface a picked commit opens under its row: its message and the names
  // of the files it changed. Choosing a file hands its diff to the git-diff pane
  // in the main area; choosing the file that pane already shows closes it again.
  commitPopup(t) {
    const c = this.commitView;
    const files = c.files.slice(0, 800);
    const target = this.shownTarget();
    const isShown = (path) => Boolean(target) && target.mode === "commit" && target.commit === c.hash && target.path === path;
    // The panel's own width and height, in design pixels (see `unit`), so the
    // surface reads as a widening of the row: never wider than the panel, never
    // taller than what fits above its bottom edge. The body caps its own height
    // rather than flexing: the surface is sized by its content, so a flex-1
    // child would contribute nothing and collapse.
    const width = Math.max(240, Math.round((this.size?.width ?? 720) / this.unit) - 20);
    const maxH = Math.max(160, Math.min(400, Math.round((this.size?.height ?? 560) / this.unit) - 110));
    return v_flex().id("git-commit-pop").w(width).max_h(maxH).flex_none().rounded(8).bg(t.popover)
      .border_1().border_color(t.input).overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().h(30).flex_none().pl(10).pr(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child("Commit"))
        // The header says which commit this is, not what it says: the message is
        // the body's first line, and the full SHA copies from the button.
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).font_family(MONO()).child(c.short))
        .child(div().id("git-commit-copy").w(20).h(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip("Copy hash")
          .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => { await this.copyHash(c); }); })
          .child(icon("copy").size(13).text_color(t.dim)))
        .child(div().id("git-commit-close").w(20).h(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeCommit(cx); })
          .child(icon("close").size(13).text_color(t.dim))))
      .child(v_flex().id("git-commit-body").max_h(maxH - 30).flex_none().overflow_y_scrollbar().p(10).gap(3)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(c.subject || "(no subject)"))
        .when(Boolean(c.body), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(c.body.slice(0, 4000))))
        .child(div().h(4).flex_none())
        .when(!c.loaded, (e) => e.child(div().text_size(12).text_color(t.dim).child("Loading\u2026")))
        .when(c.loaded && !files.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No file changes")))
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
    if (props()?.commitMenu) return this.commitMenuView(theme(), props().commitMenu);
    if (props()?.createBranch) return this.branchDialogView(theme(), props().createBranch);
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

    const body = v_flex().id("git-list").w_full().flex_1().min_h(0).py(4).overflow_y_scrollbar()
      .children(list.map((r) => (r.kind === "file" ? this.fileRow(t, r.f, r.staged) : this.sectionRow(t, r))));

    return v_flex().id("git").size_full().min_h(0).relative().rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        // The row's chip budget is measured against these, so a change redraws
        // once with the new share rather than waiting for the next refresh.
        if (size.width !== this.size?.width || size.height !== this.size?.height) { this.size = size; cx.notify(); }
      })
      // Dragging the Commits pane's top edge resizes the log. The strip stops the
      // press; a press anywhere else, leaving the panel, or a press outside ends a
      // drag the pointer got away from, so it never resumes without a button held.
      // A press outside the branch list or the commit popup closes it too (each
      // surface stops its own presses).
      .on_mouse_down("left", (_e, cx) => {
        let dirty = false;
        if (this.resize) { this.resize = null; dirty = true; }
        if (this.branchPick) { this.branchPick = false; dirty = true; }
        if (this.commitView) { this.commitView = null; dirty = true; }
        if (dirty) cx.notify();
      })
      .on_mouse_down_out((_e, cx) => {
        let dirty = false;
        if (this.resize) { this.resize = null; dirty = true; }
        if (this.branchPick) { this.branchPick = false; dirty = true; }
        if (this.commitView) { this.commitView = null; dirty = true; }
        if (dirty) cx.notify();
      })
      .on_hover((hovered, cx) => { if (!hovered && this.resize) { this.resize = null; cx.notify(); } })
      .on_mouse_move((e, cx) => this.resizeMove(e, cx))
      .on_mouse_up("left", (_e, cx) => this.resizeEnd(cx))
      .child(this.header(t))
      .when(Boolean(this.root) && Boolean(this.branch), (e) => e.child(this.branchRow(t)))
      .when(Boolean(this.root), (e) => e.child(this.commitBox(t)))
      .when(this.confirmAll, (e) => e.child(this.confirmAllBar(t)))
      .when(!this.root, (e) => e.child(this.emptyState(t)))
      .when(Boolean(this.root), (e) => e.child(body))
      .when(Boolean(this.root), (e) => e.child(this.historySection(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
