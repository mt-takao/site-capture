// テスト用サイト（test/helpers/site-server.ts）を手動確認のために起動する。
// 使い方: [PORT=4320] [VARIANT=b] tsx spike/serve-test-site.ts   （VARIANT=b はリニューアル後の版）
import { startSiteServer } from '../test/helpers/site-server.js';

const site = await startSiteServer(Number(process.env.PORT ?? 0), process.env.VARIANT === 'b' ? 'b' : 'a');
console.log(site.origin);
