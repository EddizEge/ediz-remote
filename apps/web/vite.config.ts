import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    strictPort: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8788',
        ws: true,
      },
      '/interrupt-ws': {
        target: 'ws://127.0.0.1:8790',
        ws: true,
      },
      '/health': {
        target: 'http://127.0.0.1:8788',
      },
    },
  },
})
