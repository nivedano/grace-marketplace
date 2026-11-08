#!/usr/bin/env bun

import { defineCommand, type CommandDef, runMain } from "citty";

import { fileCommand } from "./grace-file";
import { lintCommand } from "./grace-lint";
import { moduleCommand } from "./grace-module";
import { statusCommand } from "./grace-status";
import { verificationCommand } from "./grace-verification";
import { archiveCommand } from "./grace4/archive";

const main = defineCommand({
  meta: {
    name: "grace",
    version: "4.2.1",
    description: "GRACE 4 CLI for .grace linting, status snapshots, module health, verification queries, semantic markup, change archiving, and artifact navigation.",
  },
  subCommands: {
    archive: archiveCommand,
    file: fileCommand,
    lint: lintCommand,
    module: moduleCommand,
    status: statusCommand,
    verification: verificationCommand,
  },
});

if (import.meta.main) {
  await runMain(main as CommandDef);
}
