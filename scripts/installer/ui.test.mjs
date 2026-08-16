import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { setInstallerLanguage } from './i18n.mjs';
import { ConsoleUi } from './ui.mjs';

function runLanguageSelection(answer) {
  const input = Readable.from([`${answer}\n`]);
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const ui = new ConsoleUi({ input, output });
  return ui.language().then((language) => {
    ui.close();
    return { language, output: chunks.join('') };
  });
}

test('offers one bilingual language menu and selects English', async () => {
  setInstallerLanguage('zh-CN');
  const result = await runLanguageSelection('2');
  assert.equal(result.language, 'en');
  assert.match(result.output, /中文/);
  assert.match(result.output, /English/);
});

test('language menu defaults to Chinese when the user presses Enter', async () => {
  setInstallerLanguage('en');
  const result = await runLanguageSelection('');
  assert.equal(result.language, 'zh-CN');
});
