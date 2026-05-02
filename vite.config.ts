import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so phones/tablets on the same LAN can open
    // http://<this-machine-ip>:5173 (default Vite port).
    host: true,
  },
})
