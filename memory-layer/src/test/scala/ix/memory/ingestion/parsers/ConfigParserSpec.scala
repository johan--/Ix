package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import ix.memory.model.NodeKind

class ConfigParserSpec extends AnyFlatSpec with Matchers {

  val parser = new ConfigParser()

  // Test 1: JSON — creates Config entity for file
  "ConfigParser" should "create a Config entity for a JSON file" in {
    val source = """{ "name": "my-app", "version": "1.0.0" }"""
    val result = parser.parse("package.json", source)
    result.entities.exists(e => e.name == "package.json" && e.kind == NodeKind.Config) shouldBe true
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"json\"")
  }

  // Test 2: JSON — extracts top-level keys as ConfigEntry
  it should "extract top-level JSON keys as ConfigEntry nodes" in {
    val source = """{
      |  "name": "my-app",
      |  "version": "1.0.0",
      |  "description": "A test app"
      |}""".stripMargin
    val result = parser.parse("package.json", source)
    result.entities.exists(e => e.name == "name" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "version" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "description" && e.kind == NodeKind.ConfigEntry) shouldBe true
  }

  // Test 3: JSON — DEFINES relationships
  it should "generate DEFINES relationships for JSON entries" in {
    val source = """{
      |  "name": "test"
      |}""".stripMargin
    val result = parser.parse("config.json", source)
    result.relationships.exists(r => r.srcName == "config.json" && r.dstName == "name" && r.predicate == "DEFINES") shouldBe true
  }

  // Test 4: YAML — extracts top-level keys
  it should "extract top-level YAML keys" in {
    val source = """endpoint: http://localhost:8090
      |format: text
      |debug: true""".stripMargin
    val result = parser.parse("config.yaml", source)
    result.entities.exists(e => e.name == "endpoint" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "format" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "debug" && e.kind == NodeKind.ConfigEntry) shouldBe true
  }

  // Test 5: YAML — skips comments
  it should "skip YAML comment lines" in {
    val source = """# This is a comment
      |name: test
      |# Another comment
      |port: 8080""".stripMargin
    val result = parser.parse("config.yml", source)
    val entryNames = result.entities.filter(_.kind == NodeKind.ConfigEntry).map(_.name)
    entryNames should contain("name")
    entryNames should contain("port")
    entryNames.size shouldBe 2
  }

  // Test 6: YAML — format attr is "yaml"
  it should "set format to yaml for .yaml files" in {
    val result = parser.parse("app.yaml", "key: value")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"yaml\"")
  }

  // Test 7: YAML — format attr is "yaml" for .yml too
  it should "set format to yaml for .yml files" in {
    val result = parser.parse("app.yml", "key: value")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"yaml\"")
  }

  // Test 8: TOML — extracts top-level keys
  it should "extract top-level TOML keys" in {
    val source = """name = "my-app"
      |version = "1.0.0"
      |
      |[database]
      |host = "localhost"
      |port = 5432""".stripMargin
    val result = parser.parse("config.toml", source)
    result.entities.exists(e => e.name == "name" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "version" && e.kind == NodeKind.ConfigEntry) shouldBe true
    // Section keys should also be extracted
    result.entities.exists(e => e.name == "host" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "port" && e.kind == NodeKind.ConfigEntry) shouldBe true
  }

  // Test 9: TOML — format attr is "toml"
  it should "set format to toml for .toml files" in {
    val result = parser.parse("config.toml", "key = \"value\"")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"toml\"")
  }

  // Test 10: Empty config
  it should "handle empty config files" in {
    val result = parser.parse("empty.json", "")
    result.entities.exists(_.kind == NodeKind.Config) shouldBe true
    result.entities.count(_.kind == NodeKind.ConfigEntry) shouldBe 0
  }

  // Test 11: ConfigEntry has value attr
  it should "store the value in ConfigEntry attrs" in {
    val source = "port: 8080"
    val result = parser.parse("config.yaml", source)
    val entry = result.entities.find(e => e.name == "port" && e.kind == NodeKind.ConfigEntry)
    entry shouldBe defined
    entry.get.attrs.get("value").map(_.noSpaces) shouldBe Some("\"8080\"")
  }
}
