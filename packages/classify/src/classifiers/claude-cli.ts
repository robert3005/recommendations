/**
 * Claude through the local Claude Code CLI and the owner's own login — no API
 * key. Each call runs `claude -p` with no tools, no MCP servers, no saved
 * session and a JSON schema, from a temp directory so no project settings or
 * CLAUDE.md apply, and reads `structured_output` from the JSON result.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
import { DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { ClassifierError, type ReviewClassifier } from "./types";

export type CliRunner = (
  cmd: string,
  args: string[],
  stdin: string,
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = (cmd, args, stdin, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });

export interface ClaudeCliClassifierOptions {
  model?: string;
  bin?: string;
  chunkSize?: number;
  run?: CliRunner;
}

export class ClaudeCliClassifier implements ReviewClassifier {
  /** Same id as the API classifier: same model, same prompt, interchangeable analyses. */
  readonly id: string;
  readonly chunkSize: number;
  private readonly model: string;
  private readonly bin: string;
  private readonly run: CliRunner;

  constructor(opts: ClaudeCliClassifierOptions = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.id = `anthropic:${this.model}`;
    this.bin = opts.bin ?? process.env.CLAUDE_BIN ?? "claude";
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
    const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" });
    const args = [
      "-p",
      "--model",
      this.model,
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      system,
      "--json-schema",
      JSON.stringify(jsonSchema),
    ];
    const cwd = await mkdtemp(join(tmpdir(), "placemarks-claude-"));
    try {
      const { code, stdout, stderr } = await this.run(this.bin, args, user, cwd);
      let result: { is_error?: boolean; result?: string; structured_output?: unknown } | undefined;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = undefined;
      }
      if (code !== 0 || !result || result.is_error) {
        const detail = (result?.result ?? stderr ?? stdout).toString().slice(-300);
        throw new ClassifierError(
          `claude -p failed (exit ${code}): ${detail}`,
          /rate|overloaded|529|5\d\d/i.test(detail),
        );
      }
      const parsed = schema.safeParse(result.structured_output);
      if (!parsed.success) throw new ClassifierError("claude output did not match the schema");
      return parsed.data;
    } catch (err) {
      if (err instanceof ClassifierError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClassifierError(
          `Could not run "${this.bin}". Install Claude Code and sign in with \`claude\`.`,
        );
      }
      throw err;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
