// The status bar (a copy of workspace-status) with a live branch item: pressing
// the branch drops the repository's local branch list above the bar, and picking
// one checks it out. The Git panel's branch row follows on its own folder watch.
// It also shows the focused terminal's live folder (the space's, when the
// focused pane is a mod), with the home folder shortened to "~", and the last
// message sent to the shown tab's opencode agent (or the focused terminal's,
// when that is one; never another tab's), read from opencode's own SQLite
// state. Hovering that message crawls it right to left when it does not fit;
// pressing it opens the session's user messages above the bar, numbered in
// the order they were sent.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, panes, terminals, exec, focused, home, notify, theme, run, window, keys } from "herdr";

const OPENCODE = "opencode";
const PROMPT_MAX = 400;       // characters kept for the bar and the marquee
const MARQUEE_GAP = 48;       // px of blank between the two copies of the text
const MARQUEE_SPEED = 60;     // window px per second, a calm right-to-left crawl
const MESSAGE_MENU_W = 460;   // px: wide enough to read, narrow enough not to span the screen
const MESSAGE_MENU_MAX_H = 420;

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

// The agent the bar is about: the focused one, else the active tab's
// opencode agent. Never another tab's: a new tab with a plain shell, or a
// terminal where opencode has exited, shows nothing — another window's
// prompt is not this bar's business.
function currentOpencodeAgent() {
  const f = focused();
  const list = agents();
  // focused().agent is the agent an agent block shows — the first agent when
  // no agent block exists — not the focused terminal. Following it would keep
  // the old tab's prompt on every new tab. Only the focused terminal counts.
  const addr = f?.terminal ?? null;
  if (addr) {
    const a = list.find((x) => x.address === addr);
    if (a) return isOpencode(a) ? a : null;
  }
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tab = f?.tab ?? space.tabs.find((t) => t.active)?.id;
  return list.filter((a) => isOpencode(a) && a.space === space.id && a.tab === tab)
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0] ?? null;
}

// One line for the bar: the terminal width is a single row, so newlines and
// runs of spaces become one space, and very long prompts are folded.
function oneLine(text) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > PROMPT_MAX ? chars.slice(0, PROMPT_MAX - 1).join("") + "…" : s;
}

// A message's send time, to the second.
function sentAt(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// A message as flex items that may wrap: a Latin word, one CJK character, or
// a long unbroken run split into chunks. A single text block reserves a column
// for the timestamp; these items let the body use the whole width and the
// timestamp sit after the last word instead.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
function messageParagraphs(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return lines.map((line) => {
    const tokens = [];
    let word = "";
    const flush = () => {
      if (!word) return;
      // A URL or another unbroken run still needs a place to break.
      for (let i = 0; i < word.length; i += 32) tokens.push(word.slice(i, i + 32));
      word = "";
    };
    for (const ch of line) {
      if (/\s/.test(ch)) {
        // The space belongs to the word before it, so the break happens
        // between words and the gap survives a wrap.
        if (word) { flush(); tokens[tokens.length - 1] += "\u00a0"; }
        else if (tokens.length) tokens[tokens.length - 1] += "\u00a0";
        else word = "\u00a0";
      } else if (CJK.test(ch)) {
        flush();
        tokens.push(ch);
      } else {
        word += ch;
      }
    }
    flush();
    return tokens.length ? tokens : ["\u00a0"];
  });
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
    this.promptTerm = null;   // the focused terminal the line belongs to
    this.promptClear = null;  // pending delayed clear after its agent goes
    this.promptBusy = false;
    this.promptGen = 0;
    this.dataHomes = new Map();

    // The prompt's message menu: every user message of the session, oldest
    // first, read fresh when the line is pressed.
    this.promptMenuOpen = false;
    this.promptMessages = null;  // null until the first read
    this.promptMsgError = false;
    this.promptMsgGen = 0;

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

  // Repaint after a change. From an event handler or a task notify() works;
  // from a layout/measurement callback (on_size_change) it is refused while
  // the render phase is still running, so fall back to the next tick.
  paint(cx) {
    try { cx.notify(); }
    catch { cx.timer.after(0, (cx) => cx.notify()); }
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
      this.paint(cx);
    });
  }

  pick(name, cx) {
    this.open = false;
    this.paint(cx);
    const space = spaces().find((s) => s.active), folder = place(space);
    if (!folder) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await exec("git", ["switch", name], { cwd: folder, on: space.machine }); }
      catch (e) { r = { code: 1, stderr: String(e), stdout: "" }; }
      if (r.code !== 0) notify({ title: "Cannot switch branch", body: (r.stderr || r.stdout || "git switch failed").trim(), level: "warning", timeout: 2600 });
      else notify({ title: "Branch switched", body: name, timeout: 1400 });
      this.paint(cx);
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

  // Every user message of the opencode session behind this terminal, oldest
  // first. The same title-and-folder lookup as readOpencodePrompt, so the menu
  // always belongs to the session whose last line the bar shows.
  async readOpencodeMessages({ cwd, title, machine }) {
    if (!cwd) return { ok: false, messages: [] };
    const base = await this.dataHomeFor(machine);
    if (!base) return { ok: false, messages: [] };
    const db = `${base}/opencode/opencode.db`;
    const esc = (s) => String(s).replaceAll("'", "''");
    const select = (where) =>
      `select m.time_created, m.data from session_message m where m.type='user' and m.session_id=` +
      `(select s.id from session_v2 s where ${where} order by s.time_updated desc limit 1)` +
      ` order by m.seq asc;`;
    const run = async (sql) => {
      const r = await exec("sqlite3", ["-readonly", "-json", db, sql], machine ? { on: machine } : {});
      if (r.code !== 0) return { ok: false, messages: [] };
      try {
        const rows = JSON.parse(r.stdout.trim() || "[]");
        const messages = [];
        for (const row of rows) {
          let msg;
          try { msg = JSON.parse(row.data); } catch { continue; }
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          const files = Array.isArray(msg.files) ? msg.files.length : 0;
          const at = Number(row.time_created ?? msg?.time?.created);
          // A message may be only attached files; keep its place in the
          // conversation even then, so the numbering matches what was sent.
          messages.push({
            text: text || (files ? `[${files} ${files === 1 ? "file" : "files"}]` : "(no text)"),
            files,
            at,
          });
        }
        return { ok: true, messages };
      } catch { return { ok: false, messages: [] }; }
    };

    let hit = title ? await run(select(`s.directory='${esc(cwd)}' and s.title='${esc(title)}'`)) : { ok: true, messages: [] };
    if (hit.ok && !hit.messages.length) hit = await run(select(`s.directory='${esc(cwd)}'`));
    return hit;
  }

  cancelPromptClear() {
    try { this.promptClear?.cancel(); } catch {}
    this.promptClear = null;
  }

  // The menu is about one prompt line; when that line goes, so does the menu.
  // Bumping the generation drops a read that is still in flight.
  closePromptMenu() {
    this.promptMenuOpen = false;
    this.promptMessages = null;
    this.promptMsgError = false;
    this.promptMsgGen++;
  }

  // `silent` is for the render pass: notify() throws while rendering, and the
  // frame being built already shows the cleared line. Everywhere else the
  // notification is what repaints it.
  clearPrompt(cx, silent = false) {
    this.cancelPromptClear();
    this.closePromptMenu();
    if (!this.prompt && !this.promptFull) return;
    // What is shown belongs to an agent or tab that no longer owns the bar.
    this.prompt = "";
    this.promptFull = "";
    this.promptUnit = 0;
    // The line the pointer was on is gone with it; its exit event may never
    // come, and a stale "hovered" would start the next line's crawl by itself.
    this.hoverPrompt = false;
    this.clearMarquee();
    if (!silent) this.paint(cx);
  }

  // The prompt's menu reads the whole session on opening, not on every bar
  // tick: the menu is meant to be a stable, complete list while it is up.
  loadPromptMessages(cx) {
    const a = currentOpencodeAgent();
    if (!a) {
      this.promptMessages = [];
      this.paint(cx);
      return;
    }
    const gen = ++this.promptMsgGen;
    const cwd = agentCwd(a);
    const machine = agentMachine(a);
    const title = opencodeTitle(a);
    this.promptMsgError = false;
    cx.spawn(async (cx) => {
      let res = { ok: false, messages: [] };
      try { res = await this.readOpencodeMessages({ cwd, title, machine }); } catch {}
      if (gen !== this.promptMsgGen) return;
      this.promptMsgError = !res.ok;
      this.promptMessages = res.ok ? res.messages : [];
      this.paint(cx);
    });
  }

  setPromptMenu(open, cx) {
    this.promptMenuOpen = open;
    if (open) {
      this.promptMessages = null;  // show Loading… while the read runs
      this.promptMsgError = false;
      this.loadPromptMessages(cx);
    } else {
      this.promptMsgGen++;  // a late read is no longer wanted
      this.promptMessages = null;
      this.promptMsgError = false;
    }
    this.paint(cx);
  }

  // opencode quitting clears the agent a moment before the terminal settles:
  // keep the last line for a beat so a status flap cannot blank it and redraw
  // it. A returning agent cancels this from refreshPrompt.
  schedulePromptClear(cx) {
    if (this.promptClear) return;
    this.promptClear = cx.timer.after(450, (cx) => {
      this.promptClear = null;
      if (currentOpencodeAgent()) return;
      this.clearPrompt(cx);
    });
  }

  refreshPrompt(cx, silent = false) {
    const f = focused();
    const term = f?.terminal ?? null;
    const a = currentOpencodeAgent();
    const addr = a?.address ?? null;
    const termChanged = term !== this.promptTerm;
    const agentChanged = addr !== this.promptAgent;

    if (termChanged || agentChanged) {
      // The context moved, or its agent came and went; a read in flight is
      // about to be stale.
      this.promptTerm = term;
      this.promptAgent = addr;
      this.promptGen++;
      this.promptBusy = false;
      if (!termChanged && term && this.prompt && (!addr || this.promptClear)) {
        // Same terminal, the agent flickered: hold the line through the gap.
        this.cancelPromptClear();
        if (!addr) this.schedulePromptClear(cx);
      } else {
        // Another tab or terminal: what is shown belongs to the old context.
        this.clearPrompt(cx, silent);
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
      // opencode writes its database while quitting, so a read can be locked
      // for a moment: keep the line as it is instead of flashing the session
      // title. A successful read with no message (a fresh session) clears it.
      if (!res.ok) return;
      const text = res.text;
      const one = oneLine(text);
      if (one === this.prompt && text === this.promptFull) return;
      // A line that is going away cannot stay hovered.
      if (!one) {
        this.hoverPrompt = false;
        // A fresh session has no message yet; the old session's menu is not
        // this session's conversation.
        this.closePromptMenu();
      }
      this.promptFull = text;
      this.prompt = one;
      this.clearMarquee();
      this.promptUnit = 0;              // measure the new text before sliding
      if (one && this.promptMenuOpen) this.loadPromptMessages(cx);
      this.paint(cx);
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
    this.paint(cx);

    const go = cx.timer.after(120, (cx) => {
      if (!this.marqueeActive()) { this.clearMarquee(); this.paint(cx); return; }
      this.promptOffset = -(this.promptUnit + MARQUEE_GAP);
      this.paint(cx);

      const done = cx.timer.after(this.marqueeMs + 60, (cx) => {
        if (!this.marqueeActive()) { this.clearMarquee(); this.paint(cx); return; }
        // Drop the transition in the same render as the reset, so it snaps
        // back instead of sliding right.
        this.promptAnim = false;
        this.promptOffset = 0;
        this.paint(cx);
        const next = cx.timer.after(120, (cx) => {
          if (this.marqueeActive()) this.runMarquee(cx);
        });
        this.marqueeTasks.push(next);
      });
      this.marqueeTasks.push(done);
    });
    this.marqueeTasks.push(go);
  }

  // One message body. Its words are separate wrapping items, so the text runs
  // edge to edge instead of leaving a column for the time. The last word and
  // the time travel together, so the time stays appended to the message.
  messageBody(t, msg, at) {
    const paragraphs = messageParagraphs(msg.text);
    return v_flex().flex_1().min_w(0).gap(0)
      .children(paragraphs.map((tokens, p) => {
        const last = p === paragraphs.length - 1;
        const tail = last && at ? tokens[tokens.length - 1] : null;
        const rest = tail ? tokens.slice(0, -1) : tokens;
        return h_flex().w_full().min_w(0).flex_wrap().items_baseline().gap(0)
          .children(rest.map((token) =>
            div().flex_none().whitespace_nowrap().text_color(t.foreground).child(token)))
          .when(Boolean(tail), (el) => el.child(
            h_flex().flex_none().items_baseline().gap(0)
              .child(div().whitespace_nowrap().text_color(t.foreground).child(tail))
              .child(div().whitespace_nowrap().pl(6).text_size(10.5).text_color(t.dim).child(at))));
      }));
  }

  // The menu above the bar: every user message of this session, oldest first
  // and numbered from one. It scrolls once it would cover too much of the
  // window; the width is fixed so long prompts wrap instead of stretching.
  promptMenu(t) {
    const rows = this.promptMessages;
    const count = rows?.length ?? 0;
    const empty = (text) => div().p(8).text_color(t.dim).child(text);
    return v_flex().id("status-prompt-menu").w(MESSAGE_MENU_W).max_h(MESSAGE_MENU_MAX_H).overflow_y_scrollbar().p(4)
      .rounded(8).bg(t.popover).border_1().border_color(t.input).text_size(12).text_color(t.foreground)
      .child(h_flex().flex_none().px(8).pt(4).pb(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_color(t.muted).child("Session messages"))
        .when(rows !== null && !this.promptMsgError, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count)))))
      .when(rows === null && !this.promptMsgError, (el) => el.child(empty("Loading…")))
      .when(this.promptMsgError, (el) => el.child(empty("Cannot read this session")))
      .when(rows !== null && !this.promptMsgError && !rows.length, (el) => el.child(empty("No messages")))
      .children((rows ?? []).map((msg, i) => {
        const at = sentAt(msg.at);
        return h_flex().id(`status-prompt-message-${i}`).flex_none().px(8).py(6).gap(8).items_start()
          .when(i < count - 1, (el) => el.border_b(1).border_color(t.border))
          .child(div().flex_none().w(22).text_size(11).text_color(t.dim).child(`${i + 1}.`))
          .child(this.messageBody(t, msg, at));
      }));
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
              this.paint(cx);
              if (this.hoverPrompt) this.startMarquee(cx);
            }
          });
    const trigger = h_flex().id("status-prompt").flex_1().min_w(0).h_full().gap(6).items_center().cursor_pointer()
      // Starting on hover entry is wrong: a line that appears under a pointer
      // resting at the bar is reported as hovered without the pointer ever
      // moving here, and the crawl then runs on its own. Movement on the line
      // is the only sure sign the pointer is really on it. Leaving is still
      // the ordinary exit event.
      .on_mouse_move((_event, cx) => {
        if (this.hoverPrompt) return;
        this.hoverPrompt = true;
        this.startMarquee(cx);
      })
      .on_hover((hovered, cx) => {
        if (hovered || !this.hoverPrompt) return;
        this.hoverPrompt = false;
        this.clearMarquee();
        this.paint(cx);
      })
      .child(svg("mods/workspace-chrome/square-pen.svg").size(13).flex_none().text_color(t.dim))
      .child(h_flex().flex_1().min_w(0).h_full().relative().overflow_hidden().items_center()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.promptBox) > 0.5) {
            this.promptBox = size.width;
            this.paint(cx);
            if (this.hoverPrompt) this.startMarquee(cx);
          }
        })
        .child(inner));
    // bottom_left pins the menu's bottom edge to the line's top: it opens
    // upwards, over the panes, with its left edge on the prompt icon.
    return Popover.new("status-prompt-menu").anchor("bottom_left").open(this.promptMenuOpen)
      .on_open_change((open, cx) => this.setPromptMenu(open, cx))
      .trigger(trigger)
      .content(this.promptMenu(t));
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

  render(cx) {
    // Focus changes redraw at once; the prompt timer runs every 1.5 s. Catch
    // the change here so the old tab's prompt never lingers on screen.
    // Silent: this pass is the repaint, and notify() is refused while rendering.
    const f = focused();
    if ((f?.terminal ?? null) !== this.promptTerm ||
        (currentOpencodeAgent()?.address ?? null) !== this.promptAgent) this.refreshPrompt(cx, true);
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
          .on_open_change((open, cx) => { this.open = open; if (open) this.load(cx); this.paint(cx); })
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
