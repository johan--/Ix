package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

/**
 * Config file parser for YAML, JSON, and TOML files.
 * Extracts a Config node for the file and ConfigEntry nodes for top-level keys.
 * Uses simple regex heuristics — not a full YAML/TOML parser.
 */
class ConfigParser extends Parser {

  def parse(fileName: String, source: String): ParseResult = {
    val format = detectFormat(fileName)
    val entries = format match {
      case "json" => parseJson(source)
      case "yaml" => parseYaml(source)
      case "toml" => parseToml(source)
      case _      => Vector.empty
    }

    // File-level Config node
    val configEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.Config,
      attrs     = Map("format" -> Json.fromString(format)),
      lineStart = 1,
      lineEnd   = source.split("\n", -1).length
    )

    // ConfigEntry nodes for each top-level key
    val entryEntities = entries.map { case (key, value, line) =>
      ParsedEntity(
        name      = key,
        kind      = NodeKind.ConfigEntry,
        attrs     = Map(
          "value"  -> Json.fromString(value),
          "format" -> Json.fromString(format)
        ),
        lineStart = line,
        lineEnd   = line
      )
    }

    // Relationships: Config DEFINES each ConfigEntry
    val relationships = entries.map { case (key, _, _) =>
      ParsedRelationship(fileName, key, "DEFINES")
    }

    ParseResult(
      entities      = configEntity +: entryEntities,
      relationships = relationships
    )
  }

  private def detectFormat(fileName: String): String = {
    if (fileName.endsWith(".json")) "json"
    else if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) "yaml"
    else if (fileName.endsWith(".toml")) "toml"
    else "unknown"
  }

  /** Parse JSON: extract top-level keys from objects. Simple regex approach. */
  private def parseJson(source: String): Vector[(String, String, Int)] = {
    val lines = source.split("\n", -1)
    var results = Vector.empty[(String, String, Int)]
    // Match top-level JSON object keys: "key": value
    // Only match lines at indent level 2 (1 level into the root object)
    val KeyPattern = """^\s{0,4}"(\w[\w.-]*)"\s*:\s*(.+?),?\s*$""".r
    for ((line, idx) <- lines.zipWithIndex) {
      KeyPattern.findFirstMatchIn(line).foreach { m =>
        val key = m.group(1)
        val value = m.group(2).trim.stripPrefix("\"").stripSuffix("\"").stripSuffix(",")
        results = results :+ (key, value, idx + 1)
      }
    }
    results
  }

  /** Parse YAML: extract top-level keys (no indentation). */
  private def parseYaml(source: String): Vector[(String, String, Int)] = {
    val lines = source.split("\n", -1)
    var results = Vector.empty[(String, String, Int)]
    // Top-level YAML keys start at column 0 (no indentation)
    val KeyPattern = """^([a-zA-Z_][\w.-]*)\s*:\s*(.*)$""".r
    for ((line, idx) <- lines.zipWithIndex) {
      // Skip comments and empty lines
      if (!line.trim.startsWith("#") && line.trim.nonEmpty) {
        KeyPattern.findFirstMatchIn(line).foreach { m =>
          val key = m.group(1)
          val value = m.group(2).trim
          // Skip keys that start a nested block (value is empty or just a comment)
          val cleanValue = if (value.isEmpty || value.startsWith("#")) "(block)" else value
          results = results :+ (key, cleanValue, idx + 1)
        }
      }
    }
    results
  }

  /** Parse TOML: extract top-level key-value pairs and section keys. */
  private def parseToml(source: String): Vector[(String, String, Int)] = {
    val lines = source.split("\n", -1)
    var results = Vector.empty[(String, String, Int)]
    var inSection = false // Track if we're inside a [section]
    val SectionPattern = """^\[.*\]""".r
    val KeyPattern = """^([a-zA-Z_][\w.-]*)\s*=\s*(.+)$""".r
    for ((line, idx) <- lines.zipWithIndex) {
      if (!line.trim.startsWith("#") && line.trim.nonEmpty) {
        SectionPattern.findFirstMatchIn(line).foreach { _ =>
          inSection = true
        }
        if (!inSection) {
          KeyPattern.findFirstMatchIn(line).foreach { m =>
            val key = m.group(1)
            val value = m.group(2).trim.stripPrefix("\"").stripSuffix("\"")
            results = results :+ (key, value, idx + 1)
          }
        }
        // Also capture section-level keys as section.key
        if (inSection) {
          KeyPattern.findFirstMatchIn(line).foreach { m =>
            val key = m.group(1)
            val value = m.group(2).trim.stripPrefix("\"").stripSuffix("\"")
            results = results :+ (key, value, idx + 1)
          }
        }
      }
    }
    results
  }
}
