package ix.memory.context

import ix.memory.model._

trait ConfidenceScorer {
  def score(claim: Claim, ctx: ScoringContext): ScoredClaim
}

case class ScoringContext(
  latestRev:          Rev,
  sourceChanged:      Boolean,
  corroboratingCount: Int,
  conflictState:      ConflictState
)

sealed trait ConflictState
object ConflictState {
  case object NoConflict            extends ConflictState
  case object ExistsHigherAuthority extends ConflictState
  case object ExistsLowerAuthority  extends ConflictState
  case object ResolvedFor           extends ConflictState
  case object ResolvedAgainst       extends ConflictState
}

class ConfidenceScorerImpl extends ConfidenceScorer {
  def score(claim: Claim, ctx: ScoringContext): ScoredClaim = {
    val base = Factor(
      SourceType.baseAuthority(claim.provenance.sourceType),
      s"${claim.provenance.sourceType}, ${claim.provenance.extractor}"
    )

    val verif = Factor(1.0, "no verification data available")

    val recency = computeRecency(claim, ctx)
    val corr = computeCorroboration(ctx.corroboratingCount)
    val conflict = computeConflictPenalty(ctx.conflictState)

    ScoredClaim(claim, ConfidenceBreakdown(base, verif, recency, corr, conflict))
  }

  private def computeRecency(claim: Claim, ctx: ScoringContext): Factor = {
    val revDistance = ctx.latestRev.value - claim.createdRev.value
    val recencyValue = if (ctx.sourceChanged) {
      0.80  // Source has been modified since this claim was observed
    } else if (revDistance <= 5) {
      1.0   // Very recent
    } else if (revDistance <= 50) {
      0.95  // Moderately recent
    } else {
      0.85  // Old but source unchanged
    }
    Factor(recencyValue, s"rev distance: $revDistance, source changed: ${ctx.sourceChanged}")
  }

  private def computeCorroboration(count: Int): Factor = {
    val value = count match {
      case 0 => 1.0   // No data (neutral)
      case 1 => 1.0   // Single source (neutral)
      case 2 => 1.05  // Two sources agree
      case n if n >= 3 => 1.1  // Strong corroboration
    }
    Factor(value, s"$count corroborating sources")
  }

  private def computeConflictPenalty(state: ConflictState): Factor = state match {
    case ConflictState.NoConflict            => Factor(1.0, "no conflicts")
    case ConflictState.ExistsLowerAuthority  => Factor(0.95, "conflict with lower authority source")
    case ConflictState.ExistsHigherAuthority => Factor(0.70, "conflict with higher authority source")
    case ConflictState.ResolvedFor           => Factor(1.05, "conflict resolved in favor")
    case ConflictState.ResolvedAgainst       => Factor(0.30, "conflict resolved against")
  }
}
