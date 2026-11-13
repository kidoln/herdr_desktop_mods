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
  init(props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Window widening: the panel is paid for by growing the window, not by
    // squeezing the terminal. `base` is the window width with the panel closed.
    this.grown = null;
    this.wantGrown = false;
    this.resizes = Promise.resolve();
    this.clickedPanel = null;
    // While a close is in flight (set in closePanel), the panel can still be
    // painted; the window must not grow back to it in the meantime.
    this.closing = null;
    this.baseWidth = Number(localStorage.getItem("window.base")) || null;
    this.grownWidth = Number(localStorage.getItem("window.grown")) || null;
    // The compiled helper resizes in ~40ms; the AppleScript fallback needs a
    // few hundred, which is the difference between a single frame and a visible
    // one. Until it is built (or if it cannot be), window.js does the work.
    this.resizer = false;
    cx.spawn(async (cx) => {
      this.resizer = await this.buildResizer();
      if (this.resizer) cx.notify();
    });
  }

  // How much wider the window must be for the panel to take its place without
  // squeezing the terminal: its rendered width plus the gap the panel row puts
  // before it, at the window's zoom. The panel's rendered width is its layout
  // size clamped to min/max — a stored drag below the minimum still renders at
  // the minimum, so the raw size alone would undercount.
  windowDelta() {
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "work-body");
    const wanted = typeof panel?.size?.px === "number" ? panel.size.px : 0;
    const min = typeof panel?.min === "number" ? panel.min : 0;
    const max = typeof panel?.max === "number" ? panel.max : Infinity;
    const px = Math.min(max, Math.max(min, wanted));
    const gap = typeof body?.gap === "number" ? body.gap : 0;
    const zoom = typeof settings().zoom === "number" ? settings().zoom : 1;
    return Math.round((px + gap) * zoom * 10) / 10;
  }

  // Herdr has no command for the OS window; Accessibility is the only way.
  // winsize.swift is built once into the mod's data folder: calling it costs a
  // process start and one AX call, where osascript first starts a whole
  // AppleScript runtime. That speed is what lets the panel go before the window
  // moves, instead of a few frames after.
  async buildResizer() {
    const home = this.home();
    const binary = `${home}/data/tabs-git/winsize`;
    // Keep in step with winsize.swift: the helper prints its own version, so a
    // changed source is never shadowed by an older build.
    const version = 1;
    if (await this.helperVersion(binary) === version) return true;
    try {
      const source = `${home}/mods/tabs-git/winsize.swift`;
      await exec("/bin/mkdir", ["-p", `${home}/data/tabs-git`], { timeout: 5000 });
      let out = await exec("/usr/bin/xcrun", ["swiftc", "-O", source, "-o", binary], { timeout: 120000 });
      if (out.code !== 0) out = await exec("/usr/bin/swiftc", ["-O", source, "-o", binary], { timeout: 120000 });
      if (out.code !== 0) return false;
    } catch (error) {
      console.log("tabs-git: window helper unavailable, using AppleScript:", error?.message ?? error);
      return false;
    }
    return await this.helperVersion(binary) === version;
  }

  // Runs the helper with a question it answers without touching the window: an
  // answer means it is there and executable, and which build it is.
  helperVersion(binary) {
    return exec(binary, ["--version"], { timeout: 5000 })
      .then(answer => answer.code === 0 ? Number(String(answer.stdout ?? "").trim()) : NaN)
      .catch(() => NaN);
  }

  home() {
    return appHome().replace(/\/+$/, "");
  }

  async hostResize(spec) {
    if (this.resizer) {
      try {
        const answer = await exec(`${this.home()}/data/tabs-git/winsize`, [JSON.stringify(spec)], { timeout: 2500 });
        if (answer.code === 0) {
          const out = JSON.parse(String(answer.stdout ?? "").trim());
          // Trust and window lookups can fail here where AppleScript still
          // works; fall back instead of leaving the window alone.
          if (out?.ok || !["not-trusted", "no-app", "no-window"].includes(out?.reason)) return out;
        }
      } catch (_) {}
      this.resizer = false;
    }
    const script = `${this.home()}/mods/tabs-git/window.js`;
    const answer = await exec("/usr/bin/osascript", ["-l", "JavaScript", script, JSON.stringify(spec)], { timeout: 2500 });
    if (answer.code !== 0) return null;
    try { return JSON.parse(String(answer.stdout ?? "").trim()); } catch (_) { return null; }
  }

  // Closing: the panel must be gone before the window server resizes, or the
  // frame it keeps showing while the app catches up still holds the panel where
  // the terminal now is — a sidebar ghost for a few frames. The helper is fast
  // enough to land both in the same frame, so there the hide goes out at once.
  // With the AppleScript fallback the resize takes hundreds of milliseconds,
  // and narrowing while the panel still holds its width is what keeps the
  // terminal from flashing wide, so there the hide waits for the shrink.
  closePanel(cx) {
    this.closing = Date.now();
    if (this.resizer) {
      this.setPanelWidth(cx, false);
      run("layout.hide", { id: "panel" });
      return;
    }
    this.setPanelWidth(cx, false, () => run("layout.hide", { id: "panel" }));
  }

  queueResize(cx, job) {
    const task = this.resizes.then(job).catch(error => {
      console.log("tabs-git: window resize failed:", error);
    });
    this.resizes = task;
    cx.spawn(async (cx) => { await task; cx.notify(); });
  }

  // Keep the terminal's columns when the panel opens or closes: widen before
  // showing it, narrow when it goes (closePanel picks the order). Restored
  // panels (space switches, restart) go through here too. Only these two
  // transitions move the window; dragging the divider just resizes the panel.
  setPanelWidth(cx, want, after) {
    const done = () => { if (after) after(); };
    if (want === this.wantGrown) { done(); return; }
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
          let applied = out.applied > 0 ? out.applied : out.grownBy > 0 ? out.grownBy : delta;
          let to = out.to;
          // That restored width may be short of what the panel needs now (a
          // divider dragged under the minimum, a changed panel). The panel is
          // open, so grow the rest now rather than leaving the terminal squeezed.
          if (out.noop && applied + 0.5 < delta) {
            const extra = await this.hostResize({ mode: "grow", delta: delta - applied, base: 0, grown: 0, min: 640 });
            if (extra?.ok) {
              applied += extra.applied;
              to = extra.to;
            }
          }
          this.grown = { delta, applied: applied > 0 ? applied : delta, to };
          if (!out.noop) {
            this.baseWidth = out.from;
            localStorage.setItem("window.base", String(out.from));
          }
          this.grownWidth = to;
          localStorage.setItem("window.grown", String(to));
        } finally { done(); }
      });
      return;
    }
    // `wantGrown` stays true until the shrink finishes: the panel can still be
    // painted, and syncPanel must not read that leftover as an open panel.
    if (!this.wantGrown && !this.grown) { done(); return; }
    const host = window();
    if (host?.maximized || host?.fullscreen) { this.wantGrown = false; done(); return; }
    this.queueResize(cx, async () => {
      try {
        // Read here, not above: an open still waiting its turn in this queue
        // sets `grown` first, and that width is what has to be given back.
        const grown = this.grown;
        this.grown = null;
        if (!grown) return;
        // Undo exactly the width the window gained on open: dragging the
        // divider while it was open must not change how far it narrows.
        const delta = grown.applied > 0 ? grown.applied : grown.delta;
        let out = await this.hostResize({
          mode: "shrink",
          delta,
          expected: grown.to,
          min: 640,
        });
        // The window was resized by hand while the panel was open, so it is no
        // longer the width it had when it opened. Give back the panel's current
        // width instead: closing still narrows the window, and the terminal
        // keeps the size it has now.
        if (!out?.ok && out?.reason === "width-changed") {
          const now = this.windowDelta();
          if (now > 0) out = await this.hostResize({ mode: "shrink", delta: now, min: 640 });
        }
        if (out?.ok) {
          this.baseWidth = out.to;
          this.grownWidth = null;
          localStorage.setItem("window.base", String(out.to));
          localStorage.removeItem("window.grown");
        }
      } finally {
        // The hide (the callback) goes before `wantGrown` is cleared: a render
        // in between would read the still-visible panel as an open one.
        done();
        this.wantGrown = false;
      }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  // Dragging its divider resizes the panel only, never the window.
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
            this.closePanel(cx);
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
    // A panel on its way out is still painted for a frame or two: that leftover
    // is not a choice, and the window must not grow back to it. Once the hide
    // lands (or a failed one gives up) the normal rules apply again.
    if (this.closing) {
      if (now && Date.now() - this.closing < 3000) return;
      this.closing = null;
    }
    // A visible panel always owns the extra window width, including one the
    // app restored before this mod widened anything.
    if (now) {
      this.setPanelWidth(cx, true);
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
            this.closePanel(cx);
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
