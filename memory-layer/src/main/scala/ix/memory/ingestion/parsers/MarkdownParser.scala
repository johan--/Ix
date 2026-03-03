package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * Markdown parser that extracts document structure from .md files.
 * Each header becomes a Doc node. Sections are connected by DEFINES relationships
 * based on heading hierarchy (## is defined by #, ### is defined by ##).
 */
class MarkdownParser extends Parser {

  private val HeaderPattern: Regex = """^(#{1,6})\s+(.+)$""".r

  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    // File-level Doc node
    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("markdown")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    var entities = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    // Track heading hierarchy for parent-child relationships
    // Stack of (level, name) — most recent heading at each level
    var headingStack = Vector.empty[(Int, String)]

    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1

      HeaderPattern.findFirstMatchIn(line).foreach { m =>
        val level = m.group(1).length  // 1 for #, 2 for ##, etc.
        val title = m.group(2).trim

        // Find the end of this section (next heading of same or higher level)
        val sectionEnd = findSectionEnd(lines, idx, level)

        // Extract a content summary (first non-empty, non-header line after the heading)
        val contentSummary = extractSummary(lines, idx + 1, sectionEnd)

        val attrs = Map(
          "level"   -> Json.fromInt(level),
          "content" -> Json.fromString(contentSummary)
        )

        entities = entities :+ ParsedEntity(
          name      = title,
          kind      = NodeKind.Doc,
          attrs     = attrs,
          lineStart = lineNum,
          lineEnd   = sectionEnd
        )

        // Determine parent: find nearest heading with lower level number
        headingStack = headingStack.filter(_._1 < level)
        val parent = headingStack.lastOption.map(_._2).getOrElse(fileName)

        relationships = relationships :+ ParsedRelationship(parent, title, "DEFINES")

        headingStack = headingStack :+ (level, title)
      }
    }

    ParseResult(entities, relationships)
  }

  /** Find the end line of a section: the next heading line (any level). Returns 1-based line number. */
  private def findSectionEnd(lines: Array[String], startIdx: Int, level: Int): Int = {
    var i = startIdx + 1
    while (i < lines.length) {
      if (HeaderPattern.findFirstMatchIn(lines(i)).isDefined) {
        return i + 1  // Convert 0-indexed to 1-based line number
      }
      i += 1
    }
    lines.length  // Section extends to end of file
  }

  /** Extract a summary from the first paragraph after a heading (up to 200 chars). */
  private def extractSummary(lines: Array[String], startIdx: Int, endIdx: Int): String = {
    val contentLines = lines.slice(startIdx, endIdx)
      .map(_.trim)
      .filter(l => l.nonEmpty && !l.startsWith("#"))
      .take(3) // Take first 3 content lines for summary
    val summary = contentLines.mkString(" ").take(200)
    summary
  }
}
