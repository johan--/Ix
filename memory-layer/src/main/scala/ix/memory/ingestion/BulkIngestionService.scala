package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.syntax.all._
import cats.effect.implicits._
import io.circe.Json
import io.circe.syntax._

import ix.memory.db.{BulkWriteApi, CommitResult, CommitStatus, FileBatch, GraphQueryApi}
import ix.memory.model._

/**
 * High-performance ingestion service that:
 * 1. Discovers files (with optional language filter)
 * 2. Parses files in parallel (bounded by CPU cores)
 * 3. Batches parsed results
 * 4. Bulk-inserts via Document API
 */
class BulkIngestionService(
  parserRouter: ParserRouter,
  bulkWriteApi: BulkWriteApi,
  queryApi: GraphQueryApi
) {

  private val parallelism = Runtime.getRuntime.availableProcessors.max(2)
  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

  /**
   * Ingest files under a path using parallel parsing and bulk writes.
   */
  def ingestPath(
    path: Path,
    language: Option[String],
    recursive: Boolean
  ): IO[IngestionResult] = {
    for {
      files      <- discoverFiles(path, language, recursive)
      hashMap    <- loadExistingHashes(files)
      batches    <- files.parTraverseN(parallelism) { f =>
        parseFile(f, hashMap).attempt
      }
      validBatches = batches.collect { case Right(Some(b)) => b }
      skippedCount = batches.count {
        case Right(None) => true
        case _ => false
      }
      latestRev  <- queryApi.getLatestRev
      result     <- if (validBatches.isEmpty) IO.pure(CommitResult(latestRev, CommitStatus.Ok))
                    else bulkWriteApi.commitBatch(validBatches.toVector, latestRev.value)
    } yield IngestionResult(
      filesProcessed  = files.size,
      patchesApplied  = validBatches.size,
      filesSkipped    = skippedCount,
      entitiesCreated = validBatches.flatMap(_.patch.ops.collect { case _: PatchOp.UpsertNode => 1 }).size,
      latestRev       = result.newRev
    )
  }

  /**
   * Parse a single file into a FileBatch (or None if unchanged).
   */
  private def parseFile(filePath: Path, hashMap: Map[String, String]): IO[Option[FileBatch]] = {
    for {
      bytes <- IO.blocking(Files.readAllBytes(filePath))
      result <- if (bytes.isEmpty) IO.pure(None)
                else {
                  val hash = sha256Bytes(bytes)
                  hashMap.get(filePath.toString) match {
                    case Some(existingHash) if existingHash == hash =>
                      IO.pure(None)
                    case _ =>
                      for {
                        source <- IO.blocking {
                          try new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                          catch { case _: Throwable => new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1) }
                        }
                        parserOpt = parserRouter.parserFor(filePath.toString)
                        parseResult = parserOpt match {
                          case Some(p) => p.parse(filePath.getFileName.toString, source)
                          case None    => genericTextParse(filePath.getFileName.toString, source)
                        }
                        patch = GraphPatchBuilder.build(filePath.toString, Some(hash), parseResult)
                        _ <- IO.fromEither(PatchValidator.validate(patch).left.map(msg => new IllegalStateException(msg)))
                        provenance = buildProvenanceMap(patch)
                      } yield Some(FileBatch(filePath.toString, Some(hash), patch, provenance))
                  }
                }
    } yield result
  }

  private def loadExistingHashes(files: List[Path]): IO[Map[String, String]] = {
    val paths = files.map(_.toString)
    queryApi.getSourceHashes(paths)
  }

  private def buildProvenanceMap(patch: GraphPatch): java.util.Map[String, AnyRef] = {
    val json = Json.obj(
      "source_uri"  -> Json.fromString(patch.source.uri),
      "source_hash" -> patch.source.sourceHash.fold(Json.Null)(Json.fromString),
      "extractor"   -> Json.fromString(patch.source.extractor),
      "source_type" -> Json.fromString(patch.source.sourceType.asJson.asString.getOrElse("code")),
      "observed_at" -> Json.fromString(patch.timestamp.toString)
    )
    mapper.readValue(json.noSpaces, classOf[java.util.Map[String, AnyRef]])
  }

  private def discoverFiles(
    path: Path,
    language: Option[String],
    recursive: Boolean
  ): IO[List[Path]] = IO.blocking {
    val extensions = FileDiscovery.extensionsFor(language)
    if (Files.isRegularFile(path)) {
      if (FileDiscovery.matchesFilter(path, extensions)) List(path) else List.empty
    } else if (Files.isDirectory(path)) {
      // Try git ls-files first (respects .gitignore), fall back to manual walk
      FileDiscovery.tryGitLsFiles(path, recursive, extensions)
        .getOrElse(FileDiscovery.walkFiles(path, recursive, extensions))
    } else List.empty
  }

  private def sha256Bytes(bytes: Array[Byte]): String = {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    md.digest(bytes).map("%02x".format(_)).mkString
  }

  private def genericTextParse(fileName: String, source: String): ParseResult = {
    val lines = if (source.isEmpty) 1 else source.count(_ == '\n') + 1
    ParseResult(
      entities = Vector(ParsedEntity(
        name = fileName, kind = NodeKind.File,
        attrs = Map("content" -> Json.fromString(source)),
        lineStart = 1, lineEnd = lines
      )),
      relationships = Vector.empty
    )
  }
}
