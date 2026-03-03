import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";

interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

const ixMcpEntry = {
  command: "npx",
  args: ["tsx", join(process.cwd(), "ix-cli/src/mcp/server.ts")],
  env: {
    IX_ENDPOINT: "http://localhost:8090",
  },
};

export function registerMcpInstallCommand(program: Command): void {
  program
    .command("mcp-install")
    .description("Install Ix MCP server configuration")
    .option("--cursor", "Configure for Cursor")
    .option("--claude-code", "Configure for Claude Code")
    .action(async (opts: { cursor?: boolean; claudeCode?: boolean }) => {
      if (opts.cursor) {
        await installCursor();
      } else if (opts.claudeCode) {
        await installClaudeCode();
      } else {
        await installClaudeDesktop();
      }
    });
}

async function installClaudeDesktop(): Promise<void> {
  const platform = process.platform;
  let configPath: string;
  if (platform === "darwin") {
    configPath = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (platform === "win32") {
    configPath = join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  } else {
    configPath = join(homedir(), ".config", "claude", "claude_desktop_config.json");
  }

  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Claude Desktop config`);
  console.log(`       ${configPath}`);
  console.log("  Restart Claude Desktop to activate.");
}

async function installCursor(): Promise<void> {
  const configPath = join(process.cwd(), ".cursor", "mcp.json");
  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Cursor config`);
  console.log(`       ${configPath}`);
}

async function installClaudeCode(): Promise<void> {
  const configPath = join(process.cwd(), ".claude", "settings.json");
  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Claude Code config`);
  console.log(`       ${configPath}`);
}

async function loadOrCreateConfig(path: string): Promise<McpConfig> {
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      return { mcpServers: {}, ...parsed };
    } catch {
      return { mcpServers: {} };
    }
  }
  return { mcpServers: {} };
}
