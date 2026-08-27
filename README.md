# Litmus Dep Graph — Solution Documentation

**Author:** Ameya Gidh
**Repo:** `dep-graph/` (assessment submission)
**Deliverable:** `dependency_graph.json` at repo root + offline `visualization.html`

---

## 1. The Problem

Litmus supplies a **JSON catalog of tools**. Each tool has:
- a `name` / slug
- a description
- an **input schema** (params it *accepts*)
- an **output schema** (fields it *produces*)

The task: generate a **directed dependency graph**:

```
edge:  { from: producer_tool, to: consumer_tool, label: consumer_required_param }
```

An edge `A -> B [p]` exists when **tool A's output** can satisfy **a required input param `p` of tool B**. Direction is **producer → consumer**.

For a GitHub-style catalog, the intuition is: *"Which tool must run first so that its output ID (`issue_number`, `milestone_number`, `invitation_id`, ...) can be fed into the next tool?"*

**Output:** `dependency_graph.json` at the repo root, with nodes + edges.

---

## 2. Architecture

```
src/
  generate.ts        # ENTRY POINT — deterministic schema matcher
  llm_augment.ts     # OPT-IN (USE_LLM=1) — LLM gap-filler
  visualize.ts       # renders offline visualization.html
  selfcheck.ts       # npm run selfcheck — runs generator + reports stats
  check_synthetic.ts # npm run gen-synthetic — non-GitHub generalization test

github_catalog.json   # real 893-tool catalog
synthetic_catalog.json # ACME-orders catalog (generalization proof)
generator.json        # build/run spec used by the grader
package.json          # scripts + deps (openai, tsx)
```

```
build: npm install --legacy-peer-deps
run:   node --import tsx src/generate.ts <catalog_path>
       # writes dependency_graph.json at repo root
```

---

## 3. The Core Algorithm (`generate.ts`)

### 3.1 Catalog parsing
- Read the catalog path from `argv[2]`.
- Normalize wrappers: accept raw arrays **and** objects like `{"tools":[...]}`.
- Tolerate malformed entries: a missing `slug` falls back to `name`; missing `name` skips the tool.

### 3.2 Schema extraction
For every tool, walk its JSON Schema and produce:
- a set of **input params** (with required flag),
- a set of **output fields**.

References (`$ref` → `$defs`) are resolved recursively, including list-wrapped output schemas (e.g. output is `{type: array, items: {$ref: '#/$defs/foo'}}` → drill into `foo`'s properties) and nested/near-property references.

### 3.3 Classifying input params (the key design decision)
This is where precision-over-recall is decided. Params are split into:

**A. Ambient params — DROPPED (no edge).**
Params that are well-known scalar values a caller supplies themselves, *not* produced by another tool:
- `repo`, `owner`, `org` (repository context — the user already knows these)
- `issue_number`, `pull_number`, `milestone_number`, `comment_id`, `invitation_id`, `cache_id`, etc. — in *many* catalogs these are actually **produced** by other tools, so they must be handled carefully.

**B. Associative-ID params — EDGES.**
The `label` for real dependency edges. These are IDs one tool creates that another needs as input. Finding them is the actual dependency detection.

### 3.4 The matcher
For each consumer's **required** input param `p` (from class B), search all producers and connect any tool whose **output fields exposes `p`**:

```
edge = { from: producer, to: consumer, label: p }
```

- `MAX_PRODUCERS_PER_INPUT = 25` caps fan-out so the graph stays bounded and readable.
- Self-loops are filtered out.
- Only the **required** inputs create edges (optional params are risks, not hard dependencies).

### 3.5 Output
- Nodes: `{id: <tool slug>}`.
- Edges: `{from, to, label}`.
- `provenance` ratio tracked; no dangling `$ref`s.

**Real catalog result:** 893 nodes, 3955 edges, fully deterministic.

---

## 4. Design Trade-offs (decisions & reasoning)

### 4.1 Deterministic-by-default vs. LLM augmentation
- **Problem found:** originally the LLM ran on *every* invocation and loaded `.env` directly, so results were non-deterministic (edge counts varied: 3955 / 3982 / 3991 / 3992) — a hard failure for a reproducible graded artifact.
- **Fix:** LLM now runs **only** when `USE_LLM=1`. The default path is a pure, deterministic schema matcher (verified byte-identical md5 `bae9f1ba...` → 3955 edges) requiring **no API key**.
- **Trade-off:** the LLM adds ~27 edges the schema heuristic can't see (e.g. `cache_id`, `build_id`, `tag_protection_id`) for 3982 total, but sacrifices reproducibility. Decision: **determinism wins by default**; LLM is an explicit opt-in enhancement.

### 4.2 Ambient `repo`/`owner`/`org` — precision over recall
- **Experiments:** enabling `repo`/`repository` as edges flooded the graph to **11,924 edges** with `repo` alone contributing 7,936 — low-quality noise, since "repository context" is ambient and self-evident to the caller, not a real dependency.
- **Decision:** keep `repo`, `owner`, `org` ambient (dropped). The canonical README examples (`issue_number`, `pull_number`) don't require `repo` as an edge.

### 4.3 Producer fan-out cap (`MAX_PRODUCERS_PER_INPUT = 25`)
- All-or-nothing cap keeps the graph tractable.
- Tried a more sophisticated "top-K producers by score" refinement; it added **no value** given ambient `repo` is dropped, so the simpler all-or-nothing cap was kept.

### 4.4 Generic, not GitHub-hardcoded
- No tool names, slugs, or relation maps are hardcoded. Everything is derived from schemas.
- **Proof:** `synthetic_catalog.json` is a non-GitHub **ACME-orders** domain (CREATE_AN_ORDER → SHIP_AN_ORDER → GET_ORDER_STATUS → REFUND_AN_ORDER). The generator derives `ACME_* -> ACME_* [order_number]` edges purely from schemas — no GitHub knowledge required. Verified via `npm run gen-synthetic`.

---

## 5. Verification & Robustness

### 5.1 Edge cases tested (no crashes)
- Empty list catalog
- `{"tools":[]}` wrapper
- Tool with no output schema
- `data.$ref` with no properties
- List-wrapped `data.$ref`
- Dangling `$ref` (missing `$defs`)
- Numeric property keys
- Malformed entries (missing slug → fall back to `name`)

### 5.2 Canonical correctness check
```
GITHUB_LIST_REPOSITORY_ISSUES  ->  GITHUB_CREATE_AN_ISSUE_COMMENT  [issue_number]
GITHUB_LIST_PULL_REQUESTS      ->  GITHUB_MERGE_A_PULL_REQUEST     [pull_number]
milestone_number  ->  only connects to the 4 milestone tools
```
✓ All correct. Provenance 1.0, 0 self-loops, 0 dangling refs.

### 5.3 Determinism
Repeat runs produce identical output md5 (`bae9f1ba72f997fe05858939759c0bcd`, 3955 edges).

### 5.4 Comparison vs the only other on-disk solution
- A second implementation (Claude's) on disk produces **0 edges** on the real 893-tool catalog (fails the actual deliverable).
- My solution: **3955 edges** deterministic (3982 with optional LLM).

---

## 6. Grading Compatibility

- `generator.json` matches the grader spec exactly:
  - build: `npm install --legacy-peer-deps`
  - run: `node --import tsx src/generate.ts`
- The exact grader command was verified:
  `node --import tsx src/generate.ts github_catalog.json` → writes `dependency_graph.json` (893 nodes / 3955 edges) deterministically.
- `npm run selfcheck` and `npm run gen-synthetic` both pass.

---

## 7. File / Clean-commit Notes

- `.gitignore` protects: `node_modules/`, `.env*`, `selfcheck_graph.json`, `dependency_graph.json`, `.litmus/`, `.claude/`, `.github/hooks/`.
- `dependency_graph.json` is **not** committed — it is regenerated at grade time (matches specification).
- Committed files that matter: `visualization.html`, `README.md`, `src/*.ts`, `synthetic_catalog.json`, `github_catalog.json`, `generator.json`, `package.json`, `LITMUS-AI-NOTICE.md`.
- This documentation file lives **outside** the repo (temp dir) and is **never committed**.

### Commit history (clean, linear, single branch `master`)
```
ddb8245  Make generator deterministic by default; LLM becomes opt-in
e15c4ab  Add LLM augmentation, visualization, and generalization check
0425ba7  Implement schema-based dependency graph generator
d784ccb  Assessment: initial state
```
No merges, no reverts, no empty commits. Working tree clean.

---

## 8. Status & Next Steps

- All edge cases tested, deterministic output confirmed, generalization proven.
- Working tree clean; committed `visualization.html` matches the regenerated deterministic graph byte-for-byte.
- Awaiting user approval before running `litmus submit` from `dep-graph/`.
