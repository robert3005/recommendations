/**
 * OpenAI models through the Codex CLI and the user's own ChatGPT login — no
 * API key. Each call runs `codex exec` non-interactively in a read-only
 * sandbox with a strict JSON output schema and reads the final message back
 * from a temp file. Slow per call (a CLI process per chunk), so it is meant
 * for local comparison runs rather than whole libraries.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaceProfile, ReviewInput } from "@placemarks/domain";
import { z } from "zod";
import {
  EXTRACTION_SYSTEM,
  extractionUserMessage,
  SUMMARY_SYSTEM,
  summaryUserMessage,
} from "../prompt";
import {
  extractionBatchSchema,
  type ReviewExtraction,
  type SummaryOutput,
  summarySchema,
} from "../schema";
import { ClassifierError, type ReviewClassifier } from "./types";

export const DEFAULT_CODEX_MODEL = "luna";

export type Runner = (
  cmd: string,
  args: string[],
  stdin: string,
) => Promise<{ code: number; stderr: string }>;

const defaultRunner: Runner = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(stdin);
  });

export interface CodexClassifierOptions {
  model?: string;
  bin?: string;
  chunkSize?: number;
  run?: Runner;
}

export class CodexClassifier implements ReviewClassifier {
  readonly id: string;
  readonly chunkSize: number;
  private readonly model: string;
  private readonly bin: string;
  private readonly run: Runner;

  constructor(opts: CodexClassifierOptions = {}) {
    this.model = opts.model ?? DEFAULT_CODEX_MODEL;
    this.id = `codex:${this.model}`;
    this.bin = opts.bin ?? process.env.CODEX_BIN ?? "codex";
    this.chunkSize = opts.chunkSize ?? 20;
    this.run = opts.run ?? defaultRunner;
  }

  async classify(reviews: ReviewInput[], ctx: { placeName?: string }): Promise<ReviewExtraction[]> {
    const out = await this.exec(
      EXTRACTION_SYSTEM,
      extractionUserMessage(reviews, ctx.placeName),
      extractionBatchSchema,
    );
    return out.reviews;
  }

  summarise(
    profile: PlaceProfile,
    evidence: { reviewId: string; kind: string; quote: string }[],
    ctx: { placeName?: string },
  ): Promise<SummaryOutput> {
    return this.exec(
      SUMMARY_SYSTEM,
      summaryUserMessage(profile, evidence, ctx.placeName),
      summarySchema,
    );
  }

  private async exec<S extends z.ZodType>(
    system: string,
    user: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const dir = await mkdtemp(join(tmpdir(), "placemarks-codex-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const outPath = join(dir, "out.json");
      const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" });
      await writeFile(schemaPath, JSON.stringify(jsonSchema));
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        this.model,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
        "-",
      ];
      const prompt = `${system}\n\nAnswer with JSON only, matching the output schema. Do not run any commands.\n\n${user}`;
      const { code, stderr } = await this.run(this.bin, args, prompt);
      if (code !== 0) throw new ClassifierError(`codex exec exited ${code}: ${stderr.slice(-300)}`);
      const raw = await readFile(outPath, "utf8").catch(() => "");
      const parsed = schema.safeParse(
        JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "") || "null"),
      );
      if (!parsed.success) throw new ClassifierError("codex output did not match the schema");
      return parsed.data;
    } catch (err) {
      if (err instanceof ClassifierError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClassifierError(
          `Could not run "${this.bin}". Install the Codex CLI and sign in with \`codex login\`.`,
        );
      }
      if (err instanceof SyntaxError) throw new ClassifierError("codex output was not JSON");
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
