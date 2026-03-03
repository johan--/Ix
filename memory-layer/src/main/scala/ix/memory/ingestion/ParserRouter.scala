package ix.memory.ingestion

import ix.memory.ingestion.parsers.{ConfigParser, TreeSitterPythonParser, TypeScriptParser}

/**
 * Routes file paths to the appropriate language parser.
 * Supports Python (.py), TypeScript (.ts/.tsx), and config files (.json/.yaml/.yml/.toml).
 */
class ParserRouter {
  private val pythonParser = new TreeSitterPythonParser()
  private val tsParser     = new TypeScriptParser()
  private val configParser = new ConfigParser()

  def parserFor(filePath: String): Option[Parser] = {
    if (filePath.endsWith(".py")) Some(pythonParser)
    else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) Some(tsParser)
    else if (filePath.endsWith(".json") || filePath.endsWith(".yaml") || filePath.endsWith(".yml") || filePath.endsWith(".toml")) Some(configParser)
    else None
  }
}
