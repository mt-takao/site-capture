import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileBaseForUrl, shotFileName } from '../src/capture/naming.js';

test('パスを _ でつなぎ、トップページは index にする', () => {
  assert.equal(fileBaseForUrl('https://example.com/'), 'index');
  assert.equal(fileBaseForUrl('https://example.com'), 'index');
  assert.equal(fileBaseForUrl('https://example.com/about/company/'), 'about_company');
  assert.equal(shotFileName('https://example.com/about/company', 375), 'about_company__375.png');
});

test('拡張子と、ファイル名に使えない文字を取り除く', () => {
  assert.equal(fileBaseForUrl('https://example.com/news/index.html'), 'news_index');
  assert.equal(fileBaseForUrl('https://example.com/a:b/c%20d'), 'a-b_c-d');
  assert.equal(fileBaseForUrl('https://example.com/%E4%BC%9A%E7%A4%BE'), '会社');
});

test('パス内の _ は区切りと区別できるよう - にする', () => {
  assert.equal(fileBaseForUrl('https://example.com/my_page'), 'my-page');
});

test('クエリ付きのURLはハッシュを付けて区別する', () => {
  const a = fileBaseForUrl('https://example.com/list?page=1');
  const b = fileBaseForUrl('https://example.com/list?page=2');
  assert.match(a, /^list_q[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('長すぎるパスは切り詰めてハッシュを付ける', () => {
  const base = fileBaseForUrl(`https://example.com/${'a'.repeat(300)}`);
  assert.ok(base.length <= 130);
});
