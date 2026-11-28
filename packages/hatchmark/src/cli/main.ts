import path from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { VERSION } from "../version.js";
import { build, buildHelp } from "./commands/build.js";
import { check, checkHelp } from "./commands/check.js";
import { data, dataHelp } from "./commands/data.js";
import { dev, devHelp } from "./commands/dev.js";
import { doctor, doctorHelp } from "./commands/doctor.js";
import { explain, explainHelp } from "./commands/explain.js";
import { init, initHelp } from "./commands/init.js";
import { schema, schemaHelp } from "./commands/schema.js";
import { version, versionHelp } from "./commands/version.js";
import { type CommandHelp, GLOBAL_OPTIONS, renderCommandHelp, renderTopHelp } from "./help.js";
import {
  type CliIO,
  type CommandContext,
  type CommandResult,
  EXIT,
  type OutputMode,
  type PrintedResult,
} from "./io.js";
import { usageError } from "./usage.js";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Flags = Record<string, string | boolean | undefined>;

interface Command {
  help: CommandHelp;
  options: Options;
  run(
    ctx: CommandContext,
    positionals: string[],
    flags: Flags,
  ): CommandResult | PrintedResult | Promise<CommandResult | PrintedResult>;
}

const GLOBAL: Options = {
  json: { type: "boolean" },
  format: { type: "string" },
  cwd: { type: "string" },
  quiet: { type: "boolean" },
  "no-color": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS: Record<string, Command> = {
  init: {
    help: initHelp,
    options: { template: { type: "string" }, name: { type: "string" }, force: { type: "boolean" } },
    run: (ctx, positionals, flags) =>
      init(ctx, positionals, {
        ...(typeof flags.template === "string" ? { template: flags.template } : {}),
        ...(typeof flags.name === "string" ? { name: flags.name } : {}),
        force: flags.force === true,
      }),
  },
  check: {
    help: checkHelp,
    options: {
      strict: { type: "boolean" },
      sql: { type: "boolean" },
      "explain-defaults": { type: "boolean" },
    },
    run: (ctx, positionals, flags) =>
      check(ctx, positionals, {
        strict: flags.strict === true,
        sql: flags.sql === true,
        explainDefaults: flags["explain-defaults"] === true,
      }),
  },
  data: {
    help: dataHelp,
    options: { limit: { type: "string" } },
    run: (ctx, positionals, flags) =>
      data(ctx, positionals, typeof flags.limit === "string" ? { limit: flags.limit } : {}),
  },
  build: {
    help: buildHelp,
    options: { out: { type: "string" }, "no-cache": { type: "boolean" } },
    run: (ctx, positionals, flags) =>
      positionals.length > 0
        ? usageError("HM0002", `unexpected argument "${positionals[0]}"`, {
            help: "run hatchmark build --help",
          })
        : build(ctx, {
            ...(typeof flags.out === "string" ? { out: flags.out } : {}),
            cache: flags["no-cache"] !== true,
          }),
  },
  dev: {
    help: devHelp,
    options: { port: { type: "string" }, host: { type: "string" }, open: { type: "boolean" } },
    run: (ctx, positionals, flags) =>
      positionals.length > 0
        ? usageError("HM0002", `unexpected argument "${positionals[0]}"`, {
            help: "run hatchmark dev --help",
          })
        : dev(ctx, {
            ...(typeof flags.port === "string" ? { port: flags.port } : {}),
            ...(typeof flags.host === "string" ? { host: flags.host } : {}),
            open: flags.open === true,
          }),
  },
  schema: { help: schemaHelp, options: {}, run: (ctx, positionals) => schema(ctx, positionals) },
  explain: {
    help: explainHelp,
    options: { dashboard: { type: "string" }, block: { type: "string" } },
    run: (ctx, positionals, flags) =>
      explain(ctx, positionals, {
        ...(typeof flags.dashboard === "string" ? { dashboard: flags.dashboard } : {}),
        ...(typeof flags.block === "string" ? { block: flags.block } : {}),
      }),
  },
  version: { help: versionHelp, options: {}, run: (ctx) => version(ctx) },
  doctor: { help: doctorHelp, options: {}, run: (ctx) => doctor(ctx) },
};

const COMMAND_NAMES = Object.keys(COMMANDS);

function lookup(name: string | undefined): Command | undefined {
  return name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}

function helpJson(help: CommandHelp) {
  return {
    format_version: "1",
    command: help.name,
    summary: help.summary,
    usage: help.usage,
    options: help.options,
    global_options: GLOBAL_OPTIONS,
    example: help.example,
  };
}

function helpResult(help: CommandHelp | undefined): CommandResult {
  const commands = COMMAND_NAMES.map((n) => COMMANDS[n]?.help as CommandHelp);
  return {
    exitCode: EXIT.ok,
    json:
      help === undefined
        ? {
            format_version: "1",
            version: VERSION,
            commands: commands.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage })),
            global_options: GLOBAL_OPTIONS,
            exit_codes: { ok: 0, check: 1, usage: 2, environment: 3, internal: 4 },
          }
        : helpJson(help),
    human: help === undefined ? renderTopHelp(commands, VERSION) : renderCommandHelp(help),
  };
}

async function outputMode(io: CliIO, flags: Flags): Promise<OutputMode | CommandResult> {
  if (flags.format !== undefined && flags.format !== true) {
    if (flags.format === "json" || flags.format === "human") return flags.format;
    return usageError("HM0002", `unknown --format "${String(flags.format)}"`, {
      expected: ["human", "json"],
      input: String(flags.format),
    });
  }
  if (flags.json === true) return "json";
  if (!io.stdoutIsTTY) return "json";
  return (await io.isAgent()) ? "json" : "human";
}

function print(io: CliIO, mode: OutputMode, result: CommandResult | PrintedResult): number {
  if ("printed" in result) return result.exitCode;
  if (mode === "json") io.stdout(`${JSON.stringify(result.json)}\n`);
  else if (result.human !== "") io.stdout(`${result.human}\n`);
  return result.exitCode;
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const everyOption: Options = Object.assign(
    {},
    GLOBAL,
    ...Object.values(COMMANDS).map((c) => c.options),
  );
  const loose = parseArgs({
    args: [...argv],
    options: everyOption,
    allowPositionals: true,
    strict: false,
  });
  const name = loose.positionals[0];
  const command = lookup(name);
  const looseMode = await outputMode(io, loose.values as Flags);
  const fallbackMode: OutputMode =
    typeof looseMode === "string"
      ? looseMode
      : ((await outputMode(io, { ...(loose.values as Flags), format: undefined })) as OutputMode);
  const options: Options = { ...GLOBAL, ...(command?.options ?? {}) };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const flag = /'(-{1,2}[^' ]+)/.exec(message)?.[1];
    const known = Object.keys(options).map((o) => `--${o}`);
    const unknown = /^Unknown option/.test(message) && flag !== undefined;
    const result = usageError(
      "HM0002",
      unknown ? `unknown option ${flag}` : (message.split(". ")[0] ?? message),
      {
        expected: known,
        ...(flag ? { input: flag } : {}),
        help: `run hatchmark ${name ?? ""} --help`.replace("  ", " "),
      },
    );
    return print(io, fallbackMode, result);
  }
  const flags = parsed.values as Flags;
  const positionals = parsed.positionals.slice(1);

  const mode = await outputMode(io, flags);
  if (typeof mode !== "string") return print(io, fallbackMode, mode);

  if (name === undefined || name === "help") {
    const topic = name === "help" ? positionals[0] : undefined;
    const target = lookup(topic);
    if (topic !== undefined && target === undefined) {
      return print(
        io,
        mode,
        usageError("HM0001", `unknown command "${topic}"`, {
          expected: COMMAND_NAMES,
          input: topic,
        }),
      );
    }
    return print(io, mode, helpResult(target?.help));
  }
  if (command === undefined) {
    return print(
      io,
      mode,
      usageError("HM0001", `unknown command "${name}"`, { expected: COMMAND_NAMES, input: name }),
    );
  }
  if (flags.help === true) return print(io, mode, helpResult(command.help));

  const ctx: CommandContext = {
    io,
    root: path.resolve(io.cwd, typeof flags.cwd === "string" ? flags.cwd : "."),
    mode,
    color:
      mode === "human" &&
      io.stdoutIsTTY &&
      flags["no-color"] !== true &&
      io.env.NO_COLOR === undefined,
    quiet: flags.quiet === true,
  };
  try {
    return print(io, mode, await command.run(ctx, positionals, flags));
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`hatchmark: internal error, please report it with this output\n${detail}\n`);
    if (mode === "json") {
      io.stdout(
        `${JSON.stringify({
          format_version: "1",
          ok: false,
          error_count: 1,
          warning_count: 0,
          diagnostics: [
            {
              code: "HM9001",
              severity: "error",
              message: `internal error: ${error instanceof Error ? error.message : String(error)}`,
              docs: "hatchmark explain HM9001",
            },
          ],
        })}\n`,
      );
    }
    return EXIT.internal;
  }
}
