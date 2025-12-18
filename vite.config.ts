import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// --- IMPORTANT NOTE ---
// Setting base: "./" makes all asset URLs (CSS, JS) relative to index.html
// This fixes 404s when the app is hosted in a subfolder

export default defineConfig({
  plugins: [react()],
  base: "./", 
});
