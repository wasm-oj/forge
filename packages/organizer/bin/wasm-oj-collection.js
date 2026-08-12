#!/usr/bin/env node

import { runCollectionCli } from "../dist/index.js";

await runCollectionCli(process.argv.slice(2));
