import assert from 'node:assert/strict';
import { createWorkStripPreview } from '../scripts/preview-work-strip.mjs';

// Replay only invented text. This fixture does not execute tools or contact a model.
const preview = await createWorkStripPreview({ inspection: true, standaloneCode: true });
const terminal = { columns: 110, rows: 45, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {} };
for (const name of ['write', 'moveBy', 'hideCursor', 'showCursor', 'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress', 'setProgramStatus']) terminal[name] = () => {};
const plain = value => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '');
let ui;
try {
  ui = new preview.core.InteractiveMode(preview.runtime, { tuiMode: 'fullscreen', terminal });
  await ui.init();
  const runner = preview.runtime.session.extensionRunner;
  await runner.getCommand('fold').handler('expand', runner.createContext());
  const renderer = ui.renderer, scroll = renderer.getPrimaryScrollView();
  renderer.renderNow();
  const row = ui.chatContainer.children.find(row => row.toolCallId === 'standalone-wheel-code');
  assert.ok(row, 'native replay creates the standalone codemode');
  const pane = row.callRendererComponent.owner.code;
  const screen = () => renderer.getScreenLines().map(plain);
  const send = data => { renderer.handleTerminalInput(data); renderer.renderNow(); };
  // Distinct gestures must not become native double-click word selections.
  const clickAt = async (x, y) => { await new Promise(resolve => setTimeout(resolve, 550)); send(`\x1b[<0;${x + 1};${y + 1}M`); send(`\x1b[<0;${x + 1};${y + 1}m`); };
  const wheelAt = (x, y, down) => send(`\x1b[<${down ? 65 : 64};${x + 1};${y + 1}M`);
  const positionPane = atEnd => {
    scroll.scrollToEnd(); renderer.renderNow();
    if (!atEnd) { scroll.scrollTo(Math.max(0, scroll.scrollTop - 3), { disableFollow: true }); renderer.renderNow(); }
    const y = screen().findIndex(line => /▾ codemode/.test(line));
    assert.ok(y >= 0, 'standalone header is visible at its native rendered width');
    return y;
  };
  for (const width of [110, 72, 160]) {
    terminal.columns = width; renderer.requestRender(true); renderer.renderNow();
    pane.collapse(); row.invalidate(); renderer.renderNow();
    scroll.scrollToEnd(); renderer.renderNow();
    const headerY = screen().findIndex(line => /▸ codemode/.test(line));
    assert.ok(headerY >= 0);
    const headerX = screen()[headerY].indexOf('▸ codemode');
    await clickAt(headerX + 2, headerY);
    assert.equal(pane.open, true, 'terminal SGR click expands codemode without /inspect');
    assert.equal(pane.focused, false);
    for (const inspected of [false, true]) {
      for (const atEnd of [true, false]) {
        if (inspected) {
          const choices = [];
          preview.eventBus.emit('compact-renderer:inspect:v1', { add: choice => choices.push(choice) });
          const choice = choices.find(choice => /codemode.*3 nested calls/.test(choice.label));
          assert.ok(choice); choice.focus(); renderer.renderNow();
          await new Promise(resolve => setTimeout(resolve, 50)); renderer.renderNow();
        }
        pane.offset = 0; renderer.renderNow();
        const y = positionPane(atEnd), top = scroll.scrollTop;
        const before = pane.offset;
        wheelAt(headerX + 2, y + 2, true);
        assert.ok(pane.offset > before, `wheel advances body: width=${width}, inspected=${inspected}, atEnd=${atEnd}`);
        assert.equal(scroll.scrollTop, top, 'body wheel does not move transcript');
        const moreY = screen().findIndex((line, index) => index > y && index < y + 21 && /more ↓/.test(line));
        assert.ok(moreY > y);
        const beforeClick = pane.offset;
        await clickAt(screen()[moreY].indexOf('more ↓') + 2, moreY);
        assert.ok(pane.offset > beforeClick, `terminal SGR more click advances settled codemode: width=${width}, inspected=${inspected}, atEnd=${atEnd}, before=${beforeClick}, after=${pane.offset}, footer=${moreY}, header=${y}, row=${screen()[moreY]}`);
        assert.equal(scroll.scrollTop, top, 'more click does not move transcript');
        let iterations = 0;
        while (screen().some(line => /more ↓/.test(line)) && iterations++ < 400) {
          const footerY = screen().findIndex((line, index) => index > y && index < y + 21 && /more ↓/.test(line));
          if (footerY < 0) break;
          wheelAt(headerX + 2, footerY, true);
          assert.equal(scroll.scrollTop, top, 'footer wheel does not move transcript');
        }
        const footerY = screen().findIndex((line, index) => index > y && index < y + 21 && /more ↑/.test(line));
        assert.ok(footerY >= 0, 'repeated native wheel reaches the final footer');
        assert.ok(screen().some(line => line.includes('FINAL_OUTPUT_SENTINEL')), 'full escaped JSON output is reachable');
        const endOffset = pane.offset;
        wheelAt(headerX + 2, footerY, false);
        assert.ok(pane.offset < endOffset, 'upward wheel reveals earlier output');
        assert.equal(renderer.getFocusedComponent(), ui.defaultEditor);
      }
    }
  }
  const promptJump = renderer.getMountedRoots()[0]?.[Symbol.for('notrico/sticky-prompt-strip/owner')];
  if (process.env.PI_PROMPT_JUMP_PATH) {
    assert.ok(promptJump?.mounted, 'Prompt Jump candidate is mounted');
    const beforeSnapshot = pane.offset;
    const anchors = promptJump.prompts();
    assert.equal(pane.offset, beforeSnapshot, 'collecting prompt-list anchors preserves the code viewport');
    const index = anchors.findIndex(anchor => anchor.text.startsWith('独立代码输出滚动测试'));
    assert.ok(index >= 0, 'prompt list includes the standalone fixture');
    assert.equal(promptJump.jumpTo(index), true); renderer.renderNow();
    assert.ok(screen().some(line => line.includes('独立代码输出滚动测试')), 'prompt navigation reveals its native prompt');
  }
  const fold = async action => { await runner.getCommand('fold').handler(action, runner.createContext()); renderer.renderNow(); };
  const projected = () => ui.chatContainer[Symbol.for('compact-renderer:projected-children:v1')];
  await fold('off');
  assert.equal(row.callRendererComponent.owner, undefined, 'Fold off restores the native tool renderer');
  await fold('on');
  assert.equal(row.callRendererComponent.owner.code, pane, 'Fold on restores the same codemode owner');
  await fold('collapse');
  assert.ok(!projected().some(view => view.children?.[0] === row), 'collapse hides the completed work row');
  await fold('expand');
  assert.ok(projected().some(view => view.children?.[0] === row), 'expand restores the work row');
  pane.open = true; pane.offset = 0; renderer.renderNow();
  const reopenedY = positionPane(true), reopenedOffset = pane.offset;
  wheelAt(8, reopenedY + 2, true);
  assert.ok(pane.offset > reopenedOffset, 'wheel still advances after Fold mode and disclosure changes');
  const reopenedMoreY = screen().findIndex((line, index) => index > reopenedY && index < reopenedY + 21 && /more ↓/.test(line));
  assert.ok(reopenedMoreY > reopenedY);
  const beforeReopenedClick = pane.offset;
  await clickAt(screen()[reopenedMoreY].indexOf('more ↓') + 2, reopenedMoreY);
  assert.ok(pane.offset > beforeReopenedClick, 'more click still advances after Fold mode and disclosure changes');
  console.log('Standalone codemode: native SGR click/wheel, escaped JSON/Chinese, widths, inspection and scroll boundaries passed');
} finally { ui?.stop(); await preview.cleanup(); }
