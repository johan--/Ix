package ix.memory.context

import ix.memory.model.ScoredClaim

object ContextRanker {

  def rank(claims: Vector[ScoredClaim]): Vector[ScoredClaim] =
    claims.sortBy(sc => -sc.finalScore)
}
