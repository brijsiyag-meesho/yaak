import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import type {
  CallTemplateFunctionArgs,
  Context,
  GenericCompletionOption,
  PluginDefinition,
} from '@yaakapp/api';

// Get the yaak database path (macOS only)
function getYaakDbPath(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const appId = isDev ? 'app.yaak.desktop.dev' : 'app.yaak.desktop';
  return path.join(os.homedir(), 'Library', 'Application Support', appId, 'db.sqlite');
}

// Get workspace sync directory from yaak database using sqlite3 CLI
function getWorkspaceSyncDir(workspaceId: string): string | null {
  try {
    const dbPath = getYaakDbPath();
    if (!fs.existsSync(dbPath)) {
      return null;
    }

    // Use macOS built-in sqlite3 command
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT setting_sync_dir FROM workspace_metas WHERE workspace_id = '${workspaceId}'"`,
      { encoding: 'utf-8' },
    ).trim();

    return result || null;
  } catch (error) {
    console.error('Failed to read yaak database:', error);
    return null;
  }
}

// Parse an env file and return its keys
function parseEnvFile(filePath: string): Record<string, string> {
  try {
    // Create file if it doesn't exist
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf-8');
      return {};
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    if (!fileContent.trim()) {
      return {};
    }

    const parsed = parseEnv(fileContent);
    // Filter out undefined values
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  } catch (error) {
    console.error('Failed to parse env file:', error);
    return {};
  }
}

// Save a key-value pair to the .env.yaak file
function saveToEnvYaak(parentDir: string, key: string, value: string): boolean {
  try {
    const envYaakPath = path.join(parentDir, '.env.yaak');

    // Parse existing content using parseEnv
    const existingConfig = parseEnvFile(envYaakPath);

    // Update or add the key
    existingConfig[key] = value;
    // Sort the keys before writing to file
    const sortedEntries = Object.entries(existingConfig).sort(([a], [b]) => a.localeCompare(b));

    // Convert back to env file format
    const envContent = sortedEntries.map(([k, v]) => `${k}=${v}`).join('\n');

    fs.writeFileSync(envYaakPath, envContent + '\n', 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to save to .env.yaak:', error);
    return false;
  }
}

export const plugin: PluginDefinition = {
  templateFunctions: [
    {
      name: 'env',
      description:
        'Extract value from .env.yaak file. Missing keys will prompt for value on first use.',
      previewType: 'click',
      args: [
        {
          name: 'key',
          label: 'Env Key',
          type: 'text',
          placeholder: 'AUTH_SECRET',
          async dynamic(ctx, args) {
            const workspaceId = await ctx.window.workspaceId();
            if (!workspaceId) {
              return { completionOptions: [] };
            }

            const syncDir = getWorkspaceSyncDir(workspaceId);
            if (!syncDir) {
              return { completionOptions: [] };
            }

            const parentDir = path.dirname(syncDir);
            const envFilePath = path.join(parentDir, '.env.yaak');
            const config = parseEnvFile(envFilePath);
            const keys = Object.keys(config);

            return {
              completionOptions: keys.map<GenericCompletionOption>((key) => ({
                label: key,
                type: 'constant',
              })),
            };
          },
        },
      ],
      async onRender(ctx: Context, args: CallTemplateFunctionArgs): Promise<string | null> {
        try {
          const workspaceId = await ctx.window.workspaceId();
          if (!workspaceId) {
            return '[ERROR: No workspace context]';
          }

          const syncDir = getWorkspaceSyncDir(workspaceId);
          if (!syncDir) {
            return '[ERROR: No sync directory configured for workspace]';
          }

          const parentDir = path.dirname(syncDir);
          const envFilePath = path.join(parentDir, '.env.yaak');
          const key = args.values?.key?.toString();

          if (!key) {
            return '';
          }

          // Read existing config
          const config = parseEnvFile(envFilePath);

          // If key exists in .env.yaak file, return its value (even if empty)
          // This means user previously hit "Done" - don't prompt again
          if (key in config) {
            return config[key] || null;
          }

          // Key doesn't exist in file - show prompt
          const userValue = await ctx.prompt.text({
            id: `env-value-${key}`,
            title: 'Enter value',
            description: `Set a value for env key. Leave empty and click Done to skip prompts, or Cancel to be asked again next time.`,
            label: key,
            placeholder: 'Enter value or leave blank',
          });

          // User cancelled - don't save to file, will prompt again next time
          if (userValue === null || userValue === undefined) {
            return '';
          }

          // User clicked Done (with or without value) - save to file
          const saved = saveToEnvYaak(parentDir, key, userValue);
          if (!saved) {
            await ctx.toast.show({
              message: `Failed to save ${key} to .env.yaak. You can set it manually in the file.`,
              color: 'warning',
              timeout: 5000,
            });
          }

          return userValue;
        } catch (error) {
          console.error('Error in env template function:', error);
          return '';
        }
      },
    },
  ],
};
