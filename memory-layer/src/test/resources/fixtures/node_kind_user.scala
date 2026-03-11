package ix.memory.ingestion

class GraphPatchBuilder {
  def buildNode(kind: NodeKind, name: String): GraphNode = {
    val effectiveKind = NodeKind.File
    val result = createNode(name, effectiveKind)
    result
  }

  private def createNode(name: String, kind: NodeKind): GraphNode = {
    GraphNode(name, kind)
  }
}
