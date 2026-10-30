// テスト用サイト（test/helpers/site-server.ts）を手動確認のために起動する。使い方: [PORT=4320] tsx spike/serve-test-site.ts
import { startSiteServer } from '../test/helpers/site-server.js';

const site = await startSiteServer(Number(process.env.PORT ?? 0));
console.log(site.origin);
