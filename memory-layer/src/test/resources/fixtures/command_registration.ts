import { Command } from "commander";
import { registerExplainCommand } from "./commands/command_module.js";

const program = new Command();
program.name("test-cli").version("0.1.0");

registerExplainCommand(program);

program.parse();
