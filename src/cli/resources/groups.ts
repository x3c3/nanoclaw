import type { McpServerConfig } from '../../container-config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import type { ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Deprecated — use `ncl groups config-update --provider`. Kept for backwards compat.',
      updatable: false,
      default: null,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  customOperations: {
    'config-get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config-update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt',
          );
        }

        updateContainerConfigScalars(id, updates);
        restartAgentGroupContainers(id, 'config updated via ncl');

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config-add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);
        restartAgentGroupContainers(id, `mcp server "${name}" added via ncl`);

        return { added: name, servers };
      },
    },
    'config-remove-mcp-server': {
      access: 'approval',
      description: 'Remove an MCP server from a group. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);
        restartAgentGroupContainers(id, `mcp server "${name}" removed via ncl`);

        return { removed: name };
      },
    },
    'config-add-package': {
      access: 'approval',
      description: 'Add a package to a group. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return { added: { apt: apt || null, npm: npm || null } };
      },
    },
    'config-remove-package': {
      access: 'approval',
      description: 'Remove a package from a group. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return { removed: { apt: apt || null, npm: npm || null } };
      },
    },
  },
});
