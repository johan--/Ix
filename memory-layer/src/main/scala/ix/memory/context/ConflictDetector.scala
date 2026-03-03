package ix.memory.context

import java.util.UUID
import ix.memory.model._

trait ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport]
}

class ConflictDetectorImpl extends ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] = {
    // Group claims by entityId
    val grouped = claims.groupBy(_.claim.entityId)

    grouped.values.flatMap { entityClaims =>
      // Only consider active claims
      val active = entityClaims.filter(_.claim.status == ClaimStatus.Active)

      // Find pairs with different statements (same entity, different facts)
      if (active.size < 2) Vector.empty
      else {
        val pairs = for {
          i <- active.indices
          j <- (i + 1) until active.size
          a = active(i)
          b = active(j)
          if a.claim.statement != b.claim.statement
        } yield {
          // The higher-confidence claim is the recommended winner
          val (winner, _) = if (a.confidence.score >= b.confidence.score) (a, b) else (b, a)
          ConflictReport(
            id = ConflictId(UUID.randomUUID()),
            claimA = a.claim.id,
            claimB = b.claim.id,
            reason = s"Contradictory statements on entity ${a.claim.entityId.value}: " +
                     s"'${a.claim.statement}' vs '${b.claim.statement}'",
            recommendation = s"Prefer '${winner.claim.statement}' (confidence: ${winner.confidence.score})"
          )
        }
        pairs.toVector
      }
    }.toVector
  }
}

/** Stub kept for backward compatibility -- prefer ConflictDetectorImpl. */
class DefaultConflictDetector extends ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] =
    Vector.empty
}
