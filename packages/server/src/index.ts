// アプリの起動（設計書 1.1）。API と画面を http://127.0.0.1:4310 で配信し、既定のブラウザで開く
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildServer } from './api/server.js';
import { Store } from './db/store.js';
import { JobManager } from './jobs/job-manager.js';
import { dataRoot, databasePath } from './paths.js';

const port = Number(process.env.PORT ?? 4310);
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

mkdirSync(dataRoot(), { recursive: true });
const store = new Store(databasePath());
const interrupted = store.markInterruptedCrawls();
const jobs = new JobManager(store, () => chromium.launch());
const app = await buildServer({ store, jobs, port, webDistDir });

await app.listen({ host: '127.0.0.1', port });
const url = `http://127.0.0.1:${port}`;
console.log(`Site Capture を起動しました: ${url}`);
console.log(`保存先: ${dataRoot()}`);
if (interrupted > 0) console.log(`前回の起動中に止まった撮影 ${interrupted}件を「停止」にしました`);
console.log('終了するには Ctrl + C を押してください');
if (process.env.NO_OPEN !== '1') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

let closing = false;
process.on('SIGINT', async () => {
  if (closing) process.exit(130);
  closing = true;
  console.log('\n終了しています…（撮影中のページを撮り終えるまで待ちます。もう一度押すとすぐ終了）');
  await jobs.shutdown();
  await app.close();
  store.close();
  process.exit(0);
});
