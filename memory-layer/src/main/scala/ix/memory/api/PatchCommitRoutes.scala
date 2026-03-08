package ix.memory.api

import cats.effect.IO
import io.circe.syntax._
import io.circe.Json
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphWriteApi
import ix.memory.model.GraphPatch

class PatchCommitRoutes(writeApi: GraphWriteApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "patch" =>
      (for {
        patch  <- req.as[GraphPatch]
        result <- writeApi.commitPatch(patch)
        resp   <- Ok(Json.obj(
          "status" -> result.status.toString.asJson,
          "rev"    -> result.newRev.value.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
