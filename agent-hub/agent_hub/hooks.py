"""Hook system - lifecycle extension points following Claude Code architecture.

Implements Ch8 patterns:
- Lifecycle events: PreToolUse, PostToolUse, Stop, SessionStart/End
- Command hooks with matcher patterns
- HTTP hooks (POST to URL)
- Prompt hooks (LLM-based decision)
- Hook response protocol (decision/updatedInput/additionalContext)
- Priority ordering and timeout management
"""

import json
import logging
import subprocess
import platform
import threading

_logger = logging.getLogger("agent-hub.hooks")
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Callable


class HookEvent(Enum):
    """Lifecycle events (Ch8: 26 events, we implement the core ones)."""
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    POST_TOOL_USE_FAILURE = "PostToolUseFailure"
    STOP = "Stop"
    SESSION_START = "SessionStart"
    SESSION_END = "SessionEnd"
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    PRE_COMPACT = "PreCompact"
    POST_COMPACT = "PostCompact"
    TASK_CREATED = "TaskCreated"
    TASK_COMPLETED = "TaskCompleted"
    SUBAGENT_START = "SubagentStart"
    SUBAGENT_STOP = "SubagentStop"
    PERMISSION_REQUEST = "PermissionRequest"
    PERMISSION_DENIED = "PermissionDenied"
    CONFIG_CHANGE = "ConfigChange"
    CWD_CHANGED = "CwdChanged"
    FILE_CHANGED = "FileChanged"


class HookDecision(Enum):
    """Hook response decisions (Ch8: approve/block)."""
    APPROVE = "approve"
    BLOCK = "block"


class HookType(Enum):
    """Hook handler types (Ch8: command, http, prompt)."""
    COMMAND = "command"
    HTTP = "http"
    PROMPT = "prompt"


@dataclass
class HookResult:
    """Structured hook response (Ch8: decision/updatedInput/additionalContext)."""
    decision: HookDecision = HookDecision.APPROVE
    reason: str = ""
    additional_context: str = ""
    updated_input: Optional[dict] = None

    @property
    def is_blocking(self) -> bool:
        return self.decision == HookDecision.BLOCK


@dataclass
class HookConfig:
    """Configuration for a single hook."""
    event: HookEvent
    matcher: str = "*"        # Tool name pattern to match
    hook_type: HookType = HookType.COMMAND
    command: str = ""         # Shell command to execute (for command type)
    url: str = ""             # HTTP endpoint URL (for http type)
    prompt: str = ""          # LLM prompt (for prompt type)
    headers: dict = field(default_factory=dict)  # HTTP headers (for http type)
    timeout: float = 10.0     # Timeout in seconds (Ch8: < 1s recommended for sync)
    async_mode: bool = False  # Ch8: async hooks don't block

    def matches(self, tool_name: str) -> bool:
        """Check if this hook matches a tool name."""
        if self.matcher == "*":
            return True
        if self.matcher.endswith("*"):
            return tool_name.startswith(self.matcher[:-1])
        return self.matcher == tool_name


class HookRunner:
    """Execute hooks for lifecycle events (Ch8: Observer + Chain of Responsibility).

    Priority ordering (Ch8):
    1. userSettings (highest)
    2. projectSettings
    3. localSettings
    4. builtinHook (lowest)
    """

    def __init__(self):
        self._hooks: dict[HookEvent, list[HookConfig]] = {}
        self._function_hooks: dict[HookEvent, list[Callable]] = {}
        self.enabled = True

    def register(self, config: HookConfig):
        """Register a command hook for an event."""
        if config.event not in self._hooks:
            self._hooks[config.event] = []
        self._hooks[config.event].append(config)

    def register_function(self, event: HookEvent, fn: Callable):
        """Register an in-memory function hook (Ch8: Function Hook type)."""
        if event not in self._function_hooks:
            self._function_hooks[event] = []
        self._function_hooks[event].append(fn)

    def register_many(self, configs: list[HookConfig]):
        for c in configs:
            self.register(c)

    def run_hooks(
        self,
        event: HookEvent,
        tool_name: str = "",
        tool_input: dict = None,
        tool_result: str = "",
    ) -> HookResult:
        """Run all matching hooks for an event (Ch8: Chain of Responsibility).

        Returns the first blocking result, or approve if all pass.
        Non-blocking hooks that set updated_input have their input changes
        merged into the final result.
        """
        if not self.enabled:
            return HookResult()

        merged_updated_input = None

        # Run function hooks first (in-memory, fastest)
        for fn in self._function_hooks.get(event, []):
            try:
                result = fn(tool_name=tool_name, tool_input=tool_input, tool_result=tool_result)
                if isinstance(result, HookResult):
                    if result.is_blocking:
                        return result
                    if result.updated_input is not None:
                        merged_updated_input = result.updated_input
            except Exception as e:
                _logger.warning("Function hook error for %s: %s", event.value, e)

        # Run registered hooks (command, http, prompt)
        for config in self._hooks.get(event, []):
            if not config.matches(tool_name):
                continue

            if config.async_mode:
                # Ch8: async hooks run in background, don't block
                self._run_async(config, tool_name, tool_input, tool_result)
                continue

            # Dispatch based on hook type
            if config.hook_type == HookType.HTTP:
                result = self._run_http_hook(config, tool_name, tool_input, tool_result)
            elif config.hook_type == HookType.PROMPT:
                result = self._run_prompt_hook(config, tool_name, tool_input, tool_result)
            else:
                result = self._run_command_hook(config, tool_name, tool_input, tool_result)

            if result.is_blocking:
                return result
            if result.updated_input is not None:
                merged_updated_input = result.updated_input

        return HookResult(updated_input=merged_updated_input)

    def _run_command_hook(
        self,
        config: HookConfig,
        tool_name: str,
        tool_input: dict = None,
        tool_result: str = "",
    ) -> HookResult:
        """Execute a single command hook with timeout."""
        # Build hook input (Ch8: structured JSON input)
        hook_input = json.dumps({
            "event": config.event.value,
            "tool_name": tool_name,
            "tool_input": tool_input or {},
            "tool_result": tool_result[:15000],  # Truncate for hook input
        }, ensure_ascii=False)

        try:
            # Ch8: command hooks execute via subprocess
            if platform.system() == "Windows":
                result = subprocess.run(
                    config.command,
                    shell=True,
                    input=hook_input,
                    capture_output=True,
                    text=True,
                    timeout=config.timeout,
                    encoding="utf-8",
                    errors="replace",
                )
            else:
                result = subprocess.run(
                    config.command,
                    shell=True,
                    input=hook_input,
                    capture_output=True,
                    text=True,
                    timeout=config.timeout,
                )

            # Ch8: exit code semantics
            # 0 = pass, 2 = block, other = warning
            if result.returncode == 2:
                return HookResult(
                    decision=HookDecision.BLOCK,
                    reason=result.stderr.strip() if result.stderr else "Blocked by hook",
                )

            # Parse JSON response from stdout (Ch8: hook response protocol)
            if result.stdout.strip():
                try:
                    response = json.loads(result.stdout.strip())
                    decision = response.get("decision", "approve")
                    if decision == "block":
                        return HookResult(
                            decision=HookDecision.BLOCK,
                            reason=response.get("reason", "Blocked by hook"),
                        )
                    return HookResult(
                        decision=HookDecision.APPROVE,
                        additional_context=response.get("additionalContext", ""),
                        updated_input=response.get("updatedInput"),
                    )
                except json.JSONDecodeError:
                    pass  # Non-JSON stdout is treated as approve

            if result.returncode != 0 and result.returncode != 2:
                # Non-zero, non-2 exit code: warning but continue
                return HookResult()

        except subprocess.TimeoutExpired:
            # Ch8: timeout = error, not block
            return HookResult()
        except Exception as e:
            _logger.warning("Command hook error: %s", e)

        return HookResult()

    def _run_async(
        self,
        config: HookConfig,
        tool_name: str,
        tool_input: dict = None,
        tool_result: str = "",
    ):
        """Run a hook asynchronously (fire-and-forget)."""
        hook_input = json.dumps({
            "event": config.event.value,
            "tool_name": tool_name,
            "tool_input": tool_input or {},
            "tool_result": tool_result[:2000],
        }, ensure_ascii=False)

        try:
            proc = subprocess.Popen(
                config.command,
                shell=True,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Write hook input to stdin and close the pipe so the
            # subprocess does not hang waiting for EOF.
            try:
                proc.stdin.write(hook_input.encode("utf-8"))
                proc.stdin.close()
            except Exception:
                pass  # If stdin write fails, let the process continue
            # L11: Reap process in background with timeout to prevent zombies
            def _reap():
                try:
                    proc.wait(timeout=config.timeout or 30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                except Exception:
                    pass
            threading.Thread(target=_reap, daemon=True).start()
        except Exception:
            pass  # Async hooks are fire-and-forget

    def _run_http_hook(
        self,
        config: HookConfig,
        tool_name: str,
        tool_input: dict = None,
        tool_result: str = "",
    ) -> HookResult:
        """Execute an HTTP hook by POSTing to a URL."""
        import urllib.request
        import urllib.error

        # SSRF protection: validate hook URL before making the request
        from .tools.web_tools import _validate_url
        ssrf_err = _validate_url(config.url)
        if ssrf_err:
            _logger.warning("HTTP hook URL blocked by SSRF check: %s — %s", config.url, ssrf_err)
            return HookResult()

        payload = json.dumps({
            "event": config.event.value,
            "tool_name": tool_name,
            "tool_input": tool_input or {},
            "tool_result": tool_result[:2000],
        }, ensure_ascii=False)

        headers = {"Content-Type": "application/json"}
        headers.update(config.headers)

        req = urllib.request.Request(
            config.url,
            data=payload.encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=config.timeout) as resp:
                body = resp.read().decode("utf-8").strip()
                if body:
                    try:
                        data = json.loads(body)
                        decision = data.get("decision", "approve")
                        if decision == "block":
                            return HookResult(
                                decision=HookDecision.BLOCK,
                                reason=data.get("reason", "Blocked by HTTP hook"),
                            )
                        return HookResult(
                            decision=HookDecision.APPROVE,
                            additional_context=data.get("additionalContext", ""),
                            updated_input=data.get("updatedInput"),
                        )
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            _logger.warning("HTTP hook error: %s", e)

        return HookResult()

    def _run_prompt_hook(
        self,
        config: HookConfig,
        tool_name: str,
        tool_input: dict = None,
        tool_result: str = "",
    ) -> HookResult:
        """Execute a prompt hook by sending a query to an LLM.

        The LLM decides whether to approve or block the action.
        Used for auto-mode safety checks (Claude Code's classifier pattern).
        """
        # Build the prompt with context
        prompt_text = config.prompt.format(
            tool_name=tool_name,
            tool_input=json.dumps(tool_input or {}, ensure_ascii=False)[:2000],
            tool_result=tool_result[:2000],
            event=config.event.value,
        )

        # Try to use the LLM client if available
        llm_client = getattr(self, '_llm_client', None)
        if not llm_client:
            return HookResult()  # No LLM available, default to approve

        try:
            response = llm_client.chat.completions.create(
                model=getattr(self, '_llm_model', "mimo-v2.5-pro"),
                messages=[
                    {"role": "system", "content": (
                        "You are a safety classifier. Respond with JSON only: "
                        '{"decision": "approve"} or {"decision": "block", "reason": "..."}'
                    )},
                    {"role": "user", "content": prompt_text},
                ],
                temperature=0.1,
            )
            content = response.choices[0].message.content or ""
            # Parse response
            content = content.strip()
            if content.startswith("```"):
                # Strip markdown code blocks
                lines = content.split("\n")
                content = "\n".join(lines[1:-1] if len(lines) > 2 else lines)
            data = json.loads(content)
            if data.get("decision") == "block":
                return HookResult(
                    decision=HookDecision.BLOCK,
                    reason=data.get("reason", "Blocked by prompt hook"),
                )
            return HookResult(
                additional_context=data.get("additionalContext", ""),
            )
        except Exception:
            pass  # LLM hook failures are non-blocking

        return HookResult()

    def load_from_config(self, config: dict):
        """Load hooks from a configuration dictionary.

        Expected format (Ch8):
        {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {"type": "command", "command": "validate.sh", "timeout": 5}
                        ]
                    }
                ]
            }
        }
        """
        hooks_config = config.get("hooks", {})
        for event_name, matchers in hooks_config.items():
            try:
                event = HookEvent(event_name)
            except ValueError:
                continue

            for matcher_config in matchers:
                matcher = matcher_config.get("matcher", "*")
                for hook_def in matcher_config.get("hooks", []):
                    hook_type_str = hook_def.get("type", "command")
                    hook_type = HookType.COMMAND
                    try:
                        hook_type = HookType(hook_type_str)
                    except ValueError:
                        pass

                    if hook_type == HookType.HTTP:
                        self.register(HookConfig(
                            event=event,
                            matcher=matcher,
                            hook_type=HookType.HTTP,
                            url=hook_def.get("url", hook_def.get("command", "")),
                            headers=hook_def.get("headers", {}),
                            timeout=hook_def.get("timeout", 10.0),
                            async_mode=hook_def.get("async", False),
                        ))
                    elif hook_type == HookType.PROMPT:
                        self.register(HookConfig(
                            event=event,
                            matcher=matcher,
                            hook_type=HookType.PROMPT,
                            prompt=hook_def.get("prompt", ""),
                            timeout=hook_def.get("timeout", 10.0),
                            async_mode=hook_def.get("async", False),
                        ))
                    else:
                        self.register(HookConfig(
                            event=event,
                            matcher=matcher,
                            hook_type=HookType.COMMAND,
                            command=hook_def.get("command", ""),
                            timeout=hook_def.get("timeout", 10.0),
                            async_mode=hook_def.get("async", False),
                        ))
