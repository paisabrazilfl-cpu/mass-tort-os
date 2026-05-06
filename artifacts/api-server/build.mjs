import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

// Lazy-loaded heavy deps stay external (they're imported only at call sites
// inside try/catch blocks, so the runtime can recover if missing). Native
// modules and rarely-used integrations also stay external. Pure-JS hot-path
// deps (zod, drizzle-orm, express stack, pg, jsonwebtoken, pino-http) are
// now BUNDLED so production deploys don't depend on node_modules being
// installed at runtime — fixes ERR_MODULE_NOT_FOUND in Replit Autoscale where
// only the bundled dist directory ships.
const runtimeExternal = [
  // Lazy-loaded — keep external so the bundle stays small AND the import is
  // wrapped in try/catch at the call site (graceful degradation if absent).
  "pdf-lib",                 // ~650 KB + @pdf-lib/* + pako; used only by PDF redaction.
  "@pdf-lib/*",
  "@anthropic-ai/sdk",       // ~346 KB; lazy-loaded inside threat-analyzer.ts.
  "@anthropic-ai/sdk/*",
];

const external = [
  ...runtimeExternal,
  "*.node",
  "sharp",
  "better-sqlite3",
  "sqlite3",
  "canvas",
  "bcrypt",
  "argon2",
  "fsevents",
  "re2",
  "farmhash",
  "xxhash-addon",
  "bufferutil",
  "utf-8-validate",
  "ssh2",
  "cpu-features",
  "dtrace-provider",
  "isolated-vm",
  "lightningcss",
  "pg-native",
  "oracledb",
  "mongodb-client-encryption",
  "nodemailer",
  "handlebars",
  "knex",
  "typeorm",
  "protobufjs",
  "onnxruntime-node",
  "@tensorflow/*",
  "@prisma/client",
  "@mikro-orm/*",
  "@grpc/*",
  "@swc/*",
  "@aws-sdk/*",
  "@azure/*",
  "@opentelemetry/*",
  "@google-cloud/*",
  "@google/*",
  "googleapis",
  "firebase-admin",
  "@parcel/watcher",
  "@sentry/profiling-node",
  "@tree-sitter/*",
  "aws-sdk",
  "classic-level",
  "dd-trace",
  "ffi-napi",
  "grpc",
  "hiredis",
  "kerberos",
  "leveldown",
  "miniflare",
  "mysql2",
  "newrelic",
  "odbc",
  "piscina",
  "realm",
  "ref-napi",
  "rocksdb",
  "sass-embedded",
  "sequelize",
  "serialport",
  "snappy",
  "tinypool",
  "usb",
  "workerd",
  "wrangler",
  "zeromq",
  "zeromq-prebuilt",
  "playwright",
  "puppeteer",
  "puppeteer-core",
  "electron",
];

const banner = {
  js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
  `,
};

function makeSharedOptions(outdir) {
  return {
    platform: "node",
    bundle: true,
    format: "esm",
    outdir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external,
    sourcemap: "linked",
    banner,
    plugins: [
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
  };
}

async function buildEntry(entryFile, subdir) {
  const outdir = path.resolve(artifactDir, "dist", subdir);
  await rm(outdir, { recursive: true, force: true });
  await esbuild({
    ...makeSharedOptions(outdir),
    entryPoints: [path.resolve(artifactDir, entryFile)],
  });
}

const target = process.argv[2] ?? "all";

async function run() {
  if (target === "server") {
    await buildEntry("src/index.ts", "server");
  } else if (target === "worker") {
    await buildEntry("src/worker.ts", "worker");
  } else if (target === "all") {
    await Promise.all([
      buildEntry("src/index.ts", "server"),
      buildEntry("src/worker.ts", "worker"),
    ]);
  } else {
    throw new Error(`Unknown build target '${target}' (expected: server | worker | all)`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
