# Herdr 桌面增强 mods · Herdr Desktop Mods

> 一套 [Herdr](https://herdr.dev) 自定义 mod + 窗口布局：除了 Git 工作台（VS Code 风格的源代码管理面板、并排 diff、就地编辑、分支切换），还带来了更完整的文件管理（多选、右键菜单、重命名/复制/粘贴/删除）和改版的 Agents 列表、标签栏与状态栏。
>
> A set of custom [Herdr](https://herdr.dev) mods plus a window layout: a Git workspace (a VS Code-style Source Control panel, side-by-side diffs, in-place editing, branch switching) — and beyond Git, a fuller file manager (selection, context menu, rename/copy/paste/delete) and a reworked agents list, tab bar and status bar.

[中文](#zh) · [English](#en)

![Herdr 桌面增强 mods](preview.png)

---

<a id="zh"></a>

## 中文说明

### 这是什么

本仓库是 Herdr 的个性化扩展，包含两部分：

- `mods/` 下的 7 个 mod：自己编写，或基于 Herdr 自带 mod 改编；
- `layouts/herdr-git.json`：把它们组装成完整工作台的窗口布局（由自带 `main` 布局克隆而来）。

仓库结构与 Herdr 的配置目录（默认 `~/.config/herdr-app/`）一一对应，可以按需复制进去使用。仓库只跟踪我们自己的文件；Herdr 自带的 mod、布局、窗口状态都不在其中（见 `.gitignore`）。Herdr 自带的功能（spaces、changes、pane、win98 等）不属于本项目。

对自带 mod 的改动都以**克隆**形式存在：Agents 列表的改版是 `agents-left`，Files 面板的改版是 `files-menu`（另有 `tabs-git`、`status-branch`）——仓库跟踪与维护的正是这些克隆；Herdr 每次启动会重写或还原的原版副本（`mods/agents`、`mods/files` 等）不纳入版本管理。

装上这个布局后，窗口是这样的：

| 区域 | 内容 |
|---|---|
| 左侧栏 | 空间列表、Agents 列表（`agents-left`）、底部工具条 |
| 顶部 | 标签栏（`tabs-git`）：标签 + Files / Changes / Git 面板开关 |
| 主区 | 终端 / diff / 编辑器面板平铺，面板带常显的标题栏 |
| 右侧栏 | Files / Changes / Git 面板轮换（`files-menu`、`changes`、`git`） |
| 底部 | 状态栏（`status-branch`）：分支可直接点开切换 |

### 7 个 mod

| mod | 来源 | 作用 |
|---|---|---|
| `git` | 全新 | 源代码管理面板：提交框、Staged/Changes、分支与 upstream、提交历史图 |
| `git-diff` | 全新 | diff 面板：并排对比 / 单栏折叠，可从 diff 转入编辑 |
| `file-view` | 全新 | 文件编辑面板（从 Files 面板打开） |
| `files-menu` | 基于自带 `files` 改编 | 文件浏览器：多选、右键菜单、重命名/复制/粘贴/删除、Git 状态标记 |
| `status-branch` | 基于自带 `workspace-status` 改编 | 状态栏上的分支切换按钮 |
| `agents-left` | 基于自带 `agents` 改编 | 状态图标前置的 Agents 列表 |
| `tabs-git` | 基于自带 `tabs` 改编 | 标签栏上的 Files / Changes / Git 面板开关 |

#### `git` — 源代码管理面板

- **提交**：提交框支持 `Commit`（暂存区为空时相当于 VS Code 的 “全部提交”）和 `Commit & Push`；Cmd/Ctrl+Enter 直接提交。没有 upstream 时显示 `Publish`，首次推送并设置 upstream。
- **暂存**：`Staged Changes` / `Changes` 两组可折叠；每行显示状态字母（M/A/D/U/R/!）、路径与 +/− 行数；悬停出现按钮：暂存 / 取消暂存 / 丢弃（丢弃需点第二次确认；整组丢弃有确认弹窗）。
- **分支**：分支行显示当前分支（按分支配色）、upstream、ahead/behind 计数（点击即 push / pull，pull 用 `--ff-only`）。
- **分支列表**：点分支名展开（本地 / Remote 分组），可多选；提交历史会收缩为所选分支能到达的提交，不选 = 全部分支。
- **提交历史**：最多 120 条，涵盖所有本地与远程分支；每行有手绘的提交图（泳道、分支色、分叉/合并的曲线），悬停展开完整信息卡，点击弹出该提交的消息 + 变更文件浮层（再点、Esc 或点别处关闭）；右键可 `Copy Hash`、在该提交上 `Create Branch…`。
- **看 diff**：点击文件不在这里画 diff，而是把对比交给主区的 `git-diff` 面板（需要时自动分裂出面板；再点同一文件即关闭）。
- **初始化**：文件夹还不是仓库时显示空状态，一个按钮执行 `git init`。
- 面板跟随当前聚焦终端的目录；远程 space 就在那台机器执行 git。所有读取带 `--no-optional-locks` 等参数，不会自己触发文件监视刷新。

#### `git-diff` — diff 面板

- 宽面板并排显示（左旧右新，被替换的删除行与新增行同行对齐）；面板窄于阈值时折叠成单栏统一视图，行不会被挤扁。
- 新文件（整列绿色）或删除文件（整列红色）始终单栏；hunk 头与文件元信息整行显示。
- 头部 `Edit` 按钮就地切换为编辑器：保存前校验文件自读取后未被改动（否则拒绝），带未保存修改离开会先询问一次。提交的 diff 也能进入编辑——编辑的是工作区副本，diff 仍显示提交版本。
- 单次对比有上限（600 KB patch / 4000 行）；二进制文件与远程机器上的文件不可编辑。

#### `file-view` — 文件编辑面板

- 从 Files 面板点击文件打开；头部右上角 `Save` 保存，同样带“读后被改动则拒绝”的保护。
- 大于 1 MiB 或位于其他机器的文件以只读方式打开（无法安全回写）。
- 编辑器有未保存修改时，切换文件会等待而不是丢弃编辑；点击当前显示的文件会收起该面板。

#### `files-menu` — 文件管理

- 行选择：Cmd/Ctrl+单击多选、Shift+单击范围选择，右键菜单作用于整个选择；普通点击保持原行为（文件夹展开/收起，文件在 `file-view` 面板打开/关闭）。
- 文件右键菜单：用系统缺省应用打开、在面板中打开、重命名、复制、剪切、粘贴、复制路径、删除；文件夹菜单另有新建文件 / 新建文件夹；面板空白处是整目录的新建与粘贴。
- 写操作不覆盖已有文件：粘贴的重名文件得到 “ copy”，剪切带来的重名得到 “ 2”“ 3”…。
- 剪贴板放在共享状态 `files.clipboard`，各面板副本都能用；跨机器粘贴会被禁用。
- 行尾显示 Git 状态字母（A/M/D/U，来自 `git status --porcelain`，同样不打扰文件监视）。
- 重命名/删除会同步通知 `file-view` 面板（改名重指向、删除则清空）；操作完成后通过共享计数让其他副本一起刷新。

#### `status-branch` — 状态栏分支切换

- 状态栏里的分支是按钮：点开显示当前仓库的本地分支列表（当前分支高亮 + 勾选），选择即执行 `git switch`，成功/失败都有通知。
- 每次打开都重新读取分支列表；目录取当前空间第一个终端的实时目录（与状态栏本身一致）。

#### `agents-left` — Agents 列表

- 对自带 `agents` 的小改动：状态图标（工作转圈、等待 `!`、完成圆点）移到每行最前，并用固定宽度对齐，名称与图标不再被状态挤动；`!` 带 “Needs you” 提示。
- 其余保持原样：按空间分组 / 优先级排序、固定、折叠、子代理。

#### `tabs-git` — 标签栏

- 自带 `tabs` 加上 Files / Changes / Git 三个面板开关：点击切换右侧面板栈，点当前面板则收起；Git 在这里始终可用，并按空间记住上次的面板选择。

### 它们如何协作

- **点开**：面板把目标写入共享状态（`git.diff` = 仓库 + 文件 + 模式，`files.view` = 文件），主区的 `git-diff` / `file-view` 面板读取并显示，需要时自动在聚焦标签里分裂出新面板。
- **再点关闭**：点击正在显示的同一文件会关闭对应面板，同一个点击就是开关。
- 所有 mod 都跟随「聚焦终端的目录」，并在对应机器上执行命令（git、sh 或 PowerShell）——本机或远程 space 都一样。

### 安装

先决条件：较新版本的 Herdr（本项目在 macOS 上以 0.1.13 开发并测试）；需要用到 git 的机器上装有 git。

```sh
# 1) 克隆到任意位置
git clone https://github.com/kidoln/herdr_desktop_mods.git ~/herdr-git-workspace

# 2) 复制进 Herdr 配置目录（默认 ~/.config/herdr-app）
cp -R ~/herdr-git-workspace/mods/* ~/.config/herdr-app/mods/
cp ~/herdr-git-workspace/layouts/herdr-git.json ~/.config/herdr-app/layouts/

# 3) 切换到该布局
herdr-app do layout.switch --name herdr-git
```

- mod 随存随热重载，通常无需重启 Herdr。
- 卸载：删掉复制进去的 7 个 mod 文件夹和 `layouts/herdr-git.json` 即可，不影响 Herdr 自带功能。
- 也可以把这个仓库当作自己配置目录的版本管理（两者结构同构）：

  ```sh
  cd ~/.config/herdr-app
  git init
  git remote add origin https://github.com/kidoln/herdr_desktop_mods.git
  git fetch origin
  git switch -C main origin/main
  ```

### 说明

- 操作以鼠标为主，不额外占用快捷键（git 面板里 Cmd/Ctrl+Enter 提交）。
- 这些 mod 是受信任代码：会调用 `git`、shell / PowerShell 执行操作，安装前请知悉。
- 已知上限：提交历史窗口 120 条；diff 600 KB / 4000 行；文件树每目录 500 条、总计 5000 条、深度 40。

### 许可

以 [Apache License 2.0](LICENSE) 发布。`agents-left`、`files-menu`、`status-branch`、`tabs-git` 改编自 Herdr 自带 mod（同样为 Apache-2.0），来源与版权说明见 [NOTICE](NOTICE)。

---

<a id="en"></a>

## English

### What this is

A personal extension pack for Herdr, in two parts:

- seven mods under `mods/`: written from scratch, or forked from Herdr's own mods;
- `layouts/herdr-git.json`: a window layout that assembles them into a full workspace (a clone of the shipped `main` layout).

The repository mirrors the Herdr config folder (default `~/.config/herdr-app/`), so its files can be copied straight into place. Only this project's files are tracked; Herdr's own mods, layouts and window state stay out (see `.gitignore`). Herdr's built-in pieces (spaces, changes, pane, win98, …) are not part of this project.

Changes to built-in mods live as **clones**: the modified agents list is `agents-left`, the reworked Files panel is `files-menu` (plus `tabs-git` and `status-branch`). Those clones are what this repository tracks and maintains; the pristine copies Herdr rewrites or restores on every start (`mods/agents`, `mods/files`, …) are not versioned.

The window looks like this:

| Area | Content |
|---|---|
| Left sidebar | Spaces list, agents list (`agents-left`), footer toolbar |
| Top | Tab bar (`tabs-git`): tabs + Files / Changes / Git panel buttons |
| Main area | Terminal / diff / editor panes; every pane keeps a header |
| Right panel | Files / Changes / Git stack (`files-menu`, `changes`, `git`) |
| Bottom | Status bar (`status-branch`): click the branch to switch |

### The seven mods

| mod | Origin | What it does |
|---|---|---|
| `git` | new | Source Control panel: commit box, Staged/Changes, branch + upstream, commit graph |
| `git-diff` | new | Diff pane: side-by-side / folded one-column, can turn into an editor |
| `file-view` | new | File editing pane (opened from the Files panel) |
| `files-menu` | fork of `files` | File browser: selection, context menu, rename/copy/paste/delete, Git marks |
| `status-branch` | fork of `workspace-status` | Branch switcher in the status bar |
| `agents-left` | fork of `agents` | Agents list with the status chip leading each row |
| `tabs-git` | fork of `tabs` | Files / Changes / Git panel buttons in the tab bar |

#### `git` — the Source Control panel

- **Commit**: message box with `Commit` (when nothing is staged it stages everything, VS Code's smart commit) and `Commit & Push`; Cmd/Ctrl+Enter commits. Without an upstream the row shows `Publish` (pushes and sets the upstream).
- **Staging**: collapsible `Staged Changes` / `Changes` groups; every row shows the status letter (M/A/D/U/R/!), path and +/− line counts; hovering reveals stage / unstage / discard buttons (discard asks for a second click; discarding everything asks in a dialog).
- **Branch**: current branch colored by its lamp, the upstream it tracks, ahead/behind counters (clicking pushes / pulls; pull is `--ff-only`).
- **Branch list**: clicking the branch drops the list (Local / Remote groups); pick one or more to narrow the history to the commits their histories reach; nothing picked means every branch.
- **History**: up to 120 commits across every local and remote branch, with a hand-drawn commit graph (lanes, branch colors, curves where branches fork and merge), a full detail card on hover, and an anchored commit surface (message + changed files) on click — click again, Esc, or a press elsewhere closes it; right-click offers `Copy Hash` and `Create Branch…` at that commit.
- **Diffs**: clicking a file does not draw the diff here — it hands the comparison to the `git-diff` pane in the main area (splitting one in when needed; the same click on the shown file closes it).
- **Init**: a folder that is not a repository shows an empty state with one button that runs `git init`.
- The panel follows the focused terminal's folder and runs git on that machine for a remote space; every read uses `--no-optional-locks` and friends, so the folder watcher never sees our own reads.

#### `git-diff` — the diff pane

- Wide panes show it side by side (old left, new right; a removed line and the added line that replaces it share a row); a narrow pane folds the same rows into one unified column, so lines are never squeezed.
- A new file (all green) or a deleted one (all red) is always a single full-width column; hunk headers and file metadata span the row.
- The header's `Edit` button turns the pane into an editor for the file on disk: `Save` is refused when the file changed since it was read, and leaving with unsaved changes asks once. A commit's diff can be edited too — the editor holds the working-tree copy while the diff keeps showing the commit's version.
- Bounds: 600 KB patch / 4000 lines per comparison; binary files and files on another machine cannot be edited.

#### `file-view` — the file editing pane

- Opens from a click in the Files panel; `Save` sits in the header, with the same "refuse if changed on disk" contract.
- Files above 1 MiB, or on another machine, open read-only (a save could not round-trip).
- A file picked while the editor is modified waits instead of discarding edits; clicking the file the pane already shows closes it.

#### `files-menu` — the file manager

- Row selection: Cmd/Ctrl+click toggles, Shift+click takes a range, and the right-click menu acts on the whole selection; a plain click keeps the original behavior (folders open/close, files open in the `file-view` pane / close from it).
- A file's menu: open with the default app, open in the pane, rename, copy, cut, paste, copy path, delete; a folder's menu also creates files and folders; the tree's empty space offers the whole-folder versions.
- Writes never overwrite: a pasted copy takes " copy", a name a cut brings along takes " 2", " 3", ….
- The clipboard lives in shared state (`files.clipboard`), so every copy sees it; pasting across machines is disabled.
- Git status letters (A/M/D/U) are shown on rows (from `git status --porcelain`, again without disturbing the folder watcher).
- Renames and deletes tell the `file-view` pane (repoint or clear); the other copies refresh through a shared counter.

#### `status-branch` — branch switching from the status bar

- The branch in the status bar is a button: pressing it drops the repository's local branch list (the current one highlighted and checked); picking one runs `git switch`, with a toast either way.
- The list is read fresh on every open; the folder is the active space's first terminal's live folder, the same place the bar's branch comes from.

#### `agents-left` — the agents list

- A small change to the shipped agents list: the status chip (spinner, `!`, dot) leads every row in a fixed-width slot, so names and icons stay aligned; `!` carries a "Needs you" tooltip.
- Everything else is unchanged: grouped / priority views, pinning, folding, sub-agents.

#### `tabs-git` — the tab bar

- The shipped tab bar plus Files / Changes / Git panel buttons: clicking one switches the right panel stack, clicking the shown one hides it; Git is always offered here, and the choice is remembered per space.

### How they work together

- **Click to open**: a panel publishes its target into shared state (`git.diff` = repo + path + mode, `files.view` = file), and the `git-diff` / `file-view` pane in the main area reads it, splitting a new pane in the focused tab when needed.
- **Click again to close**: clicking the file already shown closes that pane, so the same click is a toggle.
- Everything follows the focused terminal's folder and runs commands (git, sh or PowerShell) on that machine — local or a remote space alike.

### Install

Requirements: a recent Herdr (developed and tested on macOS against 0.1.13); git installed wherever it will be used.

```sh
# 1) Clone anywhere
git clone https://github.com/kidoln/herdr_desktop_mods.git ~/herdr-git-workspace

# 2) Copy into the Herdr config folder (default ~/.config/herdr-app)
cp -R ~/herdr-git-workspace/mods/* ~/.config/herdr-app/mods/
cp ~/herdr-git-workspace/layouts/herdr-git.json ~/.config/herdr-app/layouts/

# 3) Switch to the layout
herdr-app do layout.switch --name herdr-git
```

- Mods hot-reload on save — no Herdr restart needed.
- To remove: delete the copied mod folders and `layouts/herdr-git.json`; nothing else is touched.
- Or keep this repository as the version control of your own config folder (the trees match):

  ```sh
  cd ~/.config/herdr-app
  git init
  git remote add origin https://github.com/kidoln/herdr_desktop_mods.git
  git fetch origin
  git switch -C main origin/main
  ```

### Notes

- Mouse-first: no keybindings are taken (except Cmd/Ctrl+Enter to commit in the git panel).
- These mods are trusted code: they run `git` and shell / PowerShell commands.
- Known bounds: the history window is 120 commits; diffs cap at 600 KB / 4000 lines; the file tree lists 500 entries per folder, 5,000 in total, 40 levels deep.

### License

Released under the [Apache License 2.0](LICENSE). `agents-left`, `files-menu`, `status-branch` and `tabs-git` are adapted from mods shipped with Herdr (also Apache-2.0); see [NOTICE](NOTICE) for attribution.
