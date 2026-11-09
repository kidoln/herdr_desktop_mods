// The file pane for the Files panel, in the main area: an editor for text files
// and a picture viewer for image files (PNG, JPEG, GIF, WebP, BMP, ICO, SVG).
// Clicking a file in the panel publishes what to open to
// shared("files.view"); this pane reads it, shows it right away, and writes
// text back from the Save button in its header (top right) -- the same
// read/edit/write contract as the git-diff pane's editor, with the editor as
// the pane's whole state. Saving is refused while the file changed on disk
// since it was read (writeTextFile's expected snapshot), and a file too large
// to read whole, or one on another machine, opens read-only instead (a write
// could not round-trip it).
// A picture is never read as text: image() reads from the app's own folder, so
// the bytes are copied into data/file-view/ first, under a fresh name per load
// (a rewritten file must not come back from an old cache entry), and only the
// copy plus its pixel size are kept. A picture bigger than the pane shows
// scaled down; clicking it (or the header's 1:1 / Fit chip) shows it at its own
// size, scrolling whatever does not fit.
// Clicking the file the tab already shows closes it again (the panel's own
// click toggles), and another file opens in the same tab. A picked file never
// throws away unsaved edits: while the editor is modified it waits, and the
// save releases it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { shared, readTextFile, writeTextFile, theme, settings, appHome, exec } from "herdr";
import * as fs from "fs/promises";
import { join } from "path";
import { Buffer } from "buffer";
import { randomUUID } from "crypto";

// The editor's language: the extension, or the same aliases the Files panel uses.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const language = (path) => { const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt"; return LANG[ext] ?? ext; };
const MAX_EDIT = 1048576; // readTextFile's cap: a longer file cannot round-trip a save
const MAX_VIEW = 400000;  // what a read-only view keeps of a longer file
const MONO = () => settings().font_family ?? "JetBrains Mono";
const icon = (name) => svg(`mods/file-view/${name}.svg`).flex_none();

// Picture files, by extension. image() reads from the app's own folder only, so
// the bytes are copied into COPY_DIR first and the pane keeps the copy.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const COPY_DIR = "data/file-view"; // under appHome()
const IMAGE_MAX = 33554432;        // 32 MiB: more than this is not copied in
const REMOTE_MAX = 6291456;        // base64 comes back through exec, whose output stops at 8 MiB
const COPIES = 16;                 // copies kept; older ones are pruned on the next load
const extOf = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
const isImage = (p) => IMAGE_EXT.has(extOf(p));
const bytesLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// The pixel size read off the file's header: PNG, GIF, BMP, WebP, JPEG, ICO
// and SVG say it early enough. null when the format does not (or these are not
// picture bytes at all), and then the picture is shown unscaled.
function imageSize(u8) {
  const be32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const le16 = (o) => u8[o] | (u8[o + 1] << 8);
  const le32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  if (u8.length >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e) return { w: be32(16), h: be32(20) };
  if (u8.length >= 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return { w: le16(6), h: le16(8) };
  if (u8.length >= 26 && u8[0] === 0x42 && u8[1] === 0x4d) return { w: le32(18), h: le32(22) };
  if (u8.length >= 30 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) {
    const kind = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (kind === "VP8X") return { w: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), h: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)) };
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L") { const bits = le32(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8) { // JPEG: hunt for the frame header
    let o = 2;
    while (o + 9 < u8.length) {
      if (u8[o] !== 0xff) { o += 1; continue; }
      const mark = u8[o + 1];
      if (mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc) return { w: (u8[o + 7] << 8) | u8[o + 8], h: (u8[o + 5] << 8) | u8[o + 6] };
      if (mark === 0x01 || (mark >= 0xd0 && mark <= 0xd8)) { o += 2; continue; }
      const len = (u8[o + 2] << 8) | u8[o + 3];
      if (len < 2) break;
      o += 2 + len;
    }
    return null;
  }
  if (u8.length >= 8 && u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0) return { w: u8[6] || 256, h: u8[7] || 256 };
  if (u8[0] === 0x3c) { // "<": XML, so probably an SVG: its viewBox, else its width/height
    const head = Buffer.from(u8.slice(0, 4096)).toString("utf8");
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(head);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return { w: Math.round(Number(vb[1])), h: Math.round(Number(vb[2])) };
    const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(head), h = /\bheight\s*=\s*["']([\d.]+)/i.exec(head);
    if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) };
  }
  return null;
}

// Old copies go: the names start with the load's timestamp in base36, so name
// order is age order. A copy still shown only goes past COPIES newer ones.
async function pruneCopies() {
  try {
    const dir = join(appHome(), COPY_DIR);
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    for (const name of names.slice(0, Math.max(0, names.length - COPIES))) {
      await fs.unlink(join(dir, name)).catch(() => {});
    }
  } catch {}
}

export default class FileView extends View {
  init() {
    this.seq = null;
    this.target = null;     // the file the panel published (it waits while edits are unsaved)
    this.editFile = null;   // { root, path, on }: the file the editor holds
    this.code = null;       // EditorState
    this.image = null;      // { name, w, h, bytes }: the picture copy in the app folder
    this.shownImage = null; // the file that copy came from, so a reselect is not reloaded
    this.oneToOne = false;  // show the picture at its own size, not scaled to the pane
    this.size = null;       // the pane's size, from on_size_change
    this.saved = null;      // the text the editor read / last saved
    this.dirty = false;
    this.readOnly = false;  // view only: on another machine, or too large to round-trip
    this.saving = false;
    this.error = null;      // nothing to edit (binary, gone, unreadable)
    this.saveError = null;  // a refused save, shown above the editor
    this.loading = false;
    this.loadToken = 0;     // guards a stale read after the panel picked another file
  }

  sameFile(a, b) { return Boolean(a && b) && a.root === b.root && a.path === b.path && (a.on ?? null) === (b.on ?? null); }

  // The room the picture has, in the same px the mod draws with: the pane
  // minus the header, the padding and a little air. on_size_change reports the
  // pane before zoom is applied, so the zoom divides it back out. Null until
  // the first layout has come back.
  available() {
    if (!this.size?.width) return null;
    const z = Number(settings()?.zoom) || 1;
    return { w: Math.max(48, Math.round(this.size.width / z) - 24), h: Math.max(48, Math.round(this.size.height / z) - 30 - 24) };
  }

  // Whether the picture at its own size is bigger than the pane, i.e. whether
  // there is anything to toggle between fitting and 1:1.
  shrunk() {
    const i = this.image, box = this.available();
    return Boolean(i?.w && i?.h && box && (i.w > box.w || i.h > box.h));
  }

  // Re-derives the shown file whenever the panel publishes a new target, guarded
  // by the sequence number. Nothing here ever drops a modified editor: the file
  // it edits wins until it is saved.
  sync(cx) {
    const target = shared("files.view");
    const seq = target?.seq ?? 0;
    if (seq === this.seq) return;
    this.seq = seq;
    this.target = target?.path && target.root ? target : null;
    // sync runs at the top of render (a shared-state change is what redraws this
    // pane), so the mutations here are already in this pass's tree; cx.notify()
    // is not allowed during render.
    if (!this.target) {
      if (!this.dirty) { this.leave(); this.loading = false; }
      return;
    }
    // The pane already holds this file: nothing to load, and any read still in
    // flight for another file is stale now.
    if (this.editFile && this.sameFile(this.target, this.editFile)) {
      this.loadToken += 1; this.loading = false;
      return;
    }
    if (this.image && this.sameFile(this.target, this.shownImage)) {
      this.loadToken += 1; this.loading = false;
      return;
    }
    if (this.dirty) return;   // wait: the edits stay until saved
    this.load(this.target, cx);
  }

  // Reads the target into the editor, or copies a picture in for the viewer. The
  // token makes a late read land nowhere; a read that arrives after the file
  // grew modified does not replace it either.
  load(target, cx) {
    const token = ++this.loadToken;
    this.loading = true;
    this.error = null; this.saveError = null;
    if (isImage(target.path)) return this.loadImage(target, token, cx);
    cx.spawn(async (cx) => {
      let text = null, error = null;
      try { text = await readTextFile(`${target.root}/${target.path}`, { on: target.on }); }
      catch (e) { error = String(e); }
      if (this.loadToken !== token) return;                       // a newer read owns the pane now
      if (this.dirty) { this.loading = false; cx.notify(); return; }  // edits won: keep them
      this.code?.release();
      this.code = null; this.editFile = null; this.saved = null;
      this.image = null; this.shownImage = null; this.oneToOne = false;
      this.dirty = false; this.readOnly = false;
      if (text === null) error = error ?? "This file is no longer available";
      else if (text.includes("\0")) error = "Binary file \u00b7 no text editor";
      else {
        const t = theme();
        // Another machine's file cannot be written from here, and a file past
        // readTextFile's cap may be truncated: both open as views, not editors.
        this.readOnly = Boolean(target.on) || text.length >= MAX_EDIT;
        this.code = EditorState.new({ language: language(target.path), readonly: this.readOnly,
          value: this.readOnly && text.length > MAX_VIEW ? text.slice(0, MAX_VIEW) + "\n\u2026 (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.editFile = { root: target.root, path: target.path, on: target.on ?? null };
        if (!this.readOnly) {
          this.saved = text;
          this.code.on("change", (_e, ccx) => {
            if (!this.code) return;
            this.dirty = this.code.value() !== this.saved;
            this.saveError = null;
            ccx.notify();
          });
        }
      }
      this.error = error; this.loading = false;
      cx.notify();
    });
  }

  // Copies the picture where image() can read it and notes its pixel size. Local
  // files are read through fs (the sandbox reads the home folder); a file on
  // another machine comes back as base64 through exec. Nothing is ever read as
  // text, so the pane never mistakes bytes for characters.
  loadImage(target, token, cx) {
    const ext = (extOf(target.path) || "img").replace(/[^a-z0-9]/g, "") || "img";
    const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    const dir = join(appHome(), COPY_DIR);
    cx.spawn(async (cx) => {
      let bytes = null, error = null;
      try {
        const abs = `${target.root}/${target.path}`;
        if (target.on) {
          const probe = await exec("sh", ["-c", 'wc -c < "$1"', "file-view", abs], { on: target.on });
          const size = Number(probe.stdout.trim());
          if (probe.code !== 0 || !(size > 0)) throw new Error("Cannot read the file there");
          if (size > REMOTE_MAX) throw new Error(`Too large to preview (${bytesLabel(size)})`);
          const r = await exec("sh", ["-c", 'base64 < "$1"', "file-view", abs], { on: target.on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read the file there");
          bytes = Buffer.from(r.stdout, "base64");
        } else {
          // exec reaches files the fs sandbox may not (say, outside the home
          // folder); its size keeps a huge file from being read into memory.
          let size = null;
          try { const r = await exec("sh", ["-c", 'wc -c < "$1"', "file-view", abs]); if (r.code === 0) size = Number(r.stdout.trim()); } catch {}
          if (size !== null && size > IMAGE_MAX) throw new Error(`Too large to preview (${bytesLabel(size)})`);
          bytes = await fs.readFile(abs);
        }
        if (!bytes.length) throw new Error("The file is empty");
        if (bytes.length > IMAGE_MAX) throw new Error(`Too large to preview (${bytesLabel(bytes.length)})`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, name), bytes);
      } catch (e) { error = String(e?.message ?? e); bytes = null; }
      if (this.loadToken !== token) return;                        // a newer read owns the pane now
      if (this.dirty) { this.loading = false; cx.notify(); return; }
      this.code?.release();
      this.code = null; this.editFile = null; this.saved = null;
      this.dirty = false; this.readOnly = true; this.oneToOne = false;
      this.image = bytes ? { name, ...(imageSize(bytes) ?? { w: null, h: null }), bytes: bytes.length } : null;
      this.shownImage = bytes ? { root: target.root, path: target.path, on: target.on ?? null } : null;
      this.error = bytes ? null : error ?? "This file is no longer available";
      this.loading = false;
      if (bytes) pruneCopies().catch(() => {});
      cx.notify();
    });
  }

  leave() {
    this.code?.release();
    this.code = null; this.editFile = null; this.saved = null;
    this.image = null; this.shownImage = null; this.oneToOne = false;
    this.dirty = false; this.readOnly = false; this.saving = false; this.saveError = null;
  }

  // A refused save (the file changed outside Herdr) leaves a dead end unless the
  // draft can be given up: reload reads the file again, discarding the draft.
  reload(cx) {
    const file = this.target && this.target.path ? this.target : this.editFile;
    if (!file) return;
    this.dirty = false; this.saveError = null;
    this.load(file, cx);
  }

  // Save: writes the editor's text only while the file still matches what was
  // read. A save also releases the file the panel picked while this one was
  // modified -- it opens the moment the edits are safe.
  save(cx) {
    if (!this.code || !this.editFile || this.readOnly || this.saving || !this.dirty) return;
    const file = this.editFile, text = this.code.value(), expected = this.saved;
    this.saving = true; this.saveError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${file.root}/${file.path}`, text, expected);
        if (!this.sameFile(this.editFile, file)) return;
        this.saved = text; this.dirty = false;
        if (this.target && !this.sameFile(this.target, file)) this.load(this.target, cx);
      } catch (e) {
        if (this.sameFile(this.editFile, file)) this.saveError = `Cannot save \u00b7 ${e}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  // The header's right button: solid while there is something to save, dimmed
  // when not (a dimmed press does nothing), reading "Saving\u2026" while the
  // write is out.
  saveButton(t) {
    const ready = this.dirty && !this.saving && Boolean(this.code);
    return h_flex().id("file-view-save").flex_none().h(20).px(8).gap(5).items_center().rounded(6).text_size(11)
      .when(ready, e => e.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover(s => s.opacity(0.88)))
      .when(!ready, e => e.bg(t.raised).border_1().border_color(t.border).text_color(t.dim))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.save(cx); })
      .child(icon("disk").size(12).text_color(ready ? t.solid_foreground : t.dim))
      .child(div().child(this.saving ? "Saving\u2026" : "Save"));
  }

  // Fit / 1:1, the picture's own toggle: fitting scales it down to the pane,
  // 1:1 shows it at its pixel size and scrolls the rest.
  fitButton(t) {
    return h_flex().id("file-view-fit").flex_none().h(18).px(7).items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
      .text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.oneToOne = !this.oneToOne; cx.notify(); })
      .child(div().child(this.oneToOne ? "Fit" : "1:1"));
  }

  header(t) {
    const label = this.editFile?.path ?? this.target?.path ?? "File";
    const chip = this.dirty ? "Modified" : this.readOnly && this.code ? "Read-only" : null;
    const i = this.image;
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.editFile || this.target ? t.foreground : t.dim).child(label))
      .when(Boolean(i), e => e.child(div().flex_none().text_size(10.5).text_color(t.dim)
        .child(`${i.w && i.h ? `${i.w}\u00d7${i.h} \u00b7 ` : ""}${bytesLabel(i.bytes)}`)))
      .when(Boolean(i) && this.shrunk(), e => e.child(this.fitButton(t)))
      .when(Boolean(chip), e => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10)
        .text_color(this.dirty ? t.ansi1 : t.dim).child(chip)))
      .when(Boolean(this.editFile) && !this.readOnly, e => e.child(this.saveButton(t)));
  }

  // The picture itself. Scaled to fit unless 1:1 was asked for; clicking it
  // switches between the two whenever there is a difference to see. Without a
  // header size to scale by (an odd SVG, or a picture that lies about its
  // format) it is shown at its own size and scrolled, which crops nothing.
  imageBody(t) {
    const i = this.image;
    if (!i) return div().p(12).text_color(t.dim).child(this.error || (this.loading ? "Loading\u2026" : "Select a file in Files to open it here"));
    const src = image(`${COPY_DIR}/${i.name}`).flex_none();
    const box = this.available();
    if (!i.w || !i.h || !box) {
      return v_flex().flex_1().min_h(0).overflow_scrollbar().p(12).child(src);
    }
    const s = this.oneToOne ? 1 : Math.min(1, box.w / i.w, box.h / i.h);
    const w = Math.max(1, Math.round(i.w * s)), h = Math.max(1, Math.round(i.h * s));
    const toggle = (cx) => { cx.stop_propagation(); this.oneToOne = !this.oneToOne; cx.notify(); };
    if (w > box.w || h > box.h) {
      // At its own size and bigger than the pane: whatever does not fit scrolls.
      return v_flex().flex_1().min_h(0).overflow_scrollbar().p(12)
        .when(w <= box.w, e => e.items_center())
        .when(h <= box.h, e => e.justify_center())
        .child(src.w(w).h(h).cursor_pointer().on_click((_e, cx) => toggle(cx)));
    }
    const clickable = this.shrunk();
    return v_flex().flex_1().min_h(0).items_center().justify_center().p(12).overflow_hidden()
      .child(src.w(w).h(h).when(clickable, e => e.cursor_pointer().on_click((_e, cx) => toggle(cx))));
  }

  body(t) {
    if (this.image || isImage(this.target?.path ?? "")) return this.imageBody(t);
    if (!this.code) return div().p(12).text_color(t.dim)
      .child(this.error || (this.loading ? "Loading\u2026" : "Select a file in Files to open it here"));
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.saveError), e => e.child(h_flex().flex_none().px(10).py(4).gap(8).items_center().bg(t.ansi1 + "22")
        .child(div().flex_1().min_w(0).text_color(t.ansi1).text_size(11).child(this.saveError))
        .child(h_flex().id("file-view-reload").flex_none().h(18).px(7).gap(4).items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
          .text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.reload(cx); })
          .child(div().child("Reload")))))
      .child(Editor.new(this.code).flex_1().min_h(0));
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    return v_flex().id("file-view").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(11).font_family(MONO())
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.header(t))
      .child(this.body(t));
  }

  async close() {
    try { this.code?.release(); } catch {}
  }
}
