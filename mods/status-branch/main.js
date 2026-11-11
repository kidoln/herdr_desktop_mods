// The status bar (a copy of workspace-status) with a live branch item: pressing
// the branch drops the repository's local branch list above the bar, and picking
// one checks it out. The Git panel's branch row follows on its own folder watch.
// It also shows the focused terminal's live folder (the space's, when the
// focused pane is a mod), with the home folder shortened to "~", and the last
// message sent to the main pane's opencode agent, read from opencode's own
// SQLite state. Hovering that message crawls it right to left when it does not
// fit.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, panes, terminals, exec, focused, home, notify, theme, run, window, keys } from "herdr";

const OPENCODE = "opencode";
const PROMPT_MAX = 400;       // characters kept for the bar and the marquee
const MARQUEE_GAP = 48;       // px of blank between the two copies of the text
const MARQUEE_SPEED = 60;     // window px per second, a calm right-to-left crawl

// The live folder of an agent, even when it has no pane of its own (a sub-agent).
function agentCwd(a) {
  if (!a) return "";
  const pane = panes().find((p) => p.pane === a.pane);
  if (pane?.cwd) return pane.cwd;
  const term = terminals().find((t) => t.address === a.address);
  return term?.cwd ?? spaces().find((s) => s.id === a.space)?.folder ?? "";
}

function agentMachine(a) {
  return spaces().find((s) => s.id === a?.space)?.machine ?? null;
}

// opencode sets its terminal title to "OC | <session title>"; "OpenCode" is
// its home screen, where no session is named.
function opencodeTitle(a) {
  const title = a?.title ?? "";
  if (title === "OpenCode") return "";
  const i = title.indexOf(" | ");
  return i >= 0 ? title.slice(i + 3) : title;
}

function isOpencode(a) {
  return a?.app === OPENCODE || a?.program?.key === OPENCODE;
}

// The agent the main pane is about: the focused one, else the active tab's
// opencode agent, else the space's most recently changed one.
function currentOpencodeAgent() {
  const f = focused();
  const addr = f?.agent ?? f?.terminal;
  const list = agents();
  if (addr) {
    const a = list.find((x) => x.address === addr);
    if (a) return isOpencode(a) ? a : null;
  }
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tab = f?.tab ?? space.tabs.find((t) => t.active)?.id;
  const inTab = list.filter((a) => isOpencode(a) && a.space === space.id && a.tab === tab);
  const pool = inTab.length ? inTab : list.filter((a) => isOpencode(a) && a.space === space.id);
  return pool.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0] ?? null;
}

// One line for the bar: the terminal width is a single row, so newlines and
// runs of spaces become one space, and very long prompts are folded.
function oneLine(text) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > PROMPT_MAX ? chars.slice(0, PROMPT_MAX - 1).join("") + "…" : s;
}

// Where the active space is now: its first terminal's live folder, else where it
// was made — the same place the bar's branch comes from.
function place(space) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

// "/Users/me/work/app" reads "~/work/app": shorter, and it says home at a glance.
function short(path) {
  const h = home();
  if (!path || !h) return path ?? "";
  if (path === h) return "~";
  return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export default class StatusBranch extends View {
  init(_props, cx) {
    this.open = false;     // the branch list
    this.branches = null;  // null until the first read

    // The last opencode prompt of the agent the main pane is about.
    this.prompt = "";      // the one-line text shown (and scrolled on hover)
    this.promptFull = "";  // the raw text, for comparing refreshes
    this.promptAgent = null;
    this.promptBusy = false;
    this.promptGen = 0;
    this.dataHomes = new Map();

    // Hover marquee: two copies on one track, slid left by exactly one copy
    // per pass; at the end the second copy sits where the first began, so the
    // reset lands on an identical frame. The slide is a native transition.
    this.hoverPrompt = false;
    this.promptBox = 0;      // visible width, window px
    this.promptUnit = 0;     // the whole text's natural width, window px
    this.promptOffset = 0;   // the track's left, window px
    this.promptAnim = false; // on for the slide, off for the instant reset
    this.marqueeMs = 0;
    this.marqueePolicy = null;
    this.marqueeTasks = [];

    cx.timer.every(1500, (cx) => this.refreshPrompt(cx));
    this.refreshPrompt(cx);
  }

  // The palette key as actually bound, not a hardcoded one. Just the key:
  // the bar is tight, and "commands" was taking room the prompt can use.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key || "";
  }

  // The branch list is read fresh on every open: branches come and go all day.
  // The previous list stays up while the new one is on its way.
  load(cx) {
    const space = spaces().find((s) => s.active), folder = place(space);
    if (!folder) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: folder, on: space.machine }).catch(() => null);
      this.branches = r && r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      cx.notify();
    });
  }

  pick(name, cx) {
    this.open = false;
    cx.notify();
    const space = spaces().find((s) => s.active), folder = place(space);
    if (!folder) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await exec("git", ["switch", name], { cwd: folder, on: space.machine }); }
      catch (e) { r = { code: 1, stderr: String(e), stdout: "" }; }
      if (r.code !== 0) notify({ title: "Cannot switch branch", body: (r.stderr || r.stdout || "git switch failed").trim(), level: "warning", timeout: 2600 });
      else notify({ title: "Branch switched", body: name, timeout: 1400 });
      cx.notify();
    });
  }

  // opencode's data folder on this machine or a remote one. One read, cached.
  async dataHomeFor(machine) {
    const key = machine ?? "";
    if (this.dataHomes.has(key)) return this.dataHomes.get(key);
    let base = "";
    try {
      const r = await exec("sh", ["-lc", 'printf %s "${XDG_DATA_HOME:-$HOME/.local/share}"'], machine ? { on: machine } : {});
      if (r.code === 0) base = r.stdout.trim();
    } catch {}
    this.dataHomes.set(key, base);
    return base;
  }

  // The newest user message in the opencode session behind this terminal.
  // The terminal title (OC | <session title>) and live folder identify it;
  // a generic title ("OpenCode") means the session cannot be named there, so
  // the folder's most recently changed session is the best guess — usually
  // the one the agent is working in.
  async readOpencodePrompt({ cwd, title, machine }) {
    if (!cwd) return { ok: false, text: "" };
    const base = await this.dataHomeFor(machine);
    if (!base) return { ok: false, text: "" };
    const db = `${base}/opencode/opencode.db`;
    const esc = (s) => String(s).replaceAll("'", "''");
    const select = (where) =>
      `select (select m.data from session_message m where m.session_id=s.id and m.type='user' order by m.seq desc limit 1) as data` +
      ` from session_v2 s where ${where} order by s.time_updated desc limit 1;`;
    const run = async (sql) => {
      const r = await exec("sqlite3", ["-readonly", "-json", db, sql], machine ? { on: machine } : {});
      if (r.code !== 0) return { ok: false, data: null };
      try {
        const rows = JSON.parse(r.stdout.trim() || "[]");
        return { ok: true, data: rows[0]?.data ?? null };
      } catch { return { ok: false, data: null }; }
    };

    let hit = title ? await run(select(`s.directory='${esc(cwd)}' and s.title='${esc(title)}'`)) : { ok: true, data: null };
    if (hit.ok && !hit.data) hit = await run(select(`s.directory='${esc(cwd)}'`));
    if (!hit.ok) return { ok: false, text: "" };
    if (!hit.data) return { ok: true, text: "" };

    let msg;
    try { msg = JSON.parse(hit.data); } catch { return { ok: true, text: "" }; }
    if (typeof msg.text === "string" && msg.text.trim()) return { ok: true, text: msg.text };
    if (Array.isArray(msg.files) && msg.files.length) return { ok: true, text: `[${msg.files.length} files]` };
    return { ok: true, text: "" };
  }

  refreshPrompt(cx) {
    const a = currentOpencodeAgent();
    const addr = a?.address ?? null;
    if (addr !== this.promptAgent) {
      // Another agent (or none) owns the bar now: what is shown belongs to
      // the old one, and a read already in flight is about to be stale.
      this.promptAgent = addr;
      this.promptGen++;
      this.promptBusy = false;
      if (this.prompt || this.promptFull) {
        this.prompt = "";
        this.promptFull = "";
        this.promptUnit = 0;
        this.clearMarquee();
        cx.notify();
      }
    }
    if (!a) return;
    if (this.promptBusy) return;
    this.promptBusy = true;
    const gen = ++this.promptGen;
    const cwd = agentCwd(a);
    const machine = agentMachine(a);
    const title = opencodeTitle(a);

    cx.spawn(async (cx) => {
      let res = { ok: false, text: "" };
      try { res = await this.readOpencodePrompt({ cwd, title, machine }); } catch {}
      this.promptBusy = false;
      if (gen !== this.promptGen) return;
      // A successful read with no message (a fresh session) shows nothing;
      // only an unreadable database falls back to the session topic.
      const text = res.ok ? res.text : title;
      const one = oneLine(text);
      if (one === this.prompt && text === this.promptFull) return;
      this.promptFull = text;
      this.prompt = one;
      this.clearMarquee();
      this.promptUnit = 0;              // measure the new text before sliding
      cx.notify();
    });
  }

  marqueeActive() {
    return Boolean(this.hoverPrompt && this.prompt && this.promptBox > 0 &&
      this.promptUnit > this.promptBox + 2);
  }

  clearMarquee() {
    for (const t of this.marqueeTasks) {
      try { t?.cancel(); } catch {}
    }
    this.marqueeTasks = [];
    this.promptAnim = false;
    this.promptOffset = 0;
  }

  // One pass moves the track left by one copy plus the gap. The transition
  // has to be on the element for a rendered frame before `left` changes:
  // adding both in the same render makes GPUI jump to the target.
  startMarquee(cx) {
    this.clearMarquee();
    if (!this.marqueeActive()) return;
    const unit = this.promptUnit + MARQUEE_GAP;
    this.marqueeMs = Math.max(1500, Math.round((unit / MARQUEE_SPEED) * 1000));
    this.marqueePolicy = { duration: this.marqueeMs, easing: "linear" };
    this.runMarquee(cx);
  }

  runMarquee(cx) {
    if (!this.marqueeActive()) { this.clearMarquee(); return; }
    this.promptAnim = true;
    this.promptOffset = 0;
    cx.notify();

    const go = cx.timer.after(120, (cx) => {
      if (!this.marqueeActive()) { this.clearMarquee(); cx.notify(); return; }
      this.promptOffset = -(this.promptUnit + MARQUEE_GAP);
      cx.notify();

      const done = cx.timer.after(this.marqueeMs + 60, (cx) => {
        if (!this.marqueeActive()) { this.clearMarquee(); cx.notify(); return; }
        // Drop the transition in the same render as the reset, so it snaps
        // back instead of sliding right.
        this.promptAnim = false;
        this.promptOffset = 0;
        cx.notify();
        const next = cx.timer.after(120, (cx) => {
          if (this.marqueeActive()) this.runMarquee(cx);
        });
        this.marqueeTasks.push(next);
      });
      this.marqueeTasks.push(done);
    });
    this.marqueeTasks.push(go);
  }

  promptView(t) {
    const sliding = this.marqueeActive();
    const copy = (id, pad) => h_flex().id(id).flex_none().whitespace_nowrap().items_center()
      .when(pad, (el) => el.pl(MARQUEE_GAP))
      .child(this.prompt);
    const inner = sliding
      ? h_flex().id("status-prompt-track").absolute().left(this.promptOffset).top(0).h_full().flex_nowrap().items_center()
          .when(this.promptAnim, (el) => el.transition("left", this.marqueePolicy ?? { duration: this.marqueeMs, easing: "linear" }))
          .child(copy("status-prompt-a", false))
          .child(copy("status-prompt-b", true))
      : div().id("status-prompt-static").flex_none().whitespace_nowrap().child(this.prompt)
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.promptUnit) > 0.5) {
              this.promptUnit = size.width;
              cx.notify();
              if (this.hoverPrompt) this.startMarquee(cx);
            }
          });
    return h_flex().id("status-prompt").flex_1().min_w(0).h_full().gap(6).items_center()
      .on_hover((hovered, cx) => {
        if (hovered === this.hoverPrompt) return;
        this.hoverPrompt = hovered;
        if (hovered) {
          cx.notify();
          this.startMarquee(cx);
        } else {
          this.clearMarquee();
          cx.notify();
        }
      })
      .child(svg("mods/workspace-chrome/square-pen.svg").size(13).flex_none().text_color(t.dim))
      .child(h_flex().flex_1().min_w(0).h_full().relative().overflow_hidden().items_center()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.promptBox) > 0.5) {
            this.promptBox = size.width;
            cx.notify();
            if (this.hoverPrompt) this.startMarquee(cx);
          }
        })
        .child(inner));
  }

  list(t) {
    const current = spaces().find((s) => s.active)?.branch ?? null;
    const rows = this.branches;
    return v_flex().id("status-branch-list").min_w(200).max_w(340).max_h(320).overflow_y_scrollbar().p(4)
      .rounded(8).bg(t.popover).border_1().border_color(t.input).text_size(12).text_color(t.foreground)
      .when(rows === null, (el) => el.child(div().p(8).text_color(t.dim).child("Loading\u2026")))
      .when(rows !== null && !rows.length, (el) => el.child(div().p(8).text_color(t.dim).child("No branches")))
      .children((rows ?? []).map((name) =>
        h_flex().id(`status-branch-${name}`).h(24).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer()
          .when(name === current, (el) => el.bg(t.selected))
          .when(name !== current, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.pick(name, cx))
          .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(name === current ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().child(name))
          .when(name === current, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(t.accent)))));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const hint = this.hint();
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const branch = space?.branch;
    // The focused terminal's folder, live; its space's folder when a mod pane
    // holds the keyboard (focused().cwd is null then).
    const cwd = focused()?.cwd ?? place(space);
    const trigger = (b) => h_flex().id("status-branch-trigger").h_full().px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(this.open ? t.accent : t.muted))
      .child(div().text_color(this.open ? t.foreground : t.muted).child(b));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(Boolean(space?.machine), el => el.child(label("server", space.machine)))
      .when(Boolean(branch), el => el.child(
        Popover.new("status-branch").anchor("bottom_left").open(this.open)
          .on_open_change((open, cx) => { this.open = open; if (open) this.load(cx); cx.notify(); })
          .trigger(trigger(branch))
          .content(this.list(t))))
      .when(Boolean(cwd), el => el.child(
        h_flex().id("status-cwd").gap(6).items_center().min_w(0)
          .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none())
          .child(div().max_w(360).truncate().child(short(cwd)))))
      .child(this.prompt ? this.promptView(t) : div().flex_1().min_w(0))
      .when(Boolean(hint), el => el.child(
        div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(hint)));
  }
}
