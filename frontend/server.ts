import { serve, buildScript, buildStyle } from "@ments/web";
import { readFile } from "fs/promises";
import { join } from "path";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3005";

// Build assets on startup
let appScriptPath: string;
let stylePath: string;

async function init() {
  console.log("Initializing frontend build...");
  appScriptPath = await buildScript("./App.client.tsx", true);
  stylePath = await buildStyle("./App.css");
}

const html = (script: string, title: string = "fairfun.xyz") => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="Provably fair treasury distributions for token communities">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.2.0",
      "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
      "react/jsx-runtime": "https://esm.sh/react@18.2.0/jsx-runtime",
      "react/jsx-dev-runtime": "https://esm.sh/react@18.2.0/jsx-dev-runtime",
      "@solana/web3.js": "https://esm.sh/@solana/web3.js@1.87.6",
      "@solana/spl-token": "https://esm.sh/@solana/spl-token@0.4.5",
      "bs58": "https://esm.sh/bs58@5.0.0",
      "tweetnacl": "https://esm.sh/tweetnacl@1.0.3",
      "buffer": "https://esm.sh/buffer@6.0.3"
    }
  }
  </script>
  <script type="module">
    import { Buffer } from 'buffer';
    window.Buffer = Buffer;
  </script>
  <link rel="stylesheet" href="${stylePath}">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${script}"></script>
</body>
</html>`;

async function handler(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  // Landing page, community, and token pages all use same SPA
  if (url.pathname === "/" || url.pathname === "/galaxy" || url.pathname === "/index.html"
    || url.pathname === "/tokens" || url.pathname.startsWith("/token/")) {
    const title = url.pathname === "/galaxy" ? "Galaxy Wheel | fairfun.xyz"
      : url.pathname === "/tokens" ? "Tokens | fairfun.xyz"
        : url.pathname.startsWith("/token/") ? "Token | fairfun.xyz"
          : "fairfun.xyz";
    return new Response(html(appScriptPath, title), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Serve static assets
  if (url.pathname.startsWith("/assets/")) {
    try {
      const filePath = join(import.meta.dir, "public", url.pathname);
      const file = await readFile(filePath);
      const ext = url.pathname.split('.').pop() || '';
      const mimeTypes: Record<string, string> = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
      };
      return new Response(file, {
        headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // Proxy API calls to backend
  if (url.pathname.startsWith("/api/")) {
    const backendUrl = BACKEND_URL + url.pathname + url.search;
    const resp = await fetch(backendUrl, {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" ? await req.text() : undefined,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  }

  return null;
}

await init();
serve(handler);

console.log(`fairfun.xyz running on port ${process.env.BUN_PORT}`);
console.log(`Backend: ${BACKEND_URL}`);
