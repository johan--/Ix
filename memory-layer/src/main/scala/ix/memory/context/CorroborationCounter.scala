package ix.memory.context

import ix.memory.model._

/**
 * Counts how many independent sources corroborate each claim.
 *
 * Two claims "corroborate" each other if:
 * 1. They share the same entityId
 * 2. Their statements share at least one keyword stem (same 4-char prefix)
 * 3. They come from different source URIs (independent sources)
 *
 * Returns a Map from ClaimId to corroboration count.
 */
object CorroborationCounter {

  def count(claims: Vector[Claim]): Map[ClaimId, Int] = {
    // Group claims by entityId
    val byEntity = claims.groupBy(_.entityId)

    byEntity.values.flatMap { entityClaims =>
      // For each claim, count how many other claims from different sources
      // have overlapping keyword stems
      entityClaims.map { claim =>
        val stems = tokenize(claim.statement).map(_.take(4).toLowerCase).toSet
        val corroborating = entityClaims.count { other =>
          other.id != claim.id &&
          other.provenance.sourceUri != claim.provenance.sourceUri &&
          {
            val otherStems = tokenize(other.statement).map(_.take(4).toLowerCase).toSet
            (stems intersect otherStems).nonEmpty
          }
        }
        claim.id -> corroborating
      }
    }.toMap
  }

  /** Split on non-alphanumeric runs, keep tokens of length >= 3. */
  private def tokenize(s: String): Vector[String] =
    s.split("[^a-zA-Z0-9]+").filter(_.length >= 3).toVector
}
