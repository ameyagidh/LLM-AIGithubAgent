/**
 * Generalization check. Runs the generator on a small NON-GitHub synthetic
 * catalog (a fictional ACME orders toolkit) and asserts that it produces the
 * expected producer->consumer edges. This proves the generator is catalog-driven
 * and not hardcoded to the GitHub example. Usage: `npm run gen-synthetic`.
 */
import { readFileSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";

const CATALOG = "synthetic_catalog.json";
const OUT = "dependency_graph.json";
if (!existsSync(CATALOG)) {
  console.error(`missing ${CATALOG}`);
  process.exit(1);
}

execFileSync("node", ["--import", "tsx", "src/generate.ts", CATALOG], {
  stdio: "inherit",
});

const g = JSON.parse(readFileSync(OUT, "utf-8"));
const edges = new Set(
  (g.edges ?? []).map((e: any) => `${e.from}|${e.to}|${e.label}`),
);

const expected = [
  "ACME_CREATE_AN_ORDER|ACME_SHIP_AN_ORDER|order_number",
  "ACME_LIST_CUSTOMER_ORDERS|ACME_SHIP_AN_ORDER|order_number",
  "ACME_CREATE_AN_ORDER|ACME_GET_ORDER_STATUS|order_number",
  "ACME_LIST_CUSTOMER_ORDERS|ACME_GET_ORDER_STATUS|order_number",
  "ACME_CREATE_AN_ORDER|ACME_REFUND_AN_ORDER|order_number",
  "ACME_LIST_CUSTOMER_ORDERS|ACME_REFUND_AN_ORDER|order_number",
];

const missing = expected.filter((e) => !edges.has(e));
const nonGitHub = (g.edges ?? []).every((e: any) =>
  String(e.from).startsWith("ACME_"),
);

if (missing.length === 0 && nonGitHub) {
  console.log(
    `PASS: synthetic catalog produced ${g.edges.length} ACME edges, all expected dependencies present.`,
  );
} else {
  console.error("FAIL: expected", expected);
  console.error("missing:", missing);
  console.error("nonGitHub:", nonGitHub);
  process.exit(1);
}

try {
  rmSync(OUT, { force: true });
} catch {
  /* ignore */
}
