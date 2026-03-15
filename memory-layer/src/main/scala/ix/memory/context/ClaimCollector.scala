package ix.memory.context

import cats.effect.IO

import ix.memory.db.GraphQueryApi
import ix.memory.model._

class ClaimCollector(queryApi: GraphQueryApi) {

  def collect(nodeIds: Vector[NodeId]): IO[Vector[Claim]] =
    queryApi.getClaimsBatch(nodeIds).map(_.distinctBy(_.id))
}
