#!/usr/bin/env -S npx tsx
/**
 * placemarks-classify — classify harvested reviews on this machine.
 *
 *   pnpm classify run     [--data DIR] [--place KEY] [--with haiku|jev|luna] [--model ID] [--no-summary]
 *   pnpm classify compare [--data DIR] [--place KEY] --with haiku,luna [--model-a ID] [--model-b ID] [--no-run]
 *
 * --data defaults to $PLACEMARKS_DATA or ~/placemarks-data. Credentials:
 * haiku uses ANTHROPIC_API_KEY (or an `ant auth login` profile), jev uses
 * TYPESAFE_API_KEY, luna uses your Codex CLI login.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ReviewAnalysis } from "@placemarks/domain";
import { AnthropicClassifier } from "./classifiers/anthropic";
import { CodexClassifier } from "./classifiers/codex";
import type { ReviewClassifier } from "./classifiers/types";
import { TypesafeClassifier } from "./classifiers/typesafe";
import { compareAnalyses, formatAgreement } from "./compare";
import { PROMPT_VERSION } from "./prompt";
import { analysePlace, classifierSlug, listPlaceDirs, loadPlaceFolder, readJsonl } from "./run";

export function makeClassifier(name: string, model?: string): ReviewClassifier {
  switch (name) {
    case "haiku":
    case "anthropic":
      return new AnthropicClassifier({ model });
    case "jev":
    case "typesafe":
      return new TypesafeClassifier({ model });
    case "luna":
    case "codex":
      return new CodexClassifier({ model });
    default:
      throw new Error(`Unknown classifier "${name}". Use haiku, jev or luna.`);
  }
}

async function folders(data: string, place: string | undefined, log: (m: string) => void) {
  const dirs = await listPlaceDirs(data);
  const loaded = (await Promise.all(dirs.map((d) => loadPlaceFolder(d, log)))).filter(
    (f) => f !== undefined,
  );
  const picked = place
    ? loaded.filter((f) => f.sourcePlaceKey === place || f.dir.endsWith(place))
    : loaded;
  if (picked.length === 0)
    throw new Error(`No place folders with reviews under ${join(data, "places")}`);
  return picked;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      data: { type: "string" },
      place: { type: "string" },
      with: { type: "string" },
      model: { type: "string" },
      "model-a": { type: "string" },
      "model-b": { type: "string" },
      "no-summary": { type: "boolean" },
      "no-run": { type: "boolean" },
    },
  });
  // pnpm runs scripts from the package folder; resolve --data against where the user ran it.
  const data = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    values.data ?? process.env.PLACEMARKS_DATA ?? join(homedir(), "placemarks-data"),
  );
  const log = (m: string) => console.error(m);

  if (command === "run") {
    const classifier = makeClassifier(values.with ?? "haiku", values.model);
    for (const folder of await folders(data, values.place, log)) {
      log(`${folder.name ?? folder.sourcePlaceKey}: ${folder.reviews.length} reviews`);
      const r = await analysePlace(folder, classifier, { summarise: !values["no-summary"], log });
      log(`  analysed ${r.analysed}, up to date ${r.skipped}, failed ${r.failed}`);
    }
    return;
  }

  if (command === "compare") {
    const [nameA, nameB, ...extra] = (values.with ?? "").split(",").filter(Boolean);
    if (!nameA || !nameB || extra.length > 0) {
      throw new Error("compare needs --with A,B, e.g. --with haiku,luna");
    }
    const a = makeClassifier(nameA, values["model-a"]);
    const b = makeClassifier(nameB, values["model-b"]);
    const all: ReviewAnalysis[][] = [[], []];
    for (const folder of await folders(data, values.place, log)) {
      log(`${folder.name ?? folder.sourcePlaceKey}: ${folder.reviews.length} reviews`);
      for (const [i, c] of [a, b].entries()) {
        if (!values["no-run"])
          await analysePlace(folder, c, { summarise: false, writeDefaultProfile: false, log });
        const rows = await readJsonl<ReviewAnalysis>(
          join(folder.dir, `analyses.${classifierSlug(c.id)}.jsonl`),
        );
        all[i]?.push(...rows.filter((r) => r.promptVersion === PROMPT_VERSION));
      }
    }
    console.log(formatAgreement(compareAnalyses(all[0] ?? [], all[1] ?? [])));
    return;
  }

  console.error("Usage: placemarks-classify run|compare [options]  (see the header of src/cli.ts)");
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
