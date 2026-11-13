// The status bar (a copy of workspace-status) with a live branch item: pressing
// the branch drops the repository's local branch list above the bar, and picking
// one checks it out. The Git panel's branch row follows on its own folder watch.
// It also shows the focused terminal's live folder (the space's, when the
// focused pane is a mod), with the home folder shortened to "~", and the last
// message sent to the shown tab's agent (or the focused terminal's, when that is
// one; never another tab's). opencode's prompts come from its own SQLite;
// Claude Code's come from its own state files (a tail of history.jsonl, keyed by
// the session Herdr's foreground pid names), so neither needs a hook. Hovering
// that message crawls it right to left when it does not fit; pressing it opens
// the session's user messages above the bar, numbered in the order they were
// sent.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import {
  spaces,
  agents,
  panes,
  terminals,
  exec,
  focused,
  home,
  notify,
  theme,
  run,
  window,
  keys,
  readTextFile,
} from "herdr";

const OPENCODE = "opencode";
const CLAUDE = "claude"; // Claude Code's program-table key
const CLAUDE_APP = "claude-code"; // the `app` its status report carries
const PROMPT_MAX = 400; // characters kept for the bar and the marquee
const MARQUEE_GAP = 48; // px of blank between the two copies of the text
const MARQUEE_SPEED = 60; // window px per second, a calm right-to-left crawl
const MESSAGE_MENU_W = 460; // px: wide enough to read, narrow enough not to span the screen
const MESSAGE_MENU_MAX_H = 420;
const CLAUDE_PID_TTL = 5000; // ms a terminal's Claude pid is trusted
const CLAUDE_HISTORY_BYTES = 262144; // history.jsonl tail read on every tick
const CLAUDE_HISTORY_MENU = 2097152; // history.jsonl read when the menu opens
const CLAUDE_MENU_MAX = 400; // messages kept in the session menu
const CLAUDE_MISS_MS = 5000; // ms before a transcript is retried after no history

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

// The session's summary as the agents sidebar shows it after the agent's name:
// the terminal title with its command prefix gone (`OC | fix login` -> `fix
// login`). Keep the two in step; both read opencode's own title.
function sessionSummary(a) {
  return opencodeTitle(a)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^[\w.-]{1,16}\s*\|\s*/u, "")
    .trim();
}

function isOpencode(a) {
  return a?.app === OPENCODE || a?.program?.key === OPENCODE;
}

// Claude Code reports `app: "claude-code"`; Herdr's program table calls it
// `claude`. Either names the same terminal.
function isClaude(a) {
  return (
    a?.app === CLAUDE_APP || a?.app === CLAUDE || a?.program?.key === CLAUDE
  );
}

// Which agent's prompt line the bar can show, or null for anyone else.
function agentKind(a) {
  if (isOpencode(a)) return "opencode";
  if (isClaude(a)) return "claude";
  return null;
}

function isSupported(a) {
  return agentKind(a) !== null;
}

// The agent the bar is about: the focused one, else the active tab's
// supported agent. Never another tab's: a new tab with a plain shell, or a
// terminal where the agent has exited, shows nothing — another window's
// prompt is not this bar's business.
function currentAgent() {
  const f = focused();
  const list = agents();
  // focused().agent is the agent an agent block shows — the first agent when
  // no agent block exists — not the focused terminal. Following it would keep
  // the old tab's prompt on every new tab. Only the focused terminal counts.
  const addr = f?.terminal ?? null;
  if (addr) {
    const a = list.find((x) => x.address === addr);
    if (a) return isSupported(a) ? a : null;
  }
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tab = f?.tab ?? space.tabs.find((t) => t.active)?.id;
  return (
    list
      .filter((a) => isSupported(a) && a.space === space.id && a.tab === tab)
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0] ?? null
  );
}

// One line for the bar: the terminal width is a single row, so newlines and
// runs of spaces become one space, and very long prompts are folded.
function oneLine(text) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > PROMPT_MAX
    ? chars.slice(0, PROMPT_MAX - 1).join("") + "…"
    : s;
}

// A line of Claude Code's own input history (`history.jsonl`): `display` is
// what the user typed, with pasted text folded to a `[Pasted text #N]`
// placeholder. A prompt that was only attachments has no display at all.
function claudeHistoryText(row) {
  const text = typeof row?.display === "string" ? row.display.trim() : "";
  if (text) return text;
  const pasted =
    row?.pastedContents && typeof row.pastedContents === "object"
      ? Object.keys(row.pastedContents).length
      : 0;
  return pasted ? `[${pasted} ${pasted === 1 ? "paste" : "pastes"}]` : "";
}

// One line of a Claude Code transcript (`projects/<cwd>/<session>.jsonl`), if
// it is a person's message. Tool results and injected context also carry
// `type: "user"`; `origin` tells them apart in current versions, the shape
// does in older ones.
function claudeTranscriptText(o) {
  if (!o || o.isMeta || o.toolUseResult) return "";
  if (o.origin && o.origin.kind !== "human") return "";
  const c = o.message?.content;
  let text = "";
  let files = 0;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    files = c.filter(
      (b) => b && (b.type === "image" || b.type === "document"),
    ).length;
  }
  text = text.trim();
  if (!text && !files) return "";
  // A slash command, a `!` shell command's output, or a task notification is
  // not something the person typed as a message.
  if (/^<(?:command-|local-command|task-notification)/.test(text)) return "";
  return text || `[${files} ${files === 1 ? "file" : "files"}]`;
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
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
function messageParagraphs(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  return lines.map((line) => {
    const tokens = [];
    let word = "";
    const flush = () => {
      if (!word) return;
      // A URL or another unbroken run still needs a place to break.
      for (let i = 0; i < word.length; i += 32)
        tokens.push(word.slice(i, i + 32));
      word = "";
    };
    for (const ch of line) {
      if (/\s/.test(ch)) {
        // The space belongs to the word before it, so the break happens
        // between words and the gap survives a wrap.
        if (word) {
          flush();
          tokens[tokens.length - 1] += "\u00a0";
        } else if (tokens.length) tokens[tokens.length - 1] += "\u00a0";
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
  return (
    panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null
  );
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
    this.open = false; // the branch list
    this.branches = null; // null until the first read

    // The last prompt of the agent the main pane is about: opencode's SQLite
    // or Claude Code's own files, whichever the agent is.
    this.prompt = ""; // the one-line text shown (and scrolled on hover)
    this.promptFull = ""; // the raw text, for comparing refreshes
    this.promptKind = null; // "opencode" | "claude", the owner of the line
    this.promptSummary = ""; // the session's name, for the menu's header
    this.promptAgent = null;
    this.promptTerm = null; // the focused terminal the line belongs to
    this.promptClear = null; // pending delayed clear after its agent goes
    this.promptBusy = false;
    this.promptGen = 0;
    this.dataHomes = new Map();

    // Claude Code's own state: the session behind a terminal (pid -> session
    // file), the pid lookup's short memory, the transcripts already located,
    // and the last time a session was asked for a transcript.
    this.claudeHomes = new Map();
    this.claudeSessions = new Map();
    this.transcripts = new Map();
    this.claudeMiss = new Map();

    // The prompt's message menu: every user message of the session, oldest
    // first, read fresh when the line is pressed.
    this.promptMenuOpen = false;
    this.promptMessages = null; // null until the first read
    this.promptMsgError = false;
    this.promptMsgGen = 0;
    this.promptMenuClosedAt = 0; // a press that closed it must not reopen it

    // Hover marquee: two copies on one track, slid left by exactly one copy
    // per pass; at the end the second copy sits where the first began, so the
    // reset lands on an identical frame. The slide is a native transition.
    this.hoverPrompt = false;
    this.promptBox = 0; // visible width, window px
    this.promptUnit = 0; // the whole text's natural width, window px
    this.promptOffset = 0; // the track's left, window px
    this.promptAnim = false; // on for the slide, off for the instant reset
    this.marqueeMs = 0;
    this.marqueePolicy = null;
    this.marqueeTasks = [];
    this.marqueePass = 0; // a fresh track per pass: no stale transition state

    cx.timer.every(1500, (cx) => this.refreshPrompt(cx));
    this.refreshPrompt(cx);
  }

  // Repaint after a change. From an event handler or a task notify() works;
  // from a layout/measurement callback (on_size_change) it is refused while
  // the render phase is still running, so fall back to the next tick.
  paint(cx) {
    try {
      cx.notify();
    } catch {
      cx.timer.after(0, (cx) => cx.notify());
    }
  }

  // The palette key as actually bound, not a hardcoded one. Just the key:
  // the bar is tight, and "commands" was taking room the prompt can use.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find(
      (k) => k.section === "global" && k.action === "app.palette",
    );
    const parts =
      b && b.keys.endsWith("--")
        ? [...b.keys.slice(0, -2).split("-"), "-"]
        : b?.keys.split("-");
    const key =
      parts &&
      parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key || "";
  }

  // The branch list is read fresh on every open: branches come and go all day.
  // The previous list stays up while the new one is on its way.
  load(cx) {
    const space = spaces().find((s) => s.active),
      folder = place(space);
    if (!folder) return;
    cx.spawn(async (cx) => {
      const r = await exec(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        { cwd: folder, on: space.machine },
      ).catch(() => null);
      this.branches =
        r && r.code === 0
          ? r.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      this.paint(cx);
    });
  }

  pick(name, cx) {
    this.open = false;
    this.paint(cx);
    const space = spaces().find((s) => s.active),
      folder = place(space);
    if (!folder) return;
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await exec("git", ["switch", name], {
          cwd: folder,
          on: space.machine,
        });
      } catch (e) {
        r = { code: 1, stderr: String(e), stdout: "" };
      }
      if (r.code !== 0)
        notify({
          title: "Cannot switch branch",
          body: (r.stderr || r.stdout || "git switch failed").trim(),
          level: "warning",
          timeout: 2600,
        });
      else notify({ title: "Branch switched", body: name, timeout: 1400 });
      this.paint(cx);
    });
  }

  // A data folder on this machine or a remote one. `expr` is a shell
  // parameter expansion (`XDG_DATA_HOME:-$HOME/.local/share`), so the
  // person's own profile decides it. One read, cached.
  async homeFor(expr, machine, cache) {
    const key = machine ?? "";
    if (cache.has(key)) return cache.get(key);
    let base = "";
    try {
      const r = await exec(
        "sh",
        ["-lc", `printf %s "\${${expr}}"`],
        machine ? { on: machine } : {},
      );
      if (r.code === 0) base = r.stdout.trim();
    } catch {}
    cache.set(key, base);
    return base;
  }

  // opencode's data folder on this machine or a remote one. One read, cached.
  async dataHomeFor(machine) {
    return this.homeFor(
      "XDG_DATA_HOME:-$HOME/.local/share",
      machine,
      this.dataHomes,
    );
  }

  // Claude Code's state folder (`~/.claude`, or wherever it was pointed).
  async claudeHomeFor(machine) {
    return this.homeFor(
      "CLAUDE_CONFIG_DIR:-$HOME/.claude",
      machine,
      this.claudeHomes,
    );
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
      const r = await exec(
        "sqlite3",
        ["-readonly", "-json", db, sql],
        machine ? { on: machine } : {},
      );
      if (r.code !== 0) return { ok: false, data: null };
      try {
        const rows = JSON.parse(r.stdout.trim() || "[]");
        return { ok: true, data: rows[0]?.data ?? null };
      } catch {
        return { ok: false, data: null };
      }
    };

    let hit = title
      ? await run(
          select(`s.directory='${esc(cwd)}' and s.title='${esc(title)}'`),
        )
      : { ok: true, data: null };
    if (hit.ok && !hit.data)
      hit = await run(select(`s.directory='${esc(cwd)}'`));
    if (!hit.ok) return { ok: false, text: "" };
    if (!hit.data) return { ok: true, text: "" };

    let msg;
    try {
      msg = JSON.parse(hit.data);
    } catch {
      return { ok: true, text: "" };
    }
    if (typeof msg.text === "string" && msg.text.trim())
      return { ok: true, text: msg.text };
    if (Array.isArray(msg.files) && msg.files.length)
      return { ok: true, text: `[${msg.files.length} files]` };
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
      const r = await exec(
        "sqlite3",
        ["-readonly", "-json", db, sql],
        machine ? { on: machine } : {},
      );
      if (r.code !== 0) return { ok: false, messages: [] };
      try {
        const rows = JSON.parse(r.stdout.trim() || "[]");
        const messages = [];
        for (const row of rows) {
          let msg;
          try {
            msg = JSON.parse(row.data);
          } catch {
            continue;
          }
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          const files = Array.isArray(msg.files) ? msg.files.length : 0;
          const at = Number(row.time_created ?? msg?.time?.created);
          // A message may be only attached files; keep its place in the
          // conversation even then, so the numbering matches what was sent.
          messages.push({
            text:
              text ||
              (files
                ? `[${files} ${files === 1 ? "file" : "files"}]`
                : "(no text)"),
            files,
            at,
          });
        }
        return { ok: true, messages };
      } catch {
        return { ok: false, messages: [] };
      }
    };

    let hit = title
      ? await run(
          select(`s.directory='${esc(cwd)}' and s.title='${esc(title)}'`),
        )
      : { ok: true, messages: [] };
    if (hit.ok && !hit.messages.length)
      hit = await run(select(`s.directory='${esc(cwd)}'`));
    return hit;
  }

  // The pid of the program Herdr sees in the terminal. `hc` names a remote
  // terminal `machine/t7`; a remote core also answers for the bare id.
  async claudePid(address, machine) {
    const bare =
      machine && address.startsWith(`${machine}/`)
        ? address.slice(machine.length + 1)
        : address;
    const get = async (args, opts) => {
      const r = await exec("hc", args, opts).catch(() => null);
      if (!r || r.code !== 0) return null;
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    };
    let t = await get(["get", address, "--json"], {});
    if (!t && machine) t = await get(["get", bare, "--json"], { on: machine });
    const pid = t?.foreground?.pid;
    return typeof pid === "number" && pid > 0 ? pid : null;
  }

  // The folder's newest transcript: Claude encodes a cwd by replacing every
  // character that is not a letter or a digit with "-".
  async newestTranscript({ base, cwd, machine }) {
    const enc = String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");
    if (!enc) return null;
    const r = await exec(
      "ls",
      ["-t", `${base}/projects/${enc}`],
      machine ? { on: machine } : {},
    ).catch(() => null);
    if (!r || r.code !== 0) return null;
    const name = r.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.endsWith(".jsonl"));
    return name ? name.slice(0, -".jsonl".length) : null;
  }

  // Where a session's transcript lives. The folder name comes from the cwd;
  // when that guess misses, the session id is unique, so a glob finds it.
  async transcriptFor({ base, sessionId, cwd, machine }) {
    const key = `${machine ?? ""}\u0000${sessionId}`;
    const known = this.transcripts.get(key);
    if (known) return known;
    const enc = String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");
    const guess = `${base}/projects/${enc}/${sessionId}.jsonl`;
    let path = null;
    if (enc) {
      const r = await exec(
        "sh",
        ["-c", 'test -f "$0"', guess],
        machine ? { on: machine } : {},
      ).catch(() => null);
      if (r?.code === 0) path = guess;
    }
    if (!path) {
      const r = await exec(
        "sh",
        [
          "-c",
          `ls "${base}/projects/"*/"${sessionId}.jsonl" 2>/dev/null | head -n 1`,
        ],
        machine ? { on: machine } : {},
      ).catch(() => null);
      path =
        r?.code === 0
          ? (r.stdout
              .split("\n")
              .map((s) => s.trim())
              .find(Boolean) ?? null)
          : null;
    }
    // A session with no file yet is asked about again, so only a hit is kept.
    if (path) this.transcripts.set(key, path);
    return path;
  }

  // The tail of Claude Code's input history: one JSON line per submitted
  // prompt, from every session on that machine, oldest first. A tail keeps it
  // cheap however long the file gets.
  async readClaudeHistory({ base, machine, bytes }) {
    const r = await exec(
      "tail",
      ["-c", String(bytes), `${base}/history.jsonl`],
      machine ? { on: machine } : {},
    ).catch(() => null);
    if (!r || r.code !== 0) return { ok: false, rows: [] };
    const rows = [];
    for (const line of r.stdout.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue; // a tail can cut the first line
      try {
        rows.push(JSON.parse(s));
      } catch {}
    }
    return { ok: true, rows };
  }

  // One transcript line per person message, from grep's output.
  transcriptMessages(out) {
    const messages = [];
    for (const line of String(out).split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      let o;
      try {
        o = JSON.parse(s);
      } catch {
        continue;
      }
      const text = claudeTranscriptText(o);
      if (!text) continue;
      messages.push({ text, at: Date.parse(o.timestamp ?? "") || 0 });
    }
    return messages;
  }

  // The newest person message of a session, or all of them. Transcripts are
  // JSONL; only person lines are wanted, and grep keeps the tool output from
  // ever crossing into the script.
  async readClaudeTranscript({ sessionId, cwd, base, machine, want }) {
    const path = await this.transcriptFor({
      base,
      sessionId,
      cwd,
      machine,
    });
    if (!path) return { ok: false, text: "", messages: [] };
    const run = async (script) => {
      const r = await exec(
        "sh",
        ["-c", `${script} || true`, path],
        machine ? { on: machine } : {},
      ).catch(() => null);
      return r ? r.stdout : null;
    };
    const marked = `grep -a '"origin":{"kind":"human"}' "$0"`;
    // Current transcripts mark the person's lines; older ones only have the
    // shape to go on, so every user line is read and filtered here instead.
    // The whole file is scanned: a long turn's tool output can put the last
    // prompt far from the end, and this read is the rare fallback, not the
    // bar's every-tick source (that is the input history).
    const first =
      want === "prompt"
        ? `${marked} | tail -n 1`
        : `${marked} | tail -n ${CLAUDE_MENU_MAX}`;
    let out = await run(first);
    let messages = this.transcriptMessages(out ?? "");
    if (!messages.length) {
      const fallback =
        want === "prompt"
          ? `grep -a '"type":"user"' "$0" | tail -n 200`
          : `grep -a '"type":"user"' "$0" | tail -n 1200`;
      out = await run(fallback);
      messages = this.transcriptMessages(out ?? "");
    }
    if (out === null) return { ok: false, text: "", messages: [] };
    if (want === "prompt") {
      return {
        ok: true,
        text: messages[messages.length - 1]?.text ?? "",
        messages: [],
      };
    }
    return { ok: true, text: "", messages };
  }

  // The Claude Code session behind a terminal. Herdr knows the program in the
  // terminal (`hc get`'s foreground pid), and Claude names that process's
  // session file by pid, so two Claudes in one folder never mix. The session
  // file is re-read every tick: it is small, and `/clear` changes it while the
  // process stays. Only the pid lookup, which runs a program, is cached.
  async claudeSession({ address, machine, cwd }) {
    const key = `${machine ?? ""}\u0000${address}`;
    let entry = this.claudeSessions.get(key);
    if (!entry) {
      entry = { pid: null, at: 0, scan: null, scanAt: 0, scanCwd: null };
      this.claudeSessions.set(key, entry);
    }
    const now = Date.now();
    if (now - entry.at > CLAUDE_PID_TTL) {
      entry.pid = await this.claudePid(address, machine);
      entry.at = now;
    }
    const base = await this.claudeHomeFor(machine);
    if (!base) return null;
    if (entry.pid) {
      const text = await readTextFile(
        `${base}/sessions/${entry.pid}.json`,
        machine ? { on: machine } : {},
      ).catch(() => null);
      if (text) {
        let s = null;
        try {
          s = JSON.parse(text);
        } catch {}
        if (typeof s?.sessionId === "string" && s.sessionId) {
          return {
            sessionId: s.sessionId,
            cwd: s.cwd || cwd,
            base,
            name: s.name,
          };
        }
      }
    }
    // No pid (a wrapper, another build) or no session file: the folder's most
    // recently written transcript is the best guess, as with opencode.
    if (entry.scanCwd !== cwd || now - entry.scanAt > 10000) {
      entry.scanCwd = cwd;
      entry.scanAt = now;
      entry.scan = await this.newestTranscript({ base, cwd, machine });
    }
    if (!entry.scan) return null;
    return { sessionId: entry.scan, cwd, base, name: null };
  }

  // The menu's header: the session's own name, else the folder it works in.
  claudeSummary(ses, cwd) {
    const name = typeof ses?.name === "string" ? ses.name.trim() : "";
    if (name) return name;
    const folder = String(ses?.cwd || cwd || "").replace(/[\\/]+$/, "");
    return folder.split(/[\\/]/).pop() || "Claude Code";
  }

  // The newest prompt of one Claude session: `display` is what the user typed,
  // pasted text folded to a placeholder.
  async readClaudePrompt({ address, cwd, machine }) {
    const ses = await this.claudeSession({ address, machine, cwd });
    if (!ses) return { ok: false, text: "" };
    const summary = this.claudeSummary(ses, cwd);
    const h = await this.readClaudeHistory({
      base: ses.base,
      machine,
      bytes: CLAUDE_HISTORY_BYTES,
    });
    if (h.ok) {
      for (let i = h.rows.length - 1; i >= 0; i--) {
        const row = h.rows[i];
        if (row?.sessionId !== ses.sessionId) continue;
        const text = claudeHistoryText(row);
        if (text) return { ok: true, text, summary };
      }
      // No prompt in the tail: usually a fresh session, but a tail can also
      // cut a resumed session's only prompt. Ask the transcript — once every
      // few seconds while the session simply has nothing to say. What that
      // read found is kept in between, so the line does not blink.
      const key = `${machine ?? ""}\u0000${ses.sessionId}`;
      const seen = this.claudeMiss.get(key);
      if (seen && Date.now() - seen.at < CLAUDE_MISS_MS)
        return { ok: true, text: seen.text, summary };
    }
    const t = await this.readClaudeTranscript({
      sessionId: ses.sessionId,
      cwd: ses.cwd || cwd,
      base: ses.base,
      machine,
      want: "prompt",
    });
    if (t.ok) {
      if (h.ok) {
        const key = `${machine ?? ""}\u0000${ses.sessionId}`;
        this.claudeMiss.set(key, { at: Date.now(), text: t.text ?? "" });
      }
      return { ok: true, text: t.text, summary };
    }
    // With a working history an empty answer means an empty session; without
    // one, a failed read is no reason to drop the line already shown.
    return { ok: h.ok, text: "", summary };
  }

  // Every person message of the focused Claude session, oldest first. The
  // transcript is the conversation itself; the input history backs it up when
  // there is no transcript to read.
  async readClaudeMessages({ address, cwd, machine }) {
    const ses = await this.claudeSession({ address, machine, cwd });
    if (!ses) return { ok: false, messages: [] };
    const t = await this.readClaudeTranscript({
      sessionId: ses.sessionId,
      cwd: ses.cwd || cwd,
      base: ses.base,
      machine,
      want: "messages",
    });
    if (t.ok && t.messages.length) return t;
    const h = await this.readClaudeHistory({
      base: ses.base,
      machine,
      bytes: CLAUDE_HISTORY_MENU,
    });
    if (!h.ok) return t;
    const messages = [];
    for (const row of h.rows) {
      if (row?.sessionId !== ses.sessionId) continue;
      messages.push({
        text: claudeHistoryText(row) || "(no text)",
        at: Number(row.timestamp) || 0,
      });
    }
    return { ok: true, messages: messages.slice(-CLAUDE_MENU_MAX) };
  }

  cancelPromptClear() {
    try {
      this.promptClear?.cancel();
    } catch {}
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
    this.promptSummary = "";
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
    const a = currentAgent();
    if (!a) {
      this.promptMessages = [];
      this.paint(cx);
      return;
    }
    const gen = ++this.promptMsgGen;
    const kind = agentKind(a);
    const cwd = agentCwd(a);
    const machine = agentMachine(a);
    const title = opencodeTitle(a);
    this.promptMsgError = false;
    cx.spawn(async (cx) => {
      let res = { ok: false, messages: [] };
      try {
        res =
          kind === "claude"
            ? await this.readClaudeMessages({
                address: a.address,
                cwd,
                machine,
              })
            : await this.readOpencodeMessages({ cwd, title, machine });
      } catch {}
      if (gen !== this.promptMsgGen) return;
      this.promptMsgError = !res.ok;
      this.promptMessages = res.ok ? res.messages : [];
      this.paint(cx);
    });
  }

  setPromptMenu(open, cx) {
    if (!open) this.promptMenuClosedAt = Date.now();
    this.promptMenuOpen = open;
    if (open) {
      this.promptMessages = null; // show Loading… while the read runs
      this.promptMsgError = false;
      this.loadPromptMessages(cx);
    } else {
      this.promptMsgGen++; // a late read is no longer wanted
      this.promptMessages = null;
      this.promptMsgError = false;
    }
    this.paint(cx);
  }

  // An agent quitting clears it a moment before the terminal settles: keep
  // the last line for a beat so a status flap cannot blank it and redraw it.
  // A returning agent cancels this from refreshPrompt.
  schedulePromptClear(cx) {
    if (this.promptClear) return;
    this.promptClear = cx.timer.after(450, (cx) => {
      this.promptClear = null;
      if (currentAgent()) return;
      this.clearPrompt(cx);
    });
  }

  refreshPrompt(cx, silent = false) {
    const f = focused();
    const term = f?.terminal ?? null;
    const a = currentAgent();
    const kind = agentKind(a);
    const addr = a?.address ?? null;
    const termChanged = term !== this.promptTerm;
    const agentChanged = addr !== this.promptAgent || kind !== this.promptKind;

    if (termChanged || agentChanged) {
      // The context moved, or its agent came and went; a read in flight is
      // about to be stale.
      this.promptTerm = term;
      this.promptAgent = addr;
      this.promptKind = kind;
      this.promptGen++;
      this.promptBusy = false;
      // A new terminal context: forget which pid and transcript belonged to
      // the old one, so a restarted agent is not still read as the old one.
      this.claudeSessions.clear();
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
      try {
        res =
          kind === "claude"
            ? await this.readClaudePrompt({ address: a.address, cwd, machine })
            : await this.readOpencodePrompt({ cwd, title, machine });
      } catch {}
      this.promptBusy = false;
      if (gen !== this.promptGen) return;
      // opencode writes its database while quitting, and a transcript can be
      // unreadable for a moment: keep the line as it is instead of flashing
      // the session title. A successful read with no message (a fresh
      // session) clears it.
      if (!res.ok) return;
      const text = res.text;
      const one = oneLine(text);
      const summary =
        kind === "claude" ? (res.summary ?? "") : sessionSummary(a);
      if (summary) this.promptSummary = summary;
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
      this.promptUnit = 0; // measure the new text before sliding
      if (one && this.promptMenuOpen) this.loadPromptMessages(cx);
      this.paint(cx);
    });
  }

  marqueeActive() {
    return Boolean(
      this.hoverPrompt &&
      this.prompt &&
      this.promptBox > 0 &&
      this.promptUnit > this.promptBox + 2,
    );
  }

  clearMarquee() {
    for (const t of this.marqueeTasks) {
      try {
        t?.cancel();
      } catch {}
    }
    this.marqueeTasks = [];
    this.promptAnim = false;
    this.promptOffset = 0;
  }

  // One pass moves a copied track left by one copy plus the gap. The track is
  // rebuilt for every pass with a new id: a reused element can carry the
  // previous pass's animated value, and re-adding its transition then makes
  // the reset look like a jump back to the head. A fresh track starts at 0
  // (the same frame the old track ends on, since its second copy is there),
  // so the swap is invisible and the next pass can follow at once.
  startMarquee(cx) {
    this.clearMarquee();
    if (!this.marqueeActive()) return;
    const unit = this.promptUnit + MARQUEE_GAP;
    this.marqueeMs = Math.max(1500, Math.round((unit / MARQUEE_SPEED) * 1000));
    this.marqueePolicy = { duration: this.marqueeMs, easing: "linear" };
    this.runMarquee(cx);
  }

  runMarquee(cx) {
    if (!this.marqueeActive()) {
      this.clearMarquee();
      return;
    }
    this.marqueePass++;
    this.promptAnim = true;
    this.promptOffset = 0;
    this.paint(cx);

    // The transition has to be on the element for a rendered frame before
    // `left` changes; adding both in one render jumps to the target.
    const go = cx.timer.after(50, (cx) => {
      if (!this.marqueeActive()) {
        this.clearMarquee();
        this.paint(cx);
        return;
      }
      this.promptOffset = -(this.promptUnit + MARQUEE_GAP);
      this.paint(cx);

      const next = cx.timer.after(this.marqueeMs + 50, (cx) => {
        if (!this.marqueeActive()) {
          this.clearMarquee();
          this.paint(cx);
          return;
        }
        // The old track's second copy is now where a fresh first copy sits,
        // so starting the next pass needs no visibility gap.
        this.runMarquee(cx);
      });
      this.marqueeTasks.push(next);
    });
    this.marqueeTasks.push(go);
  }

  // One message body. Its words are separate wrapping items, so the text runs
  // edge to edge instead of leaving a column for the time. The last word and
  // the time travel together, so the time stays appended to the message.
  messageBody(t, msg, at) {
    const paragraphs = messageParagraphs(msg.text);
    return v_flex()
      .flex_1()
      .min_w(0)
      .gap(0)
      .children(
        paragraphs.map((tokens, p) => {
          const last = p === paragraphs.length - 1;
          const tail = last && at ? tokens[tokens.length - 1] : null;
          const rest = tail ? tokens.slice(0, -1) : tokens;
          return h_flex()
            .w_full()
            .min_w(0)
            .flex_wrap()
            .items_baseline()
            .gap(0)
            .children(
              rest.map((token) =>
                div()
                  .flex_none()
                  .whitespace_nowrap()
                  .text_color(t.foreground)
                  .child(token),
              ),
            )
            .when(Boolean(tail), (el) =>
              el.child(
                h_flex()
                  .flex_none()
                  .items_baseline()
                  .gap(0)
                  .child(
                    div()
                      .whitespace_nowrap()
                      .text_color(t.foreground)
                      .child(tail),
                  )
                  .child(
                    div()
                      .whitespace_nowrap()
                      .pl(6)
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(at),
                  ),
              ),
            );
        }),
      );
  }

  // The menu above the bar: every user message of this session, oldest first
  // and numbered from one. It scrolls once it would cover too much of the
  // window; the width is fixed so long prompts wrap instead of stretching.
  promptMenu(t) {
    const rows = this.promptMessages;
    const count = rows?.length ?? 0;
    const summary = this.promptSummary;
    const empty = (text) => div().p(8).text_color(t.dim).child(text);
    return v_flex()
      .id("status-prompt-menu")
      .w(MESSAGE_MENU_W)
      .max_h(MESSAGE_MENU_MAX_H)
      .overflow_y_scrollbar()
      .p(4)
      .rounded(8)
      .bg(t.popover)
      .border_1()
      .border_color(t.input)
      .text_size(12)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .px(8)
          .pt(4)
          .pb(6)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_color(t.muted)
              .when(Boolean(summary), (el) => el.tooltip(summary))
              .child(summary || "Session messages"),
          )
          .when(rows !== null && !this.promptMsgError, (el) =>
            el.child(
              div().text_size(10.5).text_color(t.dim).child(String(count)),
            ),
          ),
      )
      .when(rows === null && !this.promptMsgError, (el) =>
        el.child(empty("Loading…")),
      )
      .when(this.promptMsgError, (el) =>
        el.child(empty("Cannot read this session")),
      )
      .when(rows !== null && !this.promptMsgError && !rows.length, (el) =>
        el.child(empty("No messages")),
      )
      .children(
        (rows ?? []).map((msg, i) => {
          const at = sentAt(msg.at);
          return h_flex()
            .id(`status-prompt-message-${i}`)
            .flex_none()
            .px(8)
            .py(6)
            .gap(8)
            .items_start()
            .when(i < count - 1, (el) => el.border_b(1).border_color(t.border))
            .child(
              div()
                .flex_none()
                .w(22)
                .text_size(11)
                .text_color(t.dim)
                .child(`${i + 1}.`),
            )
            .child(this.messageBody(t, msg, at));
        }),
      );
  }

  promptView(t) {
    const sliding = this.marqueeActive();
    const copy = (id, pad) =>
      h_flex()
        .id(id)
        .flex_none()
        .whitespace_nowrap()
        .items_center()
        .when(pad, (el) => el.pl(MARQUEE_GAP))
        .child(this.prompt);
    const inner = sliding
      ? h_flex()
          .id(`status-prompt-track-${this.marqueePass}`)
          .absolute()
          .left(this.promptOffset)
          .top(0)
          .h_full()
          .flex_nowrap()
          .items_center()
          .when(this.promptAnim, (el) =>
            el.transition(
              "left",
              this.marqueePolicy ?? {
                duration: this.marqueeMs,
                easing: "linear",
              },
            ),
          )
          .child(copy(`status-prompt-a-${this.marqueePass}`, false))
          .child(copy(`status-prompt-b-${this.marqueePass}`, true))
      : div()
          .id("status-prompt-static")
          .flex_none()
          .whitespace_nowrap()
          .child(this.prompt)
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.promptUnit) > 0.5) {
              this.promptUnit = size.width;
              this.paint(cx);
              if (this.hoverPrompt) this.startMarquee(cx);
            }
          });
    // The popover's trigger is just the icon: a Popover is not a normal flex
    // child, so making the whole line its trigger left the text at its
    // intrinsic width and pushed the palette key off the right edge. The line
    // below is a plain flex child that takes the free width.
    const trigger = svg("mods/workspace-chrome/square-pen.svg")
      .size(13)
      .flex_none()
      .text_color(t.dim);
    const surface = Popover.new("status-prompt-menu")
      .anchor("bottom_left")
      .open(this.promptMenuOpen)
      .on_open_change((open, cx) => this.setPromptMenu(open, cx))
      .trigger(trigger)
      .content(this.promptMenu(t));
    // bottom_left pins the menu's bottom edge to the icon's bottom: it opens
    // upwards, over the panes, with its left edge on the prompt icon.
    return (
      h_flex()
        .id("status-prompt")
        .flex_1()
        .min_w(0)
        .h_full()
        .gap(6)
        .items_center()
        .cursor_pointer()
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
        .child(surface)
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .h_full()
            .relative()
            .overflow_hidden()
            .items_center()
            .on_size_change((size, cx) => {
              if (Math.abs(size.width - this.promptBox) > 0.5) {
                this.promptBox = size.width;
                this.paint(cx);
                if (this.hoverPrompt) this.startMarquee(cx);
              }
            })
            .child(inner)
            // The text is outside the Popover's trigger (the icon), so it opens
            // the controlled surface itself. The surface must be opened after the
            // press: opened during it, a fresh Popover reads that same press as an
            // outside one and dismisses at once. A press that just closed the open
            // menu (reported before this click) must not re-open it.
            .child(
              div()
                .id("status-prompt-hit")
                .absolute()
                .left(0)
                .right(0)
                .top(0)
                .bottom(0)
                .cursor_pointer()
                .on_click((_e, cx) => {
                  if (Date.now() - this.promptMenuClosedAt < 300) return;
                  if (this.promptMenuOpen) {
                    this.setPromptMenu(false, cx);
                    return;
                  }
                  cx.timer.after(0, (cx) => this.setPromptMenu(true, cx));
                }),
            ),
        )
    );
  }

  list(t) {
    const current = spaces().find((s) => s.active)?.branch ?? null;
    const rows = this.branches;
    return v_flex()
      .id("status-branch-list")
      .min_w(200)
      .max_w(340)
      .max_h(320)
      .overflow_y_scrollbar()
      .p(4)
      .rounded(8)
      .bg(t.popover)
      .border_1()
      .border_color(t.input)
      .text_size(12)
      .text_color(t.foreground)
      .when(rows === null, (el) =>
        el.child(div().p(8).text_color(t.dim).child("Loading\u2026")),
      )
      .when(rows !== null && !rows.length, (el) =>
        el.child(div().p(8).text_color(t.dim).child("No branches")),
      )
      .children(
        (rows ?? []).map((name) =>
          h_flex()
            .id(`status-branch-${name}`)
            .h(24)
            .flex_none()
            .px(8)
            .gap(7)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .when(name === current, (el) => el.bg(t.selected))
            .when(name !== current, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.pick(name, cx))
            .child(
              svg("mods/workspace-chrome/branch.svg")
                .size(12)
                .flex_none()
                .text_color(name === current ? t.accent : t.dim),
            )
            .child(div().flex_1().min_w(0).truncate().child(name))
            .when(name === current, (el) =>
              el.child(
                svg("mods/workspace-chrome/check.svg")
                  .size(12)
                  .flex_none()
                  .text_color(t.accent),
              ),
            ),
        ),
      );
  }

  render(cx) {
    // Focus changes redraw at once; the prompt timer runs every 1.5 s. Catch
    // the change here so the old tab's prompt never lingers on screen.
    // Silent: this pass is the repaint, and notify() is refused while rendering.
    const f = focused();
    const cur = currentAgent();
    if (
      (f?.terminal ?? null) !== this.promptTerm ||
      (cur?.address ?? null) !== this.promptAgent ||
      agentKind(cur) !== this.promptKind
    )
      this.refreshPrompt(cx, true);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const hint = this.hint();
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);
    const branch = space?.branch;
    // The focused terminal's folder, live; its space's folder when a mod pane
    // holds the keyboard (focused().cwd is null then).
    const cwd = focused()?.cwd ?? place(space);
    const trigger = (b) =>
      h_flex()
        .id("status-branch-trigger")
        .h_full()
        .px(6)
        .gap(6)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .child(
          svg("mods/workspace-chrome/branch.svg")
            .size(13)
            .text_color(this.open ? t.accent : t.muted),
        )
        .child(
          div()
            .text_color(this.open ? t.foreground : t.muted)
            .child(b),
        );
    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .when(Boolean(space?.machine), (el) =>
        el.child(label("server", space.machine)),
      )
      .when(Boolean(branch), (el) =>
        el.child(
          Popover.new("status-branch")
            .anchor("bottom_left")
            .open(this.open)
            .on_open_change((open, cx) => {
              this.open = open;
              if (open) this.load(cx);
              this.paint(cx);
            })
            .trigger(trigger(branch))
            .content(this.list(t)),
        ),
      )
      .when(Boolean(cwd), (el) =>
        el.child(
          h_flex()
            .id("status-cwd")
            .gap(6)
            .items_center()
            .min_w(0)
            .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none())
            .child(div().max_w(360).truncate().child(short(cwd))),
        ),
      )
      .child(this.prompt ? this.promptView(t) : div().flex_1().min_w(0))
      .when(Boolean(hint), (el) =>
        el.child(
          div()
            .id("palette")
            .flex_none()
            .text_color(t.dim)
            .on_click(() => run("app.palette"))
            .child(hint),
        ),
      );
  }
}
