package ix.memory.model

import java.time.Instant

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

sealed trait SourceType
object SourceType {
  case object Code     extends SourceType
  case object Config   extends SourceType
  case object Doc      extends SourceType
  case object Test     extends SourceType
  case object Schema   extends SourceType
  case object Commit   extends SourceType
  case object Comment  extends SourceType
  case object Inferred extends SourceType
  case object Human    extends SourceType

  /** Base authority weight for confidence scoring. */
  def baseAuthority(st: SourceType): Double = st match {
    case Code     => 0.90
    case Config   => 0.85
    case Doc      => 0.70
    case Test     => 0.95
    case Schema   => 0.85
    case Commit   => 0.80
    case Comment  => 0.50
    case Inferred => 0.40
    case Human    => 0.80
  }

  private val nameMap: Map[String, SourceType] = Map(
    "code"     -> Code,
    "config"   -> Config,
    "doc"      -> Doc,
    "test"     -> Test,
    "schema"   -> Schema,
    "commit"   -> Commit,
    "comment"  -> Comment,
    "inferred" -> Inferred,
    "human"    -> Human
  )

  implicit val encoder: Encoder[SourceType] = Encoder[String].contramap {
    case Code     => "code"
    case Config   => "config"
    case Doc      => "doc"
    case Test     => "test"
    case Schema   => "schema"
    case Commit   => "commit"
    case Comment  => "comment"
    case Inferred => "inferred"
    case Human    => "human"
  }

  implicit val decoder: Decoder[SourceType] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown SourceType: $s")
  }
}

final case class Provenance(
  sourceUri:  String,
  sourceHash: Option[String],
  extractor:  String,
  sourceType: SourceType,
  observedAt: Instant
)

object Provenance {
  implicit val instantEncoder: Encoder[Instant] = Encoder[String].contramap(_.toString)
  implicit val instantDecoder: Decoder[Instant] = Decoder[String].emap { s =>
    try Right(Instant.parse(s))
    catch { case e: Exception => Left(s"Invalid instant: $s") }
  }

  implicit val encoder: Encoder[Provenance] = deriveEncoder[Provenance]
  implicit val decoder: Decoder[Provenance] = deriveDecoder[Provenance]
}
