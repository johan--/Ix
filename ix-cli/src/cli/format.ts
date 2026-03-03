import chalk from "chalk";

export function confidenceColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.5) return chalk.yellow;
  return chalk.red;
}

export function formatContext(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text format
  const { claims, conflicts, decisions, intents, metadata } = result;

  console.log(
    "\n" + chalk.bold.cyan(`--- Ix Context: "${metadata.query}" ---`)
  );
  console.log(
    chalk.dim(
      `Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`
    )
  );

  if (claims && claims.length > 0) {
    console.log(`\nClaims (${claims.length}):`);
    for (const sc of claims.slice(0, 10)) {
      const pct = sc.finalScore * 100;
      const conf = pct.toFixed(0);
      const color = confidenceColor(sc.finalScore);
      console.log(`  ${color(`[${conf}%]`)} ${sc.claim.statement}`);
    }
    if (claims.length > 10)
      console.log(chalk.dim(`  ... and ${claims.length - 10} more`));
  }

  if (conflicts && conflicts.length > 0) {
    console.log(`\nConflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(
        `  ${chalk.red.bold("!")} ${c.reason}: ${c.recommendation}`
      );
    }
  }

  if (decisions && decisions.length > 0) {
    console.log(`\nDecisions (${decisions.length}):`);
    for (const d of decisions) {
      console.log(`  ${chalk.blue("*")} ${d.title}: ${d.rationale}`);
    }
  }

  if (intents && intents.length > 0) {
    console.log(`\nIntents (${intents.length}):`);
    for (const i of intents) {
      console.log(
        `  ${chalk.magenta(">")} ${i.statement} [${i.status}]`
      );
    }
  }
  console.log();
}

export function formatNodes(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    console.log(
      `  ${chalk.cyan(n.kind)}  ${chalk.dim(shortId)}  attrs: ${chalk.gray(JSON.stringify(n.attrs))}`
    );
  }
}

export function formatPatches(patches: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(patches, null, 2));
    return;
  }
  if (patches.length === 0) {
    console.log("No patches found.");
    return;
  }
  for (const p of patches) {
    const shortPatchId =
      p.patch_id.length > 8 ? p.patch_id.slice(0, 8) : p.patch_id;
    const intentPart = p.intent
      ? chalk.white(p.intent)
      : chalk.dim("(no intent)");
    console.log(
      `  rev ${chalk.cyan.bold(String(p.rev))}  ${chalk.dim(shortPatchId)}  ${intentPart}`
    );
  }
}

export function formatIntents(intents: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(intents, null, 2));
    return;
  }
  if (intents.length === 0) {
    console.log("No intents found.");
    return;
  }

  // Build parent-child map
  const childrenMap = new Map<string, any[]>();
  const roots: any[] = [];

  for (const intent of intents) {
    if (intent.parentIntent) {
      const siblings = childrenMap.get(intent.parentIntent) || [];
      siblings.push(intent);
      childrenMap.set(intent.parentIntent, siblings);
    } else {
      roots.push(intent);
    }
  }

  function printIntent(intent: any, indent: string, isChild: boolean): void {
    const prefix = isChild
      ? `${indent}${chalk.dim("\u2514\u2500")} `
      : `${indent}${chalk.magenta(">")} `;
    const conf = intent.confidence ?? 0;
    const pctStr = `(${(conf * 100).toFixed(0)}%)`;
    const color = confidenceColor(conf);
    console.log(
      `${prefix}${intent.statement} [${intent.status}] ${color(pctStr)}`
    );

    const children = childrenMap.get(intent.id) || [];
    for (const child of children) {
      printIntent(child, indent + "  ", true);
    }
  }

  for (const root of roots) {
    printIntent(root, "  ", false);
  }
}

export function formatConflicts(conflicts: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
  if (conflicts.length === 0) {
    console.log("No conflicts detected.");
    return;
  }
  for (const c of conflicts) {
    console.log(`  ${chalk.red.bold("!")} ${c.reason}`);
    console.log(`    ${chalk.yellow(c.recommendation)}`);
    console.log(`    Claims: ${c.claimA} vs ${c.claimB}`);
  }
}
