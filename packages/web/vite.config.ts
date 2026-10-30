import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発中は Vite（5173）で画面を配信し、/api はサーバー（4310）へ転送する。
// サーバーは Host ヘッダーが 127.0.0.1:4310 の要求しか受け付けないので changeOrigin で書き換える
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true },
    },
  },
});
