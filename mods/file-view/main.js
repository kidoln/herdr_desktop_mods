// The file pane for the Files panel, in the main area: an editor. Clicking a
// file in the panel publishes what to open to shared("files.view"); this pane
// reads it, opens it for editing right away, and writes it back from the Save
// button in its header (top right) -- the same read/edit/write contract as the
// git-diff pane's editor, with the editor as the pane's whole state. Saving is
// refused while the file changed on disk since it was read (writeTextFile's
// expected snapshot), and a file too large to read whole, or one on another
// machine, opens read-only instead (a write could not round-trip it).
// Clicking the file the pane already shows closes it again (the panel's own
// click toggles), and another file opens in the same pane. A picked file never
// throws away unsaved edits: while the editor is modified it waits, and the
// save releases it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { shared, readTextFile, writeTextFile, theme, settings } from "herdr";

// The editor's language: the extension, or the same aliases the Files panel uses.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const language = (path) => { const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt"; return LANG[ext] ?? ext; };
const MAX_EDIT = 1048576; // readTextFile's cap: a longer file cannot round-trip a save
const MAX_VIEW = 400000;  // what a read-only view keeps of a longer file
const MONO = () => settings().font_family ?? "JetBrains Mono";
const icon = (name) => svg(`mods/file-view/${name}.svg`).flex_none();

export default class FileView extends View {
  init() {
    this.seq = null;
    this.target = null;     // the file the panel published (it waits while edits are unsaved)
    this.editFile = null;   // { root, path, on }: the file the editor holds
    this.code = null;       // EditorState
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

  // Re-derives the shown file whenever the panel publishes a new target, guarded
  // by the sequence number. Nothing here ever drops a modified editor: the file
  // it edits wins until it is saved.
  sync(cx) {
    const target = shared("files.view");
    const seq = target?.seq ?? 0;
    if (seq === this.seq) return;
    this.seq = seq;
    this.target = target?.path && target.root ? target : null;
    if (!this.target) {
      if (!this.dirty) { this.leave(); this.loading = false; }
      cx.notify();
      return;
    }
    // The editor already holds this file: nothing to load, and any read still in
    // flight for another file is stale now.
    if (this.editFile && this.sameFile(this.target, this.editFile)) {
      this.loadToken += 1; this.loading = false;
      cx.notify();
      return;
    }
    if (this.dirty) { cx.notify(); return; }   // wait: the edits stay until saved
    this.load(this.target, cx);
  }

  // Reads the target into the editor. The token makes a late read land nowhere;
  // a read that arrives after the file grew modified does not replace it either.
  load(target, cx) {
    const token = ++this.loadToken;
    this.loading = true;
    this.error = null; this.saveError = null;
    cx.spawn(async (cx) => {
      let text = null, error = null;
      try { text = await readTextFile(`${target.root}/${target.path}`, { on: target.on }); }
      catch (e) { error = String(e); }
      if (this.loadToken !== token) return;                       // a newer read owns the pane now
      if (this.dirty) { this.loading = false; cx.notify(); return; }  // edits won: keep them
      this.code?.release();
      this.code = null; this.editFile = null; this.saved = null;
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

  leave() {
    this.code?.release();
    this.code = null; this.editFile = null; this.saved = null;
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

  header(t) {
    const label = this.editFile?.path ?? this.target?.path ?? "File";
    const chip = this.dirty ? "Modified" : this.readOnly ? "Read-only" : null;
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.editFile || this.target ? t.foreground : t.dim).child(label))
      .when(Boolean(chip), e => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10)
        .text_color(this.dirty ? t.ansi1 : t.dim).child(chip)))
      .when(Boolean(this.editFile) && !this.readOnly, e => e.child(this.saveButton(t)));
  }

  body(t) {
    if (!this.code) return div().p(12).text_color(t.dim)
      .child(this.error || (this.loading ? "Loading\u2026" : "Select a file in Files to edit it here"));
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
      .child(this.header(t))
      .child(this.body(t));
  }

  async close() {
    try { this.code?.release(); } catch {}
  }
}
