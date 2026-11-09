// A lazy file browser for the focused pane's folder. Clicking a file hands it to
// the file-view tab in the main area (shared("files.view")), like the git panel
// hands a diff to git-diff -- it opens there as an editor; one view tab serves the
// space (another click updates it in place), the same click on the shown file
// closes the tab again, and a click on a folder opens or closes it.
// Rows are selectable: Cmd/Ctrl+click toggles one, Shift+click takes the range
// from the last click, and the right-click menu acts on the whole selection.
// The file's menu opens it (the system's default application, or the file-view
// tab), renames it, copies/cuts it, pastes into the clicked folder, copies its
// path, and deletes it; a folder's menu also makes files and folders, and the
// tree's empty space has the whole-folder versions (new, paste).
// Copy and cut leave their entries in shared("files.clipboard"); paste copies --
// or, after a cut, moves -- them into the target folder, giving a taken name
// " copy" (a name a cut brings along gets " 2") so nothing is overwritten.
// The same mod draws that menu and the three dialogs (rename, new, delete
// confirmation): overlay copies opened with props {fileMenu}, {renameOp},
// {newOp} and {confirmDelete}. Each row carries a type icon: one glyph and
// theme color per kind of file (see FILE_TYPES below), a folder its chevron.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, props, openOverlay, closeOverlay, notify, run, shared, setShared } from "herdr";

// The last folder a terminal named, so the file-view tab (a mod tab with no
// terminal of its own) keeps the panel on the folder it was browsing.
let lastTerm = null; // { cwd, on, space }

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane (this panel itself, or the file-view tab) has no folder of its
  // own: keep following the tab's terminal, so opening a file never changes the
  // folder being browsed.
  if (pane && !pane.terminal) {
    const term = panes().find(p => p.tab === pane.tab && p.terminal);
    if (term?.cwd) { lastTerm = { cwd: term.cwd, on, space: space?.id }; return { cwd: term.cwd, on, space: space?.id }; }
    // A mod tab holding no terminal (the file-view or git-diff tab this layout
    // opens): the viewed file, else the compared diff, names its folder;
    // failing that, keep the last one a terminal named in this space.
    const v = pane.mod === "file-view" ? shared("files.view")
      : pane.mod === "git-diff" ? shared("git.diff") : null;
    if (v?.root) return { cwd: v.root, on: v.on ?? on, space: space?.id };
    if (lastTerm && lastTerm.space === space?.id) return { cwd: lastTerm.cwd, on, space: space?.id };
  }
  const loc = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
  if (pane?.cwd) lastTerm = loc;
  return loc;
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
const splitExt = (name) => { const dot = name.lastIndexOf("."); return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]; };
const items = (n) => `${n} item${n === 1 ? "" : "s"}`;

// ---- file type icons ----
// Each kind of file gets its own icon and color; a name the table below does
// not know falls back to the plain file. The icons live beside this mod,
// drawn in the same 24px stroke style as folder.svg. Colors are theme names,
// so they follow the theme and its light or dark appearance.
const FILE_TYPES = [
  // [icon, color, extensions] -- first match wins.
  ["file-md", "ansi4", "md mdx markdown"],
  ["file-json", "ansi3", "json jsonc json5 webmanifest"],
  ["file-lock", "dim", "lock"],
  ["file-config", "ansi5", "yaml yml toml ini cfg conf config properties env"],
  ["file-style", "ansi4", "css scss sass less styl"],
  ["file-text", "ansi1", "pdf"],
  ["file-text", "ansi4", "doc docx odt rtf pages"],
  ["file-text", "ansi2", "xls xlsx ods numbers csv tsv"],
  ["file-text", "ansi3", "ppt pptx odp key"],
  ["file-text", "muted", "txt log text"],
  ["terminal", "ansi2", "sh bash zsh fish ksh csh tcsh dash mksh"],
  ["terminal", "ansi4", "ps1 psm1 bat cmd"],
  ["database", "ansi4", "sql db sqlite sqlite3"],
  ["image", "ansi5", "png jpg jpeg gif webp bmp ico icns tif tiff svg heic avif"],
  ["film", "ansi4", "mp4 mov mkv webm avi wmv flv m4v mpg mpeg"],
  ["music", "ansi6", "mp3 wav flac ogg m4a aac opus mid midi"],
  ["archive", "ansi3", "zip tar gz bz2 xz 7z rar zst tgz"],
  ["file-code", "ansi4", "ts tsx mts cts c h cc cpp cxx hpp hh mm java cs go rs swift kt kts scala lua zig dart xml"],
  ["file-code", "ansi3", "js jsx mjs cjs"],
  ["file-code", "ansi6", "py pyw pyi rb pl pm php r jl ex exs erl hr hs ml clj"],
  ["file-code", "ansi1", "html htm xhtml svelte"],
  ["file-code", "ansi2", "vue astro"],
].flatMap(([icon, color, exts]) => exts.split(" ").map(ext => ({ ext, icon, color })));
const FILE_TYPE_BY_EXT = new Map(FILE_TYPES.map(({ ext, icon, color }) => [ext, { icon, color }]));
// Names without an extension, or where the name says more than one would.
const FILE_TYPE_BY_NAME = new Map([
  ["gnumakefile", { icon: "file-config", color: "ansi3" }],
  ["cmakelists.txt", { icon: "file-config", color: "ansi4" }],
  ["license", { icon: "file-text", color: "ansi3" }],
  ["licence", { icon: "file-text", color: "ansi3" }],
  ["notice", { icon: "file-text", color: "muted" }],
  ["authors", { icon: "file-text", color: "muted" }],
  ["readme", { icon: "file-text", color: "ansi4" }],
  [".gitignore", { icon: "file-config", color: "ansi1" }],
  [".gitattributes", { icon: "file-config", color: "ansi1" }],
  [".gitmodules", { icon: "file-config", color: "ansi1" }],
  [".editorconfig", { icon: "file-config", color: "ansi5" }],
  [".zshrc", { icon: "terminal", color: "ansi2" }],
  [".bashrc", { icon: "terminal", color: "ansi2" }],
  [".profile", { icon: "terminal", color: "ansi2" }],
]);

// The icon and color one entry's name resolves to, against the given theme.
function fileIcon(name, t) {
  const lower = name.toLowerCase(), dot = lower.lastIndexOf(".");
  const found = FILE_TYPE_BY_NAME.get(lower)
    ?? (lower.startsWith("dockerfile") ? { icon: "file-config", color: "ansi4" }
      : lower.startsWith("makefile") ? { icon: "file-config", color: "ansi3" }
        : lower.startsWith(".env") ? { icon: "file-config", color: "ansi3" }
          : FILE_TYPE_BY_EXT.get(dot >= 0 ? lower.slice(dot + 1) : ""));
  return { file: `mods/files-menu/${found?.icon ?? "file"}.svg`, color: t[found?.color ?? "muted"] ?? t.muted };
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Opens a file or folder with the system's default application, on the machine
// that holds it.
async function openDefault(path, on) {
  const psQuote = `'${path.replace(/'/g, "''")}'`;
  const windows = ["-NoProfile", "-Command", `Invoke-Item -LiteralPath ${psQuote}`];
  let r;
  if (!on) {
    const platform = window()?.platform;
    r = platform === "windows" ? await exec("powershell", windows) : await exec(platform === "macos" ? "open" : "xdg-open", [path]);
  } else {
    try {
      r = await exec("sh", ["-c", 'if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$1"; else exec open "$1"; fi', "open", path], { on });
    } catch (e) {
      if (!String(e).includes("cannot start sh: program not found")) throw e;
      r = await exec("powershell", windows, { on });
    }
  }
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || `exit code ${r.code}`);
}

// ---- file operations ----
// They run on the machine that holds the files: POSIX sh for this computer and
// Unix remotes, PowerShell when the machine is Windows. Nothing is ever
// overwritten: a taken name gets " copy" for a pasted copy, or " 2" -- " 3",
// ... -- for a name a cut brings along.

const isWindows = (on) => !on && window()?.platform === "windows";
const psLit = (p) => `'${p.replace(/'/g, "''")}'`;

async function runOp(script, paths, on, ps) {
  if (!isWindows(on)) {
    try { return await exec("sh", ["-c", script, "files", ...paths], { on }); }
    catch (e) {
      // A Windows machine has no sh to call, local or remote.
      if (!(on && ps && String(e).includes("cannot start sh: program not found"))) throw e;
    }
  }
  if (!ps) throw new Error("This machine has no shell for the operation");
  return await exec("powershell", ["-NoProfile", "-Command", ps(paths)]);
}

async function exists(path, on) {
  const r = await runOp('test -e "$1" || test -L "$1"', [path], on,
    ([q]) => `if (Test-Path -LiteralPath ${psLit(q)}) { "yes" } else { "no" }`);
  return isWindows(on) ? r.stdout.trim() === "yes" : r.code === 0;
}

async function freeName(dir, name, on, copy) {
  if (!(await exists(`${dir}/${name}`, on))) return name;
  const [stem, ext] = splitExt(name);
  for (let i = 1; i < 1000; i++) {
    const candidate = copy ? `${stem} copy${i > 1 ? ` ${i}` : ""}${ext}` : `${stem} ${i + 1}${ext}`;
    if (!(await exists(`${dir}/${candidate}`, on))) return candidate;
  }
  throw new Error("Cannot find a free name");
}

async function transfer(from, to, move, on) {
  const op = move ? "mv" : "cp -R";
  await runOp(`${op} "$1" "$2" || exit 1`, [from, to], on, ([s, d]) => move
    ? `Move-Item -LiteralPath ${psLit(s)} -Destination ${psLit(d)} -Force -ErrorAction Stop`
    : `if ([IO.Directory]::Exists(${psLit(s)})) { Copy-Item -LiteralPath ${psLit(s)} -Destination ${psLit(d)} -Recurse -Force -ErrorAction Stop } else { Copy-Item -LiteralPath ${psLit(s)} -Destination ${psLit(d)} -Force -ErrorAction Stop }`);
}

async function deletePaths(paths, on) {
  const list = paths.filter((p) => p && p !== "/");
  if (!list.length) return;
  await runOp('for p in "$@"; do rm -rf "$p" || exit 1; done', list, on,
    (ps) => `Remove-Item -LiteralPath @(${ps.map(psLit).join(",")}) -Recurse -Force -ErrorAction Stop`);
}

async function makeFolder(path, on) {
  await runOp('mkdir -p "$1" || exit 1', [path], on, ([q]) => `[IO.Directory]::CreateDirectory(${psLit(q)}) | Out-Null`);
}

async function makeFile(path, on) {
  await runOp(': > "$1" || exit 1', [path], on, ([q]) => `[IO.File]::WriteAllText(${psLit(q)}, "")`);
}

// Copies or moves the clipboard's entries into `dir` (absolute). An entry the
// cut already has in place is skipped, not moved onto itself.
async function pasteInto(clip, dir, on) {
  const pairs = [];
  for (const e of clip.entries) {
    if (clip.cut && dirOf(e.path) === dir) continue;
    const name = await freeName(dir, e.name, on, !clip.cut);
    pairs.push([e.path, `${dir}/${name}`, name]);
  }
  for (const [src, dst, name] of pairs) {
    try { await transfer(src, dst, clip.cut, on); }
    catch (e) { throw new Error(`${name}: ${e?.message ?? e}`); }
  }
  return { names: pairs.map((p) => p[2]), skipped: clip.entries.length - pairs.length };
}

// Which of the selection's paths are gone (deleted or renamed elsewhere), so the
// panel can drop them from its selection.
async function missingPaths(root, rels, on) {
  const abs = rels.map((r) => `${root}/${r}`);
  const r = await runOp('for p in "$@"; do [ -e "$p" ] || [ -L "$p" ] || printf "%s\\0" "$p"; done', abs, on,
    (ps) => `foreach ($p in @(${ps.map(psLit).join(",")})) { if (-not (Test-Path -LiteralPath $p)) { [Console]::Out.WriteLine($p) } }`);
  return r.stdout.split(isWindows(on) ? /\r?\n/ : "\0").filter(Boolean);
}

// Every panel copy refreshes when an operation (run by a menu or dialog copy)
// bumps this; the counter is shared, so the copies agree on the last one.
function bumpRefresh() { setShared("files.refresh", (Number(shared("files.refresh")) || 0) + 1); }

// The absolute paths on the clipboard, on the local clipboard, with a toast
// either way.
async function copyText(text) {
  for (const script of ["printf %s \"$1\" | pbcopy", "printf %s \"$1\" | wl-copy", "printf %s \"$1\" | xclip -selection clipboard"]) {
    try { const r = await exec("sh", ["-c", script, "sh", text]); if (r.code === 0) return true; } catch {}
  }
  return false;
}

// The file-view tab of this space, if one is up: the panel keeps a single view
// tab, updated in place, rather than one per click.
function viewTab() {
  const space = spaces().find(s => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map(t => t.id));
  return panes().find(p => p.mod === "file-view" && tabs.has(p.tab))?.tab ?? null;
}

// Hands a file to the file-view tab, opening the tab when none is up yet and
// updating (and showing) the one that is. The panel's click and the menu's
// "Open in tab" share it. The sequence keeps growing so the tab reloads only
// when the target changes; the tab takes the file's name.
function showInPane(root, on, rel) {
  const up = viewTab();
  setShared("files.view", { seq: (Number(shared("files.view")?.seq) || 0) + 1, root, on, path: rel });
  const name = baseOf(rel);
  if (up) {
    run("tab.rename", { id: up, name });
    run("tab.select", { id: up });
  } else {
    run("tab.new", { mod: "file-view", name });
  }
}

// The file-view tab follows its file: a rename/move repoints the published
// target, a delete takes it away (file-view keeps unsaved edits either way).
function viewMoved(root, on, from, to) {
  const shown = shared("files.view");
  if (!shown?.path || shown.root !== root || (shown.on ?? null) !== (on ?? null)) return;
  const abs = `${root}/${shown.path}`;
  if (abs !== from && !abs.startsWith(`${from}/`)) return;
  setShared("files.view", { seq: (Number(shown.seq) || 0) + 1, root, on, path: `${to.slice(root.length + 1)}${abs.slice(from.length)}` });
}

function viewGone(root, on, paths) {
  const shown = shared("files.view");
  if (!shown?.path || shown.root !== root || (shown.on ?? null) !== (on ?? null)) return;
  const abs = `${root}/${shown.path}`;
  if (!paths.some((p) => abs === p || abs.startsWith(`${p}/`))) return;
  setShared("files.view", { seq: (Number(shown.seq) || 0) + 1, root: null, path: null });
}

export default class Files extends View {
  init(_props, cx) {
    // An overlay copy draws one surface only, never the panel: the context menu
    // (props {fileMenu}), the rename / new form ({renameOp}, {newOp}), or the
    // delete confirmation ({confirmDelete}). Each needs its own keys.
    const p = props() ?? {};
    if (p.fileMenu) {
      this.menuHandle = cx.focus_handle();
      this.menuHandle.focus();
      return;
    }
    if (p.renameOp || p.newOp) {
      const r = p.renameOp;
      this.text = r ? r.name : "";
      this.busy = false; this.error = null; this.inputFocused = true;
      this.input = InputState.new({ placeholder: r ? "New name" : p.newOp.kind === "folder" ? "Folder name" : "File name", value: this.text });
      if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = null; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.submitForm(cx));
      this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      this.handle = cx.focus_handle();
      return;
    }
    if (p.confirmDelete) {
      this.busy = false; this.error = null;
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.selected = new Set(); this.anchor = null; this.order = [];
    this.token = Number(shared("files.refresh")) || 0; this.prune = false;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.selected = new Set(); this.anchor = null; this.prune = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        // After an operation bumped the refresh, drop selected paths that are
        // gone (deleted, or renamed away) -- they can no longer be acted on.
        if (this.prune) {
          this.prune = false;
          const rels = [...this.selected];
          if (rels.length) {
            try { for (const abs of await missingPaths(context.cwd, rels, context.on)) this.selected.delete(abs.slice(context.cwd.length + 1)); } catch {}
          }
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // ---- selection ----

  selectOnly(rel) {
    this.selected = new Set([rel]);
    this.anchor = rel;
  }

  toggleSelect(rel) {
    if (this.selected.has(rel)) this.selected.delete(rel); else this.selected.add(rel);
    this.anchor = rel;
  }

  rangeSelect(rel) {
    const at = this.order.indexOf(rel), from = this.anchor === null ? -1 : this.order.indexOf(this.anchor);
    if (at < 0) return;
    if (from < 0) return this.selectOnly(rel);
    this.selected = new Set(this.order.slice(Math.min(at, from), Math.max(at, from) + 1));
  }

  // A row's click: modifiers select, a plain click selects that one and keeps
  // the old click behavior -- a folder opens or closes, a file opens in (or
  // closes from) the file-view tab. The second press of a double-click is the
  // first one again, so only the first acts.
  clickRow(rel, entry, e, cx) {
    if (e.modifiers.platform || e.modifiers.control) { this.toggleSelect(rel); cx.notify(); return; }
    if (e.modifiers.shift) { this.rangeSelect(rel); cx.notify(); return; }
    if (e.click_count > 1) return;
    this.selectOnly(rel);
    if (entry.dir) this.toggle(rel, cx); else this.pick(rel, cx);
    cx.notify();
  }

  // What a row's path looks like in the entries: for a selected path from
  // another folder's row, or one that has just gone, the name stands alone.
  entryOf(rel) {
    const found = (this.entries.get(dirOf(rel)) ?? []).find((e) => e.name === baseOf(rel));
    return { rel, name: baseOf(rel), dir: found?.dir ?? false };
  }

  // Opens the context menu (an overlay copy of this mod). Right-clicking a row
  // outside the selection selects it first, like every file manager; the menu
  // then acts on all of it. Right-clicking the tree's empty space offers the
  // folder itself (new file/folder, paste into this folder).
  menu(rel, entry) {
    if (rel !== null && !this.selected.has(rel)) this.selectOnly(rel);
    const selection = rel === null ? [] : [...this.selected].map((p) => this.entryOf(p));
    openOverlay({ mod: "files-menu", kind: "popup", width: 240,
      props: { fileMenu: { root: this.root, on: this.on, target: entry ? { rel, name: entry.name, dir: entry.dir } : null, selection } } });
  }

  // ---- the file-view tab in the main area ----

  // The file the file-view tab is showing, but only while that tab is up — a
  // closed tab clears the row highlight.
  shownTarget() {
    const target = shared("files.view");
    if (!target?.path) return null;
    return viewTab() ? target : null;
  }

  // Clicking the file the tab is already showing takes the view down again: the
  // lit row reads as "on", so the same click toggles it off by closing the tab.
  pick(path, cx) {
    const shown = this.shownTarget();
    if (shown && shown.path === path && shown.root === this.root) {
      const tab = viewTab();
      if (tab) run("tab.close", { id: tab });
      cx.notify();
      return;
    }
    showInPane(this.root, this.on, path);
    cx.notify();
  }

  // ---- the context menu (an overlay copy) ----

  fileMenuView(t, m) {
    const close = () => closeOverlay(props().overlay);
    const sel = m.selection ?? [], single = sel.length === 1 ? sel[0] : null, tgt = m.target;
    const clip = shared("files.clipboard");
    const clipped = Boolean(clip?.entries?.length);
    const canPaste = clipped && (clip.on ?? null) === (m.on ?? null);
    const pasteDir = tgt ? (tgt.dir ? tgt.rel : dirOf(tgt.rel)) : "";
    const abs = (rel) => `${m.root}/${rel}`;
    const detail = sel.length > 1 ? items(sel.length) : null;

    const item = (id, label, extra, fn, opts = {}) => {
      const live = Boolean(fn) && !opts.disabled;
      return h_flex().id(id).h(26).px(7).gap(7).rounded(6).items_center()
        .when(live, el => el.text_color(opts.danger ? t.ansi1 : t.foreground).cursor_pointer().hover(s => s.bg(t.hover)))
        .when(!live, el => el.text_color(t.dim))
        .when(live, el => el.on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(extra), el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(extra)));
    };
    const sep = () => div().mx(6).my(2).h(1).bg(t.border);

    const openItem = () => item("files-menu-open", tgt.dir ? "Open in file manager" : "Open with default app", null, () => {
      close();
      openDefault(abs(tgt.rel), m.on).catch(e => notify({ title: `Cannot open ${tgt.name}`, body: String(e), level: "error" }));
    });
    const viewItem = () => item("files-menu-view", "Open in tab", null, () => { close(); showInPane(m.root, m.on, tgt.rel); });
    const renameItem = () => item("files-menu-rename", "Rename…", null, () => {
      close();
      openOverlay({ mod: "files-menu", kind: "dialog", width: 420, height: 190,
        props: { renameOp: { root: m.root, on: m.on, rel: tgt.rel, name: tgt.name } } });
    });
    const newItem = (kind) => item(`files-menu-new-${kind}`, kind === "folder" ? "New folder…" : "New file…", null, () => {
      close();
      openOverlay({ mod: "files-menu", kind: "dialog", width: 420, height: 190,
        props: { newOp: { root: m.root, on: m.on, dir: pasteDir, kind } } });
    });
    const copyItem = (cut) => item(cut ? "files-menu-cut" : "files-menu-copy", cut ? "Cut" : "Copy", detail, () => {
      setShared("files.clipboard", { on: m.on, cut, root: m.root, entries: sel.map(e => ({ name: e.name, path: abs(e.rel) })) });
      notify({ title: cut ? `Cut ${items(sel.length)}` : `Copied ${items(sel.length)}`, timeout: 1400 });
      close();
    });
    // The paste keeps the menu up until it has run: closing it takes the copy
    // (and its task) away.
    const pasteItem = () => item("files-menu-paste", "Paste", canPaste ? items(clip.entries.length) : clipped ? "Another machine" : null, canPaste ? (cx) => {
      const c = clip, dir = pasteDir;
      cx.spawn(async () => {
        try {
          const { names } = await pasteInto(c, dir ? `${m.root}/${dir}` : m.root, m.on);
          if (c.cut) setShared("files.clipboard", null);
          bumpRefresh();
          notify(names.length ? { title: `Pasted ${items(names.length)}`, timeout: 1800 } : { title: "Nothing to paste", body: "The items are already in the target folder", timeout: 1800 });
        } catch (e) {
          notify({ title: "Paste failed", body: String(e), level: "error", timeout: 5000 });
        }
        close();
      });
    } : null, { disabled: !canPaste });
    const pathItem = () => item("files-menu-path", "Copy path", detail, (cx) => cx.spawn(async () => {
      const ok = await copyText(sel.map(e => abs(e.rel)).join("\n"));
      notify(ok ? { title: "Path copied", body: single?.name, timeout: 1600 }
        : { title: "Cannot copy", body: "No clipboard tool found (pbcopy, wl-copy, xclip)", level: "warning", timeout: 2400 });
      close();
    }));
    const deleteItem = () => item("files-menu-delete", "Delete", detail, () => {
      close();
      openOverlay({ mod: "files-menu", kind: "dialog", width: 420, height: 200 + Math.min(sel.length, 7) * 16,
        props: { confirmDelete: { root: m.root, on: m.on, entries: sel } } });
    }, { danger: true });

    const rows = [];
    if (tgt) {
      rows.push(openItem(), sep());
      if (single && !single.dir) rows.push(viewItem());
      if (single) rows.push(renameItem());
      if (tgt.dir) rows.push(newItem("file"), newItem("folder"));
      rows.push(sep(), copyItem(false), copyItem(true), pasteItem());
      if (sel.length) rows.push(pathItem());
      rows.push(sep(), deleteItem());
    } else {
      rows.push(newItem("file"), newItem("folder"), sep(), pasteItem());
    }
    return v_flex().id("files-menu").w_full().p(5).bg(t.popover).text_size(12.8)
      .track_focus(this.menuHandle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); close(); } })
      .child(h_flex().h(21).px(7).items_center().child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
        .child(sel.length > 1 ? `${items(sel.length)} selected` : single?.name ?? baseOf(m.root) ?? "")))
      .children(rows);
  }

  // ---- the rename / new-file / new-folder form (an overlay copy) ----

  formView(t, f) {
    const rename = Boolean(props().renameOp);
    const close = () => closeOverlay(props().overlay);
    const ready = this.text.trim().length > 0 && !this.busy;
    return v_flex().id("files-form").size_full().track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); close(); } })
      .p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child(rename ? "Rename" : f.kind === "folder" ? "New folder" : "New file"))
      .when(rename, el => el.child(div().flex_none().truncate().text_size(11.5).text_color(t.dim).child(f.name)))
      .child(Input.new(this.input).h(32).px(10).rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .when(Boolean(this.error), el => el.child(div().flex_none().truncate().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.busy ? "Working…" : "\u21b5 Submit \u00b7 Esc Cancel"))
        .child(this.textButton("files-form-cancel", "Cancel", t.background, t.foreground, () => close(), t))
        .child(this.textButton("files-form-ok", rename ? "Rename" : "Create", ready ? t.solid : t.raised, ready ? t.solid_foreground : t.dim, (cx) => this.submitForm(cx), t)));
  }

  // Rename: one mv, with the name checked first. New: one mkdir / touch. A
  // failure (a taken name, a refused write) reads in the form.
  submitForm(cx) {
    const p = props(), r = p.renameOp, n = p.newOp, overlay = p.overlay;
    if (this.busy) return;
    const name = this.text.trim();
    if (!name) { this.error = "The name cannot be empty"; cx.notify(); return; }
    if (/[\\/]/.test(name) || name === "." || name === "..") { this.error = "The name cannot contain a slash"; cx.notify(); return; }
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (r) {
          if (name !== r.name) {
            const dir = dirOf(r.rel), from = `${r.root}/${r.rel}`, to = dir ? `${r.root}/${dir}/${name}` : `${r.root}/${name}`;
            if (await exists(to, r.on)) throw new Error(`"${name}" already exists`);
            await transfer(from, to, true, r.on);
            viewMoved(r.root, r.on, from, to);
            notify({ title: "Renamed", body: name, timeout: 1600 });
          }
        } else {
          const to = n.dir ? `${n.root}/${n.dir}/${name}` : `${n.root}/${name}`;
          if (await exists(to, n.on)) throw new Error(`"${name}" already exists`);
          if (n.kind === "folder") await makeFolder(to, n.on); else await makeFile(to, n.on);
          notify({ title: n.kind === "folder" ? "Folder created" : "File created", body: name, timeout: 1600 });
        }
        bumpRefresh();
        closeOverlay(overlay);
      } catch (e) {
        this.error = String(e?.message ?? e); this.busy = false; cx.notify();
      }
    });
  }

  // ---- the delete confirmation (an overlay copy) ----

  deleteView(t, d) {
    const close = () => closeOverlay(props().overlay);
    const rows = d.entries.slice(0, 7).map((e) => {
      const ico = e.dir ? null : fileIcon(e.name, t);
      return h_flex().h(18).gap(7).items_center()
        .child(svg(ico?.file ?? "mods/files-menu/folder.svg").size(12).flex_none().text_color(ico?.color ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(e.name));
    });
    return v_flex().id("files-delete").size_full().track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); close(); }
        else if (e.key === "enter" && !this.busy) { cx.stop_propagation(); this.doDelete(cx); }
      })
      .p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child(`Delete ${items(d.entries.length)}?`))
      .child(v_flex().gap(2).children(rows)
        .when(d.entries.length > 7, el => el.child(div().h(18).text_size(11.5).text_color(t.dim).child(`…and ${d.entries.length - 7} more`))))
      .child(div().text_size(11.5).text_color(t.ansi1).child("This cannot be undone."))
      .when(Boolean(this.error), el => el.child(div().flex_none().truncate().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().items_center().gap(8)
        .child(this.textButton("files-delete-cancel", "Cancel", t.background, t.foreground, () => close(), t))
        .child(this.textButton("files-delete-yes", this.busy ? "Deleting…" : "Delete", this.busy ? t.raised : t.ansi1, this.busy ? t.dim : t.background, (cx) => this.doDelete(cx), t)));
  }

  // rm -rf on the machine holding the files; the dialog stays up while it runs.
  doDelete(cx) {
    if (this.busy) return;
    const d = props().confirmDelete, overlay = props().overlay;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const abs = d.entries.map((e) => `${d.root}/${e.rel}`);
      try {
        await deletePaths(abs, d.on);
        viewGone(d.root, d.on, abs);
        bumpRefresh();
        notify({ title: `Deleted ${items(abs.length)}`, timeout: 1600 });
        closeOverlay(overlay);
      } catch (e) {
        this.error = String(e?.message ?? e); this.busy = false; cx.notify();
      }
    });
  }

  textButton(id, label, bg, fg, fn, t) {
    return h_flex().id(id).h(26).px(10).items_center().rounded(6).bg(bg).text_color(fg).text_size(11.5).cursor_pointer()
      .hover(s => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(label);
  }

  rows(prefix, depth, out, t, shown) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(rel), mark = this.marks[`${this.root}/${rel}`];
      const selected = this.selected.has(rel);
      const opened = !entry.dir && shown?.path === rel && shown.root === this.root;
      const ico = entry.dir ? null : fileIcon(entry.name, t);
      this.order.push(rel);
      out.push(h_flex().id(`file-${rel}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(selected, el => el.bg(t.selected))
        .when(!selected, el => el.hover(s => s.bg(t.hover)))
        .on_click((e, cx) => { cx.stop_propagation(); this.clickRow(rel, entry, e, cx); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(rel, entry); })
        .child(entry.dir ? svg(`mods/files-menu/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(ico?.file ?? "mods/files-menu/folder.svg").size(14).flex_none().text_color(opened ? t.accent : ico?.color ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().when(opened, el => el.text_color(t.accent)).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(rel, depth + 1, out, t, shown);
    }
    return out;
  }

  render(cx) {
    const p = props() ?? {};
    if (p.fileMenu) return this.fileMenuView(theme(), p.fileMenu);
    if (p.renameOp || p.newOp) return this.formView(theme(), p.renameOp ?? p.newOp);
    if (p.confirmDelete) return this.deleteView(theme(), p.confirmDelete);
    if (key() !== this.context?.key) this.refresh(cx);
    // An operation (in a menu or dialog copy) asked every panel copy to reload.
    const token = Number(shared("files.refresh")) || 0;
    if (token !== this.token) { this.token = token; this.prune = true; this.refresh(cx); }
    const t = theme(), shown = this.shownTarget();
    this.order = [];
    const rows = this.rows("", 0, [], t, shown);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .child(this.selected.size ? `${items(this.selected.size)} selected` : this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(null, null); })
        .on_click((_e, cx) => { if (this.selected.size) { this.selected = new Set(); this.anchor = null; cx.notify(); } })
        .children(rows)
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
