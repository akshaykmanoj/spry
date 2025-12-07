#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// Use `deno run -A --watch` in the shebang if you're contributing / developing Spry itself.

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import * as axiomCLI from "../lib/axiom/text-ui/cli.ts";
import * as runbookCLI from "../lib/axiom/text-ui/runbook.ts";
import * as sqlpageCLI from "../lib/playbook/sqlpage/cli.ts";
import { computeSemVerSync } from "../lib/universal/version.ts";

const axCLI = new axiomCLI.CLI();
const rbCLI = new runbookCLI.CLI();
const spCLI = new sqlpageCLI.CLI({});

const axiomCmd = axCLI.rootCmd("axiom");
const runbookCmd = rbCLI.rootCmd("rb");
const sqlPageCmd = spCLI.rootCmd("sp");

const spryCLI = new Command()
  .name("Spry Axiom")
  .version(() => computeSemVerSync(import.meta.url))
  .description("Spry CLI")
  .command("help", new HelpCommand())
  .command("completions", new CompletionsCommand())
  .command(axiomCmd.getName(), axiomCmd)
  .command(runbookCmd.getName(), runbookCmd)
  .command(sqlPageCmd.getName(), sqlPageCmd);

await spryCLI.parse(Deno.args);
