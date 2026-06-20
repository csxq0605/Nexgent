"""MCP (Model Context Protocol) support - connect to external tools and data sources.

Implements Claude Code-style MCP support:
- MCP server configuration management (.mcp.json)
- Multiple transport protocols (stdio, HTTP, SSE, WebSocket)
- Tool discovery and registration
- OAuth authentication support
- Server lifecycle management
- /mcp command for status
- Resource references (@server:protocol://resource)
"""

import os
import sys
import json
import re
import subprocess
import threading
import time
import logging
import asyncio
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any, Callable
from pathlib import Path
from enum import Enum
import uuid

_logger = logging.getLogger(__name__)


class MCPTransport(Enum):
    """MCP transport types."""
    STDIO = 'stdio'
    HTTP = 'http'
    SSE = 'sse'
    WEBSOCKET = 'ws'


class MCPServerStatus(Enum):
    """MCP server status."""
    DISCONNECTED = 'disconnected'
    CONNECTING = 'connecting'
    CONNECTED = 'connected'
    FAILED = 'failed'
    PENDING = 'pending'


@dataclass
class MCPServerConfig:
    """MCP server configuration."""
    name: str
    transport: MCPTransport
    # stdio
    command: Optional[str] = None
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    # HTTP/SSE/WebSocket
    url: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    headers_helper: Optional[str] = None
    # OAuth
    oauth: Dict[str, Any] = field(default_factory=dict)
    # General
    timeout: int = 60000
    always_load: bool = False
    scope: str = 'local'  # 'local', 'project', 'user'


@dataclass
class MCPTool:
    """Represents an MCP tool."""
    name: str
    description: str
    parameters: Dict[str, Any]
    server_name: str
    _meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MCPResource:
    """Represents an MCP resource."""
    uri: str
    name: str
    description: str
    mime_type: Optional[str] = None
    server_name: str = ''


@dataclass
class MCPServer:
    """Represents a connected MCP server."""
    config: MCPServerConfig
    status: MCPServerStatus = MCPServerStatus.DISCONNECTED
    tools: Dict[str, MCPTool] = field(default_factory=dict)
    resources: Dict[str, MCPResource] = field(default_factory=dict)
    process: Optional[subprocess.Popen] = None
    session_id: Optional[str] = None
    last_error: Optional[str] = None
    reconnect_attempts: int = 0


class MCPConfigParser:
    """Parse MCP configuration files."""

    @classmethod
    def parse_mcp_json(cls, path: str) -> Dict[str, MCPServerConfig]:
        """Parse .mcp.json file."""
        if not os.path.exists(path):
            return {}

        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Failed to parse {path}: {e}")
            return {}

        servers = {}
        mcp_servers = data.get('mcpServers', {})

        for name, config in mcp_servers.items():
            server_config = cls._parse_server_config(name, config)
            if server_config:
                servers[name] = server_config

        return servers

    @classmethod
    def _parse_server_config(cls, name: str, config: Dict[str, Any]) -> Optional[MCPServerConfig]:
        """Parse a single server configuration."""
        transport_str = config.get('type', 'stdio')

        try:
            transport = MCPTransport(transport_str)
        except ValueError:
            print(f"Warning: Unknown transport type '{transport_str}' for server '{name}'")
            return None

        # Expand environment variables
        def expand_env(value: str) -> str:
            """Expand ${VAR} and ${VAR:-default} patterns."""
            def replace_var(match):
                var = match.group(1)
                if ':-' in var:
                    var_name, default = var.split(':-', 1)
                    return os.environ.get(var_name, default)
                return os.environ.get(var, match.group(0))

            return re.sub(r'\$\{([^}]+)\}', replace_var, value)

        # Parse configuration
        command = expand_env(config.get('command', '')) if config.get('command') else None
        args = [expand_env(a) for a in config.get('args', [])]
        env = {k: expand_env(v) for k, v in config.get('env', {}).items()}
        url = expand_env(config.get('url', '')) if config.get('url') else None
        headers = {k: expand_env(v) for k, v in config.get('headers', {}).items()}
        headers_helper = config.get('headersHelper')
        oauth = config.get('oauth', {})
        timeout = config.get('timeout', 60000)
        always_load = config.get('alwaysLoad', False)

        return MCPServerConfig(
            name=name,
            transport=transport,
            command=command,
            args=args,
            env=env,
            url=url,
            headers=headers,
            headers_helper=headers_helper,
            oauth=oauth,
            timeout=timeout,
            always_load=always_load,
        )

    @classmethod
    def load_all_configs(cls, project_root: str = '.') -> Dict[str, MCPServerConfig]:
        """Load all MCP configurations."""
        configs = {}

        # Project-level .nexgent/mcp.json
        project_mcp = os.path.join(project_root, '.nexgent', 'mcp.json')
        configs.update(cls.parse_mcp_json(project_mcp))

        # Also check legacy .mcp.json for backward compatibility
        legacy_mcp = os.path.join(project_root, '.mcp.json')
        if os.path.exists(legacy_mcp) and not os.path.exists(project_mcp):
            configs.update(cls.parse_mcp_json(legacy_mcp))

        # User-level ~/.nexgent/config.json
        user_config_path = os.path.join(os.path.expanduser('~'), '.nexgent', 'config.json')
        if os.path.exists(user_config_path):
            try:
                with open(user_config_path, 'r', encoding='utf-8') as f:
                    user_data = json.load(f)
                # Get project-specific servers
                project_path = os.path.abspath(project_root)
                project_configs = user_data.get('projects', {}).get(project_path, {}).get('mcpServers', {})
                for name, config in project_configs.items():
                    server_config = cls._parse_server_config(name, config)
                    if server_config:
                        server_config.scope = 'local'
                        configs[name] = server_config

                # Get user-scoped servers
                user_servers = user_data.get('mcpServers', {})
                for name, config in user_servers.items():
                    if name not in configs:
                        server_config = cls._parse_server_config(name, config)
                        if server_config:
                            server_config.scope = 'user'
                            configs[name] = server_config
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Failed to parse {user_config_path}: {e}")

        return configs


class MCPConnection:
    """Manage MCP server connections."""

    def __init__(self, config: MCPServerConfig):
        self.config = config
        self.server = MCPServer(config=config)
        self._lock = threading.Lock()
        self._use_content_length_header = False  # Default to newline-delimited JSON

    def connect(self) -> bool:
        """Connect to the MCP server."""
        with self._lock:
            if self.server.status == MCPServerStatus.CONNECTED:
                return True

            self.server.status = MCPServerStatus.CONNECTING

            try:
                if self.config.transport == MCPTransport.STDIO:
                    return self._connect_stdio()
                elif self.config.transport in (MCPTransport.HTTP, MCPTransport.SSE):
                    return self._connect_http()
                elif self.config.transport == MCPTransport.WEBSOCKET:
                    return self._connect_websocket()
                else:
                    self.server.status = MCPServerStatus.FAILED
                    self.server.last_error = f"Unsupported transport: {self.config.transport}"
                    return False
            except Exception as e:
                self.server.status = MCPServerStatus.FAILED
                self.server.last_error = str(e)
                return False

    def _connect_stdio(self) -> bool:
        """Connect via stdio transport."""
        if not self.config.command:
            self.server.status = MCPServerStatus.FAILED
            self.server.last_error = "No command specified for stdio transport"
            return False

        try:
            # Build command
            cmd = [self.config.command] + self.config.args

            # Prepare environment
            env = os.environ.copy()
            env.update(self.config.env)
            env['CLAUDE_PROJECT_DIR'] = os.getcwd()

            # Start process
            # On Windows, shell=True is needed for commands like npx/npm/node
            # that are actually .cmd/.bat wrappers
            use_shell = sys.platform == 'win32'
            self.server.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                shell=use_shell,
            )

            # Initialize MCP session
            if self._initialize_session():
                self.server.status = MCPServerStatus.CONNECTED
                self.server.reconnect_attempts = 0
                return True
            else:
                self._cleanup_process()
                self.server.status = MCPServerStatus.FAILED
                return False

        except Exception as e:
            self.server.status = MCPServerStatus.FAILED
            self.server.last_error = str(e)
            return False

    def _connect_http(self) -> bool:
        """Connect via HTTP/SSE transport."""
        if not self.config.url:
            self.server.status = MCPServerStatus.FAILED
            self.server.last_error = "No URL specified for HTTP transport"
            return False

        # TODO: Implement HTTP/SSE connection
        # This requires async HTTP client (aiohttp or httpx)
        self.server.status = MCPServerStatus.FAILED
        self.server.last_error = "HTTP/SSE transport not yet implemented"
        return False

    def _connect_websocket(self) -> bool:
        """Connect via WebSocket transport."""
        if not self.config.url:
            self.server.status = MCPServerStatus.FAILED
            self.server.last_error = "No URL specified for WebSocket transport"
            return False

        # TODO: Implement WebSocket connection
        self.server.status = MCPServerStatus.FAILED
        self.server.last_error = "WebSocket transport not yet implemented"
        return False

    def _initialize_session(self) -> bool:
        """Initialize MCP session with handshake."""
        if not self.server.process:
            return False

        try:
            # Send initialize request
            init_request = {
                'jsonrpc': '2.0',
                'id': str(uuid.uuid4()),
                'method': 'initialize',
                'params': {
                    'protocolVersion': '2024-11-05',
                    'capabilities': {
                        'tools': {},
                        'resources': {},
                    },
                    'clientInfo': {
                        'name': 'nexgent',
                        'version': '1.0.0',
                    },
                },
            }

            self._send_message(init_request)

            # Read response, skipping notifications
            response = None
            for _ in range(10):
                response = self._receive_message()
                if not response:
                    time.sleep(0.5)
                    continue
                if 'id' in response:
                    break
                # Skip notification
                response = None

            if response and 'result' in response:
                # Send initialized notification
                initialized = {
                    'jsonrpc': '2.0',
                    'method': 'notifications/initialized',
                }
                self._send_message(initialized)

                # Discover tools
                self._discover_tools()

                return True

            return False

        except Exception as e:
            self.server.last_error = f"Session initialization failed: {e}"
            return False

    def _send_message(self, message: Dict[str, Any]):
        """Send a JSON-RPC message to the server.

        Supports two formats:
        - Content-Length header format (standard MCP spec)
        - Newline-delimited JSON (used by @modelcontextprotocol/sdk)
        """
        if not self.server.process or not self.server.process.stdin:
            raise Exception("Server process not running")

        json_bytes = json.dumps(message).encode('utf-8')

        if self._use_content_length_header:
            header = f"Content-Length: {len(json_bytes)}\r\n\r\n".encode('utf-8')
            self.server.process.stdin.write(header + json_bytes)
        else:
            self.server.process.stdin.write(json_bytes + b'\n')

        self.server.process.stdin.flush()

    def _readline_with_timeout(self, timeout: float = 10.0) -> Optional[bytes]:
        """Read a line from stdout with timeout to prevent permanent blocking."""
        result = [None]
        error = [None]
        def _read():
            try:
                result[0] = self.server.process.stdout.readline()
            except Exception as e:
                error[0] = e
        t = threading.Thread(target=_read, daemon=True)
        t.start()
        t.join(timeout=timeout)
        if t.is_alive():
            # Thread still running — readline is blocked
            return None
        if error[0]:
            raise error[0]
        return result[0]

    def _receive_message(self) -> Optional[Dict[str, Any]]:
        """Receive a JSON-RPC message from the server.

        Auto-detects format:
        - Content-Length header: reads header then body
        - Newline-delimited JSON: reads a single line of JSON
        """
        if not self.server.process or not self.server.process.stdout:
            raise Exception("Server process not running")

        # Read first line to detect format (with timeout to prevent hanging)
        first_line = self._readline_with_timeout(timeout=10.0)
        if not first_line:
            return None

        first_line_str = first_line.decode('utf-8', errors='replace').strip()

        # Check if it's a Content-Length header
        if first_line_str.lower().startswith('content-length:'):
            self._use_content_length_header = True
            try:
                content_length = int(first_line_str.split(':', 1)[1].strip())
            except ValueError:
                logging.getLogger(__name__).warning("MCP: malformed Content-Length header: %s", first_line_str)
                return None

            # Read remaining headers until empty line
            while True:
                line = self._readline_with_timeout(timeout=10.0)
                if not line or line.strip() == b'':
                    break

            # Read body with timeout to prevent permanent blocking
            body = b''
            while len(body) < content_length:
                remaining = content_length - len(body)
                chunk_result = [None]
                def _read_chunk():
                    try:
                        chunk_result[0] = self.server.process.stdout.read(remaining)
                    except Exception:
                        pass
                t = threading.Thread(target=_read_chunk, daemon=True)
                t.start()
                t.join(timeout=10.0)
                if t.is_alive() or not chunk_result[0]:
                    break
                body += chunk_result[0]
            return json.loads(body.decode('utf-8'))

        # Otherwise, treat as newline-delimited JSON
        self._use_content_length_header = False
        try:
            return json.loads(first_line_str)
        except json.JSONDecodeError:
            return None

    def _discover_tools(self):
        """Discover tools from the server."""
        try:
            request = {
                'jsonrpc': '2.0',
                'id': str(uuid.uuid4()),
                'method': 'tools/list',
            }

            self._send_message(request)

            # Read responses, skipping notifications (messages without 'id')
            import time
            for _ in range(10):
                response = self._receive_message()
                if not response:
                    time.sleep(0.5)
                    continue
                # Skip notifications (no 'id' field)
                if 'id' not in response:
                    continue
                # This is the response to our tools/list request
                if 'result' in response:
                    tools = response['result'].get('tools', [])
                    for tool_data in tools:
                        tool = MCPTool(
                            name=tool_data['name'],
                            description=tool_data.get('description', ''),
                            parameters=tool_data.get('inputSchema', {}),
                            server_name=self.config.name,
                            _meta=tool_data.get('_meta', {}),
                        )
                        self.server.tools[tool.name] = tool
                break

        except Exception as e:
            print(f"Warning: Failed to discover tools from {self.config.name}: {e}")

    def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """Call a tool on the server."""
        # Hold lock for the entire send/receive cycle to prevent
        # concurrent requests from interleaving on the shared stdin/stdout pipes.
        with self._lock:
            if self.server.status != MCPServerStatus.CONNECTED:
                return {'error': f"Server {self.config.name} is not connected"}
            process = self.server.process
            tools = dict(self.server.tools)
            if not process:
                return {'error': f"Server {self.config.name} process not running"}

            if tool_name not in tools:
                return {'error': f"Tool {tool_name} not found on server {self.config.name}"}

            try:
                request = {
                    'jsonrpc': '2.0',
                    'id': str(uuid.uuid4()),
                    'method': 'tools/call',
                    'params': {
                        'name': tool_name,
                        'arguments': arguments,
                    },
                }

                self._send_message(request)
                response = self._receive_message()

                if response and 'result' in response:
                    return response['result']
                elif response and 'error' in response:
                    return {'error': response['error']}
                else:
                    return {'error': 'No response from server'}

            except Exception as e:
                return {'error': f"Tool call failed: {e}"}

    def disconnect(self):
        """Disconnect from the server."""
        with self._lock:
            self._cleanup_process()
            self.server.status = MCPServerStatus.DISCONNECTED
            self.server.tools.clear()
            self.server.resources.clear()

    def _cleanup_process(self):
        """Clean up the server process."""
        if self.server.process:
            try:
                self.server.process.terminate()
                self.server.process.wait(timeout=5)
            except Exception:
                try:
                    self.server.process.kill()
                except Exception:
                    pass
            self.server.process = None


class MCPManager:
    """Manage all MCP server connections."""

    def __init__(self, project_root: str = '.'):
        self.project_root = project_root
        self.connections: Dict[str, MCPConnection] = {}
        self._lock = threading.Lock()

    def load_configurations(self):
        """Load all MCP configurations."""
        configs = MCPConfigParser.load_all_configs(self.project_root)

        with self._lock:
            for name, config in configs.items():
                if name not in self.connections:
                    self.connections[name] = MCPConnection(config)

    def connect_all(self):
        """Connect to all configured servers."""
        self.load_configurations()

        for name, connection in self.connections.items():
            if connection.server.status == MCPServerStatus.DISCONNECTED:
                threading.Thread(
                    target=connection.connect,
                    name=f"mcp-{name}",
                    daemon=True,
                ).start()

    def connect_server(self, name: str) -> bool:
        """Connect to a specific server."""
        with self._lock:
            if name not in self.connections:
                return False

            connection = self.connections[name]
            return connection.connect()

    def disconnect_server(self, name: str):
        """Disconnect from a specific server."""
        with self._lock:
            if name in self.connections:
                self.connections[name].disconnect()

    def disconnect_all(self):
        """Disconnect from all servers."""
        with self._lock:
            for connection in self.connections.values():
                connection.disconnect()

    def get_server_status(self) -> List[Dict[str, Any]]:
        """Get status of all servers."""
        return [
            {
                'name': name,
                'status': connection.server.status.value,
                'transport': connection.config.transport.value,
                'tools_count': len(connection.server.tools),
                'scope': connection.config.scope,
                'error': connection.server.last_error,
            }
            for name, connection in self.connections.items()
        ]

    def get_all_tools(self) -> List[MCPTool]:
        """Get all available tools from connected servers."""
        tools = []
        for connection in self.connections.values():
            if connection.server.status == MCPServerStatus.CONNECTED:
                tools.extend(connection.server.tools.values())
        return tools

    def get_tool(self, tool_name: str) -> Optional[MCPTool]:
        """Get a specific tool by name."""
        for connection in self.connections.values():
            if tool_name in connection.server.tools:
                return connection.server.tools[tool_name]
        return None

    def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """Call a tool on the appropriate server."""
        found_count = 0
        result = None
        for connection in self.connections.values():
            if tool_name in connection.server.tools:
                found_count += 1
                if found_count == 1:
                    result = connection.call_tool(tool_name, arguments)
                else:
                    _logger.warning("Tool name collision: '%s' found on multiple MCP servers", tool_name)
                    break
        if result is not None:
            return result
        return {'error': f"Tool {tool_name} not found on any connected server"}

    def get_all_resources(self) -> List[MCPResource]:
        """Get all available resources from connected servers."""
        resources = []
        for connection in self.connections.values():
            if connection.server.status == MCPServerStatus.CONNECTED:
                resources.extend(connection.server.resources.values())
        return resources

    def resolve_resource(self, uri: str) -> Optional[Any]:
        """Resolve a resource URI."""
        # Parse URI: @server:protocol://path
        import re
        match = re.match(r'@(\w+):(\w+)://(.+)', uri)
        if not match:
            return None

        server_name = match.group(1)
        protocol = match.group(2)
        path = match.group(3)

        # Look up connection under lock, then release before I/O
        connection = None
        with self._lock:
            if server_name in self.connections:
                connection = self.connections[server_name]

        if connection and connection.server.status == MCPServerStatus.CONNECTED:
            # Call resource read (outside manager lock to avoid blocking other operations)
            request = {
                'jsonrpc': '2.0',
                'id': str(uuid.uuid4()),
                'method': 'resources/read',
                'params': {
                    'uri': f'{protocol}://{path}',
                },
            }
            try:
                connection._send_message(request)
                response = connection._receive_message()
                if response and 'result' in response:
                    return response['result']
            except Exception as e:
                return {'error': f"Failed to resolve resource: {e}"}

        return None
