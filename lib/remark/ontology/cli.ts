#!/usr/bin/env -S deno run -A --node-modules-dir=auto

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import {
  bold,
  brightBlue,
  brightYellow,
  cyan,
  gray,
  magenta,
  yellow,
} from "@std/fmt/colors";
import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import * as mdastCtl from "../mdastctl/mod.ts";

import type { Heading, Root, RootContent } from "types/mdast";
import { TreeLister } from "../../universal/lister-tree-tui.ts";

import {
  buildDocumentTree,
  type ClassificationTreeNode,
  type CombinedTreeNode,
  type ContentTreeNode,
  type DocumentTree,
  type SectionTreeNode,
} from "./path-tree.ts";

import { markdownASTs, Yielded } from "../mdastctl/io.ts";
import { renderPathTreeHtmlWithStore } from "./path-tree-html.ts";
import { buildCombinedTrees } from "./path-tree.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function* viewableMarkdownASTs(
  globalFiles: string[] | undefined,
  positional: string[],
  defaults: string[],
) {
  const merged = [
    ...(globalFiles ?? []),
    ...(positional.length ? positional : defaults),
  ];
  if (merged.length > 0) {
    yield* markdownASTs(merged);
  }
}

function ontNodeToPlainText(node: Any): string {
  const chunks: string[] = [];

  const recur = (n: Any): void => {
    if (n && typeof n.value === "string") {
      chunks.push(n.value);
    }
    if (Array.isArray(n?.children)) {
      for (const c of n.children as Any[]) recur(c);
    }
  };

  recur(node);
  return chunks.join("").replace(/\s+/g, " ").trim();
}

function ontHeadingText(h: Heading): string {
  const text = ontNodeToPlainText(h as Any);
  return text || "(untitled)";
}

function ontSummarizeNode(node: RootContent): string {
  switch (node.type) {
    case "heading":
      return ontHeadingText(node as Heading);

    case "paragraph": {
      const full = ontNodeToPlainText(node);
      const max = 60;
      if (full.length <= max) return full || "(paragraph)";
      return `${full.slice(0, max - 1)}…`;
    }

    case "code": {
      const lang = (node as Any).lang as string | undefined;
      return lang ? `${lang} code` : "code block";
    }

    case "list":
      return "list";

    case "listItem": {
      const full = ontNodeToPlainText(node);
      const max = 60;
      if (full.length <= max) return full || "list item";
      return `${full.slice(0, max - 1)}…`;
    }

    default: {
      const full = ontNodeToPlainText(node);
      if (full) {
        const max = 60;
        if (full.length <= max) return full;
        return `${full.slice(0, max - 1)}…`;
      }
      return node.type;
    }
  }
}

function buildOntologyTreeRowsForFile(
  pmt: Yielded<ReturnType<typeof markdownASTs>>,
  docTree: DocumentTree,
  includeDataKeys: boolean,
) {
  const { fileRef, file } = pmt;

  function row<T extends object>(o: T): T {
    return o;
  }

  const rows: Array<ReturnType<typeof row>> = [];

  const fileRowId = `${file.basename}#ont:combined`;

  rows.push(
    row({
      id: fileRowId,
      file: fileRef(),
      parentId: undefined as string | undefined,
      kind: "heading" as const,
      type: "root" as const,
      label: bold(file.basename ?? "?"),
      view: "ontology" as const,
      classInfo: undefined as string | undefined,
      dataKeys: undefined as string | undefined,
      identityInfo: undefined as string | undefined,
    }),
  );

  const emit = (
    node: CombinedTreeNode,
    parentId: string,
    level: number,
  ) => {
    // ------------------------
    // Leaf content nodes
    // ------------------------
    if (node.kind === "content") {
      const c = node as ContentTreeNode;
      const n = c.node;
      const leafId = `${fileRowId}#i${rows.length}`;

      const dk = includeDataKeys && n.data
        ? Object.keys(n.data).join(", ")
        : undefined;

      const baseLabel = `${n.type === "code" ? "📃" : "📄"} ${
        ontSummarizeNode(n)
      }`;
      const coloredLabel = n.type === "code"
        ? brightYellow(baseLabel)
        : baseLabel;

      rows.push(
        row({
          id: leafId,
          parentId,
          file: fileRef(n),
          kind: "content" as const,
          type: n.type,
          label: coloredLabel,
          view: "ontology" as const,
          classInfo: c.classText,
          dataKeys: dk,
          identityInfo: c.identityText,
        }),
      );

      return;
    }

    // ------------------------
    // Folder nodes
    // ------------------------
    let display = node.label || "(unnamed)";
    let type: string;
    let classInfo: string | undefined = node.classText;
    let identityInfo: string | undefined = undefined;

    // choose folder color
    let colorFn: (s: string) => string = (s) => s;

    if (node.kind === "section") {
      const s = node as SectionTreeNode;
      type = "section";

      // Show real identities from the heading / marker node
      identityInfo = s.identityText;

      if (s.section.nature === "heading") {
        colorFn = cyan; // heading-backed section
      } else {
        colorFn = yellow; // marker / other section
      }

      if (!display) display = "(section)";
    } else {
      const c = node as ClassificationTreeNode;
      type = "classification";

      // classification folders are synthetic → no identity
      identityInfo = undefined;

      if (c.isNamespaceRoot) {
        colorFn = magenta; // classification namespace root
      } else {
        colorFn = brightBlue; // classification path segment
      }

      if (!display) display = "(classification)";

      // For classification folders with no explicit classText, derive ns:path
      if (!classInfo && c.path) {
        classInfo = `${c.namespace}:${c.path}`;
      }
    }

    const base = `📁 ${display}`;
    const colored = colorFn(base);
    const id = `${fileRowId}#p${rows.length}`;

    rows.push(
      row({
        id,
        parentId,
        file: fileRef(),
        kind: "heading" as const,
        type,
        label: colored,
        view: "ontology" as const,
        classInfo,
        dataKeys: undefined as string | undefined,
        identityInfo, // section folders may have identities; classification folders stay blank
      }),
    );

    for (const ch of node.children) {
      emit(ch, id, level + 1);
    }
  };

  for (const sec of docTree.sections) {
    emit(sec, fileRowId, 0);
  }

  return rows;
}

export class CLI {
  readonly mdastCLI: mdastCtl.CLI;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[];
      readonly mdastCLI?: mdastCtl.CLI;
    },
  ) {
    this.mdastCLI = conf?.mdastCLI ??
      new mdastCtl.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name("ontology.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`Spry ontology controller`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("mdast", this.mdastCLI.mdastCommand())
      .command("ls", this.lsCommand())
      .command("doc", this.docCommand());
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "ls";
    const { defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./runbook.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://SpryMD.org/runbook.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./runbook.d https://qualityfolio.dev/runbook.md another.md`,
      );
  }

  lsCommand(cmdName = "ontology") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        "browse combined document ontology (sections + classifications) as a tree",
      )
      .arguments("[paths...:string]")
      .option(
        "--with-data",
        "Include node.data keys as a DATA column (for files).",
      )
      .option("--no-color", "Show output without using ANSI colors")
      .option(
        "-C, --with-class",
        "Show classifications as a column not in folder hierarchy",
      )
      .action(async (options, ...paths: string[]) => {
        const allRows: Any[] = [];

        for await (
          const viewable of viewableMarkdownASTs(
            [],
            paths,
            this.conf?.defaultFiles ?? [],
          )
        ) {
          const docTree = buildDocumentTree(viewable.mdastRoot, {
            includeClassificationFolders: options?.withClass ? false : true,
          });

          const rows = buildOntologyTreeRowsForFile(
            viewable,
            docTree,
            !!options.withData,
          );
          allRows.push(...rows);
        }

        if (!allRows.length) {
          console.log(gray("No ontology nodes to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<Any>()
          .from(allRows)
          .declareColumns(
            "label",
            "type",
            "file",
            "identityInfo",
            "classInfo",
            "dataKeys",
          )
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s: string) => s,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: magenta,
        });
        base.field("dataKeys", "dataKeys", {
          header: "DATA",
          defaultColor: magenta,
        });

        base.select(...[
          "label",
          "identityInfo",
          options.withClass ? "classInfo" : undefined,
          "type",
          "file",
          options.withData ? "dataKeys" : undefined,
          // deno-lint-ignore no-explicit-any
        ].filter((k) => typeof k !== "undefined") as any);

        const treeLister = TreeLister.wrap(base)
          .from(allRows)
          .byParentChild({ idKey: "id", parentIdKey: "parentId" })
          .treeOn("label")
          .dirFirst(true);

        await treeLister.ls(true);
      });
  }

  docCommand(cmdName = "doc") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        "generate a static HTML page for the document ontology and write it to stdout, or serve with --serve",
      )
      .arguments("[paths...:string]")
      .option(
        "--save-as <file:string>",
        "also save the generated HTML to this file",
      )
      .option(
        "--serve",
        "serve the generated HTML on a local web server with live reload",
      )
      .option(
        "--port <port:number>",
        "port for --serve (default 9876)",
      )
      .option(
        "--listen <addr:string>",
        "address/interface for --serve (default 127.0.0.1)",
      )
      .option(
        "--no-open",
        "with --serve, do not automatically open a browser",
      )
      .action(async (options, ...paths: string[]) => {
        const defaultFiles = this.conf?.defaultFiles ?? [];

        // ------------------------
        // Static (non-serve) mode
        // ------------------------
        if (!options.serve) {
          const roots: Root[] = [];
          const labels: string[] = [];

          for await (
            const viewable of viewableMarkdownASTs(
              [],
              paths,
              defaultFiles,
            )
          ) {
            roots.push(viewable.mdastRoot);
            labels.push(viewable.fileRef());
          }

          if (!roots.length) {
            console.error(gray("No Markdown files to process."));
            return;
          }

          const docs = buildCombinedTrees(roots);
          const result = renderPathTreeHtmlWithStore(docs, {
            documentLabels: labels,
            appVersion: computeSemVerSync(import.meta.url),
            lazyMdastStore: false, // static mode: embed full store
          });

          const html = result.html;

          // HTML always to stdout in static mode
          console.log(html);

          if (options.saveAs) {
            await Deno.writeTextFile(options.saveAs, html);
            console.error(`Saved ontology HTML to ${options.saveAs}`);
          }
          return;
        }

        // ------------------------
        // --serve mode
        // ------------------------
        const host = options.listen ?? "127.0.0.1";
        const port = options.port ?? 9876;
        const watchTargets: string[] = paths.length ? paths : defaultFiles;

        let currentHtml = "";
        let currentMdastStore: unknown[] = [];

        const renderOnce = async (): Promise<boolean> => {
          const roots: Root[] = [];
          const labels: string[] = [];

          for await (
            const viewable of viewableMarkdownASTs(
              [],
              paths,
              defaultFiles,
            )
          ) {
            roots.push(viewable.mdastRoot);
            labels.push(viewable.fileRef());
          }

          if (!roots.length) {
            console.error(gray("No Markdown files to process."));
            return false;
          }

          const docs = buildCombinedTrees(roots);
          const result = renderPathTreeHtmlWithStore(docs, {
            documentLabels: labels,
            appVersion: computeSemVerSync(import.meta.url),
            lazyMdastStore: true, // serve mode: lazy mdast
          });

          currentHtml = result.html;
          currentMdastStore = result.mdastNodes;

          if (options.saveAs) {
            await Deno.writeTextFile(options.saveAs, currentHtml);
            console.error(`Saved ontology HTML to ${options.saveAs}`);
          }

          return true;
        };

        // Set a minimal placeholder HTML so the server can start immediately.
        currentHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spry Programmable Markdown Ontology (starting…)</title>
  </head>
  <body>
    <p>Starting ontology server and building initial view…</p>
  </body>
</html>`;

        // Hand off to the server; it will trigger renderOnce() in the background.
        await serveOntology({
          host,
          port,
          openBrowserFlag: options.open,
          watchTargets,
          renderOnce,
          getHtml: () => currentHtml,
          getMdastStore: () => currentMdastStore,
        });
      });
  }
}

/* --------------------------------------------------------------------------- */
/* Server + helpers                                                            */
/* --------------------------------------------------------------------------- */

interface ServeOntologyArgs {
  host: string;
  port: number;
  openBrowserFlag: boolean;
  watchTargets: string[];
  renderOnce: () => Promise<boolean>;
  getHtml: () => string;
  getMdastStore: () => unknown[];
}

async function serveOntology(args: ServeOntologyArgs): Promise<void> {
  const {
    host,
    port,
    openBrowserFlag,
    watchTargets,
    renderOnce,
    getHtml,
    getMdastStore,
  } = args;

  // Live-reload clients via Server-Sent Events
  const clients = new Set<(msg: string) => void>();

  function injectReloadSnippet(srcHtml: string): string {
    const snippet = `
<script>
  (() => {
    try {
      const es = new EventSource("/events");
      es.onmessage = (ev) => {
        if (ev.data === "reload") {
          location.reload();
        }
      };
      es.onerror = () => {
        setTimeout(() => location.reload(), 3000);
      };
    } catch (e) {
      console.error("Live reload error", e);
    }
  })();
</script>`;
    if (srcHtml.includes("</body>")) {
      return srcHtml.replace("</body>", snippet + "</body>");
    }
    return srcHtml + snippet;
  }

  function broadcastReload() {
    for (const send of clients) {
      try {
        send("reload");
      } catch {
        // ignore dead streams
      }
    }
  }

  const serverUrl = `http://${host}:${port}`;

  Deno.serve({ hostname: host, port }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          const send = (msg: string) => {
            controller.enqueue(`data: ${msg}\\n\\n`);
          };
          clients.add(send);
          send("connected");
        },
        cancel() {
          clients.clear();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/mdast.json") {
      return new Response(JSON.stringify(getMdastStore() ?? []), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Main HTML page
    const body = injectReloadSnippet(getHtml());
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  });

  console.error(
    `Serving ontology at ${serverUrl} (Ctrl+C to stop)`,
  );

  if (openBrowserFlag) {
    openBrowser(`${serverUrl}/`).catch((err) => {
      console.error("Failed to open browser:", err?.message ?? err);
    });
  }

  // Kick off the initial build in the background so startup stays fast.
  (async () => {
    const ok = await renderOnce();
    if (ok) {
      broadcastReload();
    }
  })();

  if (watchTargets.length) {
    console.error(
      `Watching for changes in: ${watchTargets.join(", ")}`,
    );
    for await (const ev of Deno.watchFs(watchTargets)) {
      if (
        ev.kind === "modify" ||
        ev.kind === "create" ||
        ev.kind === "remove"
      ) {
        console.error(
          `Change detected, rebuilding ontology (kind=${ev.kind})`,
        );
        const ok = await renderOnce();
        if (!ok) continue;
        broadcastReload();
      }
    }
  } else {
    // nothing to watch; keep process alive
    await new Promise(() => {});
  }
}

// deno-lint-ignore require-await
async function openBrowser(url: string): Promise<void> {
  let cmd: string[];
  switch (Deno.build.os) {
    case "windows":
      cmd = ["cmd", "/c", "start", "", url];
      break;
    case "darwin":
      cmd = ["open", url];
      break;
    default:
      cmd = ["xdg-open", url];
      break;
  }

  try {
    const proc = new Deno.Command(cmd[0], { args: cmd.slice(1) }).spawn();
    void proc; // fire-and-forget
  } catch (err) {
    console.error("Unable to open browser automatically:", String(err) ?? err);
  }
}

/* --------------------------------------------------------------------------- */
/* Stand-alone entrypoint                                                     */
/* --------------------------------------------------------------------------- */

if (import.meta.main) {
  await new CLI().run();
}
