// The status bar (a copy of workspace-status) with a live branch item: pressing
// the branch drops the repository's local branch list above the bar, and picking
// one checks it out. The Git panel's branch row follows on its own folder watch.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, panes, exec, notify, theme, run, window, keys } from "herdr";

// Where the active space is now: its first terminal's live folder, else where it
// was made — the same place the bar's branch comes from.
function place(space) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

export default class StatusBranch extends View {
  init(_props, cx) {
    this.open = false;     // the branch list
    this.branches = null;  // null until the first read
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
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
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const branch = space?.branch;
    const trigger = (b) => h_flex().id("status-branch-trigger").h_full().px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(this.open ? t.accent : t.muted))
      .child(div().text_color(this.open ? t.foreground : t.muted).child(b));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(
        Popover.new("status-branch").anchor("bottom_left").open(this.open)
          .on_open_change((open, cx) => { this.open = open; if (open) this.load(cx); cx.notify(); })
          .trigger(trigger(branch))
          .content(this.list(t))))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
