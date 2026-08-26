import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// INV-1: すべてのアセットはセルフホスト。外部 URL を参照する設定を書かない。
export default defineConfig({
  plugins: [react()],
  // @ffmpeg/ffmpeg は内部で Worker を生成するため事前バンドルから除外する
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'], include: ['tesseract.js', 'jszip'] },
  base: './',
  worker: { format: 'es' },
  // devcontainer の 9p マウントでは inotify が効かないためポーリング監視にする
  server: { watch: { usePolling: true, interval: 500 } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
