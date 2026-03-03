package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import ix.memory.model.NodeKind

class MarkdownParserSpec extends AnyFlatSpec with Matchers {

  val parser = new MarkdownParser()

  // Test 1: Creates File entity
  "MarkdownParser" should "create a File entity for the markdown file" in {
    val result = parser.parse("README.md", "# Hello")
    result.entities.exists(e => e.name == "README.md" && e.kind == NodeKind.File) shouldBe true
    val file = result.entities.find(_.kind == NodeKind.File).get
    file.attrs.get("language").map(_.noSpaces) shouldBe Some("\"markdown\"")
  }

  // Test 2: Extracts headers as Doc nodes
  it should "extract headers as Doc nodes" in {
    val source = """# Overview
      |Some intro text.
      |
      |## Architecture
      |Details about architecture.
      |
      |## API Design
      |Details about API.""".stripMargin
    val result = parser.parse("design.md", source)
    result.entities.exists(e => e.name == "Overview" && e.kind == NodeKind.Doc) shouldBe true
    result.entities.exists(e => e.name == "Architecture" && e.kind == NodeKind.Doc) shouldBe true
    result.entities.exists(e => e.name == "API Design" && e.kind == NodeKind.Doc) shouldBe true
  }

  // Test 3: Hierarchy — ## under # creates DEFINES relationship
  it should "create DEFINES relationships based on heading hierarchy" in {
    val source = """# Top
      |## Sub
      |### SubSub""".stripMargin
    val result = parser.parse("doc.md", source)
    // File DEFINES Top (# is top-level)
    result.relationships.exists(r => r.srcName == "doc.md" && r.dstName == "Top" && r.predicate == "DEFINES") shouldBe true
    // Top DEFINES Sub
    result.relationships.exists(r => r.srcName == "Top" && r.dstName == "Sub" && r.predicate == "DEFINES") shouldBe true
    // Sub DEFINES SubSub
    result.relationships.exists(r => r.srcName == "Sub" && r.dstName == "SubSub" && r.predicate == "DEFINES") shouldBe true
  }

  // Test 4: Level attr is correct
  it should "store the heading level in attrs" in {
    val source = """# Level 1
      |## Level 2
      |### Level 3""".stripMargin
    val result = parser.parse("doc.md", source)
    val h1 = result.entities.find(_.name == "Level 1").get
    val h2 = result.entities.find(_.name == "Level 2").get
    val h3 = result.entities.find(_.name == "Level 3").get
    h1.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(1)
    h2.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(2)
    h3.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(3)
  }

  // Test 5: Content summary extracted
  it should "extract content summary from section body" in {
    val source = """# Introduction
      |This is the introduction to the project.
      |It explains the main goals.""".stripMargin
    val result = parser.parse("readme.md", source)
    val intro = result.entities.find(_.name == "Introduction").get
    val content = intro.attrs.get("content").flatMap(_.asString).getOrElse("")
    content should include("introduction")
  }

  // Test 6: Empty markdown
  it should "handle empty markdown files" in {
    val result = parser.parse("empty.md", "")
    result.entities.exists(_.kind == NodeKind.File) shouldBe true
    result.entities.count(_.kind == NodeKind.Doc) shouldBe 0
  }

  // Test 7: Markdown with no headers
  it should "handle markdown with no headers" in {
    val source = "Just some text with no headers."
    val result = parser.parse("notes.md", source)
    result.entities.count(_.kind == NodeKind.Doc) shouldBe 0
    result.relationships shouldBe empty
  }

  // Test 8: Multiple sections at same level
  it should "handle sibling sections at the same level" in {
    val source = """# Main
      |## Section A
      |Content A
      |## Section B
      |Content B""".stripMargin
    val result = parser.parse("doc.md", source)
    // Both should be DEFINES'd by Main
    result.relationships.exists(r => r.srcName == "Main" && r.dstName == "Section A") shouldBe true
    result.relationships.exists(r => r.srcName == "Main" && r.dstName == "Section B") shouldBe true
  }

  // Test 9: Section line ranges
  it should "compute correct line ranges for sections" in {
    val source = """# Intro
      |Line 2
      |Line 3
      |## Details
      |Line 5""".stripMargin
    val result = parser.parse("doc.md", source)
    val intro = result.entities.find(_.name == "Intro").get
    intro.lineStart shouldBe 1
    intro.lineEnd shouldBe 4  // Ends at line before ## Details
  }
}
