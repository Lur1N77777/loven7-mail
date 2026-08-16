import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInstallerLanguage,
  isEnglish,
  joinList,
  msg,
  normalizeInstallerLanguage,
  readInstallerLanguageOption,
  setInstallerLanguage,
} from './i18n.mjs';

test('normalizes supported installer language aliases', () => {
  assert.equal(normalizeInstallerLanguage('zh'), 'zh-CN');
  assert.equal(normalizeInstallerLanguage('中文'), 'zh-CN');
  assert.equal(normalizeInstallerLanguage('en-US'), 'en');
  assert.equal(normalizeInstallerLanguage('English'), 'en');
  assert.throws(() => normalizeInstallerLanguage('fr'), /不支持的安装器语言.*Unsupported installer language/);
});

test('reads split and inline command-line language options', () => {
  assert.equal(readInstallerLanguageOption(['--new-worker', '--lang', 'en']), 'en');
  assert.equal(readInstallerLanguageOption(['--lang=zh-CN', '--plan']), 'zh-CN');
  assert.equal(readInstallerLanguageOption(['--plan']), '');
});

test('selects one language for messages and list formatting', () => {
  const previous = getInstallerLanguage();
  try {
    setInstallerLanguage('en');
    assert.equal(isEnglish(), true);
    assert.equal(msg('中文', 'English'), 'English');
    assert.equal(joinList(['one', 'two']), 'one, two');

    setInstallerLanguage('zh-CN');
    assert.equal(isEnglish(), false);
    assert.equal(msg('中文', 'English'), '中文');
    assert.equal(joinList(['一', '二']), '一、二');
  } finally {
    setInstallerLanguage(previous);
  }
});
