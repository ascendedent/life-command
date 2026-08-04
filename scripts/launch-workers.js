// pm2-safe worker launcher: registers tsx's ESM loader from CJS, then
// imports the TypeScript worker entrypoint.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
process.chdir(root);

const { register } = require("tsx/esm/api");
register();

import(pathToFileURL(path.join(root, "apps/worker/src/index.ts")).href).catch(
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
