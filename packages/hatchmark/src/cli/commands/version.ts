import { VERSION } from "../../version.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";

export const versionHelp: CommandHelp = {
  name: "version",
  summary: "Print the Hatchmark and Node.js versions.",
  usage: "hatchmark version",
  options: [],
  example: {
    command: "hatchmark version --json",
    description: 'Prints {"format_version":"1","version":"...","node":"..."}.',
  },
};

export function version(_ctx: CommandContext): CommandResult {
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", version: VERSION, node: process.versions.node },
    human: `hatchmark ${VERSION} (Node.js ${process.versions.node})`,
  };
}
