import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildId = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    {
      name: "app-build-meta",
      transformIndexHtml(html) {
        return html.replace("</head>", `    <meta name="app-build-id" content="${buildId}" />\n  </head>`);
      }
    }
  ],
  define: {
    __APP_BUILD_ID__: JSON.stringify(buildId)
  },
  server: {
    port: 5173
  }
});
