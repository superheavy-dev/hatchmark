#!/usr/bin/env node
import { determineAgent } from "@vercel/detect-agent";
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  stdoutIsTTY: process.stdout.isTTY === true,
  isAgent: async () => (await determineAgent()).isAgent,
});
