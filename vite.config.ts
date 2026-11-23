import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';
import { buildSpaBootScript } from './app/utils/spaBootScript.ts';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const appDir = path.join(rootDir, 'app');
const sharedDir = path.join(rootDir, 'shared');
const require = createRequire(import.meta.url);
const pdfjsDirectory = path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjsAssetDirs = ['cmaps', 'standard_fonts', 'wasm'] as const;

function getAppVersion(): string {
  const envVersion =
    process.env.VITE_APP_VERSION || process.env.NUXT_PUBLIC_APP_VERSION;
  if (envVersion) {
    return envVersion;
  }

  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function collectUsedLucideIcons(dir: string): Set<string> {
  const icons = new Set<string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(vue|ts|js|mjs)$/.test(entry.name)) {
        const content = readFileSync(fullPath, 'utf8');
        for (const match of content.matchAll(/lucide:([a-z0-9-]+)/g)) {
          if (match[1]) icons.add(match[1]);
        }
      }
    }
  };
  walk(dir);
  return icons;
}

function delbIconsPlugin(): Plugin {
  const virtualId = 'virtual:delb-icons';
  const resolvedVirtualId = `\0${virtualId}`;

  return {
    name: 'delb-icons',
    resolveId(id) {
      if (id === virtualId) return resolvedVirtualId;
    },
    load(id) {
      if (id !== resolvedVirtualId) return;
      const lucideJsonPath = require.resolve('@iconify-json/lucide/icons.json');
      const raw = JSON.parse(readFileSync(lucideJsonPath, 'utf8')) as {
        prefix: string;
        width?: number;
        height?: number;
        icons: Record<string, unknown>;
        aliases?: Record<string, { parent: string; [key: string]: unknown }>;
      };

      const used = collectUsedLucideIcons(appDir);
      const selectedIcons: Record<string, unknown> = {};
      const selectedAliases: Record<string, { parent: string }> = {};

      for (const name of used) {
        if (raw.icons[name]) {
          selectedIcons[name] = raw.icons[name];
        } else if (raw.aliases?.[name]) {
          const alias = raw.aliases[name];
          selectedAliases[name] = alias;
          let parent = alias.parent;
          while (parent && !raw.icons[parent] && raw.aliases?.[parent]) {
            selectedAliases[parent] = raw.aliases[parent];
            parent = raw.aliases[parent].parent;
          }
          if (parent && raw.icons[parent]) {
            selectedIcons[parent] = raw.icons[parent];
          }
        }
      }

      const subset = {
        prefix: raw.prefix,
        width: raw.width ?? 24,
        height: raw.height ?? 24,
        icons: selectedIcons,
        ...(Object.keys(selectedAliases).length
          ? { aliases: selectedAliases }
          : {}),
      };

      return `export const lucideCollection = ${JSON.stringify(subset)};`;
    },
  };
}

function delbSpaBootAndPdfjsPlugin(): Plugin {
  const mimeTypes: Record<string, string> = {
    '.bcmap': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.json': 'application/json',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };

  let outDir = path.join(rootDir, 'dist');

  return {
    name: 'delb-spa-boot-and-pdfjs',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: buildSpaBootScript(),
          injectTo: 'head-prepend',
        },
      ];
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = (req.url || '').split('?')[0] || '';
        for (const dirName of pdfjsAssetDirs) {
          const prefix = `/pdfjs/${dirName}/`;
          if (!rawUrl.startsWith(prefix)) continue;
          const relPath = decodeURIComponent(rawUrl.slice(prefix.length));
          const baseDir = path.join(pdfjsDirectory, dirName);
          const candidate = path.resolve(baseDir, relPath);
          if (
            !candidate.startsWith(baseDir + path.sep) ||
            !existsSync(candidate) ||
            !statSync(candidate).isFile()
          ) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          const ext = path.extname(candidate).toLowerCase();
          res.setHeader(
            'Content-Type',
            mimeTypes[ext] || 'application/octet-stream',
          );
          res.end(readFileSync(candidate));
          return;
        }
        next();
      });
    },
    closeBundle() {
      // Preserve dist/.gitkeep so git stays clean and //go:embed all:dist always works.
      writeFileSync(path.join(outDir, '.gitkeep'), '');
      for (const dirName of pdfjsAssetDirs) {
        const src = path.join(pdfjsDirectory, dirName);
        if (!existsSync(src)) continue;
        const dest = path.join(outDir, 'pdfjs', dirName);
        cpSync(src, dest, { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    delbIconsPlugin(),
    delbSpaBootAndPdfjsPlugin(),
  ],
  define: {
    __DELB_APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  resolve: {
    alias: {
      '~': appDir,
      '@': appDir,
      '~~': rootDir,
      '@@': rootDir,
      '#shared': sharedDir,
    },
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
