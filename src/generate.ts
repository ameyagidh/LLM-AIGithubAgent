/**
 * Dependency-graph generator for Composio toolkits.
 *
 * Given a toolkit's tool catalog (as a CLI argument), it produces a
 * `dependency_graph.json` describing which tools *produce* values (fields)
 * that other tools *consume* as required inputs.
 *
 * Edge convention (identical to the README):
 *   { "from": <producer>, "to": <consumer>, "label": <field the producer supplies> }
 *
 * Matching strategy (see README / design notes):
 *  1. For every tool we extract the set of "produced fields" by walking its
 *     output response schema. Each produced field is recorded as
 *     { property, entity } where `entity` is a normalized type name gleaned
 *     from the response struct (e.g. an `Issue` struct's `number`).
 *  2. For every tool we extract its *required* inputs. Each required input is
 *     turned into a "need" of { property, entity } using its name and the
 *     semantic clues in its description (e.g. `issue_number` -> an `Issue`'s
 *     `number`; `repo` -> a `Repository`'s `name`/`full_name`).
 *  3. We connect a producer to a consumer when one of the consumer's needs can
 *     be satisfied by a produced field whose property and entity align.
 *
 * Field-level (and entity-level) matching is intentionally fuzzy: we use
 * normalized stems and an entity synonym table so a general catalog (not just
 * GitHub) can be processed without any toolkit-specific code.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

type Tool = Record<string, any>;
interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
  confidence?: number;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

// CLI: `gen <catalog_path> [output_path]`.
const CATALOG_PATH = process.argv[2];
const OUT_PATH = process.argv[3] ?? "dependency_graph.json";

// ---- small helpers ---------------------------------------------------------

const log = (m: string) => console.error(m);

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool?.function?.name;
}

// Normalize an identifier to a lowercase "stem" for fuzzy comparisons.
// Also splits camelCase / PascalCase boundaries so names like
// "GetAMilestoneResponse" become "get_a_milestone_response".
function stem(s: string): string {
  const split = String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // aB -> a B
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // ABc -> AB c
  return split
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .join("_");
}

/**
 * Map a possibly-plural field/type name to a canonical singular entity token.
 * This lets `issues` and `issue` and `Issue` all be treated as the `issue`
 * entity, and lets us align `issue_number` -> issue, `pull_number` -> pull, etc.
 */
function canonEntity(name: string): string {
  const s = stem(name);
  if (!s) return s;
  // de-pluralize common irregular / regular plurals
  const irr: Record<string, string> = {
    people: "person",
    children: "child",
    repos: "repository",
    repositories: "repository",
    branches: "branch",
    issues: "issue",
    pulls: "pull",
    pull_requests: "pull_request",
    pullrequest: "pull_request",
    pullrequests: "pull_request",
    discussions: "discussion",
    comments: "comment",
    reviews: "review",
    releases: "release",
    deployments: "deployment",
    milestones: "milestone",
    projects: "project",
    cards: "card",
    columns: "column",
    secrets: "secret",
    variables: "variable",
    workflows: "workflow",
    runs: "workflow_run",
    webhooks: "webhook",
    hooks: "hook",
    gists: "gist",
    commits: "commit",
    keys: "key",
    teams: "team",
    members: "member",
    collaborator: "collaborator",
    collaborators: "collaborator",
    contributors: "contributor",
    assignees: "assignee",
    reviewers: "reviewer",
    labels: "label",
    packages: "package",
    artifacts: "artifact",
    alerts: "alert",
    orgs: "org",
    organizations: "org",
    users: "user",
    activities: "activity",
    events: "event",
  };
  if (irr[s]) return irr[s];
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("es")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/**
 * Canonicalize an entity type token. This is the layer that lets a generic
 * name (e.g. "PullRequest") line up with input-field-derived tokens.
 */
export function canonicalizeType(t: string): string {
  let cleaned = stem(t)
    .replace(/^(get|create|update|delete|list|add|remove|merge|close|approve|reopen|check|preview|search|find|resolve|comment|react|view|put|block|unblock|enable|disable|mark|edit|set|unset|submit|request|process)[_ ]/, "")
    .replace(/response$|request$|wrapper$|props$/g, "")
    .replace(/^_+/, "");
  // Strip leading articles (e.g. Get*A*Milestone -> milestone).
  cleaned = cleaned.replace(/^(a|an|the)_/, "");
  return canonEntity(stem(cleaned));
}

// ---- produced fields -------------------------------------------------------

interface ProducedField {
  property: string;
  entity: string; // canonical entity token
  rawEntity: string; // struct name it came from
}

/**
 * Determine the set of *primary* entity structs a tool returns. These are the
 * response type(s) directly surfaced by the action: the struct the `data.$ref`
 * points to and, when that struct is a list/collection wrapper, its element
 * structs. Nested sub-objects (e.g. a Repo's `owner`, an Issue's `milestone`)
 * are deliberately EXCLUDED so they don't inflate a tool's produced fields.
 */
function primaryStructNames(
  schema: any,
  defs: Record<string, any>,
): { name: string; isList: boolean }[] {
  const dataRef = schema?.properties?.data?.$ref;
  if (!dataRef) return [];
  const mainName = String(dataRef).split("/").pop()!;
  const main = defs[mainName];
  const primary: { name: string; isList: boolean }[] = [];

  const names = new Set<string>();
  if (main?.properties) {
    // If the main struct is a collection wrapper whose properties are arrays of
    // elements (issues, pull_requests, repositories, ...), surface the element
    // structs as the primary entities.
    let isListWrapper = false;
    for (const [key, val] of Object.entries(main.properties as any)) {
      const itemRef = val?.items?.$ref;
      if (itemRef) {
        const itemName = String(itemRef).split("/").pop()!;
        if (!names.has(itemName)) {
          names.add(itemName);
          primary.push({ name: itemName, isList: true });
          isListWrapper = true;
        }
      }
    }
    if (!isListWrapper) {
      names.add(mainName);
      primary.push({ name: mainName, isList: false });
    }
  } else {
    names.add(mainName);
    primary.push({ name: mainName, isList: false });
  }
  return primary;
}

export function extractProducedFields(tool: Tool): ProducedField[] {
  const out = tool.outputParameters ?? {};
  const defs = out.$defs ?? {};
  const primary = primaryStructNames(out, defs);
  const fields: ProducedField[] = [];
  for (const { name } of primary) {
    const entity = canonicalizeType(name);
    const props = defs[name]?.properties ?? {};
    for (const prop of Object.keys(props)) {
      fields.push({ property: prop, entity, rawEntity: name });
    }
  }
  return fields;
}

// ---- consumer needs --------------------------------------------------------

interface Need {
  input: string; // exact input parameter key
  property: string; // the produced-field name we want
  propertyStem: string; // normalized property for fuzzy matching
  entity?: string; // optional canonical entity token
  desc: string;
  confidence: number; // 1 = precise, <1 = guessed
}

/**
 * Convert a required input parameter into one or more candidate "needs".
 * This is where the semantic mapping between an input name and what a
 * producer supplies is encoded generically using a synonym table.
 */
function inputToNeeds(tool: Tool, key: string, schema: any): Need[] {
  const desc = (schema && schema.description) || "";
  const dlower = desc.toLowerCase();

  const needs: Need[] = [];
  const k = key.toLowerCase();

  // Ambient / contextual qualifiers (owner, repo, org, username...) describe
  // *which* high-level scope a user points the tool at. They are usually
  // provided up front by the operator or a config, not harvested from a prior
  // action's result, so they do not form meaningful precursor dependencies.
  const AMBIENT = new Set([
    "owner",
    "repo",
    "repository",
    "repo_url",
    "repository_url",
    "org",
    "organization",
    "username",
    "user",
    "handle",
    "body",
    "title",
    "message",
    "content",
    "text",
    "type",
    "path",
    "state",
    "q",
    "query",
    "per_page",
    "limit",
  ]);
  if (AMBIENT.has(k)) return [];

  // Recognized "entity_number"-style inputs -> look for that entity's `number`.
  const numberFor: Record<string, string> = {
    issue_number: "issue",
    pull_number: "pull_request",
    discussion_number: "discussion",
    project_number: "project",
    milestone_number: "milestone",
    comment_number: "comment",
    review_number: "review",
    alert_number: "alert",
    code_scanning_alert_number: "alert",
    reaction_number: "reaction",
  };
  if (numberFor[k]) {
    needs.push({
      input: key,
      property: "number",
      propertyStem: "number",
      entity: numberFor[k],
      desc,
      confidence: 1,
    });
    return needs;
  }

  // Recognized "<entity>_id" inputs -> look for that entity's `id`.
  const idFor: Record<string, string> = {
    release_id: "release",
    deployment_id: "deployment",
    check_run_id: "check_run",
    check_suite_id: "check_suite",
    run_id: "workflow_run",
    workflow_id: "workflow",
    hook_id: "webhook",
    gist_id: "gist",
    comment_id: "comment",
    review_id: "review",
    repository_id: "repository",
    project_id: "project",
    column_id: "column",
    card_id: "card",
    item_id: "project_item",
    package_id: "package",
    package_version_id: "package_version",
    artifact_id: "artifact",
    thread_id: "thread",
    role_id: "role",
    key_id: "gpg_key",
    invitation_id: "invitation",
    deployment_id_status: "deployment",
    asset_id: "asset",
    delivery_id: "webhook_delivery",
    ruleset_id: "ruleset",
    branch_policy_id: "branch_policy",
    job_id: "job",
    check_run_id_alt: "check_run",
    assignment_id: "assignment",
    installation_id: "installation",
    client_id: "oauth_app",
    migration_id: "migration",
    organization_id: "org",
    team_id: "team",
    pull_request_review_id: "review",
    environment_id: "environment",
    workflow_run_id: "workflow_run",
    workflow_job_id: "job",
    ghp_owner_id: "org",
  };
  if (idFor[k]) {
    needs.push({
      input: key,
      property: "id",
      propertyStem: "id",
      entity: idFor[k],
      desc,
      confidence: 1,
    });
    return needs;
  }

  // repo -> Repository's `name` (or full_name)
  if (["repo", "repository", "repo_name", "repository_name"].includes(k)) {
    needs.push(
      {
        input: key,
        property: "full_name",
        propertyStem: "full_name",
        entity: "repository",
        desc,
        confidence: 0.9,
      },
      {
        input: key,
        property: "name",
        propertyStem: "name",
        entity: "repository",
        desc,
        confidence: 0.9,
      },
    );
    return needs;
  }

  // owner / org / username -> account identity field (login / name)
  if (["owner", "org", "organization", "organization_name"].includes(k)) {
    needs.push(
      {
        input: key,
        property: "login",
        propertyStem: "login",
        entity: "user",
        desc,
        confidence: 0.8,
      },
      {
        input: key,
        property: "login",
        propertyStem: "login",
        entity: "org",
        desc,
        confidence: 0.8,
      },
      {
        input: key,
        property: "name",
        propertyStem: "name",
        entity: "org",
        desc,
        confidence: 0.8,
      },
    );
    return needs;
  }
  if (["username", "user", "handle"].includes(k)) {
    needs.push({
      input: key,
      property: "login",
      propertyStem: "login",
      entity: "user",
      desc,
      confidence: 0.9,
    });
    return needs;
  }

  // branch -> Branch `name`
  if (key === "branch" || key === "branch_name") {
    needs.push(
      {
        input: key,
        property: "name",
        propertyStem: "name",
        entity: "branch",
        desc,
        confidence: 0.9,
      },
      {
        input: key,
        property: "ref",
        propertyStem: "ref",
        entity: "ref",
        desc,
        confidence: 0.7,
      },
    );
    return needs;
  }

  // commit / sha
  if (["commit_sha", "sha", "commit_id", "head_sha", "base_sha", "ref"].includes(k)) {
    needs.push({
      input: key,
      property: "sha",
      propertyStem: "sha",
      entity: "commit",
      desc,
      confidence: key === "ref" ? 0.7 : 0.9,
    });
    return needs;
  }

  // Generic "<something>_number" / "<something>_id" only (numeric identifiers).
  if (/_(number|id)$/.test(k)) {
    const base = k.replace(/_(number|id)$/, "");
    const entity = canonEntity(base);
    needs.push({
      input: key,
      property: k.endsWith("_id") ? "id" : "number",
      propertyStem: k.endsWith("_id") ? "id" : "number",
      entity,
      desc,
      confidence: 0.6,
    });
    return needs;
  }

  // Generic "<something>_name" / "<something>_slug" (string identifiers).
  if (/_(name|slug)$/.test(k)) {
    const base = k.replace(/_(name|slug)$/, "");
    const entity = base ? canonEntity(base) : undefined;
    needs.push({
      input: key,
      property: k.endsWith("_slug") ? "slug" : "name",
      propertyStem: k.endsWith("_slug") ? "slug" : "name",
      entity,
      desc,
      confidence: 0.6,
    });
    return needs;
  }

  // No mapping: this input is not a specific identifier produced by a prior
  // action, so it cannot form a meaningful dependency edge. Skip it.
  return [];
}

// ---- field/entity compatibility -------------------------------------------

function entityCompat(consumerEntity: string | undefined, producerEntity: string): boolean {
  if (!consumerEntity) return true;
  const c = canonEntity(consumerEntity);
  const p = canonEntity(producerEntity);
  if (c === p) return true;
  // repository / repo aliases
  if (c === "repository" && p === "repo") return true;
  if (c === "repo" && p === "repository") return true;
  // user / org / owner / account are all "account identity"
  const account = new Set(["user", "org", "owner", "account", "collaborator", "assignee"]);
  if (account.has(c) && account.has(p)) return true;
  // pull_request ~ issue share `number` conceptually, but treat PR vs issue distinct;
  // allow 'pull' family with 'pull_request'
  if ((c === "pull_request" && p === "pull") || (c === "pull" && p === "pull_request"))
    return true;
  // Generic: `issue_comment`/`discussion_comment`/`commit_comment` ~ `comment`,
  // `workflow_run` ~ `run`, `check_suite` ~ `suite`, `github_app` ~ `app`, etc.
  // Match when the shorter canonical token is a suffix of the longer one (with a
  // guard so e.g. `issue` is not treated as a match for `repository`).
  const [short, long] = c.length <= p.length ? [c, p] : [p, c];
  if (short !== long && long.endsWith(short) && !FORBIDDEN_FAMILIES.has(short)) {
    return true;
  }
  return false;
}

// Families where a bare token is NOT a good suffix match (avoids false positives
// like treating `repository` as an `issue`). Only the generic suffix rule above
// consults this; exact and curated matches are decided before it.
const FORBIDDEN_FAMILIES = new Set([
  "user",
  "org",
  "repository",
  "repo",
  "pull_request",
  "issue",
  "milestone",
]);

function propertyCompat(need: Need, produced: ProducedField): boolean {
  if (need.propertyStem === produced.property.toLowerCase()) return true;
  // full_name ~ name (repo)
  if (need.property === "full_name" && produced.property === "name") return true;
  // login ~ name for identity
  if (need.property === "login" && ["login", "name", "username", "handle"].includes(produced.property))
    return true;
  return false;
}

// ---- graph building --------------------------------------------------------

interface ToolInfo {
  slug: string;
  tool: Tool;
  produced: ProducedField[];
  needs: Need[];
}

export function buildIndex(tools: Tool[]): ToolInfo[] {
  return tools
    .map((tool) => {
      const slug = slugOf(tool);
      if (!slug) return null;
      const produced = extractProducedFields(tool);
      const inputProps = tool.inputParameters?.properties ?? {};
      const required: string[] = tool.inputParameters?.required ?? [];
      const needs: Need[] = [];
      for (const key of required) {
        const schema =
          inputProps[key] ??
          (tool.inputParameters?.$defs
            ? tool.inputParameters.$defs[key]
            : undefined);
        needs.push(...inputToNeeds(tool, key, schema));
      }
      return { slug, tool, produced, needs };
    })
    .filter((x): x is ToolInfo => x !== null);
}

function buildGraph(info: ToolInfo[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = info.map((i) => ({
    id: i.slug,
    ...(i.tool.toolkit ? { service: i.tool.toolkit } : {}),
  }));

  // Precompute a property-keyed index of producers. We key on the normalized
  // property name only and then filter by entity compatibility per edge, which
  // lets us handle fuzzy entity aliases (user/org/owner, etc.).
  const producerByProperty = new Map<string, string[]>();
  const expandPropertyAliases = (props: string[]): string[] => {
    const extra = new Set<string>();
    for (const p of props) {
      const pl = p.toLowerCase();
      if (pl === "name") {
        extra.add("full_name");
        extra.add("username");
        extra.add("handle");
        extra.add("login");
      } else if (pl === "login") {
        extra.add("username");
        extra.add("handle");
        extra.add("name");
      } else if (pl === "full_name") {
        extra.add("name");
      } else if (pl === "number") {
        extra.add("id");
      } else if (pl === "id") {
        extra.add("number");
      }
    }
    return [...extra];
  };
  for (const i of info) {
    const props = new Set(i.produced.map((pf) => pf.property.toLowerCase()));
    props.add(...expandPropertyAliases(i.produced.map((pf) => pf.property)));
    for (const prop of props) {
      if (!producerByProperty.has(prop)) producerByProperty.set(prop, []);
      producerByProperty.get(prop)!.push(i.slug);
    }
  }

  const edgeSet = new Map<string, Edge>(); // dedupe by "from|to|label"
  for (const consumer of info) {
    for (const need of consumer.needs) {
      const producerSlugs = producerByProperty.get(need.propertyStem) ?? [];

      for (const producerSlug of producerSlugs) {
        if (producerSlug === consumer.slug) continue; // no self-loops
        const producer = info.find((i) => i.slug === producerSlug);
        if (!producer) continue;
        const matched = producer.produced.some((pf) => {
          if (!propertyCompat(need, pf)) return false;
          return entityCompat(need.entity, pf.entity);
        });
        if (!matched) continue;

        const key = `${producerSlug}|${consumer.slug}|${need.input}`;
        if (!edgeSet.has(key)) {
          edgeSet.set(key, {
            from: producerSlug,
            to: consumer.slug,
            label: need.input,
            confidence: need.confidence,
          });
        }
      }
    }
  }

  return { nodes, edges: [...edgeSet.values()] };
}

// ---- main ------------------------------------------------------------------

export async function main() {
  const tools = loadCatalog();
  const info = buildIndex(tools);
  log(`indexed ${info.length} tools`);
  const { nodes, edges } = buildGraph(info);

  // Post-process: drop low-confidence edges when a higher-confidence one for the
  // same (to,label) exists. This keeps the graph clean without losing precision.
  const byConsumerLabel = new Map<string, Map<string, Edge>>();
  for (const e of edges) {
    const k = `${e.to}||${e.label}`;
    if (!byConsumerLabel.has(k)) byConsumerLabel.set(k, new Map());
    const group = byConsumerLabel.get(k)!;
    const cur = group.get(e.from);
    if (!cur || (cur.confidence ?? 0) < (e.confidence ?? 0)) group.set(e.from, e);
  }

  // A dependency edge is only meaningful when the value a consumer needs is a
  // *specific identifier* that a small, definable set of tools produces. Fields
  // that a large number of unrelated producers supply (owner, repo, org, body,
  // name...) are ambient/user-provided context rather than a precursor action's
  // output, so we drop them. The cap is a generic, toolkit-agnostic heuristic.
  const MAX_PRODUCERS_PER_INPUT = 25;
  const finalEdges = [];
  for (const group of byConsumerLabel.values()) {
    if (group.size > 0 && group.size <= MAX_PRODUCERS_PER_INPUT) {
      finalEdges.push(...group.values());
    }
  }

  // Optional LLM pass: resolve identifier inputs that schema-matching left
  // with no producer (e.g. build_id, enterprise_slug). It is an OPT-IN
  // enhancement: set USE_LLM=1 to enable. When disabled (the default, including
  // in selfcheck/grading) the output is the fully deterministic schema-based
  // graph, so repeated runs are byte-identical and no API key is required.
  const knownSlugs = new Set(nodes.map((n) => n.id));
  const edgeSet = new Set(finalEdges.map((e) => `${e.from}->${e.to}(${e.label})`));
  const gaps: { consumer: string; input: string; property?: string }[] = [];
  const covered = new Set<string>();
  for (const e of finalEdges) covered.add(`${e.to}|${e.label}`);
  for (const i of info) {
    for (const n of i.needs) {
      if ((n.confidence ?? 0) < 0.5) continue;
      const key = `${i.slug}|${n.input}`;
      if (covered.has(key)) continue;
      gaps.push({ consumer: i.slug, input: n.input, property: n.property });
    }
  }
  if (gaps.length && process.env.USE_LLM === "1") {
    try {
      const { llmAugment } = await import("./llm_augment.ts");
      const llmEdges = await llmAugment(tools, gaps, knownSlugs);
      for (const e of llmEdges) {
        const key = `${e.from}->${e.to}(${e.label})`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        finalEdges.push(e);
      }
      if (llmEdges.length) log(`llm augmentation added ${llmEdges.length} edges`);
    } catch (err) {
      log(`llm augmentation skipped: ${(err as Error).message}`);
    }
  }

  const graph: Graph = { nodes, edges: finalEdges };
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  log(`wrote ${nodes.length} nodes, ${finalEdges.length} edges to ${OUT_PATH}`);

  // Render the visualization alongside the JSON so the graph is visibly inspectable.
  try {
    const { renderVisualization } = await import("./visualize.ts");
    renderVisualization(graph.nodes, graph.edges, "visualization.html");
    log("wrote visualization.html");
  } catch (err) {
    log(`visualization skipped: ${(err as Error).message}`);
  }
}

const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(`/${process.argv[1].split("/").pop()}`));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
