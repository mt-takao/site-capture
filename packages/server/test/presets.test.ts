import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSiteSettings, hostMatches } from '../src/presets/index.js';

test('*.example.com はサブドメインにだけ当てはまる', () => {
  assert.ok(hostMatches('sourcegraph.notion.site', '*.notion.site'));
  assert.ok(!hostMatches('notion.site', '*.notion.site'));
  assert.ok(!hostMatches('evilnotion.site', '*.notion.site'));
  assert.ok(hostMatches('Example.com', 'example.com'));
});

test('Notion の公開ページには Notion 用プリセットが選ばれる', () => {
  const s = findSiteSettings('https://sourcegraph.notion.site/Being-handbook-first-a7a4');
  assert.equal(s.name, 'Notion（公開ページ）');
  assert.equal(s.reloadPerViewport, false);
  assert.equal(s.intervalMs, 30000);
  assert.ok(s.hideByText.includes('Get Notion free'));
  assert.ok(s.expandTogglesScript);
});

test('それ以外のサイトには標準の設定が選ばれる', () => {
  const s = findSiteSettings('https://example.com/');
  assert.equal(s.name, '標準');
  assert.equal(s.reloadPerViewport, true);
});
