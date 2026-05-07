#!/usr/bin/env bun
import { runCli } from "./app";

const exitCode = await runCli(Bun.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  cwd: process.cwd(),
});

process.exit(exitCode);
