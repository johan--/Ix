package ix.memory.model

sealed trait NodeKind

object NodeKind {
  case object File extends NodeKind
  case object Module extends NodeKind
  case object Class extends NodeKind
  case object Function extends NodeKind
  case object Method extends NodeKind
}
