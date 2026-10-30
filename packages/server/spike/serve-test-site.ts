// テスト用サイト（test/helpers/site-server.ts）を手動確認のために起動する。使い方: tsx spike/serve-test-site.ts
import { startSiteServer } from '../test/helpers/site-server.js';

const site = await startSiteServer();
console.log(site.origin);
