import { Effect } from "effect";

export class WtypeError extends Error {
  readonly stderr: string | undefined;

  constructor(message: string, options?: { readonly cause?: unknown; readonly stderr?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WtypeError";
    this.stderr = options?.stderr;
  }
}

const readStreamText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) {
    return "";
  }

  return await new Response(stream).text();
};

export const buildWtypeCommandArgs = (wtypeExecutable: string, text: string): Array<string> => [
  wtypeExecutable,
  "--",
  text,
];

const findWtypeExecutable = Effect.sync(() => {
  const executable = Bun.which("wtype");
  if (executable === null) {
    throw new WtypeError("wtype is required but was not found in PATH");
  }

  return executable;
});

const validateInputText = (text: string): Effect.Effect<void, WtypeError> =>
  text.trim().length > 0 ? Effect.void : Effect.fail(new WtypeError("--text must not be empty"));

export const typeTextWithWtype = (text: string): Effect.Effect<void, WtypeError> =>
  Effect.gen(function* () {
    yield* validateInputText(text);
    const wtypeExecutable = yield* findWtypeExecutable;

    const commandArgs = buildWtypeCommandArgs(wtypeExecutable, text);

    yield* Effect.tryPromise({
      try: async () => {
        const process = Bun.spawn(commandArgs, {
          stdout: "pipe",
          stderr: "pipe",
        });

        const [exitCode, stderr] = await Promise.all([
          process.exited,
          readStreamText(process.stderr),
        ]);

        if (exitCode !== 0) {
          const details = stderr.trim();
          throw new WtypeError(
            details.length > 0
              ? `wtype failed with exit code ${exitCode}: ${details}`
              : `wtype failed with exit code ${exitCode}`,
            {
              stderr,
            },
          );
        }
      },
      catch: (cause) =>
        cause instanceof WtypeError ? cause : new WtypeError("Failed to execute wtype", { cause }),
    });
  });
