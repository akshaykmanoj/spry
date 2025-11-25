#!/usr/bin/env -S deno run -A --node-modules-dir=auto

// extract-code-cells.ts
//
// Load one or more Markdown sources, build the Spry ontology,
// visit each ontology node, and show we can find <code> cells
// in files.

import { gray, green, yellow } from "@std/fmt/colors";
import type { Root } from "types/mdast";

import { markdownASTs } from "../../../lib/remark/mdastctl/io.ts";
import {
  type PathTreeContentNode,
  visitPathTreeOfKind,
} from "../../../lib/remark/ontology/path-tree-visit.ts";
import {
  buildCombinedTrees,
  CombinedTreeNode,
  type DocumentTree,
} from "../../../lib/remark/ontology/path-tree.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface ViewableRoot {
  root: Root;
  label: string;
}

async function collectRoots(sources: string[]) {
  const out: ViewableRoot[] = [];
  if (!sources.length) return out;

  for await (const viewable of markdownASTs(sources)) {
    out.push({
      root: viewable.mdastRoot,
      label: viewable.fileRef(),
    });
  }

  return out;
}

function sanitizeForFilename(label: string) {
  const trimmed = label.trim();
  const base = trimmed || "document";
  return base
    .replace(/^[./\\]+/, "") // strip leading path-ish chars
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 80) || "document";
}

interface ExtractedCodeCell {
  docIndex: number;
  docLabel: string;
  code: string;
  lang?: string;
  meta?: string;
  ancestors: readonly CombinedTreeNode[];
}

/**
 * Walk the ontology trees and collect all code cells.
 */
function extractCodeCells(
  docs: readonly DocumentTree[],
  labels: readonly string[],
) {
  const results: ExtractedCodeCell[] = [];

  docs.forEach((doc, docIndex) => {
    const docLabel = labels[docIndex] ?? `doc-${docIndex + 1}`;

    visitPathTreeOfKind(
      doc,
      "content",
      (node: PathTreeContentNode, ancestors) => {
        const md: Any = node.node;
        if (!md || md.type !== "code") return;

        const code = typeof md.value === "string" ? md.value : "";
        results.push({
          docIndex,
          docLabel,
          code,
          lang: typeof md.lang === "string" ? md.lang : undefined,
          meta: typeof md.meta === "string" ? md.meta : undefined,
          ancestors,
        });
      },
    );
  });

  return results;
}

const viewables = await collectRoots(["qf-complex.md"]);
if (!viewables.length) {
  console.error(gray("No Markdown files to process."));
} else {
  const roots: Root[] = viewables.map((v) => v.root);
  const labels: string[] = viewables.map((v) => v.label);

  const docs = buildCombinedTrees(roots);
  const cells = extractCodeCells(docs, labels);

  const perDocCount = new Map<string, number>();

  for (const cell of cells) {
    const baseDocName = sanitizeForFilename(cell.docLabel);
    const key = baseDocName;
    const prev = perDocCount.get(key) ?? 0;
    const next = prev + 1;
    perDocCount.set(key, next);

    console.info(
      green("Found code cell"),
      yellow(`#${next}`),
      gray("→"),
      cell.lang,
      "in",
      baseDocName,
    );
    console.info(
      "      ",
      gray(cell.ancestors.map((a) => a.label).join(" → ")),
      "\n",
    );
  }
}
