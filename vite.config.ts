import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // three.js (≈ 570 kB) sta in un blocco separato caricato solo per 3D e assonometrie:
    // l'avviso standard di 500 kB riguarderebbe solo quel blocco
    chunkSizeWarningLimit: 650,
  },
});
