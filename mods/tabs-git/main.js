import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, exec, appHome } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Window widening: the panel is paid for by growing the window, not by
    // squeezing the terminal. `base` is the window width with the panel closed.
    this.grown = null;
    this.wantGrown = false;
    this.resizes = Promise.resolve();
    this.clickedPanel = null;
    this.panelSync = false;
    this.liveBusy = false;
    this.pendingDelta = null;
    this.baseWidth = Number(localStorage.getItem("window.base")) || null;
    this.grownWidth = Number(localStorage.getItem("window.grown")) || null;
  }

  // Herdr has no command for the OS window; System Events is the only way.
  windowDelta() {
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "work-body");
    const px = typeof panel?.size?.px === "number" ? panel.size.px : 368;
    const gap = typeof body?.gap === "number" ? body.gap : 8;
    const zoom = typeof settings().zoom === "number" ? settings().zoom : 1;
    return Math.round((px + gap) * zoom * 10) / 10;
  }

  async hostResize(spec) {
    const script = `${appHome().replace(/\/+$/, "")}/mods/tabs-git/window.js`;
    const answer = await exec("/usr/bin/osascript", ["-l", "JavaScript", script, JSON.stringify(spec)], { timeout: 2500 });
    if (answer.code !== 0) return null;
    try { return JSON.parse(String(answer.stdout ?? "").trim()); } catch (_) { return null; }
  }

  queueResize(cx, job) {
    const task = this.resizes.then(job).catch(error => {
      console.log("tabs-git: window resize failed:", error);
    });
    this.resizes = task;
    cx.spawn(async (cx) => { await task; cx.notify(); });
  }

  // Keep the terminal's columns while the panel is open: widen before showing
  // it, narrow after hiding it. Restored panels (space switches, restart) go
  // through here too, so the window width follows the panel every time.
  setPanelWidth(cx, want, after) {
    const done = () => { if (after) after(); };
    if (want === this.wantGrown) { done(); return; }
    this.pendingDelta = null;
    if (want) {
      const host = window();
      if (host?.maximized || host?.fullscreen) { done(); return; }
      this.wantGrown = true;
      this.queueResize(cx, async () => {
        try {
          const delta = this.windowDelta();
          if (delta <= 0) return;
          const out = await this.hostResize({
            mode: "grow", delta,
            base: this.baseWidth ?? 0, grown: this.grownWidth ?? 0, min: 640,
          });
          if (!out?.ok) return;
          // A window already at the width it had with the panel open after a
          // restart is grown, even though this session didn't widen it:
          // closing still narrows it.
          this.grown = {
            delta,
            applied: out.applied > 0 ? out.applied : out.grownBy > 0 ? out.grownBy : delta,
            to: out.to,
          };
          if (out.applied > 0) {
            this.baseWidth = out.from;
            localStorage.setItem("window.base", String(out.from));
          }
          this.grownWidth = out.to;
          localStorage.setItem("window.grown", String(out.to));
        } finally { done(); }
      });
      return;
    }
    this.wantGrown = false;
    const grown = this.grown;
    this.grown = null;
    if (!grown) { done(); return; }
    const host = window();
    if (host?.maximized || host?.fullscreen) { done(); return; }
    this.queueResize(cx, async () => {
      try {
        // Use the panel's width now, not the one it had when it opened: a
        // dragged divider must not make the terminal jump on close.
        const delta = this.windowDelta();
        const out = await this.hostResize({
          mode: "shrink",
          delta: delta > 0 ? delta : grown.applied,
          expected: grown.to,
          min: 640,
        });
        if (out?.ok) {
          this.baseWidth = out.to;
          this.grownWidth = null;
          localStorage.setItem("window.base", String(out.to));
          localStorage.removeItem("window.grown");
        }
      } finally { done(); }
    });
  }

  // Dragging the panel's divider changes the layout, not the window; after the
  // drag settles, move the window by the same amount so the terminal keeps its
  // columns. Debounced: a drag re-renders on every pixel.
  followPanelWidth(cx) {
    if (!this.wantGrown || !this.grown || this.panelSync || this.liveBusy) return;
    const delta = this.windowDelta();
    if (Math.abs(delta - this.grown.delta) < 0.5) return;
    this.pendingDelta = delta;
    this.panelSync = true;
    cx.spawn(async (cx) => {
      await cx.sleep(180);
      this.panelSync = false;
      if (!this.wantGrown || !this.grown || this.liveBusy) return;
      const want = this.pendingDelta;
      if (want == null) return;
      const diff = Math.round((want - this.grown.delta) * 10) / 10;
      if (Math.abs(diff) < 0.5) return;
      this.liveBusy = true;
      this.queueResize(cx, async () => {
        const grown = this.grown;
        if (!grown) { this.liveBusy = false; return; }
        try {
          const out = diff > 0
            ? await this.hostResize({ mode: "grow", delta: diff, base: 0, grown: 0, min: 640 })
            : await this.hostResize({ mode: "shrink", delta: -diff, expected: grown.to, min: 640 });
          // The panel may be gone by the time the OS answers.
          if (!this.grown) return;
          // Remember the new divider position either way; retrying a refused
          // resize (a manually changed window) every render would spin.
          this.grown.delta = want;
          if (!out?.ok) return;
          this.grown.applied = this.baseWidth != null
            ? Math.max(0, out.to - this.baseWidth)
            : grown.applied + diff;
          this.grown.to = out.to;
          this.grownWidth = out.to;
          localStorage.setItem("window.grown", String(out.to));
        } finally {
          this.liveBusy = false;
        }
      });
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled, cx) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
            this.setPanelWidth(cx, true);
          } else {
            run("layout.hide", { id: "panel" });
            this.setPanelWidth(cx, false);
          }
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    // A visible panel always owns the extra window width, including one the
    // app restored before this mod widened anything.
    if (now) {
      this.setPanelWidth(cx, true);
      this.followPanelWidth(cx);
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Only what this layout's stack actually holds is offered; the clone
    // always offers Git too.
    const held = new Set((body?.children ?? []).map(c => c.id));
    const enabled = [...new Set([...(shared("workspace.panels") ?? ["files"]), "git"])].filter(id => held.has(id));
    this.syncPanel(space, panel, body, enabled, cx);
    // The Git panel publishes the files waiting there (shared "git.counts"); the
    // button carries them as a corner badge on its right-bottom corner, so
    // uncommitted work shows from the tab bar whether or not the panel is open.
    // Each file counts once.
    const counts = shared("git.counts");
    const tip = counts?.total > 0 ? [counts.staged > 0 ? `${counts.staged} staged` : null, counts.changes > 0 ? `${counts.changes} changes` : null].filter(Boolean).join(" · ") : "";
    const gitBadge = counts?.total > 0 ? div()
      .absolute().right(-4).bottom(-4).h(13).min_w(13).pl(3.6).pr(2.4).rounded_full()
      .bg(t.accent).text_color(t.accent_foreground)
      .text_size(9.5).font_semibold().flex().items_center().justify_center()
      .tooltip(tip)
      .child(counts.total > 99 ? "99+" : String(counts.total)) : null;
    const panelButton = (id, label, icon, badge) => {
      const on = panel && !panel.hidden && body?.active === id;
      const pending = this.clickedPanel === id && (!panel || panel.hidden);
      return h_flex().id(`panel-${id}`).relative().h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on || pending ? t.selected : t.chrome).text_color(on || pending ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          if (on) {
            this.clickedPanel = null;
            run("layout.hide", { id: "panel" });
            this.setPanelWidth(cx, false);
          } else if (panel && !panel.hidden) {
            run("layout.select", { stack: "panel-body", child: id });
          } else {
            // Widen first, then show: the terminal never loses columns.
            this.clickedPanel = id;
            cx.notify();
            this.setPanelWidth(cx, true, () => {
              this.clickedPanel = null;
              run("layout.select", { stack: "panel-body", child: id });
              run("layout.show", { id: "panel" });
            });
          }
        }).child(svg(icon).size(14)).child(label).when(Boolean(badge), el => el.child(badge));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("git"), el => el.child(panelButton("git", "Git", "mods/git/git.svg", gitBadge)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-git/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-git/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-git/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
