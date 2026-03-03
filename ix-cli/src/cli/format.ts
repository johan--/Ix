export function formatContext(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text format
  const { claims, conflicts, decisions, intents, metadata } = result;

  console.log(`\n--- Ix Context: "${metadata.query}" ---`);
  console.log(`Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`);

  if (claims && claims.length > 0) {
    console.log(`\nClaims (${claims.length}):`);
    for (const sc of claims.slice(0, 10)) {
      const conf = (sc.finalScore * 100).toFixed(0);
      console.log(`  [${conf}%] ${sc.claim.statement}`);
    }
    if (claims.length > 10) console.log(`  ... and ${claims.length - 10} more`);
  }

  if (conflicts && conflicts.length > 0) {
    console.log(`\nConflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(`  ! ${c.reason}: ${c.recommendation}`);
    }
  }

  if (decisions && decisions.length > 0) {
    console.log(`\nDecisions (${decisions.length}):`);
    for (const d of decisions) {
      console.log(`  * ${d.title}: ${d.rationale}`);
    }
  }

  if (intents && intents.length > 0) {
    console.log(`\nIntents (${intents.length}):`);
    for (const i of intents) {
      console.log(`  > ${i.statement} [${i.status}]`);
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
    console.log(`  ${n.kind}  ${n.id}  attrs: ${JSON.stringify(n.attrs)}`);
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
    console.log(`  rev ${p.rev}  ${p.patch_id}  ${p.intent || "(no intent)"}`);
  }
}
