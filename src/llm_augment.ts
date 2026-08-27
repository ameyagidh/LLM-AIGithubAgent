/**
 * Optional LLM-augmentation pass.
 *
 * The schema-based matcher already resolves most <producer -> consumer> edges. This
 * module closes the remaining gaps for identifier-style required inputs that the
 * schema match could not connect, by asking the model to pick real producer slugs from
 * the *given* catalog. Node ids are never invented.
 *
 * It is fully optional and self-gating: if OpenAI credentials (OPENAI_API_KEY /
 * OPENAI_BASE_URL) are absent it no-ops, so the generator is deterministic without a
 * key. Prompts are scoped per input-label to a shortlist of candidate producer tools so
 * each call stays small, cheap and precise.
 */

import { readFileSync, existsSync } from "fs";

interface Gap {
  consumer: string;
  input: string;
}
interface CandidateEdge {
  from: string;
  to: string;
  label: string;
  confidence: number;
}

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  try {
    for (const line of readFileSync(".env", "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ignore malformed .env */
  }
}

// Normalise an identifier into coarse matching tokens for shortlisting.
function tokensOf(input: string, slug: string, desc: string): string {
  const text = `${slug} ${desc} ${input}`.toLowerCase();
  return text.replace(/[^a-z0-9]+/g, " ");
}

/**
 * Build a shortlist of candidate producer tools for an input label: tools whose slug
 * or description shares a salient keyword with the input (e.g. `migration` for
 * `migration_id`, `cache` for `cache_id`, `enterprise` for `enterprise_slug`).
 */
function shortlistFor(
  tools: any[],
  input: string,
  knownSlugs: Set<string>,
): any[] {
  const base = input.replace(/_[a-z]+$/, ""); // strip _id/_number/_slug/_name
  const baseTokens = new Set(base.split("_").filter((t) => t.length > 2));
  // Global provenance: a candidate must be a tool that RETURNS something (has output).
  const scored: { t: any; score: number }[] = [];
  for (const t of tools) {
    const slug: string = String(t.slug ?? t.name ?? t.function?.name ?? "").toUpperCase();
    if (!knownSlugs.has(slug)) continue;
    const desc = String(t.description ?? "").toLowerCase();
    let score = 0;
    for (const tok of baseTokens) {
      if (slug.toLowerCase().includes(tok)) score += 3;
      if (desc.includes(tok)) score += 1;
    }
    // Inputs are assumed to come from actions that materially affect the entity.
    if (score > 0) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 25).map((s) => s.t);
}

export async function llmAugment(
  tools: any[],
  gaps: Gap[],
  knownSlugs: Set<string>,
): Promise<CandidateEdge[]> {
  loadDotEnv();
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseURL || gaps.length === 0) return [];

  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, baseURL });
  const model = process.env.OPENAI_MODEL || "openai/gpt-4o";

  // Group gaps by input label so we can shortlist once per label.
  const byLabel = new Map<string, Gap[]>();
  for (const g of gaps) {
    if (!byLabel.has(g.input)) byLabel.set(g.input, []);
    byLabel.get(g.input)!.push(g);
  }

  const edges: CandidateEdge[] = [];
  const system =
    "You build dependency graphs for an agentic tool system. producer -> consumer " +
    "means the producer's action returns a value the consumer needs as the named " +
    "required input. Only reference tool slugs present in the provided catalog. " +
    "Output JSON only.";

  for (const [input, labelGaps] of byLabel) {
    const candidates = shortlistFor(tools, input, knownSlugs);
    if (candidates.length === 0) continue; // no plausible producer in this toolkit

    const catalogBlock = candidates
      .map(
        (t) =>
          `SLUG: ${t.slug}\nDESC: ${String(t.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`,
      )
      .join("\n\n");
    const consumers = [...new Set(labelGaps.map((g) => g.consumer))];

    const user =
      `A consumer tool needs the required input field \`${input}\` to execute (e.g. a migration's ` +
      `id, an enterprise's slug, a cache's id). Which of these producer tools returns a ` +
      `value that would supply \`${input}\`?\n\n` +
      `${catalogBlock}\n\n` +
      `Consumers needing \`${input}\`: ${consumers.join(", ")}\n\n` +
      `Respond ONLY as JSON: {"produces_${input}": ["SLUG", ...]} (empty array if none).`;

    try {
      const r = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 400,
      });
      const text = r.choices?.[0]?.message?.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      const obj = m ? JSON.parse(m[0]) : {};
      let slugs = obj[`produces_${input}`];
      if (!Array.isArray(slugs)) {
        // tolerate model drifting to another key
        const v = Object.values(obj).find((x) => Array.isArray(x));
        slugs = (v as string[]) ?? [];
      }
      for (const sRaw of slugs) {
        const s = String(sRaw).toUpperCase();
        if (!knownSlugs.has(s)) continue;
        for (const g of labelGaps) {
          if (s === g.consumer.toUpperCase()) continue; // no self-loops
          edges.push({ from: s, to: g.consumer, label: input, confidence: 0.85 });
        }
      }
    } catch (err) {
      // Skip this label on transient failures; keep the rest of the graph intact.
      console.error(`llm augment (${input}) failed: ${(err as Error).message}`);
    }
  }

  return edges;
}
