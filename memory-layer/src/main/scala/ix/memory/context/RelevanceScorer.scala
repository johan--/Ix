package ix.memory.context

import ix.memory.model._

object RelevanceScorer {
  def score(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge]
  ): Vector[ScoredClaim] = {
    val oneHopIds = expandedEdges
      .flatMap(e => Vector(e.src, e.dst))
      .toSet -- seedNodeIds

    claims.map { sc =>
      val relevance = if (seedNodeIds.contains(sc.claim.entityId)) 1.0
                      else if (oneHopIds.contains(sc.claim.entityId)) 0.7
                      else 0.4
      sc.copy(relevance = relevance, finalScore = relevance * sc.confidence.score)
    }
  }
}
