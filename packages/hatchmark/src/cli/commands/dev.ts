import { startDevServer } from "../../dev/server.js";
import { renderHuman } from "../../diagnostics/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT, type PrintedResult } from "../io.js";
import { usageError } from "../usage.js";

export const devHelp: CommandHelp = {
  name: "dev",
  summary:
    "Serve every dashboard locally and update it on every save: changed cards swap in place, errors show over the page.",
  usage: "hatchmark dev [--port <n>] [--host <host>] [--open]",
  options: [
    {
      flag: "--port <n>",
      description:
        "Listen on this port, or fail when it is taken. Default: 5173, or the next free port.",
    },
    {
      flag: "--host <host>",
      description:
        "Listen on this address. Default: localhost only; 0.0.0.0 serves the local network.",
    },
    { flag: "--open", description: "Open the dashboard in the default browser once it is ready." },
  ],
  example: {
    command: "hatchmark dev --json",
    description:
      'Prints {"format_version":"1","ok":true,"url":"http://localhost:5173/sales/",...} once the server is ready and nothing more on stdout; runs until stopped with Ctrl-C.',
  },
};

export interface DevDeps {
  start: typeof startDevServer;
  stopped(): Promise<void>;
}

const defaultDeps: DevDeps = {
  start: startDevServer,
  stopped: () =>
    new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
};

export async function dev(
  ctx: CommandContext,
  flags: { port?: string; host?: string; open: boolean },
  deps: DevDeps = defaultDeps,
): Promise<CommandResult | PrintedResult> {
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    return usageError(
      "HM0002",
      `--port must be a whole number from 0 to 65535, not "${flags.port}"`,
    );
  }
  let started: Awaited<ReturnType<typeof startDevServer>>;
  try {
    started = await deps.start({
      root: ctx.root,
      ...(port === undefined ? {} : { port }),
      ...(flags.host === undefined ? {} : { host: flags.host }),
      open: flags.open,
      color: ctx.color,
      log: (text) => ctx.io.stderr(text),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE" && code !== "EADDRNOTAVAIL" && code !== "EACCES") throw error;
    const where = `${flags.host ?? "localhost"}:${port ?? 5173}`;
    const result = usageError(
      "HM0006",
      `cannot listen on ${where}: ${code === "EADDRINUSE" ? "the port is in use" : (error as Error).message}`,
      { help: "pass another --port, or stop the process that uses it" },
    );
    return { ...result, exitCode: EXIT.environment };
  }
  if ("report" in started) {
    return {
      exitCode: EXIT.usage,
      json: started.report,
      human: renderHuman(started.report, { color: ctx.color }),
    };
  }
  const { server } = started;
  if (ctx.mode === "json") {
    ctx.io.stdout(
      `${JSON.stringify({ format_version: "1", ok: true, url: server.url, urls: server.urls })}\n`,
    );
  } else if (!ctx.quiet) {
    ctx.io.stdout(
      `Hatchmark dev server running at ${server.url}\n${server.urls
        .slice(1)
        .map((u) => `  also ${u}\n`)
        .join("")}Watching the project for changes. Press Ctrl-C to stop.\n`,
    );
  }
  await deps.stopped();
  await server.close();
  return { exitCode: EXIT.ok, printed: true };
}
