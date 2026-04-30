import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

// Heavy runtime deps that are resolved from node_modules at runtime instead
// of bundled. Each one is a direct or catalog dep of @workspace/api-server,
// so Node's resolver finds them via artifacts/api-server/node_modules. Keeps
// the bundle small without changing behavior. See replit.md "API Server
// Bundle Size Budget" before adding more.
const runtimeExternal = [
  // Heavy app deps — lazy-imported at call sites in addition to being external.
  "pdf-lib",                 // ~650 KB + transitive @pdf-lib/* and pako (~966 KB total). Used only by PDF redaction & doc generation.
  "@pdf-lib/*",              // pdf-lib's font + image submodules pulled in transitively.
  "@anthropic-ai/sdk",       // ~346 KB; lazy-loaded inside threat-analyzer.ts.
  "@anthropic-ai/sdk/*",
  // Hot-path runtime deps — kept resolved-at-runtime so the bundle is small.
  // All listed in package.json dependencies, so node_modules has them.
  "zod",                     // ~547 KB (v3 + v4 namespaces).
  "zod/*",
  "drizzle-orm",             // ~221 KB; api-server, @workspace/db, @workspace/api-zod all use the same catalog version.
  "drizzle-orm/*",
  // Express HTTP stack — transitively pulls in body-parser, raw-body,
  // iconv-lite (~530 KB), mime-types, mime-db (~228 KB), qs, send, etc.
  "express",
  "express-rate-limit",
  "helmet",
  "cors",
  "jsonwebtoken",
  "pino-http",
  // Postgres driver tree (~130 KB)
  "pg",
  "pg-*",
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
