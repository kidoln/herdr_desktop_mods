// Resizes the Herdr window through macOS Accessibility (System Events).
// Called by main.js as: osascript -l JavaScript window.js '<json>'
//   { mode: "grow", delta, min }            → widen to the right, clamped to the screen
//   { mode: "shrink", delta, expected, min } → narrow again, but only if the width is unchanged
// Prints one JSON line. Any failure leaves the window alone.
ObjC.import("AppKit");

function result(value) {
  return JSON.stringify(value);
}

function screens() {
  const height = Number($.NSScreen.screens.objectAtIndex(0).frame.size.height);
  const list = [];
  for (let i = 0; i < $.NSScreen.screens.count; i++) {
    const frame = $.NSScreen.screens.objectAtIndex(i).frame;
    const visible = $.NSScreen.screens.objectAtIndex(i).visibleFrame;
    list.push({
      x: Number(frame.origin.x),
      top: height - (Number(frame.origin.y) + Number(frame.size.height)),
      w: Number(frame.size.width),
      h: Number(frame.size.height),
      vx: Number(visible.origin.x),
      vw: Number(visible.size.width),
    });
  }
  return list;
}

function screenFor(pos, size, list) {
  const cx = pos[0] + size[0] / 2;
  const cy = pos[1] + size[1] / 2;
  return (
    list.find(
      (s) => cx >= s.x && cx < s.x + s.w && cy >= s.top && cy < s.top + s.h,
    ) || list[0]
  );
}

function run(argv) {
  let spec = {};
  try {
    spec = JSON.parse(argv[0] || "{}");
  } catch (_) {
    return result({ ok: false, reason: "bad-args" });
  }

  const system = Application("System Events");
  let process = null;
  try {
    process = system.processes.byName("Herdr");
  } catch (_) {}
  if (!process) return result({ ok: false, reason: "no-app" });

  // Popovers, tooltips and sheets are windows too: take the largest one,
  // which is the app's main window.
  let win = null;
  let pos = null;
  let size = null;
  let best = -1;
  try {
    for (let i = 0; i < process.windows.length; i++) {
      const candidate = process.windows[i];
      try {
        const p = Array.from(candidate.position());
        const s = Array.from(candidate.size());
        const area = s[0] * s[1];
        if (area > best) {
          best = area;
          win = candidate;
          pos = p;
          size = s;
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (!win || !pos || !size) {
    return result({ ok: false, reason: "no-window" });
  }

  const min = Number(spec.min) || 640;
  const delta = Number(spec.delta);

  if (spec.mode === "grow") {
    if (!Number.isFinite(delta) || delta <= 0) {
      return result({ ok: false, reason: "bad-delta" });
    }
    // After a restart the window may still be at the width it had with the
    // panel open. Then there is nothing to grow.
    const base = Number(spec.base);
    const known = Number(spec.grown);
    if (Number.isFinite(known) && known > 0 && Math.abs(size[0] - known) <= 2) {
      const hasBase = Number.isFinite(base) && base > 0;
      return result({
        ok: true,
        noop: true,
        from: size[0],
        to: size[0],
        applied: 0,
        grownBy: hasBase ? Math.max(0, size[0] - base) : 0,
      });
    }
    const screen = screenFor(pos, size, screens());
    const right = screen.vx + screen.vw;
    const target = Math.min(
      Math.round(size[0] + delta),
      Math.max(min, Math.round(right - pos[0])),
    );
    const applied = target - size[0];
    if (applied < 1) {
      return result({ ok: false, reason: "no-room", width: size[0] });
    }
    win.size = [target, size[1]];
    return result({
      ok: true,
      from: size[0],
      to: target,
      applied,
    });
  }

  if (spec.mode === "shrink") {
    const expected = Number(spec.expected);
    if (Number.isFinite(expected) && Math.abs(size[0] - expected) > 2) {
      return result({ ok: false, reason: "width-changed", width: size[0] });
    }
    if (!Number.isFinite(delta) || delta <= 0) {
      return result({ ok: false, reason: "bad-delta" });
    }
    const target = Math.max(min, Math.round(size[0] - delta));
    const applied = size[0] - target;
    if (applied < 1) {
      return result({ ok: false, reason: "no-room", width: size[0] });
    }
    win.size = [target, size[1]];
    return result({
      ok: true,
      from: size[0],
      to: target,
      applied,
    });
  }

  return result({ ok: false, reason: "bad-mode" });
}
