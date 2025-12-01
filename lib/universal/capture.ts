import { gitignore } from "./gitignore.ts";
import { ensureTrailingNewline } from "./text-utils.ts";

export type CaptureSpec = {
  readonly nature: "relFsPath";
  readonly fsPath: string;
  readonly gitignore?: boolean | string;
} | {
  readonly nature: "memory";
  readonly key: string;
};

export type Captured = {
  text: () => string;
  json: () => unknown;
};

export async function typicalOnCapture(
  cs: CaptureSpec,
  cap: Captured,
  history: Record<string, Captured>,
) {
  if (cs.nature === "relFsPath") {
    await Deno.writeTextFile(cs.fsPath, ensureTrailingNewline(cap.text()));
  } else {
    history[cs.key] = cap;
  }
}

export async function gitignorableOnCapture(
  cs: CaptureSpec,
  cap: Captured,
  history: Record<string, Captured>,
) {
  if (cs.nature === "relFsPath") {
    await Deno.writeTextFile(cs.fsPath, ensureTrailingNewline(cap.text()));
    const { gitignore: ignore } = cs;
    if (ignore) {
      const gi = cs.fsPath.slice("./".length);
      if (typeof ignore === "string") {
        await gitignore(gi, ignore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    history[cs.key] = cap;
  }
}

export function captureFactory<Context, Operation>(
  opts: {
    readonly isCapturable: (
      ctx: Context,
      op: Operation,
    ) => false | CaptureSpec[];
    readonly prepareCaptured: (op: Operation, ctx: Context) => Captured;
    readonly onCapture?: (
      cs: CaptureSpec,
      cap: Captured,
      history: Record<string, Captured>,
    ) => void | Promise<void>;
  },
) {
  const history = {} as Record<string, Captured>;
  const {
    isCapturable,
    prepareCaptured,
    onCapture = typicalOnCapture,
  } = opts;

  const capture = async (ctx: Context, op: Operation) => {
    const specs = isCapturable(ctx, op);
    if (specs) {
      const cap = prepareCaptured(op, ctx);
      for (const cs of specs) {
        await onCapture(cs, cap, history);
      }
    }
  };

  return {
    isCapturable,
    onCapture,
    history,
    capture,
    prepareCaptured,
  };
}

export function captureFactorySync<Context>(
  opts: {
    readonly isCapturable: (ctx: Context) => false | CaptureSpec;
    readonly prepareCapture: (ctx: Context) => Captured;
    readonly onCapture?: (
      cs: CaptureSpec,
      cap: Captured,
      history: Record<string, Captured>,
    ) => void;
  },
) {
  const history = {} as Record<string, Captured>;
  const {
    isCapturable,
    prepareCapture: prepareCaptured,
    onCapture = typicalOnCapture,
  } = opts;

  const capture = (ctx: Context) => {
    const cs = isCapturable(ctx);
    if (cs) {
      const cap = prepareCaptured(ctx);
      onCapture(cs, cap, history);
    }
  };

  return {
    isCapturable,
    onCapture,
    history,
    capture,
    prepareCaptured,
  };
}
