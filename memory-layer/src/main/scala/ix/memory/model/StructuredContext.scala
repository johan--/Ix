package ix.memory.model

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

final case class ScoredClaim(
  claim:      Claim,
  confidence: ConfidenceBreakdown,
  relevance:  Double = 1.0,
  finalScore: Double = 0.0
)

object ScoredClaim {
  implicit val encoder: Encoder[ScoredClaim] = deriveEncoder[ScoredClaim]
  implicit val decoder: Decoder[ScoredClaim] = deriveDecoder[ScoredClaim]
}

final case class ConflictReport(
  id:             ConflictId,
  claimA:         ClaimId,
  claimB:         ClaimId,
  reason:         String,
  recommendation: String
)

object ConflictReport {
  implicit val encoder: Encoder[ConflictReport] = deriveEncoder[ConflictReport]
  implicit val decoder: Decoder[ConflictReport] = deriveDecoder[ConflictReport]
}

final case class DecisionReport(
  title:    String,
  rationale: String,
  entityId: Option[NodeId],
  intentId: Option[NodeId],
  rev:      Rev
)

object DecisionReport {
  implicit val encoder: Encoder[DecisionReport] = deriveEncoder[DecisionReport]
  implicit val decoder: Decoder[DecisionReport] = deriveDecoder[DecisionReport]
}

final case class IntentReport(
  id:           NodeId,
  statement:    String,
  status:       String,
  confidence:   Double,
  parentIntent: Option[String]
)

object IntentReport {
  implicit val encoder: Encoder[IntentReport] = deriveEncoder[IntentReport]
  implicit val decoder: Decoder[IntentReport] = deriveDecoder[IntentReport]
}

final case class ContextMetadata(
  query:        String,
  seedEntities: List[NodeId],
  hopsExpanded: Int,
  asOfRev:      Rev,
  depth:        Option[String]
)

object ContextMetadata {
  implicit val encoder: Encoder[ContextMetadata] = deriveEncoder[ContextMetadata]
  implicit val decoder: Decoder[ContextMetadata] = deriveDecoder[ContextMetadata]
}

final case class StructuredContext(
  claims:    List[ScoredClaim],
  conflicts: List[ConflictReport],
  decisions: List[DecisionReport],
  intents:   List[IntentReport],
  nodes:     List[GraphNode],
  edges:     List[GraphEdge],
  metadata:  ContextMetadata
)

object StructuredContext {
  implicit val encoder: Encoder[StructuredContext] = deriveEncoder[StructuredContext]
  implicit val decoder: Decoder[StructuredContext] = deriveDecoder[StructuredContext]
}
