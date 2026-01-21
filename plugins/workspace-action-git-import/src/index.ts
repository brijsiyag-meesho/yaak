import { CallWorkspaceActionArgs, Context, PluginDefinition } from '@yaakapp/api';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const repoPath = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'app.yaak.desktop',
  'api-collections',
);

// Get the yaak database path (macOS only)
function getYaakDbPath(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const appId = isDev ? 'app.yaak.desktop.dev' : 'app.yaak.desktop';
  return path.join(os.homedir(), 'Library', 'Application Support', appId, 'db.sqlite');
}

// Generate a unique ID with prefix
function generateId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}_${id}`;
}

// Format timestamp in Yaak's expected format: YYYY-MM-DD HH:MM:SS.ssssss
function formatYaakTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  // Add microseconds (3 additional digits) - using 000 as JavaScript doesn't support microseconds
  const microseconds = '000';

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}${microseconds}`;
}

// Get all directories in the repo
function getDirectories(repoPath: string): string[] {
  try {
    const items = fs.readdirSync(repoPath, { withFileTypes: true });
    return items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => item.name)
      .sort();
  } catch (error) {
    console.error('Failed to read directories:', error);
    return [];
  }
}

// Read workspace info from YAML file
function readWorkspaceFromYaml(workspaceDir: string): any | null {
  try {
    const yaakDir = path.join(workspaceDir);
    if (!fs.existsSync(yaakDir)) {
      return null;
    }

    // Find the workspace YAML file (yaak.*.yaml where model is workspace)
    const files = fs.readdirSync(yaakDir);
    for (const file of files) {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const filePath = path.join(yaakDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Simple YAML parsing to check if it's a workspace
        if (content.includes('model: workspace') || content.includes('model: "workspace"')) {
          // Parse key-value pairs from YAML
          const lines = content.split('\n');
          const workspace: any = {};

          for (const line of lines) {
            const match = line.match(/^(\w+):\s*(.+)$/);
            if (match) {
              const [, key, value] = match;
              if (key && value) {
                workspace[key] = value.replace(/^["']|["']$/g, '').trim();
              }
            }
          }

          return workspace;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to read workspace YAML:', error);
    return null;
  }
}

// Insert workspace directly into database
function registerWorkspaceInDb(workspaceDir: string): {
  success: boolean;
  workspaceId?: string;
  isNew?: boolean;
  error?: string;
} {
  try {
    const dbPath = getYaakDbPath();
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: 'Yaak database not found' };
    }

    const workspaceInfo = readWorkspaceFromYaml(workspaceDir);
    if (!workspaceInfo || !workspaceInfo.id) {
      return { success: false, error: 'Invalid workspace structure' };
    }

    const workspaceId = workspaceInfo.id;
    const workspaceName = workspaceInfo.name || path.basename(workspaceDir);
    const timestamp = formatYaakTimestamp();

    // Check if workspace already exists
    const checkQuery = `SELECT id FROM workspaces WHERE id = '${workspaceId}'`;
    const existing = execSync(`sqlite3 "${dbPath}" "${checkQuery}"`, { encoding: 'utf-8' }).trim();

    if (existing) {
      console.log(`Workspace ${workspaceId} already exists, updating sync directory`);

      // Find existing workspace_meta or create one
      const checkMetaQuery = `SELECT id FROM workspace_metas WHERE workspace_id = '${workspaceId}'`;
      const existingMeta = execSync(`sqlite3 "${dbPath}" "${checkMetaQuery}"`, {
        encoding: 'utf-8',
      }).trim();

      if (existingMeta) {
        // Update existing meta
        const updateMetaQuery = `
                  UPDATE workspace_metas 
                  SET setting_sync_dir = '${workspaceDir}',
                      updated_at = '${timestamp}'
                  WHERE workspace_id = '${workspaceId}'
              `;
        execSync(`sqlite3 "${dbPath}" "${updateMetaQuery.replace(/\n/g, ' ')}"`, {
          encoding: 'utf-8',
        });
      } else {
        // Create new meta
        const workspaceMetaId = generateId('wm');
        const insertMetaQuery = `
                  INSERT INTO workspace_metas (
                      id, model, workspace_id, created_at, updated_at, setting_sync_dir
                  ) VALUES (
                      '${workspaceMetaId}',
                      'workspace_meta',
                      '${workspaceId}',
                      '${timestamp}',
                      '${timestamp}',
                      '${workspaceDir}'
                  )
              `;
        execSync(`sqlite3 "${dbPath}" "${insertMetaQuery.replace(/\n/g, ' ')}"`, {
          encoding: 'utf-8',
        });
      }

      return { success: true, workspaceId, isNew: false };
    }

    // Insert new workspace
    const insertWorkspaceQuery = `
          INSERT INTO workspaces (
              id, model, name, description, 
              created_at, updated_at,
              authentication, authentication_type,
              headers,
              encryption_key_challenge,
              setting_validate_certificates,
              setting_follow_redirects,
              setting_request_timeout,
              setting_dns_overrides
          ) VALUES (
              '${workspaceId}',
              'workspace',
              '${workspaceName.replace(/'/g, "''")}',
              '',
              '${timestamp}',
              '${timestamp}',
              '{}',
              NULL,
              '[]',
              NULL,
              1,
              1,
              0,
              '[]'
          )
      `;

    execSync(`sqlite3 "${dbPath}" "${insertWorkspaceQuery.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
    });

    // Insert workspace_meta
    const workspaceMetaId = generateId('wm');
    const insertMetaQuery = `
          INSERT INTO workspace_metas (
              id, model, workspace_id, created_at, updated_at, setting_sync_dir
          ) VALUES (
              '${workspaceMetaId}',
              'workspace_meta',
              '${workspaceId}',
              '${timestamp}',
              '${timestamp}',
              '${workspaceDir}'
          )
      `;

    execSync(`sqlite3 "${dbPath}" "${insertMetaQuery.replace(/\n/g, ' ')}"`, { encoding: 'utf-8' });

    return { success: true, workspaceId, isNew: true };
  } catch (error) {
    console.error('Failed to register workspace in database:', error);
    return { success: false, error: String(error) };
  }
}

export const plugin: PluginDefinition = {
  workspaceActions: [
    {
      label: 'Open older collection',
      async onSelect(ctx: Context, args: CallWorkspaceActionArgs): Promise<void> {
        try {
          // Step 2: Get all directories
          const directories = getDirectories(repoPath);

          if (directories.length === 0) {
            await ctx.toast.show({
              message: 'No collections found in the repository',
              color: 'warning',
              timeout: 5000,
            });
            return;
          }

          const result = await ctx.prompt.form({
            id: 'select-collection',
            title: 'Select API Collection',
            description: 'Choose a collection to open from api-collections repository',
            confirmText: 'Open Collection',
            cancelText: 'Cancel',
            inputs: [
              {
                type: 'text',
                name: 'collection',
                label: 'Collection',
                placeholder: 'Enter collection name',
                completionOptions: directories.map((dir) => ({
                  label: dir,
                  type: 'variable',
                })),
              },
            ],
          });

          if (!result || !result.collection) {
            // User cancelled
            return;
          }

          const selectedCollection = result.collection as string;
          const collectionPath = path.join(repoPath, selectedCollection);

          // Step 4: Verify it's a valid workspace
          const yaakDir = path.join(collectionPath);
          if (!fs.existsSync(yaakDir)) {
            await ctx.toast.show({
              message: `"${selectedCollection}" is not a valid Yaak workspace`,
              color: 'danger',
              timeout: 5000,
            });
            return;
          }

          // Step 5: Register the workspace
          await ctx.toast.show({
            message: `Opening collection: ${selectedCollection}...`,
            color: 'info',
            timeout: 3000,
          });

          const registerResult = registerWorkspaceInDb(collectionPath);

          if (registerResult.success) {
            const action = registerResult.isNew ? 'registered' : 'updated';
            await ctx.toast.show({
              message: `Successfully ${action} "${selectedCollection}"!\n\nRestarting Yaak to refresh workspace list...`,
              color: 'success',
              timeout: 3000,
            });

            // Wait a bit for the toast to be visible, then restart Yaak
            setTimeout(() => {
              try {
                // Use AppleScript to restart Yaak on macOS
                execSync(
                  `osascript -e 'tell application "Yaak" to quit' && sleep 1 && open -a Yaak`,
                  {
                    encoding: 'utf-8',
                    timeout: 5000,
                  },
                );
              } catch (error) {
                console.error('Failed to restart Yaak automatically:', error);
              }
            }, 2000);
          } else {
            await ctx.toast.show({
              message: `Failed to register "${selectedCollection}": ${registerResult.error}`,
              color: 'danger',
              timeout: 5000,
            });
          }
        } catch (error) {
          console.error('Error opening collection:', error);
          await ctx.toast.show({
            message: `Failed to open collection: ${error}`,
            color: 'danger',
            timeout: 5000,
          });
        }
      },
    },
  ],
};
