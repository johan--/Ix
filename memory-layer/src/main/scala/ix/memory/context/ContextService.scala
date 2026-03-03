package ix.memory.context

import cats.effect.IO

import ix.memory.db.GraphQueryApi
import ix.memory.model._

class ContextService(
  queryApi:         GraphQueryApi,
  seeder:           GraphSeeder,
  expander:         GraphExpander,
  claimCollector:   ClaimCollector,
  confidenceScorer: ConfidenceScorer,
  conflictDetector: ConflictDetector
) {

  def query(question: String,
            asOfRev: Option[Rev] = None,
            depth: Option[String] = None): IO[StructuredContext] =
    for {
      // 1. Extract entity keywords from the natural language query
      terms <- IO.pure(EntityExtractor.extract(question))

      // 2. Seed: search the graph for nodes matching extracted terms
      seeds <- seeder.seed(terms, asOfRev)

      // 3. Expand: traverse the graph 1 hop from each seed (with edge priority)
      expanded <- expander.expand(seeds.map(_.id), hops = 1, asOfRev = asOfRev)

      // 4. Collect claims for all discovered nodes
      allNodeIds = (seeds.map(_.id) ++ expanded.nodes.map(_.id)).distinct
      claims <- claimCollector.collect(allNodeIds)

      // 5. Score each claim for confidence
      rev <- asOfRev.fold(queryApi.getLatestRev)(IO.pure)
      scored = claims.map { c =>
        confidenceScorer.score(c, ScoringContext(
          latestRev          = rev,
          sourceChanged      = false,
          corroboratingCount = 1,
          conflictState      = ConflictState.NoConflict,
          intentAlignment    = IntentAlignment.NoConnection,
          observedAt         = c.provenance.observedAt
        ))
      }

      // 6. Detect conflicts among scored claims
      conflicts = conflictDetector.detect(scored)

      // 7. Relevance score: weight claims by hop distance from seeds
      relevant = RelevanceScorer.score(scored, seeds.map(_.id).toSet, expanded.edges)

      // 8. Rank claims by finalScore (relevance x confidence) descending
      ranked = ContextRanker.rank(relevant)

      // Collect decisions and intents from expanded nodes
      allNodes = (seeds ++ expanded.nodes).distinctBy(_.id)
      decisions = allNodes.filter(_.kind == NodeKind.Decision).map(toDecisionReport(_, rev))
      intents   = allNodes.filter(_.kind == NodeKind.Intent).map(toIntentReport)

    } yield StructuredContext(
      claims    = ranked.toList,
      conflicts = conflicts.toList,
      decisions = decisions.toList,
      intents   = intents.toList,
      nodes     = allNodes.toList,
      edges     = expanded.edges.toList,
      metadata  = ContextMetadata(
        query        = question,
        seedEntities = seeds.map(_.id).toList,
        hopsExpanded = 1,
        asOfRev      = rev,
        depth        = depth.orElse(Some("standard"))
      )
    )

  private def toDecisionReport(node: GraphNode, rev: Rev): DecisionReport =
    DecisionReport(
      title     = node.attrs.hcursor.get[String]("title").getOrElse(node.id.value.toString),
      rationale = node.attrs.hcursor.get[String]("rationale").getOrElse(""),
      entityId  = Some(node.id),
      intentId  = node.attrs.hcursor.get[String]("intent_id").toOption.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(NodeId(_))
      ),
      rev       = rev
    )

  private def toIntentReport(node: GraphNode): IntentReport =
    IntentReport(
      id           = node.id,
      statement    = node.attrs.hcursor.get[String]("statement").getOrElse(""),
      status       = node.attrs.hcursor.get[String]("status").getOrElse("active"),
      confidence   = node.attrs.hcursor.get[Double]("confidence").getOrElse(1.0),
      parentIntent = node.attrs.hcursor.get[String]("parent_intent").toOption
    )
}
