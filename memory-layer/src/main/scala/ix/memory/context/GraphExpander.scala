package ix.memory.context

import cats.effect.IO
import cats.syntax.parallel._

import ix.memory.db.{GraphQueryApi, Direction, ExpandResult}
import ix.memory.model._

class GraphExpander(queryApi: GraphQueryApi) {

  /** Low-priority edge predicates — skipped at hop 2+ to focus expansion. */
  private val lowPriorityPredicates: Set[String] =
    Set("mentioned_in", "changed_with", "same_as")

  def expand(seeds: Vector[NodeId], hops: Int = 1,
             predicates: Option[Set[String]] = None,
             asOfRev: Option[Rev] = None): IO[ExpandResult] =
    seeds
      .parTraverse { nodeId =>
        queryApi.expand(nodeId, Direction.Both, predicates, hops, asOfRev)
      }
      .map { results =>
        val allNodes = results.flatMap(_.nodes).distinctBy(_.id)
        val allEdges = results.flatMap(_.edges).distinctBy(_.id)
        // Filter out low-priority edges when expanding beyond 1 hop
        val filteredEdges = if (hops > 1)
          allEdges.filterNot(e => lowPriorityPredicates.contains(e.predicate.value.toLowerCase))
        else
          allEdges
        ExpandResult(allNodes, filteredEdges)
      }
}
